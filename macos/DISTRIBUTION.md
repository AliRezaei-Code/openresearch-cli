# Distributing OpenResearch.app

`scripts/build-macos-app.sh` builds the app; `scripts/package-macos-app.sh`
signs, notarizes, and packages it into a DMG. CI
(`.github/workflows/release-macos-app.yml`) runs both after each release and
attaches `OpenResearch.dmg`:

```
https://github.com/alphaXiv/openresearch-cli/releases/latest/download/OpenResearch.dmg
```

The release job is a no-op until the `MACOS_SIGNING_ENABLED` variable is `true`.

## Configure signing (CI)

Needs an Apple Developer Program account with a **Developer ID Application**
certificate (see Apple's [notarizing docs](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)).
From it you produce the six values below.

1. Create the **`release-signing` environment** (Settings → Environments): add
   **required reviewers** and set **Deployment branches → `main`**. Add these as
   **environment** secrets (not repo-wide):

   | Secret | Value |
   | --- | --- |
   | `MACOS_CERT_P12_BASE64` | `base64 -i cert.p12` of the exported Developer ID cert |
   | `MACOS_CERT_PASSWORD` | the `.p12` export password |
   | `MACOS_SIGN_IDENTITY` | `Developer ID Application: <name> (TEAMID)` — `security find-identity -v -p codesigning` |
   | `MACOS_NOTARY_APPLE_ID` | your Apple ID email |
   | `MACOS_NOTARY_TEAM_ID` | your Team ID |
   | `MACOS_NOTARY_PASSWORD` | an app-specific password (account.apple.com) |

2. Set repo **variable** `MACOS_SIGNING_ENABLED = true` to switch the pipeline on.

Also enable **Require a pull request** + **Require review from Code Owners** on
`main` (see `.github/CODEOWNERS`) so the signing scripts can't change unreviewed.
Never commit the `.p12`.

## Build / sign locally

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # once, for universal
ORX_APP_UNIVERSAL=1 bash scripts/build-macos-app.sh
xcrun notarytool store-credentials orx-notary \
  --apple-id you@example.com --team-id TEAMID --password <app-specific-password>
MACOS_SIGN_IDENTITY="Developer ID Application: <name> (TEAMID)" \
  MACOS_NOTARY_PROFILE=orx-notary bash scripts/package-macos-app.sh
```

Without the two `MACOS_*` vars, `package-macos-app.sh` still makes an **unsigned**
`dist/OpenResearch.dmg` for quick local testing.

## Not yet automated

- A nicer DMG layout (background + drag-to-Applications alias); `create-dmg` is
  the usual tool.
