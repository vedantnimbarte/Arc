# Security — ARC

ARC is a desktop developer workspace (terminal, editor, git, SSH). This document covers how it
handles credentials and local data, and how to report a vulnerability.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or contact the maintainer
listed there, rather than filing a public issue. Include reproduction steps and the affected
version. We aim to acknowledge reports promptly and coordinate a fix before public disclosure.

## Credential storage

ARC stores secrets in the **OS credential vault**, never in plaintext on disk:

- **macOS** — Keychain
- **Windows** — Credential Manager
- **Linux** — Secret Service (libsecret)

Secrets kept there today:

- **SSH key passphrases** — under the service `dev.arc.terminal.ssh`.
- **GitHub personal access token** (for the PR panel) — under `dev.arc.terminal.git-host`.

SSH private keys themselves are referenced by on-disk path (e.g. `~/.ssh/id_ed25519`); ARC does
not copy their contents into its own storage.

## Workspace trust

A repository can ship a `.arc/config.toml` that injects environment variables into terminals
spawned inside that workspace. Because that runs repository-supplied values on your machine, ARC
prompts for **trust** before applying an env-carrying config, and remembers your decision per
root. Configs that only set a theme or workspace name are harmless and never prompt. Only trust
folders you obtained from a source you trust.

## Local data

ARC persists workspace, tab, and command-history state to a local SQLite database:

- **macOS** — `~/Library/Application Support/arc/arc.db`
- **Linux** — `~/.local/share/arc/arc.db`
- **Windows** — `%APPDATA%\arc\arc.db`

The full-text search index lives alongside it under `arc/index/`. This data is **not encrypted
at rest** — it relies on your OS user account and disk encryption. To clear it, quit ARC and
delete the `arc/` directory in the location above.

Command history may capture command text and a short output excerpt (when OSC 133 shell
integration is present). Avoid running commands that echo secrets if you don't want them stored;
clear the database to remove any that were.

## Best practices

- Keep SSH private keys outside any workspace you might share or commit.
- Scope GitHub tokens to only the repositories and permissions you need, and rotate them
  periodically.
- Add credential files and `.env` files to `.gitignore`.
- Only trust `.arc/config.toml` from repositories you control or trust.
