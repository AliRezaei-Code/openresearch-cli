//! Self-update for the Linux desktop app.
//!
//! The Linux app has no cargo-dist receipt (a receipt would put it on the CLI's
//! installer path and let the two replace each other's files), so — like the
//! macOS app — this module is the whole pipeline: fetch `linux-app.json`, sign
//! nothing, verify the `sha256`, swap the app dir.
//!
//! Trust model differs from macOS deliberately: there is no Gatekeeper/notary
//! equivalent on Linux, so the release's published checksum is the *only* gate
//! between the app and an unattended swap. That is the same trust the CLI's
//! own installer already rests on (`sha256.sum` next to the tarball), and it
//! means a source build of the fork can self-update too — the check pins the
//! bytes, not a signing identity. If you build and publish your own releases,
//! the checksum you publish is the trust anchor; keep `linux-app.json` next to
//! its tarball exactly as `release-linux-app.yml` does.
//!
//! The swap renames whole directories rather than writing into the installed
//! app. A running process keeps its original inode, so it keeps working (and
//! serves the dashboard) until the user relaunches — the same atomicity the
//! macOS swap uses, minus the signature worries.

use std::path::{Path, PathBuf};
use std::time::Duration;

use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::error::{anyhow, Result};

/// Release asset describing the published app build. Written by
/// `.github/workflows/release-linux-app.yml` next to the tarball it describes.
const MANIFEST_ASSET: &str = "linux-app.json";

#[derive(Debug, Deserialize)]
pub struct AppManifest {
    pub version: String,
    /// Release tag the asset is pinned to, so the download can't drift to a
    /// different release between the manifest fetch and the download.
    pub tag: String,
    pub asset: String,
    pub sha256: String,
}

/// Fetches the published app manifest. `Ok(None)` for a 404 — the expected
/// state between a release being published and its tarball being attached
/// (or before upstream ships a Linux build at all). That is "nothing to update
/// to yet", never an error the user should see.
pub async fn fetch_manifest(timeout: Duration) -> Result<Option<AppManifest>> {
    let url = format!(
        "{}/releases/latest/download/{}",
        super::REPO_URL,
        MANIFEST_ASSET
    );
    let res = super::http()
        .get(&url)
        .header("user-agent", super::UA)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| anyhow!("Could not fetch the Linux app manifest: {}", e))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let status = res.status();
    if !status.is_success() {
        return Err(anyhow!(
            "App manifest request failed ({} {})",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ));
    }
    Ok(Some(serde_json::from_str(&res.text().await?)?))
}

