# Installing ARC

Grab the installer for your platform from the
[latest release](https://github.com/vedantnimbarte/Arc/releases/latest).

| Platform | File |
|----------|------|
| **Windows** | `ARC_x.y.z_x64-setup.exe` (or `.msi`) |
| **macOS** (Apple Silicon) | `ARC_x.y.z_aarch64.dmg` |
| **Linux** (Debian/Ubuntu) | `ARC_x.y.z_amd64.deb` |
| **Linux** (Fedora/RHEL) | `ARC-x.y.z-1.x86_64.rpm` |
| **Linux** (any) | `ARC_x.y.z_amd64.AppImage` |

## First run: the security warning

**ARC's installers are not code-signed.** Signing certificates cost money per year
from Apple and from a Windows CA, and this project doesn't have them yet. Both
operating systems will therefore warn you the first time you run it.

That warning means "nobody paid a certificate authority to vouch for this binary."
It does not mean the binary was tampered with — see [Verifying a
download](#verifying-a-download) below if you want to check that yourself.

### macOS

Gatekeeper will say ARC "cannot be opened because it is from an unidentified
developer," or that it is damaged.

Right-click (or Control-click) **ARC.app** in Applications and choose **Open**,
then **Open** again in the dialog. The choice is remembered; normal launching
works from then on.

If macOS insists the app is damaged, the quarantine attribute needs clearing:

```bash
xattr -dr com.apple.quarantine /Applications/ARC.app
```

### Windows

SmartScreen will show "Windows protected your PC."

Click **More info**, then **Run anyway**.

### Linux

No warning — Linux doesn't gate unsigned binaries this way.

```bash
sudo apt install ./ARC_x.y.z_amd64.deb     # Debian / Ubuntu
sudo rpm -i ARC-x.y.z-1.x86_64.rpm         # Fedora / RHEL

chmod +x ARC_x.y.z_amd64.AppImage          # AppImage: mark executable first
./ARC_x.y.z_amd64.AppImage
```

The AppImage needs FUSE. On Ubuntu 22.04+: `sudo apt install libfuse2`.

## In-app updates

ARC checks for a new release on launch and offers it in a corner card. Unlike the
installers, **every update is verified before it runs**: each downloaded bundle
must carry a minisign signature matching the public key baked into the build, and
an unsigned or mismatched bundle is rejected rather than installed. Turn the check
off in **Settings → About**.

That verification is independent of the code-signing above, which is why updates
are protected even though first-run isn't.

## Verifying a download

Every release ships a `.sig` file next to each updater artifact, signed with the
project's minisign key. To check one by hand you need
[minisign](https://jedisct1.github.io/minisign/) and the public key from
`apps/desktop/tauri.conf.json`:

```bash
minisign -Vm ARC_x.y.z_amd64.AppImage -P <pubkey from tauri.conf.json>
```

The `.dmg` has no `.sig` — macOS updates ship as `ARC_aarch64.app.tar.gz`, and
that is the artifact that carries one.

## Requirements

| Platform | Needs |
|----------|-------|
| **macOS** | 12 or newer, Apple Silicon |
| **Windows** | 10 or newer, with WebView2 (the installer pulls it in if missing) |
| **Linux** | gtk3 and WebKit2GTK 4.1 |

## Building from source

See [Quick Start](README.md#quick-start) in the README — Node 20+, pnpm 9.x, and
Rust 1.80+, then `pnpm install && pnpm tauri:dev`.
