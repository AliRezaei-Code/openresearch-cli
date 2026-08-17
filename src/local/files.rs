//! Per-project artifacts directory — a plain folder on the user's machine
//! (`<data dir>/files/<project slug>/`). The filesystem is the source of
//! truth: no registry, no upload step. The dashboard's Artifacts tab is an
//! explorer over this folder. Files may live directly at the root or in any
//! user-chosen nested layout. Root-level `PROJECT.md` is reserved for the
//! lightweight project brief that OpenResearch keeps visible in Artifacts.
//!
//! Serving is contained to the artifacts dir: requested paths are relative
//! (`is_safe_rel_path`) and must still resolve inside it once symlinks are
//! followed (`resolve_contained`), so nothing outside can be listed, read,
//! or deleted through the API.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{anyhow, Result};
use crate::store::data_dir;

use super::model::LocalProject;

/// Files surfaced by the OS that aren't the user's or the agent's.
const IGNORED: &[&str] = &[".DS_Store", "Thumbs.db"];

pub const PROJECT_BRIEF_NAME: &str = "PROJECT.md";
pub const MAX_PROJECT_BRIEF_BYTES: usize = 256 * 1024;

pub fn is_project_brief_path(path: &str) -> bool {
    path.eq_ignore_ascii_case(PROJECT_BRIEF_NAME)
}

const PROJECT_BRIEF_TEMPLATE: &str = "# Objective\n\nNot defined yet.\n\n# Current Project Summary\n\nNo project summary yet.\n\n# Important Highlights\n\n- None yet.\n\n# Future Experiments\n\n- None proposed yet.\n";

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
/// `{artifacts}` playbook token in `opencode.rs` and report-writing guidance),
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

pub(crate) fn ensure_project_brief_contents_at(dir: &Path, contents: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|e| anyhow!("Could not create {}: {}", dir.display(), e))?;
    let path = dir.join(PROJECT_BRIEF_NAME);
    match std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
    {
        Ok(mut file) => {
            if let Err(error) = file.write_all(contents.as_bytes()) {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(anyhow!("Could not write {}: {}", path.display(), error));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(anyhow!("Could not create {}: {}", path.display(), error));
        }
    }
    Ok(path)
}

fn ensure_project_brief_at(dir: &Path) -> Result<PathBuf> {
    ensure_project_brief_contents_at(dir, PROJECT_BRIEF_TEMPLATE)
}

pub fn ensure_project_brief(project: &LocalProject) -> Result<PathBuf> {
    ensure_project_brief_at(&files_dir(project))
}

fn read_project_brief_at(dir: &Path) -> Result<String> {
    let path = dir.join(PROJECT_BRIEF_NAME);
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PROJECT_BRIEF_TEMPLATE.to_string())
        }
        Err(error) => Err(anyhow!("Could not read {}: {}", path.display(), error)),
    }
}

pub fn read_project_brief(project: &LocalProject) -> Result<String> {
    read_project_brief_at(&files_dir(project))
}

fn write_project_brief_at(dir: &Path, content: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|e| anyhow!("Could not create {}: {}", dir.display(), e))?;
    let path = dir.join(PROJECT_BRIEF_NAME);
    let temporary = dir.join(format!(
        ".{PROJECT_BRIEF_NAME}.{}.tmp",
        uuid::Uuid::new_v4()
    ));
    if let Err(error) =
        std::fs::write(&temporary, content).and_then(|()| std::fs::rename(&temporary, &path))
    {
        let _ = std::fs::remove_file(&temporary);
        return Err(anyhow!("Could not write {}: {}", path.display(), error));
    }
    Ok(path)
}

pub fn write_project_brief(project: &LocalProject, content: &str) -> Result<PathBuf> {
    write_project_brief_at(&files_dir(project), content)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FilePresentation {
    Image,
    Audio,
    Video,
    Pdf,
    Text,
    Unknown,
    Download,
}

impl FilePresentation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
            Self::Video => "video",
            Self::Pdf => "pdf",
            Self::Text => "text",
            Self::Unknown => "unknown",
            Self::Download => "download",
        }
    }
}

