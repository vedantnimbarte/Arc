# Development Guide — ARC

Welcome, contributor! This guide covers local setup, code conventions, and step-by-step walkthroughs for common tasks.

**Quick links:**
- Installation: [INSTALLATION.md](INSTALLATION.md)
- Architecture: [ARCHITECTURE.md](ARCHITECTURE.md)
- Design decisions: [docs/decisions.md](docs/decisions.md)

---

## Getting Started

### Setup

Follow [INSTALLATION.md](INSTALLATION.md) to install prerequisites and clone the repo:

```bash
git clone https://github.com/anthropics/arc.git
cd arc
pnpm install
```

### Running for Development

#### Option 1: Full App (Tauri)

```bash
pnpm tauri:dev
```

Starts both Rust and frontend. Hot reload enabled for React; Rust changes require a restart.

#### Option 2: Frontend Only (Browser)

```bash
pnpm dev
```

Faster iteration if you're working on UI. Tauri/Rust features are stubbed.

#### Option 3: Specific Commands

```bash
pnpm typecheck          # Type-check all TypeScript
cargo check --workspace # Type-check all Rust
pnpm lint               # Lint TypeScript (ESLint)
pnpm format             # Format code (Prettier)
```

### Logs & Debugging

**Rust logs:**
```bash
# Control verbosity
RUST_LOG=arc=trace pnpm tauri:dev
RUST_LOG=arc=debug pnpm tauri:dev (default)
RUST_LOG=arc=info pnpm tauri:dev
```

**Frontend logs:**
- Open DevTools in the Tauri window: `Ctrl+Shift+I` / `Cmd+Option+I`
- Or use the browser console in `pnpm dev` mode

**Tauri window DevTools:**
- Available by default in dev mode
- Can be disabled in `tauri.conf.json` for production

---

## Code Conventions

### Tauri Command Naming

Commands follow `<area>_<verb>` snake_case:

```rust
// ✅ Good
pty_spawn()
fs_read_file()
llm_stream()
session_save_tabs()

// ❌ Bad
spawnPty()
readFile()
streamLLM()
```

### Event Topic Naming

Events use `<area>://<verb>/<id>`:

```rust
// ✅ Good
pty://data/<tabId>
llm://chunk/<requestId>
fs://change/<watchId>
agent://event/<runId>

// ❌ Bad
pty-data
llm_chunk
fs-change
```

### IPC & Typed Wrappers

**All invoke/listen calls must go through `apps/frontend/src/lib/tauri.ts`.**

Components never call `invoke()` or `listen()` directly. Instead, they import typed helpers:

```typescript
// ✅ Good (in a component)
import { ptySpawn, onPtyData } from '@/lib/tauri'

const tabId = await ptySpawn({ shell: 'bash', cwd: '/tmp', rows: 24, cols: 80 })
onPtyData(tabId, (event) => term.write(event.bytes))

// ❌ Bad (never do this in components)
import { invoke, listen } from '@tauri-apps/api/core'
const tabId = await invoke('pty_spawn', { opts: {...} })
```

### Rust Module Split

Each Rust crate owns **one** problem:

| Crate | Owns |
|-------|------|
| `arc-pty` | PTY process management — nothing else |
| `arc-ai-runtime` | LLM streaming + embeddings — not agent logic, not UI |
| `arc-filesystem` | File ops, watch, index, search — not persistence, not git |
| `arc-git` | Git introspection — not filesystem, not persistence |
| `arc-session-manager` | Persistence layer — not business logic, not command dispatch |
| `arc-agent-runtime` | Agent loop + tool execution — not persistence, not file watching |

The desktop app (`apps/desktop`) is a **thin composition layer** that wires these together. No domain logic should live there.

### Frontend Component Structure

Colocation is preferred—keep related files together:

```
apps/frontend/src/components/
├── Terminal.tsx         # One component, one file
├── Editor.tsx
├── FileTree/            # Complex component = directory
│   ├── FileTree.tsx
│   ├── FileTreeNode.tsx
│   └── fileTreeUtils.ts
└── Chat/
    ├── ChatPanel.tsx
    ├── Composer.tsx
    └── MessageList.tsx
```

