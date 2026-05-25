# ARC Planned Features

A comprehensive roadmap of proposed features for the ARC terminal & agent runtime. Features are grouped by phase and include rationale, implementation approach, and technical considerations.

## Phase 1: Immediate Wins (Next 2-4 weeks)

These features leverage existing infrastructure and close gaps in core workflows.

### 1. Git UI Enhancements

#### 1.1 Visual Branch Switcher with Stash/Pop

**Description**: Interactive UI for switching branches, with built-in stash management for uncommitted changes.

**Why it matters**:
- Branch switching is frequent but currently requires terminal commands
- Context-switching between tasks is a core developer workflow
- Prevents accidental loss of uncommitted work

**Implementation**:
- Add `git_branches()` command to `rust/git/` that returns branch list with metadata (current, tracking, last-commit)
- New sidebar pane or dropdown menu (⌘B?) listing branches
- On branch click:
  - Detect dirty state via `git_status()`
  - If dirty, offer: "Stash & Switch" / "Cancel" / "Discard"
  - Execute `git stash` → `git checkout` → auto-restore tab scroll positions
- Add `git_stash_list()` and `git_stash_pop(index)` commands for stash management UI

**Technical approach**:
- Extend `rust/git/src/lib.rs` with branch/stash operations
- Add `git_branches`, `git_stash_list`, `git_stash_pop`, `git_stash_drop` Tauri commands
- Update `apps/frontend/src/state/workspace.ts` to track current branch (already uses `git_status`)
- New component: `apps/frontend/src/components/BranchSwitcher.tsx`

**Dependencies**: None; uses existing git infrastructure

---

#### 1.2 Interactive Staging (Hunk-level control)

**Description**: Stage/unstage individual hunks (diff chunks) directly from the editor or a dedicated staging UI.

**Why it matters**:
- Precise commit control without terminal `git add -p`
- Easier code review before commit
- Split large changes into logical commits

**Implementation**:
- Extend `git_diff()` to return hunks with line ranges (not just text)
- New staging pane (sidebar tab or modal) showing:
  - Unstaged changes (left) vs staged (right)
  - Checkbox per hunk to toggle staging
  - Live preview of commit diff
- On hunk toggle: call `git apply --cached --reverse` (or staged equivalent) for the hunk range

**Technical approach**:
- Parse git diff output into hunk objects (start line, end line, content)
- Add `git_apply_hunk()` command that applies/reverses a specific hunk
- New component: `apps/frontend/src/components/StagingPane.tsx`
- Integrate into editor gutter or side panel

**Dependencies**: None

---

#### 1.3 Merge Conflict Resolver

**Description**: Visual side-by-side conflict resolution UI integrated into the editor.

**Why it matters**:
- Merge conflicts are stressful; a guided UI reduces errors
- Common during multi-branch workflows
- Reduces context-switching to external diff tools

**Implementation**:
- Detect conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in `fs_read_file()`
- When editor opens a conflicted file, show a conflict banner above the code
- Side-by-side view:
  - Left: "Ours" (current branch)
  - Right: "Theirs" (incoming branch)
  - Checkboxes to select hunks
  - Full conflict resolution in one pane
- On resolve, remove markers and call `git add <file>`

**Technical approach**:
- Parse conflict markers in Editor component
- New component: `apps/frontend/src/components/ConflictResolver.tsx`
- Add `git_resolve_conflict()` helper in agent runtime (built-in tool for `/agent`)
- Persist conflict state in a temp store until resolved

**Dependencies**: None

---

#### 1.4 Commit Templates & GPG Signing

**Description**: Pre-filled commit message templates and GPG signature toggle.

**Why it matters**:
- Enforces consistent commit message format (conventional commits, project standards)
- GPG signing adds non-repudiation for compliance/security teams

**Implementation**:
- `.gitmessage` template file support (read from repo root)
- Settings UI for default template + custom templates per workspace
- Commit dialog:
  - Template selector dropdown
  - Text area with template pre-filled
  - Checkbox for "Sign commit" (requires GPG key)
- On commit, pass `--gpg-sign` flag if enabled

**Technical approach**:
- Add `git_config_get(key)` to read `.gitmessage` path
- New component: `apps/frontend/src/components/CommitDialog.tsx`
- Store GPG signing preference in workspace settings
- Use `git_commit()` with `--gpg-sign` flag in agent

