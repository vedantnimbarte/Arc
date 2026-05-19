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
    /// Agent persona id (matches the UI's agent registry). NULL means the
    /// default "Chat Assistant" — resolved on the frontend.
    pub agent_id: Option<String>,
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

/// Row-shape tuple used by every conversation SELECT in this file. Kept as
/// a typedef so a future column add only edits one place.
type ConversationRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
);

fn row_to_conversation(row: ConversationRow) -> ChatConversation {
    let (id, workspace_id, title, agent_id, created_at, last_message_at) = row;
    ChatConversation {
        id,
        workspace_id,
        title,
        agent_id,
        created_at,
        last_message_at,
    }
}

const CONV_SELECT: &str =
    "id, workspace_id, title, agent_id, created_at, last_message_at";

/// Most recent conversation for `workspace_id`, or a fresh one if none.
/// Passing `None` returns/creates the orphan "default" conversation.
pub async fn current_or_create(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
) -> Result<ChatConversation> {
    // NULL-aware lookup: SQLite treats NULL = NULL as false, so use IS NULL.
    let sql = match workspace_id {
        Some(_) => format!(
            "SELECT {CONV_SELECT} FROM chat_conversations \
             WHERE workspace_id = ? ORDER BY last_message_at DESC LIMIT 1"
        ),
        None => format!(
            "SELECT {CONV_SELECT} FROM chat_conversations \
             WHERE workspace_id IS NULL ORDER BY last_message_at DESC LIMIT 1"
        ),
    };
    let mut q = sqlx::query_as::<_, ConversationRow>(&sql);
    if let Some(ws) = workspace_id {
        q = q.bind(ws);
    }
    if let Some(row) = q.fetch_optional(pool).await? {
        return Ok(row_to_conversation(row));
    }

    create(pool, workspace_id, None, None).await
}

/// List all conversations for `workspace_id` (or orphan ones when None),
/// newest activity first. Powers the sessions sidebar.
pub async fn list_conversations(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
) -> Result<Vec<ChatConversation>> {
    let sql = match workspace_id {
        Some(_) => format!(
            "SELECT {CONV_SELECT} FROM chat_conversations \
             WHERE workspace_id = ? ORDER BY last_message_at DESC"
        ),
        None => format!(
            "SELECT {CONV_SELECT} FROM chat_conversations \
             WHERE workspace_id IS NULL ORDER BY last_message_at DESC"
        ),
    };
    let mut q = sqlx::query_as::<_, ConversationRow>(&sql);
    if let Some(ws) = workspace_id {
        q = q.bind(ws);
    }
    let rows = q.fetch_all(pool).await?;
    Ok(rows.into_iter().map(row_to_conversation).collect())
}

/// Insert a new conversation row.
pub async fn create(
    pool: &SqlitePool,
    workspace_id: Option<&str>,
    agent_id: Option<&str>,
    title: Option<&str>,
) -> Result<ChatConversation> {
    let now = now_ms();
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO chat_conversations \
            (id, workspace_id, title, agent_id, created_at, last_message_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(workspace_id)
    .bind(title)
    .bind(agent_id)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;

    Ok(ChatConversation {
        id,
        workspace_id: workspace_id.map(String::from),
        title: title.map(String::from),
        agent_id: agent_id.map(String::from),
        created_at: now,
        last_message_at: now,
    })
}

/// Update title and/or agent on an existing conversation. `None` for a
/// field means "leave it unchanged".
pub async fn update_meta(
    pool: &SqlitePool,
    id: &str,
    title: Option<&str>,
    agent_id: Option<&str>,
) -> Result<()> {
    // Build a tiny dynamic UPDATE so we only touch the columns the caller
    // actually supplied. Keeps NULL semantics distinct from "not provided"
    // (otherwise we'd clobber an existing title with NULL on every rename).
    let mut sets: Vec<&str> = Vec::new();
    if title.is_some() {
        sets.push("title = ?");
    }
    if agent_id.is_some() {
        sets.push("agent_id = ?");
    }
    if sets.is_empty() {
        return Ok(());
    }
    let sql = format!("UPDATE chat_conversations SET {} WHERE id = ?", sets.join(", "));
    let mut q = sqlx::query(&sql);
    if let Some(t) = title {
        q = q.bind(t);
    }
    if let Some(a) = agent_id {
        q = q.bind(a);
    }
    q.bind(id).execute(pool).await?;
    Ok(())
}

/// Delete a conversation and (via FK cascade) all its messages.
pub async fn delete_conversation(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM chat_conversations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
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