No forced separation of "container" vs "presentational" components.

### Zustand Store Pattern

Each store is a single file with a clear shape and actions:

```typescript
// apps/frontend/src/state/workspace.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface WorkspaceState {
  tabs: Tab[]
  activeTabId: string | null
  sessionId: string
  // ...actions below
  addTab: (tab: Tab) => void
  setActiveTab: (id: string) => void
  hydrate: () => Promise<void>
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,
      sessionId: '',
      addTab: (tab) => set((state) => ({ tabs: [...state.tabs, tab] })),
      setActiveTab: (id) => set({ activeTabId: id }),
      hydrate: async () => {
        // Load from SQLite, then set state
        const state = await sessionLoad()
        set({
          tabs: state.tabs,
          activeTabId: state.activeTabId,
          sessionId: state.sessionId,
        })
      },
    }),
    { name: 'arc-workspace' }, // localStorage key
  ),
)
```

Stores **do not** reach into each other. Cross-store composition happens at the component level:

```typescript
// ✅ Good (in a component)
const { tabs } = useWorkspace()
const { messages } = useChat()
// Use both here

// ❌ Bad (inside a store action)
// useChat().addMessage(...)  // Don't call other stores
```

### TypeScript Types

Use TypeScript's `interface` for public contracts and `type` for internal/utility types:

```typescript
// Public contract
interface Tab {
  id: string
  title: string
  kind: 'terminal' | 'editor'
}

// Internal utility
type TabsById = Record<string, Tab>
```

Non-obvious types should have JSDoc comments:

```typescript
// The set of pending tool approvals, keyed by approval ID.
// Resolved when the user clicks Approve/Deny or closes the popover.
interface AgentApprovals {
  [approvalId: string]: Arc<Notify>
}
```

### Styling

**Tailwind dark-first with semantic tokens:**

```tsx
// ✅ Good
<div className="bg-base fg-base border border-border rounded-window shadow-panel">
  <button className="bg-accent fg-base hover:opacity-90">Click me</button>
</div>

// ❌ Bad (hardcoded hex colors)
<div style={{ backgroundColor: '#161618', color: '#d5d5d6' }}>
  <button style={{ backgroundColor: '#c8cad0' }}>Click me</button>
</div>

// ❌ Bad (using arbitrary colors)
<div className="bg-purple-700 text-red-300">
  This doesn't match the app's palette
</div>
```

Colors are defined in `apps/frontend/tailwind.config.ts`. Use the semantic tokens there.

### Comments & Docstrings

Default to **no comments**. Code should be self-documenting via clear names.

**Add a comment only when:**
- The WHY is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug)
- Future readers would be surprised by the implementation

**Never comment WHAT the code does**—well-named variables and functions already say that.

```typescript
// ✅ Good
const MAX_RETRIES = 3
// Retrying up to this limit accommodates transient DNS failures in flaky networks
// without blocking agent runs indefinitely; see https://github.com/.../issues/123
for (let i = 0; i < MAX_RETRIES; i++) {
  try {
    return await fetchWorkspace()
  } catch (e) {
    if (i === MAX_RETRIES - 1) throw e
  }
}

// ❌ Bad
// Loop 3 times
for (let i = 0; i < 3; i++) {
  // Try to fetch
  try {
    // Return the result
    return await fetchWorkspace()
  } catch (e) {
    // If last iteration, throw
    if (i === 2) throw e
  }
}
```

---

## Common Tasks

### Task 1: Add a New Tauri Command

Example: Add a command to calculate file hash.

#### Step 1: Implement in Rust

Create or edit `apps/desktop/src/commands/fs.rs`:

```rust
use tauri::command;
use sha2::{Sha256, Digest};

#[command]
pub async fn fs_hash_file(path: String) -> Result<String, String> {
    let content = std::fs::read(&path)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;
    
    let mut hasher = Sha256::new();
    hasher.update(&content);
    let hash = format!("{:x}", hasher.finalize());
    
    Ok(hash)
}
```

#### Step 2: Register in Tauri

Edit `apps/desktop/src/main.rs`:

