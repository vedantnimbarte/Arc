//! System font enumeration for the Settings → Font Family picker.
//!
//! ARC ships a curated list of monospace families ("Arc supported fonts");
//! this command surfaces the *other* group — whatever the user has installed
//! locally — so the dropdown can offer both. Backed by `fontdb`, which is a
//! pure-Rust scanner over the OS font directories (no native toolchain).
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("fonts_list_system") -> Vec<String>   // sorted, de-duplicated

/// Enumerate every font family installed on this machine.
///
/// Returns family names sorted case-insensitively with case-insensitive
/// duplicates collapsed. The scan touches disk, so it runs on the blocking
/// pool. Any failure degrades to an empty list — the picker just shows the
/// bundled group in that case.
#[tauri::command]
pub async fn fonts_list_system() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();

        let mut names: Vec<String> = db
            .faces()
            .flat_map(|face| face.families.iter().map(|(name, _lang)| name.clone()))
            .filter(|name| !name.trim().is_empty())
            .collect();

        names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        names
    })
    .await
    .unwrap_or_default()
}
