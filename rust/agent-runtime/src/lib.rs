//! arc-agent-runtime — background agent execution (stub).
//!
//! See docs/architecture.md §"Agent runtime" for the planner/executor/memory
//! split. Phase 2 wires this up.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub system_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentStatus {
    Idle,
    Running,
    Paused,
    Completed,
    Failed(String),
}
