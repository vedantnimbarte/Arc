# Contributing to ARC

Thank you for your interest in contributing to ARC! We welcome contributions from the community. This document provides guidelines and instructions for getting started.

## Code of Conduct

We are committed to providing a welcoming and inclusive environment for all contributors. Please be respectful and professional in all interactions.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/arc.git
   cd arc
   ```
3. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **Install dependencies**:
   ```bash
   pnpm install
   ```

## Development Workflow

### Setting Up Your Environment

Follow the [DEVELOPMENT.md](DEVELOPMENT.md) guide for:
- Local development setup
- Running tests
- Code conventions
- Adding new features

### Running the App

**Full desktop app (Tauri + React):**
```bash
pnpm tauri:dev
```

**Frontend only (browser):**
```bash
pnpm dev
```

### Code Quality Checks

Before submitting a PR, ensure all checks pass:

```bash
# Type-check TypeScript
pnpm typecheck

# Check Rust compilation
cargo check --workspace

# Lint and format
pnpm lint
pnpm format
```

## Making Changes

### Commit Messages

Use semantic commit messages following this format:
- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `refactor:` — Code refactoring without feature changes
- `test:` — Adding or updating tests
- `chore:` — Build, CI, or tooling changes
- `perf:` — Performance improvements

Example:
```
feat: add vector search for memory entries

Implement cosine similarity search for workspace notes using
OpenAI/Ollama embeddings stored in SQLite.
```

### Architecture & Code Conventions

- Prefer editing existing files over creating new ones
- New crates should be added to `Cargo.toml` workspace members and `pnpm-workspace.yaml`
- When adding Tauri commands, update both `apps/desktop/src/commands/<area>.rs` AND `apps/frontend/src/lib/tauri.ts`
- Use Tailwind classes for styling (avoid hardcoded hex colors)
- Use Zustand stores in `apps/frontend/src/state/*` for state management
- Write minimal comments; only explain the WHY when non-obvious

See [docs/architecture.md](docs/architecture.md) and [CLAUDE.md](CLAUDE.md) for deeper guidance.

## Submitting a Pull Request

1. **Push your branch** to your fork
2. **Create a Pull Request** with a clear title and description
   - Link any related issues
   - Describe what changed and why
   - Include test coverage if applicable
3. **Address feedback** from reviewers
4. **Keep your branch updated** with main if there are conflicts

### PR Title & Description Guidelines

**Title:** Concise, under 70 characters
- ✅ `feat: add vector search to memory`
- ❌ `update memory stuff with search`

**Description:** Include:
- What problem does this solve?
- How does it work?
- Any breaking changes?
- Testing approach

Example:
```
## Summary
Adds vector-based search for memory entries using embeddings.
Allows fuzzy semantic search in addition to keyword FTS.

## Testing
- [x] Unit tests for embedding generation
- [x] Integration tests with SQLite
- [x] Manual testing in app

## Checklist
- [x] Type-checks pass
- [x] No linting errors
- [x] Commits are clean
```

## Areas for Contribution

### High-Priority

- **Testing** — More unit and integration tests
- **Documentation** — Improving guides and API docs
- **Bug fixes** — Issues tagged `good-first-issue` or `bug`
- **Performance** — Optimization opportunities (profile first!)

### Medium-Priority

- **MCP Integrations** — New MCP server examples
- **Agent Personas** — New agent types or prompt improvements
- **Shell Support** — Additional shell integrations
- **Keyboard Shortcuts** — Custom keybinding presets

### Phase 2+ (Planned)

- Docker/Server deployment
- Plugin system
- Additional AI providers
- Advanced debugging tools

## Reporting Issues

Use GitHub Issues to report bugs or suggest features:

1. **Search** existing issues first
2. **Be specific** — Include steps to reproduce
3. **Environment** — Mention your OS, node version, Rust version
4. **Logs** — Attach relevant error messages or screenshots

Example:
```
## Bug: Terminal not resizing on window change
**Platform:** Windows 11
**Node:** 20.11.0
**Rust:** 1.75.0

### Steps to reproduce
1. Open ARC
2. Resize the window
3. Terminal content doesn't reflow

### Expected
Terminal should resize to fit the new window size

### Actual
Terminal content is clipped
```

## Questions?

- **Setup issues?** Check [INSTALLATION.md](INSTALLATION.md#troubleshooting)
- **Architecture questions?** See [docs/architecture.md](docs/architecture.md)
- **Code style?** Review [DEVELOPMENT.md](DEVELOPMENT.md)
- **Licensing questions?** See [LICENSE](LICENSE)

## Licensing

By contributing to ARC, you agree that your contributions will be licensed under the MIT License. See [LICENSE](LICENSE) for details.

---

Thank you for making ARC better! 🚀
