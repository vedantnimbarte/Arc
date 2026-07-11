# Contributing to ARC

Thanks for your interest in contributing! This document covers how to get set up and submit
changes.

## Code of Conduct

Please be respectful and professional in all interactions.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork:
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

## Running the App

```bash
pnpm tauri:dev      # Full desktop app (Tauri + React)
pnpm dev            # Frontend only (browser; PTY/fs stubbed)
```

## Before submitting a PR

Ensure these pass:

```bash
pnpm typecheck             # Type-check all TypeScript
cargo check --workspace    # Check all Rust crates
pnpm test                  # Run the Vitest suite
```

## Commit Messages

Use semantic prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`.

Example:
```
feat(git): add cherry-pick onto a target branch
```

## Code Conventions

- Prefer editing existing files over creating new ones.
- New crates go in `Cargo.toml` workspace members and `pnpm-workspace.yaml`.
- When adding a Tauri command, update both `apps/desktop/src/commands/<area>.rs` AND
  `apps/frontend/src/lib/tauri.ts` so the typed wrapper stays in sync.
- Style with Tailwind classes (avoid hardcoded hex colors).
- Use Zustand stores in `apps/frontend/src/state/*` for state.
- Keep comments minimal — explain the *why* when it isn't obvious.

## Submitting a Pull Request

1. Push your branch to your fork.
2. Open a PR with a concise title (semantic prefix, under ~70 chars) and a description covering
   what changed, why, and how you tested it. Link any related issues.
3. Address review feedback and keep your branch up to date with `main`.

## Reporting Issues

Use GitHub Issues. Search existing issues first, then include steps to reproduce and your
environment (OS, Node version, Rust version) plus any relevant logs.

## Licensing

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