/// Best-effort content type from a file extension (serving files).
pub fn content_type_for_path(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "md" | "markdown" | "mdx" => "text/markdown; charset=utf-8",
        "apng" => "image/apng",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "ico" => "image/x-icon",
        "jfif" | "jpg" | "jpeg" => "image/jpeg",
        "jxl" => "image/jxl",
        "pbm" => "image/x-portable-bitmap",
        "pgm" => "image/x-portable-graymap",
        "png" => "image/png",
        "pnm" => "image/x-portable-anymap",
        "ppm" => "image/x-portable-pixmap",
        "svg" => "image/svg+xml",
        "tif" | "tiff" => "image/tiff",
        "webp" => "image/webp",
        "aac" => "audio/aac",
        "aif" | "aiff" => "audio/aiff",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mid" | "midi" => "audio/midi",
        "mp3" => "audio/mpeg",
        "oga" | "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "wav" => "audio/wav",
        "weba" => "audio/webm",
        "3gp" => "video/3gpp",
        "avi" => "video/x-msvideo",
        "m4v" | "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "mpeg" | "mpg" => "video/mpeg",
        "ogv" => "video/ogg",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "eps" | "ps" => "application/postscript",
        "7z" => "application/x-7z-compressed",
        "bz2" => "application/x-bzip2",
        "gz" | "tgz" => "application/gzip",
        "rar" => "application/vnd.rar",
        "tar" => "application/x-tar",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "eot" => "application/vnd.ms-fontobject",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "json" | "jsonl" | "ipynb" => "application/json",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "txt" | "log" | "rst" | "bib" | "cfg" | "cmake" | "conf" | "dart" | "dockerignore"
        | "editorconfig" | "env" | "ex" | "exs" | "fs" | "fsx" | "gitattributes" | "gitignore"
        | "gitmodules" | "gql" | "graphql" | "gradle" | "hs" | "ini" | "jl" | "lock" | "lua"
        | "m" | "mm" | "nix" | "npmrc" | "properties" | "proto" | "qmd" | "r" | "rmd" | "swift"
        | "tex" => "text/plain; charset=utf-8",
        "htm" | "html" => "text/html; charset=utf-8",
        "xml" => "application/xml",
        "c" | "cc" | "cpp" | "cs" | "go" | "h" | "hpp" | "java" | "kt" | "php" | "pl" | "py"
        | "rb" | "rs" | "scala" | "sh" | "sql" | "toml" | "ts" | "tsx" | "vue" | "yaml" | "yml" => {
            "text/plain; charset=utf-8"
        }
        "css" => "text/css; charset=utf-8",
        "js" | "jsx" | "mjs" => "text/javascript; charset=utf-8",
        _ => "application/octet-stream",
    }
}

pub fn presentation_for_path(path: &str) -> FilePresentation {
    let content_type = content_type_for_path(path);
    if content_type.starts_with("image/") {
        FilePresentation::Image
    } else if content_type.starts_with("audio/") {
        FilePresentation::Audio
    } else if content_type.starts_with("video/") {
        FilePresentation::Video
    } else if content_type == "application/pdf" {
        FilePresentation::Pdf
    } else if content_type.starts_with("text/")
        || matches!(content_type, "application/json" | "application/xml")
        || matches!(
            path.rsplit('/')
                .next()
                .unwrap_or(path)
                .to_ascii_lowercase()
                .as_str(),
            "cargo.lock"
                | "dockerfile"
                | "gemfile"
                | "justfile"
                | "license"
                | "makefile"
                | "readme"
        )
        || path
            .rsplit('/')
            .next()
            .is_some_and(|name| name.starts_with(".env"))
    {
        FilePresentation::Text
    } else if content_type != "application/octet-stream" {
        FilePresentation::Download
    } else {
        FilePresentation::Unknown
    }
}

