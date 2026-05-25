//! Tauri command surface for the built-in HTTP client (API Client tab).
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("http_request", { req }) -> HttpResponse
//!
//! The heavy lifting lives in `arc-http-client`; this file is just the IPC
//! adapter that maps anyhow errors to the `String` convention used by the
//! rest of the command surface.

use arc_http_client::{execute, HttpRequest, HttpResponse};

#[tauri::command]
pub async fn http_request(req: HttpRequest) -> Result<HttpResponse, String> {
    execute(req).await.map_err(|e| format!("{e:#}"))
}
