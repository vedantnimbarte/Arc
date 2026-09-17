# Code signing

ARC's release workflow (`.github/workflows/release.yml`) signs each platform
**as soon as that platform's secrets exist** in the repo
(**Settings → Secrets and variables → Actions**). Until then, builds stay
unsigned and the release notes say so. Nothing in `tauri.conf.json` needs
changing either way.

Code signing is separate from the updater's minisign key
(`TAURI_SIGNING_PRIVATE_KEY`). That key protects in-app updates. Code signing
is what stops Gatekeeper and SmartScreen from warning on first run.

## macOS: Developer ID + notarization

### What you need

- A paid **Apple Developer Program** membership (USD 99/year).
- A **Developer ID Application** certificate. Create it in Xcode
  (**Settings → Accounts → Manage Certificates → + → Developer ID Application**)
  or at developer.apple.com → Certificates. You need the Account Holder role.
- Credentials for notarization. Use one of these:
  - Apple ID: your Apple ID email, an
    [app-specific password](https://account.apple.com) and your Team ID; or
  - App Store Connect API key: **Users and Access → Integrations → App Store
    Connect API**. Create a key with the Developer role and download the `.p8`.
    You can only download it once.

### Secrets

| Secret | Value | How to produce it |
|--------|-------|-------------------|
| `APPLE_CERTIFICATE` | The Developer ID certificate and its private key, as a base64 `.p12` | In Keychain Access, expand the certificate under **My Certificates**, select the certificate and its key, then **Export 2 items… → .p12**. Then run `base64 -i certificate.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when you exported the `.p12` | |
| `APPLE_SIGNING_IDENTITY` | For example `Developer ID Application: Your Name (TEAMID)` | `security find-identity -v -p codesigning` |
| `APPLE_ID` | Apple ID email | Apple ID route only |
| `APPLE_PASSWORD` | App-specific password | Apple ID route only |
| `APPLE_TEAM_ID` | 10-character Team ID | developer.apple.com → Membership. Apple ID route only |
| `APPLE_API_ISSUER` | Issuer ID | Shown above the keys table. API key route only |
| `APPLE_API_KEY` | Key ID | The key's row in the table. API key route only |
| `APPLE_API_PRIVATE_KEY` | Full text of `AuthKey_<KEYID>.p8` | `cat AuthKey_XXXX.p8 \| pbcopy`. API key route only |

Set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and
`APPLE_SIGNING_IDENTITY`, plus **one** of the notarization sets. The workflow
exports only the secrets that have a value. For the API key route, it writes
`APPLE_API_PRIVATE_KEY` to a file and sets `APPLE_API_KEY_PATH`, which is the
variable the Tauri bundler reads. Every other name above is the variable
tauri-action and the bundler read directly.

### Verify

On a Mac, with the `.app` from the `.dmg`:

```bash
codesign -dv --verbose=4 /Applications/ARC.app   # Authority=Developer ID Application: …
codesign --verify --deep --strict --verbose=2 /Applications/ARC.app
spctl -a -vv /Applications/ARC.app               # accepted, source=Notarized Developer ID
xcrun stapler validate /Applications/ARC.app     # The validate action worked!
```

## Windows: Authenticode

### What you need

Pick one:

- **An OV or EV code-signing certificate** exported as a `.pfx` (this is what
  the workflow supports). OV certificates cost roughly USD 200–400/year from
  DigiCert, Sectigo, SSL.com and others. Since June 2023, CAs issue new OV and
  EV keys only on hardware tokens or cloud HSMs. A `.pfx` you can put in a
  GitHub secret is therefore only possible when the key is exportable (older
  certificates, or some cloud-HSM offerings). If yours isn't, use the next
  option.
- **Azure Trusted Signing**: Microsoft-managed certificates for about
  USD 10/month, with no hardware token. It needs an Azure subscription and
  identity validation. Tauri supports it through `bundle.windows.signCommand`
  with `trusted-signing-cli`. See
  [Tauri: Windows code signing](https://v2.tauri.app/distribute/sign/windows/).
  Using it means replacing the "Import Windows signing certificate" step with
  one that writes a `signCommand` overlay the same way, and passing
  `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID` to
  tauri-action.

A new certificate still earns SmartScreen reputation gradually, so expect a
warning on the first few hundred downloads. EV certificates used to skip that,
but they no longer do.

### Secrets (PFX)

| Secret | Value | How to produce it |
|--------|-------|-------------------|
| `WINDOWS_CERTIFICATE` | The `.pfx` as base64 | PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx')) \| Set-Clipboard`. macOS/Linux: `base64 -i cert.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` export password | |

The workflow imports the certificate into `Cert:\CurrentUser\My`. It then
builds with a `--config` overlay that sets `bundle.windows.certificateThumbprint`
(read from the imported certificate), `digestAlgorithm: sha256` and
`timestampUrl: http://timestamp.digicert.com`. When the secret is absent, that
step is skipped.

### Verify

In a Developer Command Prompt (signtool comes with the Windows SDK):

```powershell
signtool verify /pa /v ARC_x.y.z_x64-setup.exe
signtool verify /pa /v "C:\Program Files\ARC\ARC.exe"
Get-AuthenticodeSignature .\ARC_x.y.z_x64-setup.exe   # Status: Valid
```

Or right-click the file → **Properties → Digital Signatures**.

## Linux

Nothing to set up. Linux packages aren't code-signed this way. The updater's
minisign `.sig` files cover integrity.
