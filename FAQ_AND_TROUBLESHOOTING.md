# FAQ & Troubleshooting — ARC

Common questions and solutions beyond basic setup.

## General

### Q: How is ARC different from VS Code?
**A:** ARC is purpose-built for AI agents + terminals + coding. VS Code is a general editor. ARC integrates:
- Real PTY terminal (xterm.js)
- Built-in agent with approval gating
- Streaming LLM chat (OpenAI/Anthropic/Ollama)
- Workspace-scoped memory
- Full-text file search

### Q: Can I use ARC on servers or containers?
**A:** Currently, ARC is desktop-only (Tauri app). Server/Docker deployment is planned for Phase 2. For now, use locally.

### Q: Is ARC open source?
**A:** License is TBD. Check [LICENSE](LICENSE) or GitHub for current status.

### Q: Can I customize keybindings?
**A:** Yes! Settings → Keyboard Shortcuts. All defaults are customizable.

---

## Terminal

### Q: How do I change the default shell?
**A:** Settings → Terminal → Default Shell → Dropdown or custom path. New terminals use it.

### Q: Can I resize the terminal?
**A:** Yes, drag the divider between the file tree and terminal. The PTY resizes automatically.

### Q: Why doesn't my command work?
**A:** The terminal inherits PATH from your system. If a command isn't found, it's not installed. Verify:
```bash
which <command>  # or 'where' on Windows
```

### Q: Can I use tmux or screen inside ARC?
**A:** Yes! Run `tmux` or `screen` inside the ARC terminal. But ARC already multiplexes tabs, so it's optional.

---

## Code Editor

### Q: The editor is slow on large files.
**A:** CodeMirror 6 has limits:
- **Max file:** 5 MiB
- **Max lines:** ~100k lines
For larger files, use an external editor (`vim`, `nano`, VSCode) inside the terminal.

### Q: Can I use vim keybindings?
**A:** Not yet. CodeMirror 6 extensions for vim are planned.

### Q: Why doesn't the editor syntax highlight my file?
**A:** Language detection is based on file extension (`.ts`, `.py`, etc.). If the extension is non-standard, it won't highlight. Rename or open in terminal editor.

---

## AI Chat

### Q: Which provider should I use?
**A:** 
- **Anthropic (recommended):** Best for coding tasks, fast, reliable
- **OpenAI:** Good alternative, widely available
- **Ollama (local):** Best for privacy/offline, slower, weaker models

### Q: My API key doesn't work.
**A:** Check:
1. Key is copied correctly (no extra spaces)
2. Key is active on provider dashboard (not revoked)
3. Correct provider selected in Settings
4. Restart ARC after changing key

### Q: How much will my API usage cost?
**A:** Depends on the model:
- **OpenAI:** $0.00003/input token, $0.00006/output token
- **Anthropic:** $3/MTok input, $15/MTok output
- **Ollama:** $0 (local)

Monitor usage on provider dashboards.

### Q: Can I use custom model endpoints?
**A:** Yes. Settings → Provider → Base URL. Example: `http://localhost:8000/v1` for local vLLM.

---

## Agents

### Q: The agent is slow or stuck.
**A:** Check:
1. Agent is still running (look for spinner in chat)
2. Waiting for your approval? (Check if popover is visible)
3. Tool timed out? (30 second timeout per tool)

**Fix:** Close the chat popover (Escape) to stop the agent.

