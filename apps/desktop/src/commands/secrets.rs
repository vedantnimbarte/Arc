//! User secrets vault, backed by the OS keychain.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("secret_set",    { name, value })  -> ()
//!   invoke("secret_get",    { name })         -> Option<String>
//!   invoke("secret_delete", { name })         -> ()
//!   invoke("secret_list")                     -> Vec<String>   (names only)
//!
//! Values live in the OS credential vault under the `dev.arc.terminal.secrets`
//! service, keyed by secret name. The keyring can't enumerate its own entries,
//! so the set of names is tracked as a JSON array in a single reserved entry
//! (`INDEX_KEY`) in the same service — no database migration needed. `secret_list`
//! never returns values.

use keyring::Entry;

const KEYRING_SERVICE: &str = "dev.arc.terminal.secrets";
/// Reserved key holding the JSON name index. Not a valid user secret name.
const INDEX_KEY: &str = "__arc_secret_index__";

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, name).map_err(|e| e.to_string())
}

fn load_index() -> Result<Vec<String>, String> {
    match entry(INDEX_KEY)?.get_password() {
        Ok(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn save_index(names: &[String]) -> Result<(), String> {
    let json = serde_json::to_string(names).map_err(|e| e.to_string())?;
    entry(INDEX_KEY)?.set_password(&json).map_err(|e| e.to_string())
}

/// Validate a user-supplied secret name: non-empty and not the reserved key.
fn check_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("secret name cannot be empty".to_string());
    }
    if name == INDEX_KEY {
        return Err("reserved name".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    check_name(&name)?;
    entry(&name)?.set_password(&value).map_err(|e| e.to_string())?;
    let mut names = load_index()?;
    if !names.iter().any(|n| n == &name) {
        names.push(name);
        names.sort();
        save_index(&names)?;
    }
    Ok(())
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    check_name(&name)?;
    match entry(&name)?.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    check_name(&name)?;
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    let names: Vec<String> = load_index()?.into_iter().filter(|n| n != &name).collect();
    save_index(&names)
}

/// The names of stored secrets (never the values).
#[tauri::command]
pub fn secret_list() -> Result<Vec<String>, String> {
    load_index()
}
