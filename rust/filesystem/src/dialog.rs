//! Native folder picker — runs the rfd sync dialog on a blocking thread
//! because rfd's sync picker handles modality + cross-platform parenting
//! more reliably than the async variant inside Tauri's runtime.

use std::path::Path;

use crate::{Error, Result};

pub async fn pick_folder(starting: Option<String>) -> Result<Option<String>> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Choose folder");
        if let Some(start) = starting.as_ref() {
            if Path::new(start).is_dir() {
                dialog = dialog.set_directory(start);
            }
        }
        dialog
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| Error::Dialog(e.to_string()))
}

/// Native multi-file open dialog. Returns the picked absolute paths, or an
/// empty vec when the user cancels.
pub async fn pick_files(starting: Option<String>) -> Result<Vec<String>> {
    tokio::task::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Attach files");
        if let Some(start) = starting.as_ref() {
            if Path::new(start).is_dir() {
                dialog = dialog.set_directory(start);
            }
        }
        dialog
            .pick_files()
            .map(|paths| {
                paths
                    .into_iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default()
    })
    .await
    .map_err(|e| Error::Dialog(e.to_string()))
}
