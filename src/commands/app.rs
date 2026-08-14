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

/// True when this process is the executable inside a `<name>.app/Contents/MacOS`
/// bundle — the signal to enter GUI app mode instead of parsing CLI args.
#[cfg(target_os = "macos")]
pub fn launched_as_app_bundle() -> bool {
    std::env::current_exe()
        .ok()
        .as_deref()
        .and_then(std::path::Path::parent)
        .is_some_and(|dir| dir.ends_with("Contents/MacOS"))
}

/// Enter GUI app mode: adopt the user's shell PATH, pick a free port, start the
/// dashboard server on background threads, and hand the main thread to the
/// AppKit run loop. Returns only when the user quits the app (usually the
/// process just exits).
#[cfg(target_os = "macos")]
pub async fn run() {
    // Before the port is reserved, so the reservation can't go stale while the
    // probe runs — and long before detection reads PATH for `/api/harnesses`.
    hydrate_search_path().await;
    // Ephemeral loopback port so the app never collides with a terminal
    // `orx up`. Bind-then-drop to reserve it; the tiny race is harmless locally.
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(4791);
    imp::run_event_loop(format!("http://127.0.0.1:{port}/"), port);
}

/// Adopt the user's shell PATH in place of the one launchd handed us (see
/// [`crate::local::search_path`]).
///
/// `-ilc`, not `-lc`: zsh reads `.zshrc` only for *interactive* shells, and
/// that is where PATH edits overwhelmingly live. The inner `sh -c` keeps the
/// answer portable — the outer shell sees three plain words and execs
/// `/bin/sh`, which prints the colon-separated PATH it inherited, where fish
/// would have printed its own list-valued `$PATH` space-separated.
#[cfg(target_os = "macos")]
async fn hydrate_search_path() {
    // Nonce, so rc-file chatter can't forge the fence around the PATH.
    let marker = format!("__ORX_PATH_{}__", uuid::Uuid::new_v4().simple());
    let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/zsh".into());
    let script = format!(r#"/bin/sh -c 'printf "{marker}%s{marker}" "$PATH"'"#);
    let fut = tokio::process::Command::new(shell)
        .args(["-ilc".to_string(), script])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    // A slow rc file (nvm, conda) delays the dashboard, so cap the wait; the
    // inherited PATH stays in force when the probe doesn't answer.
    let out = match tokio::time::timeout(std::time::Duration::from_secs(5), fut).await {
        Ok(Ok(out)) => out,
        other => {
            eprintln!("openresearch app: PATH probe failed ({other:?}); using the inherited PATH");
            return;
        }
    };
    // The markers are the success signal, not the exit status — an interactive
    // rc file routinely ends on a failing command.
    match crate::local::search_path::extract_path(&String::from_utf8_lossy(&out.stdout), &marker) {
        Some(path) => {
            eprintln!("openresearch app: adopted the shell PATH: {path}");
            crate::local::search_path::set(path.into());
        }
        None => eprintln!(
            "openresearch app: PATH probe returned nothing usable; using the inherited PATH. \
             shell stderr: {}",
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