```rust
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // ... existing commands ...
            commands::fs::fs_hash_file,  // Add this line
        ])
        // ... rest of setup ...
}
```

#### Step 3: Add TypeScript Wrapper

Edit `apps/frontend/src/lib/tauri.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core'

export const fsHashFile = (path: string): Promise<string> =>
  invoke('fs_hash_file', { path })
```

#### Step 4: Use in a Component

```typescript
import { fsHashFile } from '@/lib/tauri'

export function FileHash({ path }: { path: string }) {
  const [hash, setHash] = useState<string | null>(null)
  
  useEffect(() => {
    fsHashFile(path).then(setHash).catch(console.error)
  }, [path])
  
  return <div>Hash: {hash || 'Loading...'}</div>
}
```

---

### Task 2: Add a New Frontend Component

Example: Add a "Copy Path" button to the file tree.

#### Step 1: Create the Component

`apps/frontend/src/components/FileTree/CopyPathButton.tsx`:

```typescript
import { Copy } from 'lucide-react'

interface CopyPathButtonProps {
  path: string
  onCopy?: () => void
}

export function CopyPathButton({ path, onCopy }: CopyPathButtonProps) {
  const handleClick = () => {
    navigator.clipboard.writeText(path)
    onCopy?.()
  }
  
  return (
    <button
      onClick={handleClick}
      className="p-1 rounded hover:bg-panel transition"
      title="Copy path to clipboard"
    >
      <Copy size={16} className="fg-muted" />
    </button>
  )
}
```

#### Step 2: Use in FileTree

In `FileTree.tsx` or `FileTreeNode.tsx`:

```typescript
import { CopyPathButton } from './CopyPathButton'

export function FileTreeNode({ file }: { file: FileEntry }) {
  return (
    <div className="flex items-center gap-2">
      <span>{file.name}</span>
      <CopyPathButton path={file.path} />
    </div>
  )
}
```

---

### Task 3: Add a New Zustand Store

Example: Add a "layout" store for UI state (sidebar width, chat height, etc.).

`apps/frontend/src/state/layout.ts`:

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface LayoutState {
  sidebarWidth: number
  chatHeight: number
  chatCollapsed: boolean
  setSidebarWidth: (width: number) => void
  setChatHeight: (height: number) => void
  toggleChat: () => void
}

export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarWidth: 250,
      chatHeight: 300,
      chatCollapsed: false,
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      setChatHeight: (height) => set({ chatHeight: height }),
      toggleChat: () => set((state) => ({ chatCollapsed: !state.chatCollapsed })),
    }),
    { name: 'arc-layout' },
  ),
)
```

Use it in a component:

```typescript
import { useLayout } from '@/state/layout'

export function App() {
  const { sidebarWidth, setSidebarWidth } = useLayout()
  
  return (
    <div className="flex">
      <div style={{ width: sidebarWidth }}>
        {/* sidebar */}
      </div>
      <ResizeHandle onResize={(w) => setSidebarWidth(w)} />
    </div>
  )
}
```

---

### Task 4: Add a New Rust Crate

Example: Add a `arc-search` crate for advanced search.

#### Step 1: Create the Crate

```bash
cargo init --lib rust/search
```

#### Step 2: Add to Workspace

Edit `rust/Cargo.toml`:

```toml
[workspace]
members = [
    # ... existing ...
    "search",
]
```

#### Step 3: Add to Desktop Dependencies

Edit `apps/desktop/Cargo.toml`:

```toml
[dependencies]
arc-search = { path = "../rust/search" }
```

#### Step 4: Use in Desktop Commands

`apps/desktop/src/commands/search.rs`:

```rust
use arc_search::{SearchEngine, SearchQuery};

#[tauri::command]
pub async fn search_advanced(query: SearchQuery) -> Result<Vec<SearchResult>, String> {
    let engine = SearchEngine::new();
    engine.search(query).await.map_err(|e| e.to_string())
}
```

---

## Testing

Currently, ARC doesn't have automated tests. Manual verification is expected before PRs.

### Pre-Submission Checklist

```bash
# 1. Type-check everything
pnpm typecheck
cargo check --workspace

