# Distributing OpenResearch.app

The macOS app is built by `scripts/build-macos-app.sh` and packaged into a
signed, notarized DMG by `scripts/package-macos-app.sh`. In CI,
`.github/workflows/release-macos-app.yml` does both after cargo-dist's "Release"
workflow completes and attaches `OpenResearch.dmg` to that release — the download
link becomes:

```
https://github.com/alphaXiv/openresearch-cli/releases/latest/download/OpenResearch.dmg
```

Until the secrets below are set, the release job **skips cleanly** (an unsigned
DMG would just trip Gatekeeper, so we don't publish one).

## One-time Apple setup (manual — only a human with the account can do this)

1. **Enrol in the Apple Developer Program** ($99/yr). Approval can take up to a day.
2. **Create a "Developer ID Application" certificate** (Xcode → Settings →
   Accounts → Manage Certificates → +, or the Developer portal). This is the
   cert for distributing *outside* the App Store.
3. **Export it as a `.p12`** (Keychain Access → your "Developer ID Application"
   cert → right-click → Export), setting an export password.
4. **Create an app-specific password** for the notary service at
   <https://account.apple.com> → Sign-In and Security → App-Specific Passwords.
5. Note your **Team ID** (Developer portal → Membership) and the exact signing
   identity string, e.g. `Developer ID Application: Your Org (TEAMID)`
   (`security find-identity -v -p codesigning` lists it).

## GitHub repository secrets to add

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `MACOS_CERT_P12_BASE64` | `base64 -i cert.p12` (the exported `.p12`, base64-encoded) |
| `MACOS_CERT_PASSWORD` | the `.p12` export password |
| `MACOS_SIGN_IDENTITY` | `Developer ID Application: Your Org (TEAMID)` |
| `MACOS_NOTARY_APPLE_ID` | your Apple ID email |
| `MACOS_NOTARY_TEAM_ID` | your Team ID |
| `MACOS_NOTARY_PASSWORD` | the app-specific password from step 4 |

Once all six exist, the next published release attaches a signed + notarized
`OpenResearch.dmg` automatically.

## Testing it locally (with your cert)

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin  # one-time, for universal
ORX_APP_UNIVERSAL=1 bash scripts/build-macos-app.sh
# one-time: cache notary creds in your keychain
xcrun notarytool store-credentials orx-notary \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
MACOS_SIGN_IDENTITY="Developer ID Application: Your Org (TEAMID)" \
MACOS_NOTARY_PROFILE=orx-notary \
  bash scripts/package-macos-app.sh
```

Without `MACOS_SIGN_IDENTITY` / `MACOS_NOTARY_PROFILE`, `package-macos-app.sh`
still produces an **unsigned** `dist/OpenResearch.dmg` for local testing (open it
with right-click → Open, or `xattr -dr com.apple.quarantine OpenResearch.app`).

## Not yet automated

- **A nicer DMG layout** (background image + drag-to-Applications alias) — the
  current DMG just contains the `.app`. `create-dmg` is the usual tool.
- Publishing the download link anywhere other than GitHub Releases.
