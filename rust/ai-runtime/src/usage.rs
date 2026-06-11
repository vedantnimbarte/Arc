//! Provider usage/cost reporting.
//!
//! Best-effort fetch of token usage from the cloud providers' *organization*
//! usage APIs:
//!   * Anthropic — Admin API `GET /v1/organizations/usage_report/messages`
//!   * OpenAI    — `GET /v1/organization/usage/completions`
//!
//! Both endpoints require an **admin / usage-scoped** key, NOT the normal
//! chat key. A normal key gets a 401/403 — we map that to
//! `UsageReport { authorized: false, .. }` with an explanatory `note` so the
//! UI can render a "needs an admin key" state instead of a hard error.
//!
//! Token totals are summed defensively by walking `data[].results[]` and
//! adding any numeric field we recognise; the raw JSON is always returned so
//! the UI can fall back to showing it verbatim if the shape drifts.

use chrono::{Datelike, TimeZone, Utc};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use crate::ProviderError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageProvider {
    Anthropic,
    OpenAi,
}

impl UsageProvider {
    /// Map a provider *kind* (the routing target, see `lib::provider`) to a
    /// usage backend. Returns `None` for kinds without a usage API (Ollama).
    pub fn from_kind(kind: &str) -> Option<Self> {
        match kind {
            "anthropic" => Some(Self::Anthropic),
            "openai" => Some(Self::OpenAi),
            _ => None,
        }
    }
}

/// A normalized usage summary for the current calendar month (UTC). `raw`
/// always carries the verbatim provider response so the UI can show it when
/// `authorized` is true but our field-summing missed the shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    /// `false` when the key lacks usage/admin scope (401/403). The other
    /// numeric fields are then `None` and `note` explains why.
    pub authorized: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Spend in USD. Currently always `None` — the usage endpoints return
    /// tokens, not cost (cost needs a separate `/costs` call). Reserved.
    pub cost_usd: Option<f64>,
    /// Human label for the window the numbers cover, e.g. "Jun 2026 (UTC)".
    pub period_label: String,
    pub raw: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Fetch usage for the current month. `api_key` must be an admin/usage key.
/// `base_url` overrides the default host (useful for proxies / Anthropic-
/// compatible gateways).
pub async fn fetch_usage(
    provider: UsageProvider,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<UsageReport, ProviderError> {
    if api_key.trim().is_empty() {
        return Err(ProviderError::MissingKey);
    }
    let client = Client::new();
    match provider {
        UsageProvider::Anthropic => fetch_anthropic(&client, api_key, base_url).await,
        UsageProvider::OpenAi => fetch_openai(&client, api_key, base_url).await,
    }
}

/// 00:00:00 UTC on the first day of the current month, plus a "Mon YYYY" label.
fn month_start() -> (chrono::DateTime<Utc>, String) {
    let now = Utc::now();
    let start = Utc
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or(now);
    let label = format!("{} (UTC)", start.format("%b %Y"));
    (start, label)
}

async fn fetch_anthropic(
    client: &Client,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<UsageReport, ProviderError> {
    let base = base_url.unwrap_or("https://api.anthropic.com");
    let (start, period_label) = month_start();
    let url = format!(
        "{}/v1/organizations/usage_report/messages",
        base.trim_end_matches('/')
    );

    let resp = client
        .get(&url)
        .query(&[
            ("starting_at", start.format("%Y-%m-%dT%H:%M:%SZ").to_string()),
            ("bucket_width", "1d".to_string()),
        ])
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await?;

    finish(resp, period_label, &["uncached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]).await
}

async fn fetch_openai(
    client: &Client,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<UsageReport, ProviderError> {
    let base = base_url.unwrap_or("https://api.openai.com");
    let (start, period_label) = month_start();
    let url = format!(
        "{}/v1/organization/usage/completions",
        base.trim_end_matches('/')
    );

    let resp = client
        .get(&url)
        .query(&[("start_time", start.timestamp().to_string())])
        .bearer_auth(api_key)
        .send()
        .await?;

    finish(resp, period_label, &["input_tokens"]).await
}

/// Shared response handling: 401/403 → unauthorized report; other non-2xx →
/// `Status` error; success → sum token fields out of `data[].results[]`.
/// `input_fields` lists the provider-specific names that count as input
/// tokens (output is always `output_tokens`).
async fn finish(
    resp: reqwest::Response,
    period_label: String,
    input_fields: &[&str],
) -> Result<UsageReport, ProviderError> {
    let status = resp.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Ok(UsageReport {
            authorized: false,
            input_tokens: None,
            output_tokens: None,
            cost_usd: None,
            period_label,
            raw: Value::Null,
            note: Some(
                "This key isn't authorized for the usage API. Provider usage \
                 reporting needs an admin / usage-scoped key (Anthropic Admin \
                 key or an OpenAI org admin key), not a regular chat key."
                    .to_string(),
            ),
        });
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderError::Status {
            status: status.as_u16(),
            body,
        });
    }

    let raw: Value = resp.json().await?;
    let input_tokens = sum_fields(&raw, input_fields);
    let output_tokens = sum_fields(&raw, &["output_tokens"]);
    Ok(UsageReport {
        authorized: true,
        input_tokens,
        output_tokens,
        cost_usd: None,
        period_label,
        raw,
        note: None,
    })
}

/// Walk `data[].results[]` and sum every occurrence of any name in `fields`.
/// Returns `None` if no matching numeric field was found (so the UI can fall
/// back to the raw payload rather than reporting a misleading 0).
fn sum_fields(raw: &Value, fields: &[&str]) -> Option<u64> {
    let data = raw.get("data")?.as_array()?;
    let mut total: u64 = 0;
    let mut found = false;
    for bucket in data {
        let Some(results) = bucket.get("results").and_then(|r| r.as_array()) else {
            continue;
        };
        for r in results {
            for field in fields {
                if let Some(n) = r.get(*field).and_then(Value::as_u64) {
                    total = total.saturating_add(n);
                    found = true;
                }
            }
        }
    }
    found.then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sums_across_buckets_and_results() {
        let raw = json!({
            "data": [
                { "results": [ { "input_tokens": 10, "output_tokens": 5 } ] },
                { "results": [ { "input_tokens": 20, "output_tokens": 7 } ] }
            ]
        });
        assert_eq!(sum_fields(&raw, &["input_tokens"]), Some(30));
        assert_eq!(sum_fields(&raw, &["output_tokens"]), Some(12));
    }

    #[test]
    fn sums_multiple_input_field_names() {
        let raw = json!({
            "data": [ { "results": [
                { "uncached_input_tokens": 100, "cache_read_input_tokens": 50, "output_tokens": 9 }
            ] } ]
        });
        let fields = ["uncached_input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
        assert_eq!(sum_fields(&raw, &fields), Some(150));
    }

    #[test]
    fn missing_fields_yield_none() {
        let raw = json!({ "data": [ { "results": [ { "other": 1 } ] } ] });
        assert_eq!(sum_fields(&raw, &["input_tokens"]), None);
    }

    #[test]
    fn no_data_yields_none() {
        assert_eq!(sum_fields(&json!({}), &["input_tokens"]), None);
    }
}