/// Update the installed app at `root` in place.
pub async fn update(root: &Path, current: &Version, dry_run: bool, background: bool) -> Result<()> {
    let published = fetch_manifest(Duration::from_secs(10)).await?;
    let latest = published
        .as_ref()
        .map(|manifest| {
            Version::parse(&manifest.version).map_err(|e| {
                anyhow!(
                    "Could not parse the published app version {:?}: {}",
                    manifest.version,
                    e
                )
            })
        })
        .transpose()?;

    // Keep the cache honest even when this install can't apply the update: it is
    // what the dashboard and the outdated warning read.
    if let Some(latest) = &latest {
        super::write_check_cache(&latest.to_string());
    }

    let Some((manifest, latest)) = published
        .zip(latest)
        .filter(|(_, latest)| super::is_outdated(current, latest))
    else {
        if !background {
            println!("OpenResearch {} is up to date.", current);
        }
        return Ok(());
    };

    if dry_run {
        // Deliberately before the replaceability checks: reporting that a
        // release exists shouldn't require a writable install.
        println!(
            "OpenResearch {} → {} is available. Re-run without --dry-run to update.",
            current, latest
        );
        return Ok(());
    }

    ensure_replaceable(root)?;
    if !background {
        eprintln!("Updating OpenResearch {} → {} ...", current, latest);
    }

    // Stage beside the target so the final move is a same-filesystem rename.
    let parent = root
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", root.display()))?;
    // A kill or reboot mid-update leaves staging behind, and this runs
    // unattended for months — so clear any previous run's leftovers first.
    sweep_leftovers(parent, root);
    let staging = parent.join(format!(".openresearch-update-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging)
        .map_err(|e| anyhow!("Could not create {}: {}", staging.display(), e))?;

    let staged = match stage_verified_app(&manifest, &staging).await {
        Ok(staged) => staged,
        Err(err) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(err);
        }
    };

    let swapped = swap_app(root, &staged);
    let _ = std::fs::remove_dir_all(&staging);
    swapped?;

    super::record_installed(&latest.to_string());
    if !background {
        println!("✓ Updated OpenResearch {} → {}.", current, latest);
        println!("Restart the app to run the new version.");
    }
    Ok(())
}

/// Refuse installs where swapping the app dir is wrong or impossible. The
/// marker file guards the whole swap: an app root that lost it (extracted from
/// a foreign tarball, one the checksum should have rejected) is refused rather
/// than guessed at.
fn ensure_replaceable(root: &Path) -> Result<()> {
    if !root.join(super::LINUX_APP_MARKER).is_file() {
        return Err(anyhow!(
            "{} doesn't look like an OpenResearch Linux app install (no {} marker), \
             so the updater won't touch it.",
            root.display(),
            super::LINUX_APP_MARKER
        ));
    }
    let parent = root
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", root.display()))?;
    match super::probe_writable(parent) {
        Ok(()) => Ok(()),
        Err(e) => Err(anyhow!(
            "Can't write to {} ({e}), so OpenResearch can't update itself. \
             If you installed it with sudo, re-run the installer without sudo or \
             `sudo -u $USER` the update instead.",
            parent.display()
        )),
    }
}

/// Download the tarball, verify its checksum, extract it, and return the
/// staged app root.
async fn stage_verified_app(manifest: &AppManifest, staging: &Path) -> Result<PathBuf> {
    let archive = super::fetch_release_asset(
        &manifest.tag,
        &manifest.asset,
        Duration::from_secs(600),
    )
    .await?;

    let digest = format!("{:x}", Sha256::digest(&archive));
    if !digest.eq_ignore_ascii_case(manifest.sha256.trim()) {
        return Err(anyhow!(
            "The downloaded {} does not match the checksum published for {} \
             (expected {}, got {}). Nothing was installed.",
            manifest.asset,
            manifest.tag,
            manifest.sha256.trim(),
            digest
        ));
    }

    let tar = staging.join(&manifest.asset);
    std::fs::write(&tar, &archive)
        .map_err(|e| anyhow!("Could not write {}: {}", tar.display(), e))?;
    let status = tokio::process::Command::new("tar")
        .args(["-xzf"])
        .arg(&tar)
        .current_dir(staging)
        .status()
        .await
        .map_err(|e| anyhow!("Could not run tar: {e}"))?;
    let _ = std::fs::remove_file(&tar);
    if !status.success() {
        return Err(anyhow!("Could not extract {}", manifest.asset));
    }

    // The archive is `tar -czf ... openresearch` from dist/, so the extracted
    // app root is staging/openresearch. The marker guards against a tarball
    // that isn't ours (shouldn't pass the checksum, but never guess).
    let staged = staging.join("openresearch");
    if !staged.join(super::LINUX_APP_MARKER).is_file() {
        return Err(anyhow!(
            "{} did not contain an OpenResearch app (no {} marker). Nothing was installed.",
            manifest.asset,
            super::LINUX_APP_MARKER
        ));
    }
    Ok(staged)
}

/// Rename the old app aside, rename the staged app in, drop the backup, and
/// rewrite the `.desktop` Exec to the (stable) installed path. The old dir is
/// removed only after the new one is in place, so a crash between the moves
/// leaves a recoverable `root.old-*` rather than no app at all.
fn swap_app(root: &Path, staged: &Path) -> Result<()> {
    let parent = root
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", root.display()))?;
    let backup = parent.join(format!(
        ".openresearch-old-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::rename(root, &backup)
        .map_err(|e| anyhow!("Could not move {} aside: {}", root.display(), e))?;
    if let Err(err) = std::fs::rename(staged, root) {
        // Restore the previous install before reporting — failing the update
        // must not leave the user with no app at all.
        let _ = std::fs::rename(&backup, root);
        return Err(anyhow!("Could not move the new app into place: {err}"));
    }
    let _ = std::fs::remove_dir_all(&backup);

    rewrite_desktop_exec(root);
    Ok(())
}

/// Point the `.desktop` Exec at the app's real `bin/openresearch`. The packaged
/// file carries a placeholder prefix (the installer didn't know where this
/// install lives), so every swap and every install must rewrite it.
fn rewrite_desktop_exec(root: &Path) {
    let desktop = root
        .join("share")
        .join("applications")
        .join("openresearch.desktop");
    let Some(text) = std::fs::read_to_string(&desktop).ok() else {
        return;
    };
    let rewritten = text
        .lines()
        .map(|line| {
            if line.starts_with("Exec=") {
                format!("Exec={}/bin/openresearch", root.display())
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let _ = std::fs::write(&desktop, &rewritten);
    // The copy the installer placed in the user's menu needs the same fix.
    if let Some(home) = dirs::home_dir() {
        let menu = home
            .join(".local")
            .join("share")
            .join("applications")
            .join("openresearch.desktop");
        if menu.is_file() {
            let _ = std::fs::write(&menu, &rewritten);
        }
    }
}

/// Remove stale staging/backup dirs from a previously interrupted update.
fn sweep_leftovers(parent: &Path, root: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if (name.starts_with(".openresearch-update-")
            || name.starts_with(".openresearch-old-"))
            && entry.path() != root
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_desktop_exec_pins_the_installed_root() {
        let dir = std::env::temp_dir().join(format!("orx-desktop-{}", std::process::id()));
        let root = dir.join("openresearch");
        let desktop = root.join("share").join("applications");
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::write(
            desktop.join("openresearch.desktop"),
            "[Desktop Entry]\nName=OpenResearch\nExec=__PREFIX__/bin/openresearch\nTerminal=false\n",
        )
        .unwrap();

        rewrite_desktop_exec(&root);

        let text = std::fs::read_to_string(desktop.join("openresearch.desktop")).unwrap();
        assert!(
            text.contains(&format!("Exec={}/bin/openresearch", root.display())),
            "Exec not rewritten: {text}"
        );
        assert!(!text.contains("__PREFIX__"));
        std::fs::remove_dir_all(&dir).ok();
    }
}