# 2. Lint & format
pnpm lint
pnpm format

# 3. Test locally
pnpm tauri:dev
# Test your feature manually

# 4. Test in release mode
pnpm tauri:build
# Run the built app and test again

# 5. Review git diff
git diff HEAD
# Ensure no unintended changes
```

### Manual Testing Tips

- **Terminal:** Type commands, resize, switch shells
- **Editor:** Open large files, test syntax highlighting
- **Chat:** Send messages, verify streaming works
- **Agent:** Run `/agent <goal>` and approve/deny tool calls
- **File search:** `Ctrl+P`, search for files
- **Settings:** Change provider, API key, shell, keybindings

---

## Keyboard Shortcuts

Default bindings are in `apps/frontend/src/state/shortcuts.ts`:

```typescript
export const DEFAULT_BINDINGS = {
  'newTerminal': 'Ctrl+T',
  'settings': 'Ctrl+,',
  'toggleChat': 'Ctrl+J',
  'searchFiles': 'Ctrl+P',
  'commandHistory': 'Ctrl+R',
  'agentPicker': 'Ctrl+/',
  'toggleSidebar': 'Ctrl+B',
  // ... more
}
```

Users can override via Settings. The `actionFor(e)` helper matches a keyboard event to an action.

To **add a new shortcut:**

1. Add to `DEFAULT_BINDINGS` in `shortcuts.ts`
2. Implement the action handler in `App.tsx` or the component that handles it
3. Document in the Shortcuts dialog

---

## Contributing Process

1. **Fork the repo** (if you're an external contributor)
2. **Create a branch:** `git checkout -b feature/your-feature`
3. **Make changes** following the conventions above
4. **Run checks:** `pnpm typecheck && cargo check --workspace && pnpm lint`
5. **Commit:** Use clear, concise commit messages (see below)
6. **Push:** `git push origin feature/your-feature`
7. **Open a PR** with a summary of what changed and why
8. **Address review comments** iteratively

### Commit Message Style

Use the format: `<type>: <description>`

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation only
- `refactor:` — Code refactoring (no feature change)
- `perf:` — Performance improvement
- `test:` — Tests (when we have them)
- `chore:` — Build, dependencies, etc.

Example:
```
feat: add file hash calculation command

Add fs_hash_file Tauri command to compute SHA-256 hashes of files.
Useful for integrity checking and deduplication in the agent.

- Rust: implemented in fs.rs with sha2 dependency
- TS: typed wrapper in lib/tauri.ts
- Component example: FileHash.tsx

Closes #123
```

---

## Architecture Decisions

Before making large architectural changes, read [docs/decisions.md](docs/decisions.md) to understand the existing rationale. Consider:

- **Why Tauri?** It lets us ship a real PTY without web-only constraints.
- **Why Zustand?** Simple, fine-grained reactivity, minimal boilerplate.
- **Why separate crates?** Each crate owns one problem, testable in isolation.
- **Why TypeScript on the frontend?** Type safety at the IPC boundary, editor support.

---

## Resources

- [Tauri docs](https://tauri.app/v2/guides/)
- [React docs](https://react.dev/)
- [TypeScript docs](https://www.typescriptlang.org/docs/)
- [Zustand docs](https://docs.pmnd.rs/zustand/)
- [Rust book](https://doc.rust-lang.org/book/)
- [Tailwind docs](https://tailwindcss.com/docs)

---

## Getting Help

- **Setup issues?** Check [INSTALLATION.md#troubleshooting](INSTALLATION.md#troubleshooting)
- **Architectural questions?** See [ARCHITECTURE.md](ARCHITECTURE.md)
- **Confused about code conventions?** Grep for similar examples in the codebase
- **Want to discuss a big change?** Open an issue first before implementing

---

## Summary

- Follow conventions: `<area>_<verb>`, semantic Tailwind tokens, no hardcoded colors
- Always use typed IPC wrappers in `tauri.ts`; don't call `invoke()` directly in components
- Each Rust crate owns one problem
- Zustand stores don't communicate; composition happens at the component level
- Type-check and lint before submitting PRs
- Comment the WHY, not the WHAT

Happy coding! 🚀