pub fn content_disposition_for_path(path: &str) -> &'static str {
    if matches!(
        presentation_for_path(path),
        FilePresentation::Download | FilePresentation::Unknown
    ) || matches!(
        content_type_for_path(path),
        "application/xml" | "text/html; charset=utf-8"
    ) {
        "attachment"
    } else {
        "inline"
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<FilePresentation>,
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

#[cfg(unix)]
fn same_file(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt as _;
    left.dev() == right.dev() && left.ino() == right.ino()
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
    let mut root_brief_metadata = None;
    if rel_prefix.is_empty() {
        let brief = dir.join(PROJECT_BRIEF_NAME);
        if resolves_inside(canonical_base, &brief) {
            if let Ok(md) = std::fs::metadata(&brief) {
                if md.is_file() {
                    *seen += 1;
                    out.push(ArtifactEntry {
                        name: PROJECT_BRIEF_NAME.to_string(),
                        path: PROJECT_BRIEF_NAME.to_string(),
                        is_dir: false,
                        size: md.len(),
                        modified_at: mtime_ms(&md),
                        presentation: Some(presentation_for_path(PROJECT_BRIEF_NAME)),
                        children: Vec::new(),
                    });
                    root_brief_metadata = Some(md);
                }
            }
        }
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (out, false);
    };
    for entry in entries.flatten() {
        if *seen >= MAX_ENTRIES {
            return (out, true);
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if rel_prefix.is_empty() && is_project_brief_path(&name) {
            if let (Some(brief), Ok(candidate)) = (
                root_brief_metadata.as_ref(),
                std::fs::metadata(entry.path()),
            ) {
                if same_file(brief, &candidate) {
                    continue;
                }
            }
        }
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
                presentation: None,
                children,
            });
        } else if md.is_file() {
            let presentation = presentation_for_path(&rel);
            out.push(ArtifactEntry {
                name,
                path: rel,
                is_dir: false,
                size: md.len(),
                modified_at: mtime_ms(&md),
                presentation: Some(presentation),
                children: Vec::new(),
            });
        }
    }
    // PROJECT.md is the durable project overview, so pin it above the ordinary
    // directory-first alphabetical tree at the artifacts root.
    out.sort_by(|a, b| {
        if rel_prefix.is_empty() {
            let a_brief = is_project_brief_path(&a.path);
            let b_brief = is_project_brief_path(&b.path);
            if a_brief != b_brief {
                return b_brief.cmp(&a_brief);
            }
        }
        b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name))
    });
    (out, truncated)
}

