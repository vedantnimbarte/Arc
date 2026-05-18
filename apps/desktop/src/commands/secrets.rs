//! OS credential vault for sensitive secrets (LLM API keys today).
//!
//! Keys are stored per-provider under the service name `dev.arc.terminal`,
//! account = provider id ("openai" / "anthropic"). The keyring crate routes
//! to the platform-native backend:
//!   * macOS  → Keychain
//!   * Windows→ Credential Manager
//!   * Linux  → libsecret (GNOME Keyring, KWallet, etc.)
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("secrets_set_api_key", { provider, key }) -> ()
//!   invoke("secrets_get_api_key", { provider })      -> Option<String>
//!   invoke("secrets_delete_api_key", { provider })   -> ()

use keyring::Entry;

const SERVICE: &str = "dev.arc.terminal";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| format!("keyring entry: {e}"))
}

#[tauri::command]
pub async fn secrets_set_api_key(provider: String, key: String) -> Result<(), String> {
    let e = entry(&provider)?;
    if key.is_empty() {
        // Treat empty as "delete" so the UI's clear-the-field gesture works.
        return match e.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("delete: {err}")),
        };
    }
    e.set_password(&key).map_err(|err| format!("set: {err}"))
}

#[tauri::command]
pub async fn secrets_get_api_key(provider: String) -> Result<Option<String>, String> {
    let e = entry(&provider)?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("get: {err}")),
    }
}

#[tauri::command]
pub async fn secrets_delete_api_key(provider: String) -> Result<(), String> {
    let e = entry(&provider)?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("delete: {err}")),
    }
}
