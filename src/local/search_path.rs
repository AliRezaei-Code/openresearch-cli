//! The PATH harness detection searches and harness children inherit.
//!
//! Normally just the process PATH. macOS app mode installs an override once at
//! startup: a bundle launched from Finder gets launchd's
//! `/usr/bin:/bin:/usr/sbin:/sbin` and never sources the user's shell rc, so a
//! `claude` or `codex` installed by Homebrew, nvm, or npm-global is invisible
//! to `harness::detect::find_on_path` — the app finds no `codex` at all, and
//! `claude`/`opencode` only at their installer drop locations, while a terminal
//! `orx up` on the same machine detects them all.
//!
//! Scope is harnesses only. The other things orx shells out to (ray, slurm,
//! modal, kubectl, gh) still resolve against the process PATH.

use std::ffi::OsString;
use std::sync::OnceLock;

static OVERRIDE: OnceLock<OsString> = OnceLock::new();

/// The PATH to search for harness binaries and hand to harness children.
pub fn current() -> Option<OsString> {
    match OVERRIDE.get() {
        Some(path) => Some(path.clone()),
        None => std::env::var_os("PATH"),
    }
}

/// Install the override; the first call wins. Deliberately not
/// `env::set_var` — app mode enters inside an already-running tokio runtime,
/// where mutating the process environment races every live thread.
#[cfg(target_os = "macos")]
pub fn set(path: OsString) {
    let _ = OVERRIDE.set(path);
}

/// The PATH a shell probe fenced between two `marker`s, if the payload ran to
/// completion and produced something usable.
///
/// Requiring an absolute directory is what rejects a garbage or empty capture —
/// including the literal `%s` left behind if the fence ever wraps the `printf`
/// template rather than its output.
pub fn extract_path(stdout: &str, marker: &str) -> Option<String> {
    let mut parts = stdout.split(marker);
    // `split` always yields a first element; the *third* is what proves the
    // closing fence arrived rather than the probe being cut short.
    let path = parts.nth(1)?;
    parts.next()?;
    std::env::split_paths(path)
        .any(|dir| dir.is_absolute())
        .then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: &str = "__ORX_PATH_abc123__";

    #[test]
    fn extracts_path_from_a_chatty_shell() {
        let stdout = format!("nvm loaded\n{M}/opt/homebrew/bin:/usr/bin{M}");
        assert_eq!(
            extract_path(&stdout, M).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn rejects_truncated_or_empty_output() {
        assert_eq!(extract_path("", M), None);
        assert_eq!(extract_path(&format!("{M}/usr/bin"), M), None);
        assert_eq!(extract_path(&format!("{M}{M}"), M), None);
    }

    #[test]
    fn rejects_a_fence_wrapping_the_template_instead_of_its_output() {
        let stdout = format!(r#"+ /bin/sh -c printf "{M}%s{M}" "$PATH""#);
        assert_eq!(extract_path(&stdout, M), None);
    }
}
