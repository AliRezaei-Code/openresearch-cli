//! Per-project artifacts directory — a plain folder on the user's machine
//! (`<data dir>/files/<project slug>/`). The filesystem is the source of
//! truth: no registry, no upload step. The dashboard's Artifacts tab is an
//! explorer over this folder. Files may live directly at the root or in any
//! user-chosen nested layout; no filename or directory name is reserved.
//!
//! Serving is contained to the artifacts dir: requested paths are relative
//! (`is_safe_rel_path`) and must still resolve inside it once symlinks are
//! followed (`resolve_contained`), so nothing outside can be listed, read,
//! or deleted through the API.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{anyhow, Result};
use crate::store::data_dir;

use super::model::LocalProject;

/// Files surfaced by the OS that aren't the user's or the agent's.
const IGNORED: &[&str] = &[".DS_Store", "Thumbs.db"];

/// Listing cap — a runaway directory shouldn't stall the 2Hz event loop.
const MAX_ENTRIES: usize = 2000;

/// `<data dir>/files/`. The physical name stays stable for compatibility even
/// though the product surface is called Artifacts. A pre-v0.1.48 `artifacts/`
/// root is still migrated in place when no `files/` root exists; when both
/// exist, `files/` remains authoritative and the legacy root is untouched.
fn files_root() -> PathBuf {
    let root = data_dir().join("files");
    let legacy = data_dir().join("artifacts");
    if !root.exists() && legacy.is_dir() {
        // Same filesystem (sibling dirs), so a plain rename; on failure fall
        // through — ensure_dir will create the new root and the legacy dir
        // simply stops being served.
        let _ = std::fs::rename(&legacy, &root);
    }
    root
}

/// `<data dir>/files/<slug>/` — slugs are unique per store and filesystem-safe.
pub fn files_dir(project: &LocalProject) -> PathBuf {
    files_root().join(&project.slug)
}

/// The artifacts dir as the UI sees it, for recognizing artifact paths in chat
/// links. Deliberately NOT canonicalized: the absolute path the agent inlines
/// into the transcript comes from the un-canonicalized `files_dir` (the
/// `{artifacts}` playbook token in `opencode.rs` and the `orx report` guidance),
/// so the surfaced string must match it byte-for-byte or the UI's prefix match
/// misses on symlinked data dirs (e.g. `/tmp` → `/private/tmp`).
pub fn files_dir_display(project: &LocalProject) -> String {
    files_dir(project).to_string_lossy().into_owned()
}

/// Create the project's artifacts dir if missing and return it.
pub fn ensure_dir(project: &LocalProject) -> Result<PathBuf> {
    let dir = files_dir(project);
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow!("Could not create {}: {}", dir.display(), e))?;
    Ok(dir)
}

/// Relative, no `..`/`.` segments, no backslashes — a requested path can't
/// escape the artifacts dir. Lexical only; symlink containment is enforced by
/// `resolve_contained`.
pub fn is_safe_rel_path(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && !p.contains('\\')
        && !p
            .split('/')
            .any(|seg| seg == ".." || seg == "." || seg.is_empty())
}

/// True when `path` resolves (following symlinks) to a location inside
/// `canonical_base`. Anything that fails to resolve is treated as outside.
fn resolves_inside(canonical_base: &Path, path: &Path) -> bool {
    path.canonicalize()
        .map(|c| c.starts_with(canonical_base))
        .unwrap_or(false)
}

/// Metadata for a listed entry: an escaping symlink yields `None` (skip), a
/// contained symlink its *followed* target metadata (`DirEntry::metadata`
/// never follows links). Shared by the tree walk and the fingerprint so both
/// see exactly the same entries.
fn followed_metadata(
    canonical_base: &Path,
    entry: &std::fs::DirEntry,
) -> Option<std::fs::Metadata> {
    let ft = entry.file_type().ok()?;
    if ft.is_symlink() {
        if !resolves_inside(canonical_base, &entry.path()) {
            return None;
        }
        std::fs::metadata(entry.path()).ok()
    } else {
        entry.metadata().ok()
    }
}

/// Join `rel_path` onto `base` and resolve it, requiring the result to stay
/// inside `base` once every symlink is followed. `is_safe_rel_path` already
/// blocks lexical escapes (`..`); this closes the remaining hole — a symlink
/// inside the dir pointing outside it. Internal symlinks still work.
///
/// Check and use are separate syscalls, so a link swapped in between could
/// still escape — accepted: the API is localhost-only and the artifacts dir is
/// written by the same user it would expose.
fn resolve_contained(base: &Path, rel_path: &str) -> Result<PathBuf> {
    if !is_safe_rel_path(rel_path) {
        return Err(anyhow!("invalid file path: {rel_path}"));
    }
    let canonical_base = base
        .canonicalize()
        .map_err(|e| anyhow!("Could not resolve {}: {}", base.display(), e))?;
    let path = canonical_base.join(rel_path);
    let canonical = path
        .canonicalize()
        .map_err(|e| anyhow!("Could not read {}: {}", path.display(), e))?;
    if !canonical.starts_with(&canonical_base) {
        return Err(anyhow!("path escapes the artifacts directory: {rel_path}"));
    }
    Ok(canonical)
}

