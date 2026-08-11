//! Cross-platform "open URL in browser".

use std::process::{Command, Stdio};

pub fn try_open_browser(url: &str) -> std::io::Result<()> {
    let mut child = browser_command(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    for _ in 0..20 {
        if let Some(status) = child.try_wait()? {
            return status.success().then_some(()).ok_or_else(|| {
                std::io::Error::other(format!("browser opener exited with {status}"))
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Ok(())
}

/// Opens `url` in the user's default browser. Best-effort and non-fatal: errors
/// (e.g. no browser, headless) are swallowed, since the caller is expected to
/// have already printed the URL for manual opening. The child is detached so the
/// CLI does not block on it.
pub fn open_browser(url: &str) {
    let _ = browser_command(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn browser_command(url: &str) -> Command {
    #[cfg(target_os = "macos")]
    let command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };

    #[cfg(target_os = "windows")]
    let command = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new("rundll32.exe");
        command
            .args(windows_browser_args(url))
            .creation_flags(CREATE_NO_WINDOW);
        command
    };

    command
}

#[cfg(any(test, target_os = "windows"))]
fn windows_browser_args(url: &str) -> [&str; 2] {
    ["url.dll,FileProtocolHandler", url]
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_opener_passes_query_url_as_one_argument() {
        let url = "https://example.com/login?code=a&state=b";
        assert_eq!(
            super::windows_browser_args(url),
            ["url.dll,FileProtocolHandler", url]
        );
    }
}
