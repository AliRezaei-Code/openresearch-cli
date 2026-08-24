//! macOS `.app` mode — the GUI entry point for the downloadable OpenResearch app.
//!
//! The bundle's executable IS the `orx` binary. When launched from a `.app`
//! (double-click), macOS starts it with no arguments, so `main` routes here
//! instead of parsing CLI args. App mode owns the main thread with the AppKit
//! run loop — giving a proper Dock icon (from the bundle's `.icns`), the
//! "OpenResearch" menu-bar name, and interactive Dock-icon clicks — while the
//! `orx up` dashboard server runs on background tokio worker threads.
//!
//! This is distinct from `orx up` launched in a terminal, which stays a plain
//! CLI. The whole module is macOS-only; other targets compile it away.

/// True when `exe` is a `<name>.app/Contents/MacOS` bundle executable that was
/// invoked under its own name — the signal to enter GUI app mode instead of
/// parsing CLI args.
///
/// The name check is what keeps the bundle's `orx` symlink (see
/// `build-macos-app.sh`) a plain CLI: an agent shelling out to a bare `orx`
/// must print help, not open a second dashboard. That relies on `exe` being
/// canonicalized — it is the *symlink* whose name differs, so an uncanonicalized
/// path would compare `orx` against `orx` and match.
// Un-gated so its tests run on CI's Linux runner; only macOS has a caller.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn is_bundle_exe_launch(exe: &std::path::Path, argv0: Option<&std::ffi::OsStr>) -> bool {
    let in_bundle = exe
        .parent()
        .is_some_and(|dir| dir.ends_with("Contents/MacOS"));
    let invoked_as_bundle_exe = argv0
        .map(std::path::Path::new)
        .and_then(std::path::Path::file_name)
        == exe.file_name();
    in_bundle && invoked_as_bundle_exe
}

/// Whether to enter GUI app mode. macOS `current_exe` reports the path the
/// process was *launched as*, symlink and all, so it is canonicalized first.
#[cfg(target_os = "macos")]
pub fn launched_as_app_bundle() -> bool {
    let Ok(exe) = std::env::current_exe().and_then(|exe| exe.canonicalize()) else {
        return false;
    };
    is_bundle_exe_launch(&exe, std::env::args_os().next().as_deref())
}

/// The Linux desktop app root marker: `build-linux-app.sh` drops this file in
/// the app dir so neither the launch check nor the update-channel detector
/// needs to know where an install lives (it can be `~/.local/share/
/// openresearch/app`, `/opt/openresearch`, or anything else).
pub(crate) const LINUX_APP_MARKER: &str = ".openresearch-app";

/// True when `exe` sits in `<root>/bin/` and the root carries the app marker.
/// Mirrors `updates::linux_app_root`, which classifies the same install for
/// self-update; both must agree or an app install is silently a CLI forever.
#[cfg(target_os = "linux")]
fn linux_app_root(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let bin = exe.parent()?;
    if bin.file_name() != Some(std::ffi::OsStr::new("bin")) {
        return None;
    }
    let root = bin.parent()?;
    root.join(LINUX_APP_MARKER)
        .is_file()
        .then(|| root.to_path_buf())
}

/// Whether to enter GUI app mode on Linux. Same shape as macOS: the real
/// executable is `bin/openresearch` (launched by the `.desktop` entry with no
/// arguments), while `bin/orx` is a symlink to the same file that stays a
/// plain CLI because its argv0 name differs from the resolved executable name.
#[cfg(target_os = "linux")]
pub fn launched_as_app_bundle() -> bool {
    let Ok(exe) = std::env::current_exe().and_then(|exe| exe.canonicalize()) else {
        return false;
    };
    let in_bundle = linux_app_root(&exe).is_some();
    let invoked_as_bundle_exe = std::env::args_os()
        .next()
        .as_deref()
        .map(std::path::Path::new)
        .and_then(std::path::Path::file_name)
        == exe.file_name();
    in_bundle && invoked_as_bundle_exe
}