/// Best-effort content type from a file extension (serving files).
pub fn content_type_for_path(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("md") => "text/markdown; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("json") => "application/json",
        Some("csv") => "text/csv",
        Some("txt") => "text/plain; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// One node of the artifacts tree: a file or a directory with its children.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub name: String,
    /// Directory-relative, `/`-joined — the id for read/delete endpoints.
    pub path: String,
    pub is_dir: bool,
    /// 0 for directories.
    pub size: u64,
    pub modified_at: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ArtifactEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactsListing {
    /// Absolute path of the artifacts dir, shown in the UI so the user can
    /// write or drop files into it.
    pub dir: String,
    pub entries: Vec<ArtifactEntry>,
    pub truncated: bool,
}

fn mtime_ms(md: &std::fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_ignored(name: &str) -> bool {
    name.starts_with('.') || IGNORED.contains(&name)
}

/// Recursively build the tree under `dir`, counting nodes against
/// `MAX_ENTRIES`. Returns (children, hit_cap). Symlinks resolving outside
/// `canonical_base` are skipped — the serve endpoints would refuse them.
fn collect_tree(
    canonical_base: &Path,
    dir: &Path,
    rel_prefix: &str,
    seen: &mut usize,
) -> (Vec<ArtifactEntry>, bool) {
    let mut out = Vec::new();
    let mut truncated = false;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (out, false);
    };
    for entry in entries.flatten() {
        if *seen >= MAX_ENTRIES {
            return (out, true);
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) {
            continue;
        }
        let Some(md) = followed_metadata(canonical_base, &entry) else {
            continue;
        };
        *seen += 1;
        let rel = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if md.is_dir() {
            let (children, hit) = collect_tree(canonical_base, &entry.path(), &rel, seen);
            truncated |= hit;
            out.push(ArtifactEntry {
                name,
                path: rel,
                is_dir: true,
                size: 0,
                modified_at: mtime_ms(&md),
                children,
            });
        } else if md.is_file() {
            out.push(ArtifactEntry {
                name,
                path: rel,
                is_dir: false,
                size: md.len(),
                modified_at: mtime_ms(&md),
                children: Vec::new(),
            });
        }
    }
    // Dirs first, then files, each alphabetical — stable explorer order.
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    (out, truncated)
}

/// Scan the artifacts dir (creating it if missing) into a plain file tree.
pub fn list(project: &LocalProject) -> Result<ArtifactsListing> {
    let dir = ensure_dir(project)?;
    let canonical = dir
        .canonicalize()
        .map_err(|e| anyhow!("Could not resolve {}: {}", dir.display(), e))?;
    let mut seen = 0;
    let (entries, truncated) = collect_tree(&canonical, &canonical, "", &mut seen);
    Ok(ArtifactsListing {
        dir: dir.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

/// One file in the artifacts dir, by directory-relative path.
pub fn read_file(project: &LocalProject, rel_path: &str) -> Result<Vec<u8>> {
    let path = resolve_contained(&files_dir(project), rel_path)?;
    std::fs::read(&path).map_err(|e| anyhow!("Could not read {}: {}", path.display(), e))
}

/// Delete a file or folder in the artifacts dir.
///
/// The final component is deleted literally — a symlink is removed, never
/// followed — but every parent segment must resolve inside the artifacts dir, or
/// `a/b` with `a -> /elsewhere` would delete outside it.
pub fn delete_entry(project: &LocalProject, rel_path: &str) -> Result<()> {
    if !is_safe_rel_path(rel_path) {
        return Err(anyhow!("invalid file path: {rel_path}"));
    }
    let base = files_dir(project);
    let parent = match rel_path.rsplit_once('/') {
        Some((parent_rel, _)) => resolve_contained(&base, parent_rel)?,
        None => base
            .canonicalize()
            .map_err(|e| anyhow!("Could not resolve {}: {}", base.display(), e))?,
    };
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let path = parent.join(name);
    let md = std::fs::symlink_metadata(&path)
        .map_err(|e| anyhow!("Could not stat {}: {}", path.display(), e))?;
    if md.is_dir() {
        std::fs::remove_dir_all(&path)
    } else {
        std::fs::remove_file(&path)
    }
    .map_err(|e| anyhow!("Could not delete {}: {}", path.display(), e))
}

/// Cheap change fingerprint (paths + sizes + mtimes) for the SSE diff loop.
/// A missing dir hashes to a stable value, so first creation is a change.
pub fn fingerprint(project: &LocalProject) -> u64 {
    let mut hasher = DefaultHasher::new();
    if let Ok(canonical) = files_dir(project).canonicalize() {
        hash_dir(&canonical, &canonical, &mut hasher, &mut 0);
    }
    hasher.finish()
}

/// Hash the tree under `dir`, skipping (like `collect_tree`) symlinks that
/// resolve outside `base`, so the fingerprint tracks exactly what's listed.
fn hash_dir(base: &Path, dir: &Path, hasher: &mut DefaultHasher, seen: &mut usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *seen >= MAX_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_ignored(&name) {
            continue;
        }
        let Some(md) = followed_metadata(base, &entry) else {
            continue;
        };
        *seen += 1;
        if let Ok(rel) = entry.path().strip_prefix(base) {
            rel.to_string_lossy().hash(hasher);
        }
        if md.is_dir() {
            hash_dir(base, &entry.path(), hasher, seen);
        } else {
            md.len().hash(hasher);
            mtime_ms(&md).hash(hasher);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// Fresh scratch dir with a `base/` (the artifacts dir under test) and an
    /// `outside/` holding a file symlinks will try to escape to.
    fn scratch() -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("orx-files-{}", uuid::Uuid::new_v4()));
        let base = root.join("base");
        let outside = root.join("outside");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "secret").unwrap();
        (root, base, outside)
    }

    #[test]
    fn rejects_lexical_escapes() {
        let (root, base, _) = scratch();
        for bad in ["../x", "/etc/passwd", "a/../b", "a/./b", "", "a\\b"] {
            assert!(resolve_contained(&base, bad).is_err(), "accepted {bad:?}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn blocks_symlink_file_escape() {
        let (root, base, outside) = scratch();
        symlink(outside.join("secret.txt"), base.join("link.txt")).unwrap();
        assert!(resolve_contained(&base, "link.txt").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn blocks_symlink_dir_escape() {
        let (root, base, outside) = scratch();
        symlink(&outside, base.join("sub")).unwrap();
        assert!(resolve_contained(&base, "sub/secret.txt").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn allows_internal_symlink() {
        let (root, base, _) = scratch();
        std::fs::write(base.join("real.txt"), "data").unwrap();
        symlink("real.txt", base.join("alias.txt")).unwrap();
        let resolved = resolve_contained(&base, "alias.txt").unwrap();
        assert_eq!(std::fs::read_to_string(resolved).unwrap(), "data");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn allows_regular_files() {
        let (root, base, _) = scratch();
        std::fs::create_dir(base.join("exp")).unwrap();
        std::fs::write(base.join("exp/report.md"), "# T").unwrap();
        assert!(resolve_contained(&base, "exp/report.md").is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn listing_skips_escaping_symlinks_keeps_internal() {
        let (root, base, outside) = scratch();
        std::fs::write(base.join("real.txt"), "data").unwrap();
        symlink("real.txt", base.join("alias.txt")).unwrap();
        symlink(outside.join("secret.txt"), base.join("leak.txt")).unwrap();
        symlink(&outside, base.join("leakdir")).unwrap();
        let canonical = base.canonicalize().unwrap();
        let (entries, truncated) = collect_tree(&canonical, &canonical, "", &mut 0);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["alias.txt", "real.txt"]);
        assert!(!truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn listing_gives_project_and_experiment_names_no_special_order() {
        let (root, base, _) = scratch();
        for name in ["project", "baseline", "notes"] {
            std::fs::create_dir(base.join(name)).unwrap();
        }
        std::fs::write(base.join("summary.md"), "# Summary").unwrap();
        let canonical = base.canonicalize().unwrap();
        let (entries, truncated) = collect_tree(&canonical, &canonical, "", &mut 0);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, ["baseline", "notes", "project", "summary.md"]);
        assert!(!truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn report_md_is_an_ordinary_nested_file() {
        let (root, base, _) = scratch();
        std::fs::create_dir(base.join("exp")).unwrap();
        std::fs::write(base.join("exp/analysis.md"), "# Analysis").unwrap();
        std::fs::write(base.join("exp/report.md"), "# Report").unwrap();
        let canonical = base.canonicalize().unwrap();
        let (entries, _) = collect_tree(&canonical, &canonical, "", &mut 0);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "exp");
        let names: Vec<&str> = entries[0]
            .children
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["analysis.md", "report.md"]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
