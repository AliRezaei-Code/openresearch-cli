# Desktop packaging

`openresearch` is a thin GUI launcher packaged beside the `orx` executable. It
checks `http://127.0.0.1:4791/api/health`; if a dashboard is already running it
opens that URL, otherwise it starts the neighboring `orx up --no-browser`,
waits for readiness, and then opens the browser. Server behavior remains owned
by `orx up`.

The launcher exits after opening the browser, matching the requested one-shot
`orx up` entry point instead of staying resident as a tray application. It
records a random instance ID for servers it starts so a newer desktop version
can replace only an older desktop-owned server; manually started `orx up`
processes are never stopped.

All desktop packages run a versioned copy of their bundled `orx` executable
from the local data directory. This keeps `current_exe()` valid after a Linux
AppImage's temporary mount goes away and lets macOS/Windows replace the
application bundle while the current local dashboard is running. Once a new
desktop-owned server starts, older helper versions are removed.

The cargo-dist release workflow calls `scripts/package-desktop.sh` through the
`build-desktop` reusable workflow and publishes stable asset names:

- `OpenResearch-macos-{arm64,x64}.dmg`
- `OpenResearch-linux-{arm64,x64}.AppImage`
- `OpenResearch-windows-{arm64,x64}-setup.exe`

Dry runs use an ad-hoc macOS signature and unsigned Windows installers.
Publishing releases require these repository secrets:

- macOS: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and `APPLE_TEAM_ID`
- Windows: `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD`

Certificates are base64-encoded P12/PFX files. The macOS package is notarized
with the configured Apple ID credentials. Windows imports the certificate into
the ephemeral runner certificate store and signs the executables and installer.
The generated `release.yml` intentionally replaces cargo-dist's broad
`secrets: inherit` entries with an explicit publishing-only signing secret map;
preserve that hardening whenever regenerating the workflow.