/// Enter GUI app mode on Linux: adopt the user's shell environment, take the
/// lifecycle lock, focus an already-running dashboard if one is reachable,
/// then start the dashboard server on an ephemeral loopback port, open the
/// default browser, and block until the desktop session asks us to quit.
/// There is no native run loop like AppKit's — parking on SIGINT/SIGTERM is
/// the Linux equivalent of `imp::run_event_loop`.
#[cfg(target_os = "linux")]
pub async fn run() {
    // First: everything below resolves a directory the probe can still change.
    // The lock lives under `config_dir()`, so taking it earlier would lock the
    // default path while the CLI locks the user's `XDG_CONFIG_HOME` one —
    // protecting nothing at all.
    hydrate_shell_env().await;
    // App mode returns before `dispatch`, which is where `orx up` takes this
    // same read lock. Without it `orx delete` from a CLI install sees no
    // reader and wipes the store out from under a running app.
    let lifecycle = crate::store::open_lifecycle_lock()
        .inspect_err(|err| eprintln!("openresearch app: could not open the lifecycle lock: {err}"))
        .ok();
    let _lifecycle_guard = lifecycle.as_ref().and_then(|lock| {
        lock.read()
            .inspect_err(|err| {
                eprintln!("openresearch app: could not hold the lifecycle lock: {err}")
            })
            .ok()
    });

    // Re-launch while a dashboard is up: raise the existing one and exit
    // instead of starting a second server (the macOS Dock-click analogue; the
    // desktop's launcher has no reopen event).
    if let Some(existing) = live_app_port() {
        crate::browser::open_browser(&format!("http://127.0.0.1:{existing}/"));
        return;
    }
    // Ephemeral loopback port so the app never collides with a terminal
    // `orx up`. Bind-then-drop to reserve it; the tiny race is harmless locally.
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(4791);
    write_app_port(port);
    let url = format!("http://127.0.0.1:{port}/");

    // Dashboard server on background workers (we're inside main's runtime).
    tokio::spawn(async move {
        let args = crate::UpArgs {
            port,
            remote: None,
            no_browser: true,
            no_agent: false,
            model: None,
        };
        if let Err(err) = crate::commands::up::run(args).await {
            eprintln!("openresearch app: dashboard server exited: {err}");
        }
        remove_app_port();
    });

    // Open the browser once the server accepts connections.
    let ready_url = url.clone();
    tokio::spawn(async move {
        for _ in 0..100 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                crate::browser::open_browser(&ready_url);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    });

    // Block until the desktop session (or a terminal Ctrl-C) quits us; the
    // spawned tasks die with the runtime right after `main` returns.
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate_signal() => {}
    }
    remove_app_port();
}

/// The file recording the running app's loopback port, plus its pid. Lives in
/// the shared store dir; the CLI never reads it, so coexistence is unaffected.
#[cfg(target_os = "linux")]
fn app_port_path() -> std::path::PathBuf {
    crate::store::data_dir().join("app-port")
}

#[cfg(target_os = "linux")]
fn write_app_port(port: u16) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(crate::store::data_dir());
    let line = format!("{port} {}\n", std::process::id());
    if std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(app_port_path())
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .is_err()
    {
        eprintln!("openresearch app: could not record the dashboard port");
    }
}

#[cfg(target_os = "linux")]
fn remove_app_port() {
    let _ = std::fs::remove_file(app_port_path());
}

/// The port of a live app dashboard, if any. A stale file (crash, reboot)
/// fails the TCP probe and is treated as absent — a fresh server then
/// overwrites it. The probe is bounded so a dead-but-listening port can't hang
/// the launch.
#[cfg(target_os = "linux")]
fn live_app_port() -> Option<u16> {
    let text = std::fs::read_to_string(app_port_path()).ok()?;
    let port: u16 = text.split_whitespace().next()?.parse().ok()?;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300))
        .ok()?;
    Some(port)
}

#[cfg(target_os = "linux")]
async fn terminate_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    term.recv().await;
}

