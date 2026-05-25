//! Stateless HTTP request executor for ARC's built-in API client tab.
//!
//! One async fn: [`execute`]. Takes a fully-specified [`HttpRequest`], returns
//! an [`HttpResponse`] with the status, headers, timing, and body (as both
//! UTF-8 text when valid and base64 bytes for binary payloads).
//!
//! No streaming for v1 — the response body is fully buffered up to
//! [`MAX_RESPONSE_BYTES`]. Larger responses are truncated; callers see
//! `truncated = true` and `size_bytes` reflects the cap.

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    multipart, Client, Method,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// 10 MiB cap on the in-memory response buffer. Anything larger is truncated
/// and `HttpResponse.truncated` is set.
pub const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

/// Default per-request timeout when the caller doesn't specify one.
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderKV {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HttpBody {
    /// No request body.
    None,
    /// Raw body: arbitrary bytes (passed as a UTF-8 string from the frontend)
    /// with an explicit `Content-Type` header that will be added if the
    /// caller didn't already set one.
    Raw { text: String, content_type: String },
    /// application/x-www-form-urlencoded — key/value pairs.
    FormUrlEncoded { entries: Vec<HeaderKV> },
    /// multipart/form-data — only text fields for v1 (no file uploads).
    Multipart { entries: Vec<HeaderKV> },
}

impl Default for HttpBody {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderKV>,
    #[serde(default)]
    pub body: HttpBody,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<HeaderKV>,
    /// UTF-8 text body if the bytes decoded cleanly, otherwise null.
    pub body_text: Option<String>,
    /// Base64-encoded raw bytes — always present (even when `body_text`
    /// also is). Lets the frontend handle images / binary downloads.
    pub body_base64: String,
    pub size_bytes: u64,
    pub time_ms: u64,
    pub truncated: bool,
    /// Final URL after redirects, if any. Same as request URL when none.
    pub final_url: String,
}

/// Build a one-shot reqwest client. We don't share clients across requests
/// because users may want to switch certificate-verification / proxy settings
/// in the future — and the cost of building one is trivial vs. the network
/// round-trip.
fn build_client(timeout: Duration) -> Result<Client> {
    Client::builder()
        .timeout(timeout)
        .build()
        .context("building reqwest client")
}

fn parse_method(s: &str) -> Result<Method> {
    Method::from_bytes(s.to_uppercase().as_bytes())
        .map_err(|e| anyhow!("invalid HTTP method '{s}': {e}"))
}

fn build_headers(headers: &[HeaderKV]) -> Result<HeaderMap> {
    let mut map = HeaderMap::new();
    for h in headers {
        if h.name.is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(h.name.as_bytes())
            .map_err(|e| anyhow!("invalid header name '{}': {e}", h.name))?;
        let value = HeaderValue::from_str(&h.value)
            .map_err(|e| anyhow!("invalid header value for '{}': {e}", h.name))?;
        map.append(name, value);
    }
    Ok(map)
}

pub async fn execute(req: HttpRequest) -> Result<HttpResponse> {
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let client = build_client(timeout)?;
    let method = parse_method(&req.method)?;
    let mut headers = build_headers(&req.headers)?;

    let mut builder = client.request(method, &req.url);

    // Body handling. We attach the body first, then headers — so an explicit
    // user-set Content-Type wins over the body's default.
    match &req.body {
        HttpBody::None => {}
        HttpBody::Raw { text, content_type } => {
            if !content_type.is_empty()
                && !headers.contains_key(reqwest::header::CONTENT_TYPE)
            {
                let value = HeaderValue::from_str(content_type)
                    .map_err(|e| anyhow!("invalid Content-Type '{content_type}': {e}"))?;
                headers.insert(reqwest::header::CONTENT_TYPE, value);
            }
            builder = builder.body(text.clone());
        }
        HttpBody::FormUrlEncoded { entries } => {
            let pairs: Vec<(&str, &str)> = entries
                .iter()
                .map(|e| (e.name.as_str(), e.value.as_str()))
                .collect();
            builder = builder.form(&pairs);
        }
        HttpBody::Multipart { entries } => {
            let mut form = multipart::Form::new();
            for e in entries {
                form = form.text(e.name.clone(), e.value.clone());
            }
            builder = builder.multipart(form);
        }
    }

    builder = builder.headers(headers);

    let started = Instant::now();
    let resp = builder
        .send()
        .await
        .with_context(|| format!("sending request to {}", req.url))?;
    let status = resp.status();
    let final_url = resp.url().to_string();

    let resp_headers: Vec<HeaderKV> = resp
        .headers()
        .iter()
        .map(|(k, v)| HeaderKV {
            name: k.as_str().to_string(),
            value: v.to_str().unwrap_or("").to_string(),
        })
        .collect();

    // Buffer the body up to MAX_RESPONSE_BYTES. We collect the full bytes
    // first (reqwest doesn't expose a "take up to N" stream helper without
    // pulling in `futures-util`), then truncate.
    let full = resp.bytes().await.context("reading response body")?;
    let total_len = full.len();
    let (bytes, truncated) = if total_len > MAX_RESPONSE_BYTES {
        (full.slice(..MAX_RESPONSE_BYTES), true)
    } else {
        (full, false)
    };

    let time_ms = started.elapsed().as_millis() as u64;
    let body_text = std::str::from_utf8(&bytes).ok().map(|s| s.to_string());
    let body_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status
            .canonical_reason()
            .unwrap_or("")
            .to_string(),
        headers: resp_headers,
        body_text,
        body_base64,
        size_bytes: total_len as u64,
        time_ms,
        truncated,
        final_url,
    })
}
