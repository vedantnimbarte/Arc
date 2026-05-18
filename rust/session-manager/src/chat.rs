//! Chat conversations and messages.
//!
//! V0 keeps a single conversation per workspace (and one orphan "default"
//! conversation for when no workspace is open). The schema already allows
//! multiple conversations per workspace if we want to grow into branching
//! later; the API just doesn't expose it yet.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{now_ms, Result};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

impl ChatRole {
    fn as_str(self) -> &'static str {
        match self {
            ChatRole::System => "system",
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        }
    }

    fn parse(s: &str) -> ChatRole {
        match s {
            "system" => ChatRole::System,
            "assistant" => ChatRole::Assistant,
            _ => ChatRole::User,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatConversation {
    pub id: String,
    pub workspace_id: Option<String>,
    pub title: Option<String>,
    pub created_at: i64,
    pub last_message_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: ChatRole,
    pub content: String,
    pub created_at: i64,
}

/// Most recent conversation for `workspace_id`, or a fresh one if none.
/// Passing `None` returns/creates the orphan "default" conversation.
pub async fn current_or_create(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
) -> Result<ChatConversation> {
    // NULL-aware lookup: SQLite treats NULL = NULL as false, so use IS NULL.
    let existing = match workspace_id {
        Some(ws) => sqlx::query_as::<_, (String, Option<String>, Option<String>, i64, i64)>(
            "SELECT id, workspace_id, title, created_at, last_message_at \
             FROM chat_conversations WHERE workspace_id = ? \
             ORDER BY last_message_at DESC LIMIT 1",
        )
        .bind(ws)
        .fetch_optional(pool)
        .await?,
        None => sqlx::query_as::<_, (String, Option<String>, Option<String>, i64, i64)>(
            "SELECT id, workspace_id, title, created_at, last_message_at \
             FROM chat_conversations WHERE workspace_id IS NULL \
             ORDER BY last_message_at DESC LIMIT 1",
        )
        .fetch_optional(pool)
        .await?,
    };

    if let Some((id, workspace_id, title, created_at, last_message_at)) = existing {
        return Ok(ChatConversation {
            id,
            workspace_id,
            title,
            created_at,
            last_message_at,
        });
    }

    let now = now_ms();
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO chat_conversations (id, workspace_id, title, created_at, last_message_at) \
         VALUES (?, ?, NULL, ?, ?)",
    )
    .bind(&id)
    .bind(workspace_id)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    Ok(ChatConversation {
        id,
        workspace_id: workspace_id.map(String::from),
        title: None,
        created_at: now,
        last_message_at: now,
    })
}

pub async fn list(pool: &SqlitePool, conversation_id: &str) -> Result<Vec<ChatMessage>> {
    let rows = sqlx::query_as::<_, (String, String, String, String, i64)>(
        "SELECT id, conversation_id, role, content, created_at \
         FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, conversation_id, role, content, created_at)| ChatMessage {
            id,
            conversation_id,
            role: ChatRole::parse(&role),
            content,
            created_at,
        })
        .collect())
}

/// Append a message and bump the conversation's `last_message_at`.
/// Returns the persisted row (with assigned id + timestamp).
pub async fn append(
    pool: &SqlitePool,
    conversation_id: &str,
    role: ChatRole,
    content: &str,
) -> Result<ChatMessage> {
    let now = now_ms();
    let id = Uuid::new_v4().to_string();
    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT INTO chat_messages (id, conversation_id, role, content, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(role.as_str())
    .bind(content)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    sqlx::query("UPDATE chat_conversations SET last_message_at = ? WHERE id = ?")
        .bind(now)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(ChatMessage {
        id,
        conversation_id: conversation_id.to_string(),
        role,
        content: content.to_string(),
        created_at: now,
    })
}

/// Wipe all messages in a conversation (but keep the conversation row).
pub async fn clear(pool: &SqlitePool, conversation_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM chat_messages WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(pool)
        .await?;
    Ok(())
}