/// Enter GUI app mode: adopt the user's shell PATH, pick a free port, start the
/// dashboard server on background threads, and hand the main thread to the
/// AppKit run loop. Returns only when the user quits the app (usually the
/// process just exits).
#[cfg(target_os = "macos")]
pub async fn run() {
    // App mode returns before `dispatch`, which is where `orx up` takes this
    // same read lock. Without it `orx delete` from a CLI install sees no reader
    // and wipes the store out from under a running app.
    let lifecycle = crate::store::open_lifecycle_lock()
        .inspect_err(|err| eprintln!("openresearch app: could not open the lifecycle lock: {err}"))
        .ok();
    let _lifecycle_guard = lifecycle.as_ref().and_then(|lock| {
        lock.read()
            .inspect_err(|err| {
                eprintln!("openresearch app: could not hold the lifecycle lock: {err}")
            })
            .ok()
    });
    // Ephemeral loopback port so the app never collides with a terminal
    // `orx up`. Bind-then-drop to reserve it; the tiny race is harmless locally.
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(4791);
    imp::run_event_loop(format!("http://127.0.0.1:{port}/"), port);
}

/// Adopt the user's shell environment in place of the one the desktop session
/// handed us (see [`crate::local::shell_env`]). Applies to both desktop apps:
/// Finder/launchd on macOS and the desktop launcher on Linux both start with a
/// minimal `PATH` and no shell rc, which is exactly where `codex`/`omp` and the
/// `orx`-visible exports live.
///
/// `-ilc`, not `-lc`: zsh reads `.zshrc` only for *interactive* shells, and
/// that is where these exports overwhelmingly live. The inner `sh -c` keeps the
/// answer portable — the outer shell execs `/bin/sh`, which prints the values it
/// inherited, where fish would have printed its own list-valued `$PATH`
/// space-separated. NUL separates them because a PATH or a directory may
/// contain spaces, colons, and newlines, but never NUL.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) async fn hydrate_shell_env() {
    // Nonce, so rc-file chatter can't forge the fence around the values. The
    // leading `_` is load-bearing: `printf` reads `\0` plus up to three octal
    // digits, so a marker starting with a digit would be eaten by the escape.
    let marker = format!("__ORX_ENV_{}__", uuid::Uuid::new_v4().simple());
    #[cfg(target_os = "macos")]
    let default_shell = "/bin/zsh";
    #[cfg(target_os = "linux")]
    let default_shell = "/bin/bash";
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| default_shell.into());
    let reads = crate::local::shell_env::IMPORTED
        .map(|key| format!(r#""${key}""#))
        .join(" ");
    let template = "%s\\0".repeat(crate::local::shell_env::IMPORTED.len());
    let script = format!(r#"/bin/sh -c 'printf "{marker}{template}{marker}" {reads}'"#);
    let fut = tokio::process::Command::new(&shell)
        .args(["-ilc".to_string(), script])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    // A slow rc file (nvm, conda) delays the dashboard, so cap the wait; the
    // inherited environment stays in force when the probe doesn't answer.
    let out = match tokio::time::timeout(std::time::Duration::from_secs(5), fut).await {
        Ok(Ok(out)) => out,
        Ok(Err(err)) => {
            eprintln!(
                "openresearch app: could not run {shell:?}: {err}; using the inherited environment"
            );
            return;
        }
        Err(_) => {
            eprintln!("openresearch app: {shell:?} did not answer within 5s; using the inherited environment");
            return;
        }
    };
    // The markers are the success signal, not the exit status — an interactive
    // rc file routinely ends on a failing command.
    match crate::local::shell_env::parse_probe(&String::from_utf8_lossy(&out.stdout), &marker) {
        Some(vars) => {
            let adopted: Vec<String> = crate::local::shell_env::IMPORTED
                .iter()
                .filter_map(|key| Some(format!("{key}={:?}", vars.get(key)?)))
                .collect();
            eprintln!(
                "openresearch app: adopted the shell environment: {}",
                adopted.join(" ")
            );
            crate::local::shell_env::set(vars);
        }
        None => eprintln!(
            "openresearch app: the environment probe returned nothing usable; using the inherited \
             environment. shell stderr: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
    }
}

/// Dock-icon click: raise the dashboard the user already has open instead of
/// opening the URL again, which lands on a *new* tab once the SPA has navigated
/// off `/`.
#[cfg(target_os = "macos")]
fn focus_or_open(url: &str) {
    // The first attempt parks on the Automation permission prompt, which needs
    // unbounded user time; without this, every impatient re-click stacks
    // another blocked thread and, once they all unblock, another tab.
    let Some(in_flight) = InFlight::claim() else {
        return;
    };
    let url = url.to_string();
    // Off the main thread for that same prompt — the AppKit run loop has to
    // stay responsive while it is up.
    std::thread::spawn(move || {
        if !raise_dashboard(&url) {
            crate::browser::open_browser(&url);
        }
        // Named so the closure captures it: dropping at the end of
        // `focus_or_open` instead would end the claim before the attempt starts.
        drop(in_flight);
    });
}

#[cfg(target_os = "macos")]
static ATTEMPT_IN_FLIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
struct InFlight;

#[cfg(target_os = "macos")]
impl InFlight {
    fn claim() -> Option<Self> {
        // Constructed only on the winning branch: `then_some` would build one
        // for the loser too and its `Drop` would free the winner's claim.
        if ATTEMPT_IN_FLIGHT.swap(true, std::sync::atomic::Ordering::SeqCst) {
            None
        } else {
            Some(Self)
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for InFlight {
    /// Released here rather than on the happy path so a panic cannot latch the
    /// claim on and kill the Dock icon for the life of the process.
    fn drop(&mut self) {
        ATTEMPT_IN_FLIGHT.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// True when a dashboard the user already had open was brought forward. False
/// means the caller must open the URL — a duplicate tab beats a Dock icon that
/// visibly does nothing, since app mode's port is ephemeral and the user has no
/// other way back to the dashboard.
#[cfg(target_os = "macos")]
fn raise_dashboard(url: &str) -> bool {
    use std::sync::atomic::{AtomicU64, Ordering};

    const NEVER: u64 = u64::MAX;
    // Long enough to cover looking at the browser and deciding the dashboard is
    // not there, short enough that a click minutes later still prefers a raise
    // over a duplicate tab. Guessing wrong either way costs one tab.
    const ACTIVATION_IS_RECENT_MS: u64 = 5_000;
    // Only a real activation is recorded, so a click that fell through cannot
    // slide the window forward and suppress the next one.
    static LAST_ACTIVATION_MS: AtomicU64 = AtomicU64::new(NEVER);

    if focus_existing_tab(url) {
        return true;
    }
    // Firefox exposes no tab API, so a tab there can only be inferred from its
    // event stream, and nothing finer than its whole browser can be raised.
    // Clicking again within seconds says that did not surface the dashboard —
    // it was left on another tab — so the repeat click opens the URL instead.
    if !crate::commands::up::has_live_dashboard_clients() {
        return false;
    }
    let last = LAST_ACTIVATION_MS.load(Ordering::SeqCst);
    if last != NEVER && monotonic_ms() - last < ACTIVATION_IS_RECENT_MS {
        return false;
    }
    if !activate_default_browser() {
        return false;
    }
    LAST_ACTIVATION_MS.store(monotonic_ms(), Ordering::SeqCst);
    true
}

/// Monotonic, so an NTP correction cannot suppress the fallback or end its
/// window early.
#[cfg(target_os = "macos")]
fn monotonic_ms() -> u64 {
    use std::sync::OnceLock;
    use std::time::Instant;

    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Activates the browser tab whose URL starts with `url`. False when no tab
/// matches, no scriptable browser is running, or Automation permission was
/// denied.
#[cfg(target_os = "macos")]
fn focus_existing_tab(url: &str) -> bool {
    let out = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", FOCUS_TAB_SCRIPT, url])
        .output();
    let Ok(out) = out else {
        return false;
    };
    match String::from_utf8_lossy(&out.stdout).trim() {
        "ok" => true,
        // Silent otherwise: "no tab open" is the ordinary case, but a denied
        // Automation prompt is invisible without a line in the log.
        "blocked" => {
            eprintln!(
                "openresearch app: not allowed to search browser tabs — grant OpenResearch \
                 Automation access in System Settings › Privacy & Security"
            );
            false
        }
        _ => false,
    }
}

/// Brings the default browser forward without opening anything, so the tab the
/// user left open stays put. False when it is not running, where `open -a`
/// would raise an empty browser instead of the dashboard.
#[cfg(target_os = "macos")]
fn activate_default_browser() -> bool {
    let Some(browser) = default_browser_path() else {
        return false;
    };
    if !is_running(&browser) {
        return false;
    }
    std::process::Command::new("open")
        .arg("-a")
        .arg(&browser)
        .status()
        .is_ok_and(|status| status.success())
}

/// True when the app bundle at `bundle_path` is running. Both sides come from
/// `NSURL.path`, so plain string equality is enough. The autorelease pools here
/// and in `default_browser_path` are explicit because this runs on a plain
/// `std::thread`, which never gets one of its own.
#[cfg(target_os = "macos")]
fn is_running(bundle_path: &str) -> bool {
    use objc2_app_kit::NSWorkspace;

    objc2::rc::autoreleasepool(|_| {
        NSWorkspace::sharedWorkspace()
            .runningApplications()
            .iter()
            .any(|app| {
                app.bundleURL()
                    .and_then(|url| url.path())
                    .is_some_and(|path| path.to_string() == bundle_path)
            })
    })
}

/// macOS has no "which browser is default" call, so ask which app would open a
/// throwaway `http://` URL.
#[cfg(target_os = "macos")]
fn default_browser_path() -> Option<String> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    objc2::rc::autoreleasepool(|_| {
        let probe = NSURL::URLWithString(&NSString::from_str("http://127.0.0.1/"))?;
        let app = NSWorkspace::sharedWorkspace().URLForApplicationToOpenURL(&probe)?;
        app.path().map(|path| path.to_string())
    })
}

#[cfg(target_os = "macos")]
const FOCUS_TAB_SCRIPT: &str = include_str!("../../macos/focus-dashboard-tab.js");

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSApplicationDelegate};

    struct DelegateIvars {
        url: String,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements; no `Drop` impl.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "OrxAppDelegate"]
        #[ivars = DelegateIvars]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl NSApplicationDelegate for Delegate {
            // Dock-icon click with no open windows → raise the dashboard.
            #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
            fn should_handle_reopen(&self, _app: &NSApplication, _has_windows: bool) -> bool {
                super::focus_or_open(&self.ivars().url);
                true
            }
        }
    );

    impl Delegate {
        fn new(mtm: MainThreadMarker, url: String) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(DelegateIvars { url });
            unsafe { msg_send![super(this), init] }
        }
    }

    pub(super) fn run_event_loop(url: String, port: u16) {
        let mtm = MainThreadMarker::new().expect("app mode runs on the main thread");

        // Dashboard server on background workers (we're inside main's runtime).
        tokio::spawn(async move {
            let args = crate::UpArgs {
                port,
                remote: None,
                no_browser: true,
                no_agent: false,
                model: None,
            };
            if let Err(err) = crate::commands::up::run(args).await {
                eprintln!("openresearch app: dashboard server exited: {err}");
            }
        });

        // Open the browser once the server accepts connections.
        let ready_url = url.clone();
        tokio::spawn(async move {
            for _ in 0..100 {
                if tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .is_ok()
                {
                    crate::browser::open_browser(&ready_url);
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        });

        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
        // Delegate must outlive `run()` — AppKit holds it weakly.
        let delegate = Delegate::new(mtm, url);
        app.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        app.run();
    }
}

#[cfg(test)]
mod tests {
    use super::is_bundle_exe_launch;
    use std::ffi::OsStr;
    use std::path::Path;

    const EXE: &str = "/Applications/OpenResearch.app/Contents/MacOS/OpenResearch";

    #[test]
    fn finder_and_direct_runs_of_the_bundle_exe_are_app_launches() {
        assert!(is_bundle_exe_launch(Path::new(EXE), Some(OsStr::new(EXE))));
        assert!(is_bundle_exe_launch(
            Path::new(EXE),
            Some(OsStr::new("./OpenResearch"))
        ));
    }

    #[test]
    fn the_bundles_orx_symlink_stays_a_cli() {
        // `exe` is canonicalized, so the symlink shows up only in argv.
        assert!(!is_bundle_exe_launch(
            Path::new(EXE),
            Some(OsStr::new("orx"))
        ));
        assert!(!is_bundle_exe_launch(
            Path::new(EXE),
            Some(OsStr::new(
                "/Applications/OpenResearch.app/Contents/MacOS/orx"
            ))
        ));
    }

    #[test]
    fn installs_outside_a_bundle_are_never_app_launches() {
        assert!(!is_bundle_exe_launch(
            Path::new("/usr/local/bin/orx"),
            Some(OsStr::new("orx"))
        ));
        assert!(!is_bundle_exe_launch(Path::new(EXE), None));
    }
}