/// Scan the artifacts dir (creating it if missing) into a plain file tree.
pub fn list(project: &LocalProject) -> Result<ArtifactsListing> {
    let dir = ensure_dir(project)?;
    ensure_project_brief_at(&dir)?;
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

/// A contained artifact path suitable for streaming without buffering.
pub fn file_path(project: &LocalProject, rel_path: &str) -> Result<PathBuf> {
    resolve_contained(&files_dir(project), rel_path)
}

/// Delete a file or folder in the artifacts dir.
///
/// The final component is deleted literally — a symlink is removed, never
/// followed — but every parent segment must resolve inside the artifacts dir, or
/// `a/b` with `a -> /elsewhere` would delete outside it.
pub fn delete_entry(project: &LocalProject, rel_path: &str) -> Result<()> {
    if is_project_brief_path(rel_path) {
        return Err(anyhow!(
            "{PROJECT_BRIEF_NAME} is part of the project and cannot be deleted"
        ));
    }
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
    fn project_brief_is_pinned_above_directories() {
        let (root, base, _) = scratch();
        std::fs::create_dir(base.join("experiment")).unwrap();
        std::fs::write(base.join(PROJECT_BRIEF_NAME), "# Objective\n").unwrap();
        std::fs::write(base.join("notes.md"), "# Notes\n").unwrap();
        let canonical = base.canonicalize().unwrap();
        let (entries, truncated) = collect_tree(&canonical, &canonical, "", &mut 0);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, [PROJECT_BRIEF_NAME, "experiment", "notes.md"]);
        assert!(!truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_brief_is_listed_even_when_the_entry_cap_is_already_reached() {
        let (root, base, _) = scratch();
        std::fs::write(base.join(PROJECT_BRIEF_NAME), "# Objective\n").unwrap();
        std::fs::write(base.join("notes.md"), "# Notes\n").unwrap();
        let canonical = base.canonicalize().unwrap();
        let mut seen = MAX_ENTRIES;
        let (entries, truncated) = collect_tree(&canonical, &canonical, "", &mut seen);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, [PROJECT_BRIEF_NAME]);
        assert!(truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn case_variant_is_not_hidden_or_duplicated() {
        let (root, base, _) = scratch();
        std::fs::write(base.join("project.md"), "# Lowercase\n").unwrap();
        let expected_name = if base.join(PROJECT_BRIEF_NAME).exists() {
            PROJECT_BRIEF_NAME
        } else {
            "project.md"
        };
        let canonical = base.canonicalize().unwrap();
        let (entries, truncated) = collect_tree(&canonical, &canonical, "", &mut 0);
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, [expected_name]);
        assert!(!truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_brief_creation_preserves_existing_content() {
        let (root, base, _) = scratch();
        let path = ensure_project_brief_at(&base).unwrap();
        let initial = std::fs::read_to_string(&path).unwrap();
        assert_eq!(initial, PROJECT_BRIEF_TEMPLATE);

        std::fs::write(&path, "# My custom brief\n").unwrap();
        ensure_project_brief_at(&base).unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "# My custom brief\n"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reading_a_missing_brief_is_pure() {
        let (root, base, _) = scratch();
        assert_eq!(
            read_project_brief_at(&base).unwrap(),
            PROJECT_BRIEF_TEMPLATE
        );
        assert!(!base.join(PROJECT_BRIEF_NAME).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_brief_deletion_guard_is_case_insensitive() {
        assert!(is_project_brief_path(PROJECT_BRIEF_NAME));
        assert!(is_project_brief_path("project.md"));
        assert!(!is_project_brief_path("notes/PROJECT.md"));
    }

    #[test]
    fn project_brief_writes_replace_the_complete_file() {
        let (root, base, _) = scratch();
        ensure_project_brief_at(&base).unwrap();
        let path = write_project_brief_at(&base, "# Updated\n\nCurrent state.\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            "# Updated\n\nCurrent state.\n"
        );
        assert_eq!(
            std::fs::read_dir(&base)
                .unwrap()
                .filter_map(std::result::Result::ok)
                .count(),
            1
        );
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

    #[test]
    fn content_types_cover_browser_media_families() {
        for (path, expected_type, expected_presentation) in [
            ("figure.AVIF", "image/avif", FilePresentation::Image),
            ("figure.jpeg", "image/jpeg", FilePresentation::Image),
            (
                "figure.ppm",
                "image/x-portable-pixmap",
                FilePresentation::Image,
            ),
            ("figure.svg", "image/svg+xml", FilePresentation::Image),
            ("sample.flac", "audio/flac", FilePresentation::Audio),
            ("sample.m4a", "audio/mp4", FilePresentation::Audio),
            ("sample.webm", "video/webm", FilePresentation::Video),
            ("sample.mov", "video/quicktime", FilePresentation::Video),
            ("paper.pdf", "application/pdf", FilePresentation::Pdf),
            (
                "source.rs",
                "text/plain; charset=utf-8",
                FilePresentation::Text,
            ),
            (
                "Makefile",
                "application/octet-stream",
                FilePresentation::Text,
            ),
            (
                ".gitignore",
                "text/plain; charset=utf-8",
                FilePresentation::Text,
            ),
            (
                "Cargo.lock",
                "text/plain; charset=utf-8",
                FilePresentation::Text,
            ),
            (
                ".env.local",
                "application/octet-stream",
                FilePresentation::Text,
            ),
            (
                "archive.bin",
                "application/octet-stream",
                FilePresentation::Unknown,
            ),
            (
                "drawing.eps",
                "application/postscript",
                FilePresentation::Download,
            ),
        ] {
            assert_eq!(
                content_type_for_path(path),
                expected_type,
                "wrong type for {path}"
            );
            assert_eq!(presentation_for_path(path), expected_presentation);
        }
        assert_eq!(content_disposition_for_path("page.html"), "attachment");
        assert_eq!(content_disposition_for_path("figure.svg"), "inline");
    }
}