### Q: Agent can't find a file I know exists.
**A:** Possibilities:
1. File is outside the workspace root (change root in FileTree)
2. Agent is searching the wrong path (ask it to list the directory first)
3. File is binary (agent won't read .exe, .png, .zip)

### Q: Agent denies approval but I wanted to approve.
**A:** You closed the popover (Escape), which auto-denies. Open chat again and re-run agent.

### Q: Can agents access my API keys or passwords?
**A:** No. Keys are in the OS credential vault. Agent sees only what it requests (via shell). Even then, you must approve shell calls.

---

## File Search

### Q: Search is slow.
**A:** First search builds the tantivy index. Subsequent searches are fast.
**Fix:** Rebuild index: FileTree header → Rebuild Index. Wait for completion.

### Q: My search results are wrong.
**A:** Query tips:
- Use exact phrases: `"async function"` not just `async function`
- Avoid keywords that appear in every file (like `function`, `var`)
- Try more specific queries

---

## Memory & Notes

### Q: Can I share notes with teammates?
**A:** Not yet. Notes are workspace-local in SQLite. Export via:
```
/memory list → Copy text → Share via email/Slack
```

### Q: How do I search notes by meaning?
**A:** Use vector search:
```
/memory search -semantic How do I handle authentication?
```

Requires embedding setup (OpenAI or Ollama).

---

## MCP Integration

### Q: How do I know if MCP connection is working?
**A:** Try:
```
/mcp list
```

Shows all connected servers and tools.

### Q: MCP server crashes and stops working.
**A:** Reconnect:
```
/mcp disconnect <server-id>
/mcp connect <server-id> <command>
```

### Q: I'm getting "tool not found" errors.
**A:** Tools might not be defined in the server. Verify server exposes the tool:
```
/mcp call <server> list_tools
```

---

## Workspace & Sessions

### Q: How do I back up my sessions?
**A:** Copy the data directory:
- macOS: `~/Library/Application\ Support/dev.arc.terminal/`
- Windows: `%APPDATA%\dev.arc.terminal\`
- Linux: `~/.local/share/dev.arc.terminal/`

### Q: Can I sync sessions across machines?
**A:** Not automatically. You'd need to sync the data directory manually (iCloud, Dropbox, etc.).

### Q: How do I delete all my data?
**A:** Delete the data directory (see above). Chat history, notes, command history, everything is deleted.

---

## Performance & Optimization

### Q: ARC is using a lot of memory.
**A:** Check:
1. How many tabs/terminals are open? (Close unused ones)
2. Is a large file open in editor? (Close it)
3. Is search index being built? (Wait for completion)

**Fix:** Restart ARC.

### Q: Index rebuilding is taking forever.
**A:** Tantivy indexing is slow on large repos (>100k files).
**Fix:** 
- Close other apps to free memory
- Use `-F` flag if available: `fs_index_rebuild(root)`
- Or skip indexing; use fast walker fallback (slower but works)

### Q: Why is the terminal/chat responsiveness slow?
**A:** Tauri IPC has overhead. Expect minor latency (< 100ms). If worse, check:
1. CPU usage (background processes)
2. Disk I/O (index building, file watching)

---

## Errors & Debugging

### Error: "Workspace not found"
**Cause:** Workspace ID is invalid or was deleted.
**Fix:** Create a new workspace or check workspace settings.

### Error: "Permission denied"
**Cause:** File permissions or agent approval rejected.
**Fix:** Check file permissions or approve the agent's request.

### Error: "Network error"
**Cause:** Internet issue or provider down.
**Fix:**
- Check internet connection
- Verify provider's status page
- Switch to local Ollama

### Error: "Shell command not found"
**Cause:** Command isn't installed.
**Fix:** Install the command or use full path (e.g., `/usr/local/bin/command`).

### Error: "File too large"
**Cause:** File > 5 MiB.
**Fix:** Open in terminal editor (`vim`, `nano`) or external editor.

---

## Advanced

### Q: How do I run ARC with custom environment variables?
**A:**
```bash
export API_KEY=secret
export DATABASE_URL=postgresql://...
pnpm tauri:dev
```

Agent can access via `shell("echo $API_KEY")`.

### Q: Can I use ARC offline?
**A:** Mostly. Without internet:
- PTY terminal: ✅ Works
- Editor: ✅ Works
- File search: ✅ Works
- Local Ollama chat: ✅ Works
- OpenAI/Anthropic: ❌ Doesn't work
- MCP remote servers: ❌ Don't work

### Q: How do I debug the agent?
**A:** Check:
1. Chat UI for error messages
2. Command history for tool calls (`Ctrl+R`)
3. Browser console (DevTools: `Ctrl+Shift+I`)
4. Rust logs: `RUST_LOG=arc=debug pnpm tauri:dev`

---

## See Also

- [INSTALLATION.md](INSTALLATION.md#troubleshooting) — Installation troubleshooting
- [SECURITY.md](SECURITY.md#incident-response) — Security troubleshooting
- [FEATURES.md](FEATURES.md) — Feature guides