**Dependencies**: None (GPG must be installed on user's machine)

---

### 2. Environment & Secrets Management

#### 2.1 `.env` File Editor

**Description**: Syntax-highlighted editor with validation and autocomplete for environment files.

**Why it matters**:
- `.env` files are critical but often edited carelessly
- Autocomplete from common vars (`NODE_ENV`, `API_URL`, etc.) prevents typos
- Validation catches missing required vars

**Implementation**:
- Detect `.env`, `.env.local`, `.env.[stage]` files in root
- New tab type: "Environment" (like Preview)
- Editor with:
  - Syntax highlighting (KEY=VALUE pairs, comments)
  - Autocomplete from a curated list + project history
  - Red underline for required-but-missing vars (read from `arc.env.schema.json` in repo)
  - Masking for sensitive values (show as `•••`)
- On save, reload related services (dev server, agent runtime)

**Technical approach**:
- Add `.env` language to CodeMirror 6 (simple: key=value + # comments)
- New component: `apps/frontend/src/components/EnvEditor.tsx`
- Store `envVars` in workspace state (in-memory, never persisted to DB)
- Add `env_validate()` command to check against `arc.env.schema.json`

**Dependencies**: CodeMirror 6 extensions (minimal)

---

#### 2.2 Visual Secret Rotation

**Description**: UI for rotating API keys and secrets with confirmation gates.

**Why it matters**:
- Frequent rotation is a security best practice
- Manual rotation is error-prone
- Logging which secrets are outdated helps catch stale configs

**Implementation**:
- Settings → Secrets pane showing:
  - Provider (OpenAI, Anthropic, Ollama, custom MCP keys)
  - Last rotated date + expiry (optional)
  - "Rotate" button per secret
- On rotate:
  - Show a modal: "Rotate [OpenAI API key]? This will invalidate the current key."
  - Require new key paste (or generate link to provider's key page)
  - Confirm + store in keyring
  - Log rotation event with timestamp

**Technical approach**:
- Extend `apps/frontend/src/components/Settings.tsx` with Secrets tab
- Use existing `secrets_set_api_key()` / `secrets_get_api_key()` infrastructure
- Add `secrets_rotate_log()` to persist rotation history (SQLite)
- Integration with `rust/ai-runtime` to reload providers on key change

**Dependencies**: None (uses existing secrets infrastructure)

---

#### 2.3 Environment-Aware Preview URLs

**Description**: Store multiple preview URLs per tab (dev/staging/prod) and switch between them.

**Why it matters**:
- Developers often test the same UI across environments
- Current preview only stores one URL; adding env switching adds flexibility
- Pairs well with environment editor

**Implementation**:
- Extend Preview component to show tabs for each environment (Dev, Staging, Prod)
- Store in SQLite: `preview_urls` table with columns `tab_id, environment, url`
- Environment picker in preview URL bar (dropdown next to "Detect ports")
- Keyboard shortcut (⌘1/2/3) to switch envs

**Technical approach**:
- Update `0007_preview_tabs.sql` migration to add `environment` column
- Modify Preview.tsx to render env tabs
- Add `setPreviewUrl(tabId, env, url)` to workspace store
- New Tauri command: `session_save_preview_url(tab_id, env, url)`

**Dependencies**: None (extends existing migration)

---

## Phase 2: Test Runner Integration (4-6 weeks)

### 3. Test Output Parser & Inline Results

**Description**: Parse test runner output (Jest, Vitest, cargo test, etc.) and display results inline in the editor.

**Why it matters**:
- Developers frequently run tests; feedback latency is a pain point
- Jumping from test output to failing code is manual today
- Visual indicators (pass/fail) reduce cognitive load

**Implementation**:
- Detect test commands in terminal input (via OSC 133 or keyword detection: `npm test`, `cargo test`, `vitest`)
- Parse output (regex + language-specific parsers):
  - Jest: `/FAIL.*/ (number) passed, (number) failed`
  - Cargo: `test result: (ok|FAILED)`
  - Vitest: similar to Jest
- Store results in memory: `{ file, line, status, error }`
- Gutter decorations in Editor:
  - ✅ green for passing tests
  - ❌ red for failing tests
  - ⏱ gray for skipped
- Click gutter icon to show error in tooltip

**Technical approach**:
- Add `test_parse_output()` helper in `rust/session-manager/` to run regexes on command output
- Extend `Command` model with `test_results` field
- New `useTestResults()` hook in Editor component
- Gutter markers via CodeMirror 6 decorations
- New Tauri command: `tests_parse_output(output, language)`

**Dependencies**: CodeMirror 6 (decorations, already used)

---

### 4. Quick-Jump to Failing Tests

**Description**: Keyboard shortcut to navigate to the next/previous failing test.

**Why it matters**:
- Reduces time jumping between terminal and editor
- Batch-fixing tests becomes faster

**Implementation**:
- ⌘↓ / ⌘↑ to navigate through failing tests
- Show test name in breadcrumb or status bar
- Auto-scroll editor to line

**Technical approach**:
- Store failing tests in a Zustand store (`state/tests.ts`)
- Add keyboard bindings in App.tsx
- Dispatch `onTestNavigate(index)` event

**Dependencies**: None

---

### 5. Watch Mode Auto-Rerun

**Description**: Automatically re-run tests when relevant files change, using the existing Watcher.

**Why it matters**:
- TDD workflows benefit from instant feedback
- Removes manual test command re-entry
- Pairs naturally with the filesystem watcher

**Implementation**:
- Settings toggle: "Auto-run tests on file change"
- On `fs://change/<watchId>`, check if changed file is a test or source file
- If so, re-run the last test command
- Show progress spinner in status bar + new results in gutter

**Technical approach**:
- Subscribe to `onFileChange()` in a dedicated hook
- Store `lastTestCommand` in workspace state
- Execute via `pty_write()` + parse output

**Dependencies**: Existing Watcher + file system watching

---

## Phase 3: Database & Data Tools (6-8 weeks)

### 6. SQLite Browser & Query Builder

**Description**: Built-in SQLite explorer with table browser, query editor, and export/import.

**Why it matters**:
- ARC already uses SQLite (arc.db); exposing it adds introspection value
- Common during development (debugging schema, checking persisted state)
- Eliminates need for external tools

**Implementation**:
- New sidebar pane: "Database" tab
- Left: Table list + right: Inspector/Query editor
- Features:
  - Browse tables (schema, row count, preview rows)
  - Write/execute SQL queries (with syntax highlighting)
  - Export table to CSV/JSON
  - Import CSV → new table
  - Index usage hints (EXPLAIN QUERY PLAN)

**Technical approach**:
- Add `db_query(sql)`, `db_tables()`, `db_export(table, format)` commands to Rust (wrap sqlx)
- New component: `apps/frontend/src/components/DatabaseBrowser.tsx`
- Use CodeMirror 6 for SQL editor with autocomplete

**Dependencies**: sqlx (already in session-manager), CodeMirror 6

---

### 7. PostgreSQL/MySQL Support via MCP

**Description**: Extend database browser to connect to external databases via MCP servers.

**Why it matters**:
- Many teams use cloud databases during development
- Adds a competitor feature to Insomnia/DBeaver
- MCP architecture already supports this

**Implementation**:
- Connect via existing `/mcp connect` flow
- MCP server must expose `db_query`, `db_tables` tools
- Reuse database browser UI for any connected database

**Technical approach**:
- Extend `DatabaseBrowser.tsx` to detect MCP db servers
- Route queries through `mcp_call_tool()` for external DBs

**Dependencies**: MCP ecosystem (user-provided servers)

---

## Phase 4: Agent & Workflow Extensions (8-12 weeks)

### 8. Custom Agent Templates

**Description**: UI for creating custom agents with pre-configured tools, prompts, and personas.

**Why it matters**:
- Different tasks benefit from different agent personas
- Reduces friction vs. typing long prompts
- Templates can be saved and shared within teams

**Implementation**:
- Settings → Custom Agents tab
- Editor to define:
  - Agent name + icon
  - System prompt (pre-filled templates: "Code Review", "Documentation", "Performance")
  - Tools to include (checkboxes over available tools)
  - Output format preference (markdown, JSON, etc.)
- Save as workspace artifact or user-global
- Use in chat via `/agent <name>` or agent picker

**Technical approach**:
- New Zustand store: `state/agents.ts`
- Extend `packages/agents/` with custom agent descriptor type
- Agent picker shows built-in + custom agents
- Pass custom prompt to agent runtime

**Dependencies**: None (extends agent system)

---

### 9. Code Review Agent Template

**Description**: Pre-built agent persona optimized for code review.

**Why it matters**:
- Code review is a frequent task (async reviews on PRs)
- Automated suggestions + guidance reduces junior dev review time
- Pairs with git diff introspection

**Implementation**:
- Pre-configured agent with:
  - System prompt biased toward code quality, security, tests, docs
  - Built-in tools: `git_diff`, `fs_read_file`, `fs_search`, `shell` (for running linters)
- On invocation with `/agent Review <PR#>` or `/agent Review (current branch)`:
  - Fetch diff via `git_diff()`
  - Suggest improvements (style, bugs, tests, docs)
  - Highlight risky changes
  - Propose specific edits

**Technical approach**:
- Template in `packages/agents/review-agent.ts`
- Triggered by chat command `/review <target>`

**Dependencies**: Existing agent runtime

---

### 10. Documentation Generator Agent

**Description**: Agent that auto-generates or updates docs from code.

**Why it matters**:
- Docs rot without automated help
- Auto-generating README, API docs, architecture diagrams saves time
- Pairs with memory system for context

**Implementation**:
- Agent persona: "Documentation Expert"
- On invocation `/agent Document <file or dir>`:
  - Read source files
  - Analyze comments, exports, types
  - Generate or update:
    - README.md
    - API docs (JSDoc/Rustdoc style)
    - Architecture diagram (Mermaid syntax)
  - Propose changes via `fs_edit` (approval-gated)

**Technical approach**:
- Template in `packages/agents/docs-agent.ts`
- Built-in tools: `fs_read_file`, `fs_edit`, `memory_search` (for context)

**Dependencies**: None

---

### 11. Performance Analysis Agent

**Description**: Agent that profiles code and suggests optimizations.

**Why it matters**:
- Performance is often an afterthought
- Automated suggestions catch low-hanging fruit
- Complements manual profiling

**Implementation**:
- On invocation `/agent Optimize <file or command>`:
  - Read code + detect patterns (N+1 loops, inefficient algorithms)
  - For Node/Python: run profiler (flame graphs via `shell`)
  - Suggest optimizations: memoization, batching, caching
  - Propose specific code edits

**Technical approach**:
- Template in `packages/agents/perf-agent.ts`
- Built-in tools: `fs_read_file`, `shell` (for profilers), `fs_edit`

**Dependencies**: None (profilers must be installed)

---

## Phase 5: UI & Layout (6-10 weeks)

### 12. Split Pane Layout System

**Description**: Multi-pane editor with draggable resizing and layout persistence.

**Why it matters**:
- Side-by-side editing is essential for refactors, comparisons
- Drag-drop resizing feels modern
- Matching VS Code patterns is expected

**Implementation**:
- Extend tab strip (already supports split tabs per CLAUDE.md) to pane-level resizing
- Features:
  - Drag edge between panes to resize
  - Right-click pane → "Close", "Maximize", "Swap sides"
  - Keyboard: ⌘⌥→ (move to right pane), ⌘⌥← (left)
  - Save/restore layout per workspace
- State: `{ left: [tab1, tab2], right: [tab3], sizes: [60%, 40%] }`

**Technical approach**:
- Extend `apps/frontend/src/components/Editor.tsx` with split logic
- New component: `PaneGroup.tsx` (renders draggable divider)
- Store layout in `workspace.layout` (persisted to SQLite)
- Use `react-split-pane` library or build custom resizer

**Dependencies**: Maybe `react-split-pane` or custom CSS Grid + mouse handlers

---

### 13. Workspace Snapshots

**Description**: Save and restore entire workspace state (editor layout, open tabs, chat history, agent runs).

**Why it matters**:
- Context-switching between projects is tedious
- Teams benefit from shareable "project setup" snapshots
- Faster onboarding for new contributors

**Implementation**:
- Settings → Workspaces tab
- "Save Snapshot" button captures:
  - Tab list + content (if small)
  - Editor layout
  - Chat history (optional, toggle)
  - File tree scroll position
  - Active pane
- "Load Snapshot" restores all state
- Export/import snapshots (JSON) for sharing

**Technical approach**:
- Extend `workspace.ts` store with snapshot methods
- New Tauri command: `session_save_snapshot(name)` / `session_load_snapshot(name)`
- Store in SQLite: `workspaces` table (already exists, extend with snapshot data)

**Dependencies**: None

---

## Phase 6: Terminal & Recording (8-12 weeks)

### 14. Terminal Recording & Replay

**Description**: Record terminal sessions for playback, replay at speed, and export clips.

**Why it matters**:
- Async knowledge-sharing (demos, onboarding videos)
- Training materials
- Debugging complex multi-step workflows

**Implementation**:
- Toggle "Record" in terminal toolbar
- Capture:
  - Keystrokes + timing (via pty input stream)
  - Output chunks + timestamps (already via xterm.js)
  - OSC 133 command markers
- Playback UI:
  - Play/pause, speed control (0.5x–2x)
  - Scrubber timeline
  - Trim start/end frames
- Export as:
  - JSON (importable recording file)
  - MP4/WebM (ffmpeg wrapper, optional)
  - Markdown (list of commands with output)

**Technical approach**:
- Extend PTY manager to log keystrokes + timestamps
- New Zustand store: `state/recording.ts`
- New component: `apps/frontend/src/components/TerminalRecorder.tsx`
- Add `pty_record_start()` / `pty_record_stop()` Tauri commands
- Use xterm.js replay API

**Dependencies**: ffmpeg (optional, for video export), xterm.js

---

### 15. Quick Actions Palette (⌘K)

**Description**: Searchable command palette combining files, commands, agent runs, and recent actions.

**Why it matters**:
- Keyboard-driven workflows are faster
- Reduces toolbar/menu hunting
- Single entry point for power users (like VS Code's ⌘P)

**Implementation**:
- ⌘K opens a searchable modal with tabs:
  - Files (existing `⌘P`)
  - Commands (terminal history, git commands)
  - Agents (recent agent runs, custom agents)
  - Actions (switch workspace, open settings, record session)
- Fuzzy search across all
- Keyboard nav (↑/↓ to select, Enter to execute)

**Technical approach**:
- Extend existing file search (already uses tantivy)
- New component: `apps/frontend/src/components/QuickActionsModal.tsx`
- Combine results from:
  - File index
  - `command_history` (SQLite)
  - `agent_runs` (SQLite)
  - Hard-coded action list

**Dependencies**: None (reuses existing search)

---

## Phase 7: Developer Tools (10-14 weeks)

### 16. Dependency Vulnerability Scanner

**Description**: Automated scanning of package.json / Cargo.toml with severity reporting and fix suggestions.

**Why it matters**:
- Security is critical; developers need fast feedback
- Tool chain reduces context-switching to external services
- Audit results can be persisted for CI integration

**Implementation**:
- Background scan on file change (debounced)
- Integration with:
  - npm audit (JavaScript)
  - cargo audit (Rust)
  - Optional: Snyk API (if user provides API key)
- UI:
  - Status bar badge (e.g., "3 vulns")
  - Sidebar pane: vulnerability list
  - Details: severity, version range, fix suggestion
  - "Apply Fix" → `npm install <fixed-version>` or manual edit suggestion
- Cache results (hourly) to avoid repeated API calls

**Technical approach**:
- New Zustand store: `state/vulnerabilities.ts`
- Agent tool: `audit_dependencies()` (wrapper around `npm audit` + `cargo audit`)
- Trigger on `fs://change` for `package.json` / `Cargo.toml`
- New component: `apps/frontend/src/components/VulnerabilityScanner.tsx`

**Dependencies**: npm/cargo (built-in), optional: Snyk SDK

---

### 17. Dependency Graph Viewer

**Description**: Visualize project dependencies as an interactive graph.

**Why it matters**:
- Understand coupling and modularity
- Identify circular dependencies
- Aids refactoring decisions

**Implementation**:
- Parse `package.json` + `Cargo.toml` recursively
- Build graph: node = module, edge = import
- Render as interactive visualization:
  - Force-directed layout (D3.js or similar)
  - Color by size/depth
  - Click node to jump to file
  - Highlight dependencies of selected node

**Technical approach**:
- New command: `fs_dependency_graph()` (parse imports + exports)
- New component: `apps/frontend/src/components/DependencyGraph.tsx`
- Use D3.js or Cytoscape.js for visualization
- Sidebar integration

**Dependencies**: D3.js or Cytoscape.js

---

## Phase 8: Cloud & Collaboration (12+ weeks)

### 18. Workspace Sharing & Cloud Sync

**Description**: Save workspaces to cloud (GitHub, S3, or custom) and share with teammates.

**Why it matters**:
- Onboarding new team members (share project setup)
- Distributed teams benefit from async context sharing
- Integrates with modern DevOps workflows

**Implementation**:
- Save snapshot to GitHub (private gist or repo branch)
- Or custom S3 endpoint
- Shareable link + QR code
- On teammate's machine: `/arc load-snapshot <link>` restores state

**Technical approach**:
- Extend `session_save_snapshot()` with optional `--cloud` flag
- Tauri commands: `cloud_save_snapshot()`, `cloud_load_snapshot(url)`
- Auth via OAuth (GitHub) or API keys (S3)
- Store cloud URLs in workspace metadata

**Dependencies**: GitHub API SDK or AWS SDK, OAuth

---

### 19. Real-time Collaboration (Future)

**Description**: Shared editor + terminal sessions (like Live Share).

**Why it matters**:
- Pair programming without switching tools
- Code review + live guidance
- Training sessions

**Implementation** (high-level):
- WebSocket server for broadcasting changes
- Cursor positions, selection ranges, text deltas
- Conflict-free merge (CRDT or OT)
- Presence indicators

**Technical approach**:
- Add `arc-collab-server` crate (Axum + tokio)
- Client-side: extend Zustand stores to broadcast changes
- Security: auth + permissions model

**Dependencies**: High (real-time DB, auth, networking)

---

## Low-Priority / Exploratory

### 20. Syntax Highlighting Improvements
- Better language support (e.g., add Solidity, HCL)
- Custom themes editor
- Theme export/sharing

### 21. Plugin/Extension System
- Allow users to write custom tools
- Package + distribute plugins
- Hook system for lifecycle events

### 22. Performance Metrics Dashboard
- Memory/CPU usage of ARC itself
- PTY responsiveness stats
- Agent runtime benchmarks

### 23. AI-Powered Refactoring Assistant
- Suggest code improvements (style, patterns, modernization)
- Batch apply suggestions

### 24. Accessibility Improvements
- Screen reader support
- High contrast theme
- Keyboard-only navigation

---

## Implementation Strategy

### Prioritization Criteria
1. **Impact**: How much does it improve developer workflow?
2. **Effort**: Is it realistic to build in 2-4 weeks?
3. **Leverage**: Does it reuse existing infrastructure (Watcher, agent, MCP)?
4. **Dependencies**: External libs, services, or user setup required?

### Recommended Order
1. **Weeks 1-2**: Git UI (branch switcher + staging pane)
2. **Weeks 3-4**: Environment editor + test parser
3. **Weeks 5-6**: Database browser + quick actions palette
4. **Weeks 7-8**: Split pane layout + workspace snapshots
5. **Weeks 9-10**: Agent templates + code review agent
6. **Weeks 11+**: Recording, dependency scanner, cloud sync

### Success Metrics
- **Reduced friction**: Time to common tasks (git switch, test run, env edit)
- **User feedback**: Feature adoption in daily workflows
- **Code health**: Test coverage, type safety, performance

---

## Notes for Contributors

- **File structure**: New components go in `apps/frontend/src/components/`, new commands in `apps/desktop/src/commands/`, new Rust crates in `rust/`
- **Testing**: Unit tests for Rust (cargo), component tests for React (vitest or jest)
- **Documentation**: Update CLAUDE.md status table + docs/architecture.md when landing major features
- **Backwards compatibility**: Migrations for database schema changes (follow `0001_`, `0002_` pattern in `rust/session-manager/migrations/`)
- **Keyboard shortcuts**: Document in `apps/frontend/src/lib/keybindings.json` + README
