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

/// Enter GUI app mode: adopt the user's shell PATH, pick a free port, start the
/// dashboard server on background threads, and hand the main thread to the
/// AppKit run loop. Returns only when the user quits the app (usually the
/// process just exits).
#[cfg(target_os = "macos")]
pub async fn run() {
    // First: everything below resolves a directory the probe can still change.
    // The lock lives under `config_dir()`, so taking it earlier would lock the
    // default path while the CLI locks the user's `XDG_CONFIG_HOME` one —
    // protecting nothing at all.
    hydrate_shell_env().await;
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

/// Adopt the user's shell environment in place of the one launchd handed us
/// (see [`crate::local::shell_env`]).
///
/// `-ilc`, not `-lc`: zsh reads `.zshrc` only for *interactive* shells, and
/// that is where these exports overwhelmingly live. The inner `sh -c` keeps the
/// answer portable — the outer shell execs `/bin/sh`, which prints the values it
/// inherited, where fish would have printed its own list-valued `$PATH`
/// space-separated. NUL separates them because a PATH or a directory may
/// contain spaces, colons, and newlines, but never NUL.
#[cfg(target_os = "macos")]
async fn hydrate_shell_env() {
    // Nonce, so rc-file chatter can't forge the fence around the values. The
    // leading `_` is load-bearing: `printf` reads `\0` plus up to three octal
    // digits, so a marker starting with a digit would be eaten by the escape.
    let marker = format!("__ORX_ENV_{}__", uuid::Uuid::new_v4().simple());
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
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
    // The lock below is still taken after this, so `orx delete` can win a
    // few-second window at startup. Locking first is worse: the lock path comes
    // from `config_dir()`, which this probe can still change.
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
            // Dock-icon click with no open windows → reopen the dashboard.
            #[unsafe(method(applicationShouldHandleReopen:hasVisibleWindows:))]
            fn should_handle_reopen(&self, _app: &NSApplication, _has_windows: bool) -> bool {
                crate::browser::open_browser(&self.ivars().url);
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
