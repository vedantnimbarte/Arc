# Security & Credential Management — ARC

This document explains how ARC handles sensitive data (API keys, passwords, credentials) and best practices for secure usage.

**Key topics:**
- [Credential Storage](#credential-storage)
- [API Key Setup](#api-key-setup)
- [Data Persistence](#data-persistence)
- [Agent Approval Security](#agent-approval-security)
- [Best Practices](#best-practices)

---

## Credential Storage

### OS Credential Vault

ARC stores API keys in your operating system's **credential vault**, not in plaintext files:

| OS | Vault | Service Name | Username |
|--|--|--|--|
| **macOS** | Keychain | `dev.arc.terminal` | `<provider>` (e.g., `openai`) |
| **Windows** | Credential Manager | `dev.arc.terminal` | `<provider>` |
| **Linux** | sync-secret-service | `dev.arc.terminal` | `<provider>` |

**When you set an API key in Settings:**

```
Ctrl+, → Provider → API Key field → [enter key]
```

Behind the scenes:
1. Key is validated (basic format check)
2. Key is encrypted by OS
3. Key is stored in the vault
4. ARC app memory never persists the key to disk
5. Key is only loaded from vault when needed (to call LLM provider)

### Keychain (macOS)

View stored keys:
```bash
security find-generic-password -s dev.arc.terminal
security find-generic-password -s dev.arc.terminal -a openai
```

Delete a key:
```bash
security delete-generic-password -s dev.arc.terminal -a openai
```

### Credential Manager (Windows)

View stored keys:
```powershell
Get-CredentialStoreItem -Target "dev.arc.terminal"
```

---

## API Key Setup

### OpenAI

1. Create account at https://platform.openai.com/account/api-keys
2. Copy your API key (format: `sk-...`)
3. In ARC Settings:
   - **Provider:** OpenAI
   - **API Key:** Paste the key
   - **Model:** (optional) Override default `gpt-4o-mini`
   - Click Save

**Permissions needed:**
- `read` — List models
- `write` — Send chat requests

**Revoke access:**
Regenerate your key on OpenAI dashboard → ARC will need the new key.

### Anthropic

1. Create account at https://console.anthropic.com/
2. Create an API key
3. In ARC Settings:
   - **Provider:** Anthropic
   - **API Key:** Paste the key
   - **Model:** (optional) Override default `claude-sonnet-4-6`
   - Click Save

**Permissions needed:**
- Message API access

**Revoke access:**
Delete the key on Anthropic dashboard.

### Ollama (Local)

No API key needed. Ollama runs locally on your machine.

1. Install Ollama from https://ollama.ai/
2. Run: `ollama serve`
3. In ARC Settings:
   - **Provider:** Ollama
   - **API Key:** (leave empty)
   - **Base URL:** `http://127.0.0.1:11434/v1`
   - **Model:** `llama3.2:1b` or another model you've pulled
   - Click Save

**Download models:**
```bash
ollama pull llama3.2:1b
ollama pull mistral
ollama pull neural-chat
```

---

## Data Persistence

### What's Encrypted

| Data | Storage | Encrypted? |
|------|---------|-----------|
| API Keys | OS Credential Vault | ✅ Yes (OS-managed) |
| Chat history | SQLite (local) | ⚠️ No (SQLite unencrypted) |
| Command history | SQLite (local) | ⚠️ No |
| Session state | SQLite (local) | ⚠️ No |
| Settings (provider, model) | localStorage | ⚠️ No |
| Memory entries | SQLite (local) | ⚠️ No |

### What's NOT Encrypted

SQLite database and localStorage are **not encrypted**. Anyone with access to your data directory can read:
- All your chat conversations
- Commands you've typed
- Files you've opened
- Memory notes you've saved

### Data Location

| OS | Path |
|--|--|
| **macOS** | `~/Library/Application Support/dev.arc.terminal/` |
| **Windows** | `%APPDATA%\dev.arc.terminal\` |
| **Linux** | `~/.local/share/dev.arc.terminal/` |

### Backup Strategy

```bash
# macOS/Linux: Backup the data directory
tar -czf arc-backup.tar.gz ~/Library/Application\ Support/dev.arc.terminal/

# Windows: Copy the folder
copy %APPDATA%\dev.arc.terminal\ D:\backups\arc-backup\
```

### Clearing Data

To completely remove your data:

```bash
# macOS
rm -rf ~/Library/Application\ Support/dev.arc.terminal/

# Linux
rm -rf ~/.local/share/dev.arc.terminal/

# Windows
rmdir /s %APPDATA%\dev.arc.terminal\
```

---

## Agent Approval Security

### When Approval is Required

These tools need explicit approval before execution:

1. **fs_write_file** — Writing to disk
2. **fs_edit** — Modifying files
3. **shell** — Running shell commands
4. **MCP tools** — Any tool from an MCP server (except read-only tools)

### When Approval is NOT Required

These are read-only and execute immediately:

- `fs_read_file` — Reading files
- `fs_list_dir` — Listing directories
- `fs_search` — Searching files
- `git_*` — Git operations
- `memory_search` — Searching notes
- `memory_save` — Saving notes (benign side effect)

### Approval Flow

```
Agent calls: fs_write_file("config.ts", "...")

ARC shows:
  ┌─────────────────────────────────┐
  │ Agent wants to: fs_write_file   │
  │ Path: config.ts                 │
  │ [Approve] [Deny]                │
  └─────────────────────────────────┘

User clicks [Approve]
→ Tool executes
→ Agent continues

OR

User clicks [Deny]
→ Tool fails with error
→ Agent gets: "fs_write_file was denied"
→ Agent adjusts (e.g., suggests changes in chat)
```

### Preventing Malicious Agents

**Risk:** An agent could try to:
- Delete important files
- Exfiltrate data via shell commands
- Modify configuration files

**Mitigations:**
1. **Approval gating** — You see and approve tool calls
2. **Read-only by default** — Most tools are read-only
3. **No network access** — Agent can't send data outside (except via shell)
4. **Scoped to workspace** — Agent can't access files outside workspace root

**Best practices:**
- **Review approval prompts carefully** before clicking Approve
- **Don't approve suspicious commands** (e.g., `curl | bash`, `rm -rf /`)
- **Use descriptive agent goals** so agent understands intent
- **Combine agents with trusted LLM providers** (use Anthropic for sensitive work)

---

## Best Practices

### 1. Limit API Key Scope

Use provider-specific API key scopes when available:

**OpenAI:**
- Create restricted keys (not full account access)
- Limit to specific endpoints (chat, not billing, admin, etc.)

**Anthropic:**
- Create separate keys per project/environment
- Rotate keys regularly (monthly or quarterly)

### 2. Separate Keys per Environment

```
Development:  sk-dev-...
Staging:      sk-stage-...
Production:   sk-prod-...
```

This limits blast radius if a key leaks.

### 3. Rotate Keys Regularly

```
Every 90 days:
1. Generate a new key on provider dashboard
2. Update ARC settings with new key
3. Delete the old key
```

### 4. Don't Share Workspaces with Keys

If sharing your ARC workspace (e.g., git repo with `.arc` folder), **exclude the credential store:**

```bash
# .gitignore
# Never commit credential vault
.arc/credentials/
```

### 5. Audit Agent Runs

Check your LLM provider dashboard for usage:
- **OpenAI:** dashboard.openai.com/account/billing/overview
- **Anthropic:** console.anthropic.com/usage

Verify all requests are legitimate.

### 6. Monitor Database Access

On shared machines, restrict access to your data directory:

**macOS:**
```bash
chmod 700 ~/Library/Application\ Support/dev.arc.terminal/
```

**Linux:**
```bash
chmod 700 ~/.local/share/dev.arc.terminal/
```

**Windows:**
Right-click folder → Properties → Security → Edit permissions

### 7. Use Ollama for Sensitive Work

If working with sensitive code:
- Use local Ollama (no cloud)
- Model runs on your machine
- Data never leaves your device
- Trade-off: Slower, less capable models

### 8. Clear Chat History After Sensitive Sessions

If discussing passwords or secrets in chat:

```
Ctrl+J (open chat) → [Clear button] → Clear all messages
```

This deletes the chat from SQLite.

### 9. MCP Server Trust

When connecting MCP servers:

```
/mcp connect web-search npx @some-org/web-search
```

**Ask:**
- Is the NPM package from a trusted org?
- What data does it access?
- Does it send data externally?

**Example: Don't trust random packages:**
```
❌ /mcp connect db npx random-db-tool  // Unknown origin
✅ /mcp connect web npx @anthropic/mcp-server-web-search  // Known org
```

### 10. Environment Variables

For sensitive data (DB URLs, API keys), use environment variables:

```bash
# Start ARC with env vars
export STRIPE_KEY=sk_live_...
export DATABASE_URL=postgresql://user:pass@host/db
pnpm tauri:dev
```

Agent can access these via shell:
```
Agent calls: shell("echo $STRIPE_KEY")
Agent uses the key without you typing it
```

---

## Incident Response

### If an API Key Leaks

1. **Immediately revoke the key** on the provider dashboard:
   - OpenAI: Generate a new key
   - Anthropic: Delete the key
   - Ollama: (not applicable, local only)

2. **Update ARC:**
   - Settings → Provider → API Key → Paste new key

3. **Monitor for abuse:**
   - Check provider dashboard for suspicious requests
   - Contact provider support if compromised

### If Your Data Directory is Compromised

1. **Stop using ARC** on that machine
2. **Back up your data** (if not compromised)
3. **Delete the data directory:** `rm -rf <data-dir>`
4. **Reinstall ARC** on a clean machine
5. **Revoke all API keys** from provider dashboards
6. **Generate new keys** and reconfigure ARC

---

## Compliance

### GDPR / Data Privacy

ARC stores data locally. You own your data:
- No data is sent to Anthropic (except LLM API calls)
- No tracking or analytics
- You can delete everything by removing the data directory

### HIPAA / PII

If working with sensitive personal data:
- Use local Ollama (no cloud)
- Encrypt your data directory (full-disk encryption on OS level)
- Audit agent runs carefully

### SOC 2 / Enterprise

ARC is not SOC 2 certified. For enterprise use:
- Deploy on-premises (self-hosted)
- Use local Ollama only
- Implement network segmentation
- Regular security audits

---

## Troubleshooting

### "Failed to save API key"

**Cause:** Credential vault issue (service not running, permissions).

**Fix:**
- **macOS:** Keychain is always running; try logging out/in
- **Windows:** Check Credential Manager is running (`services.msc`)
- **Linux:** Ensure `secret-service` daemon is running:
  ```bash
  systemctl start secret-service
  ```

### "API key not found" (but I set it)

**Cause:** Key was deleted from credential vault by another app, or vault was corrupted.

**Fix:**
- Re-enter the API key in Settings
- Or check if Keychain/Credential Manager was reset

### "LLM request failed" after changing keys

**Cause:** Old key was revoked; cached key is stale.

**Fix:**
- Close ARC completely
- Reopen ARC (forces fresh key load from vault)

---

## See Also

- [INSTALLATION.md](INSTALLATION.md) — Setting up API keys
- [FEATURES.md](FEATURES.md#settings) — Settings dialog
- [AGENTS.md](AGENTS.md#agent-approval-security) — Agent approval security
