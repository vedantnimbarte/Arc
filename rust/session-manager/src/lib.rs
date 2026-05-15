//! arc-session-manager — workspace + session persistence (stub).
//!
//! Phase 2 work: serialize tab layouts, command history, and agent state to
//! the SQLite store described in docs/architecture.md.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub shell: String,
}

pub struct SessionStore;

impl SessionStore {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}
