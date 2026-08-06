import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Code,
  FileText,
  FolderOpen,
  MousePointerClick,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  artifactUrl,
  deleteArtifact,
  fmtBytes,
  type ArtifactEntry,
  type Project,
  type ProjectArtifacts,
} from "../api";
import { CodeView } from "./CodeView";
import { mdCodeComponents, normalizeMathDelimiters, remarkMathOptions } from "./Md";

/** Any href with a URI scheme (https:, mailto:, data:, …) or a
 * protocol-relative // — i.e. not an artifact-relative path to resolve. */
function isExternalSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
}

/** Resolve a Markdown target within the artifacts root. URL suffixes stay
 * outside the encoded filesystem path, and upward escapes are rejected. */
function artifactTargetUrl(projectId: string, folder: string, src: string): string | null {
  const hashAt = src.indexOf("#");
  const beforeHash = hashAt === -1 ? src : src.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : src.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const pathname = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
  const parts = pathname.startsWith("/")
    ? []
    : folder.split("/").filter((part) => part.length > 0);

  for (const part of pathname.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  const path = parts.join("/");
  if (!path) return null;
  const queryParams = new URLSearchParams(query);
  queryParams.delete("path");
  const querySuffix = queryParams.toString();
  return `${artifactUrl(projectId, path)}${querySuffix ? `&${querySuffix}` : ""}${hash}`;
}

/** Drop a leading YAML frontmatter block so it doesn't render as markdown. */
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  return end === -1 ? md : md.slice(end + 4).replace(/^\r?\n/, "");
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const MD_RE = /\.(md|mdx|markdown)$/i;
/** Raw text preview cap — matches the repo file viewer's truncation cap. */
const MAX_TEXT_PREVIEW = 512 * 1024;

/** Tree pane width: draggable divider, persisted across reloads. */
const TREE_WIDTH_KEY = "orx:files-tree-width";
const COLLAPSED_DIRS_KEY_PREFIX = "orx:artifacts-collapsed:";
const TREE_MIN_WIDTH = 180;
const TREE_MAX_WIDTH = 560;
const TREE_DEFAULT_WIDTH = 280;

function initialTreeWidth(): number {
  try {
    const w = Number(localStorage.getItem(TREE_WIDTH_KEY));
    if (Number.isFinite(w) && w >= TREE_MIN_WIDTH && w <= TREE_MAX_WIDTH) return w;
  } catch {
    // storage unavailable — fall through to the default
  }
  return TREE_DEFAULT_WIDTH;
}

function initialCollapsed(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${COLLAPSED_DIRS_KEY_PREFIX}${projectId}`);
    if (!raw) return new Set();
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((path): path is string => typeof path === "string"));
  } catch {
    return new Set();
  }
}

/** Depth-first lookup of a tree entry by its directory-relative path. */
function findEntry(entries: ArtifactEntry[], path: string): ArtifactEntry | null {
  for (const e of entries) {
    if (e.path === path) return e;
    if (e.isDir && path.startsWith(e.path + "/")) {
      const hit = findEntry(e.children ?? [], path);
      if (hit) return hit;
    }
  }
  return null;
}

/** Artifact markdown with relative image/link paths rewritten to the raw
 * artifact endpoint, scoped to the markdown file's parent directory. */
export function ArtifactMarkdown({
  projectId,
  folder,
  markdown,
}: {
  projectId: string;
  folder: string;
  markdown: string;
}) {
  const resolve = (src: string) => {
    if (isExternalSrc(src)) return src;
    return artifactTargetUrl(projectId, folder, src);
  };
  return (
    <div className="md artifact-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, remarkMathOptions]]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // In-page anchors (headings, GFM footnotes) keep their hash href
          // and stay in the page; everything else resolves + opens a tab.
          a: ({ href, children, ...rest }) => {
            const isHash = !href || href.startsWith("#");
            const resolved = isHash ? href : resolve(href);
            if (!resolved) return <span>{children}</span>;
            return (
              <a
                {...rest}
                href={resolved}
                {...(isHash ? {} : { target: "_blank", rel: "noopener noreferrer" })}
              >
                {children}
              </a>
            );
          },
          img: ({ src, alt }) => {
            if (!src || typeof src !== "string") return null;
            const url = resolve(src);
            if (!url) return null;
            return (
              <a href={url} target="_blank" rel="noopener noreferrer" className="artifact-img">
                <img src={url} alt={alt ?? ""} loading="lazy" />
                {alt && <span className="artifact-img-caption">{alt}</span>}
              </a>
            );
          },
          ...mdCodeComponents,
        }}
      >
        {normalizeMathDelimiters(stripFrontmatter(markdown))}
      </ReactMarkdown>
    </div>
  );
}

type PreviewKind = "markdown" | "image" | "pdf" | "text";

function previewKind(entry: ArtifactEntry): PreviewKind {
  if (MD_RE.test(entry.name)) return "markdown";
  if (IMAGE_RE.test(entry.name)) return "image";
  if (/\.pdf$/i.test(entry.name)) return "pdf";
  return "text";
}

/** Fetched body for kinds that need text: markdown or raw text.
 * `binary` flags NUL bytes so we don't dump garbage into a <pre>. */
function useTextBody(projectId: string, entry: ArtifactEntry, kind: PreviewKind) {
  const [text, setText] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wantsText = kind === "markdown" || (kind === "text" && entry.size <= MAX_TEXT_PREVIEW);

  useEffect(() => {
    // Reset before the wantsText guard: a refire on the same mounted entry
    // (modifiedAt changed — file rewritten on disk) must not leave the
    // previous body or binary/error flags behind.
    setText(null);
    setBinary(false);
    setError(null);
    if (!wantsText) return;
    let cancelled = false;
    const load = fetch(artifactUrl(projectId, entry.path)).then((r) => {
      if (!r.ok) throw new Error(`Failed to load artifact (${r.status})`);
      return r.text();
    });
    load
      .then((body) => {
        if (cancelled) return;
        if (body.includes("\u0000")) setBinary(true);
        else setText(body);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, entry.path, entry.modifiedAt, kind, wantsText]);

  return { text, binary, error, wantsText };
}

/** Right pane: the selected artifact rendered inline — markdown as a document,
 * images/PDFs directly, and everything else as code. */
function PreviewPane({
  projectId,
  entry,
  onDelete,
}: {
  projectId: string;
  entry: ArtifactEntry;
  onDelete: (path: string) => void;
}) {
  const kind = previewKind(entry);
  const { text, binary, error, wantsText } = useTextBody(projectId, entry, kind);
  const [showSource, setShowSource] = useState(false);
  const isDoc = kind === "markdown";
  const mdFolder = entry.path.split("/").slice(0, -1).join("/");
  const rawUrl = artifactUrl(projectId, entry.path);

  let body: ReactNode;
  if (kind === "image") {
    body = (
      <a className="fpreview-image" href={rawUrl} target="_blank" rel="noopener noreferrer">
        <img src={rawUrl} alt={entry.name} />
      </a>
    );
  } else if (kind === "pdf") {
    body = <iframe className="fpreview-pdf" title={entry.name} src={rawUrl} />;
  } else if (!wantsText || binary) {
    body = (
      <div className="file-view-note">
        {binary ? "Binary file — no inline preview." : "File too large to preview inline."}{" "}
        <a href={rawUrl} target="_blank" rel="noopener noreferrer">
          Open raw
        </a>
      </div>
    );
  } else if (error) {
    body = <div className="file-view-note">Failed to load: {error}</div>;
  } else if (text === null) {
    body = (
      <div className="settings-loading">
        <span className="spinner" /> Loading…
      </div>
    );
  } else if (isDoc && !showSource) {
    body = <ArtifactMarkdown projectId={projectId} folder={mdFolder} markdown={text} />;
  } else {
    body = <CodeView text={text} path={entry.path} />;
  }

  return (
    // `file-view` scopes the shared syntax-token colors onto the code view.
    <div className="fpreview file-view">
      <div className="fpreview-head">
        <FileText size={13} style={{ flexShrink: 0 }} />
        <code className="fpreview-path" title={entry.path}>
          {entry.path}
        </code>
        <span className="fpreview-date">
          Modified{" "}
          {new Date(entry.modifiedAt).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
        {kind === "text" && (
          <span className="fpreview-size">{fmtBytes(entry.size)}</span>
        )}
        {isDoc && (
          <button
            className={`icon-btn ${showSource ? "active" : ""}`}
            data-tip={showSource ? "Rendered view" : "View source"}
            data-tip-align="end"
            aria-label={showSource ? "Rendered view" : "View source"}
            onClick={() => setShowSource((s) => !s)}
          >
            <Code size={13} />
          </button>
        )}
        <a
          className="icon-btn"
          href={rawUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-tip="Open raw in new tab"
          data-tip-align="end"
          aria-label="Open raw in new tab"
        >
          <ExternalLink size={13} />
        </a>
        <button
          className="icon-btn"
          data-tip="Delete artifact"
          data-tip-align="end"
          aria-label="Delete artifact"
          onClick={() => {
            if (window.confirm(`Delete "${entry.path}" from the artifacts directory?`))
              onDelete(entry.path);
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className={`fpreview-body ${isDoc && !showSource ? "doc" : ""}`}>{body}</div>
    </div>
  );
}

function TreeRows({
  projectId,
  entries,
  depth,
  collapsed,
  selected,
  onToggle,
  onSelect,
  onDelete,
}: {
  projectId: string;
  entries: ArtifactEntry[];
  depth: number;
  collapsed: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  return (
    <>
      {entries.map((e) => {
        const indent = { paddingLeft: 8 + depth * 14 };
        if (e.isDir) {
          const open = !collapsed.has(e.path);
          return (
            <div key={e.path}>
              <div className="ft-row" style={indent} onClick={() => onToggle(e.path)}>
                <button
                  className={`ft-chevron ${open ? "open" : ""}`}
                  aria-label={open ? `Collapse ${e.name}` : `Expand ${e.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onToggle(e.path);
                  }}
                >
                  <ChevronRight size={12} />
                </button>
                <span className="ft-dirname">{e.name}/</span>
                <button
                  className="icon-btn ft-row-delete"
                  data-tip="Delete folder"
                  data-tip-align="end"
                  aria-label={`Delete folder ${e.name}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (window.confirm(`Delete "${e.path}" from the artifacts directory?`))
                      onDelete(e.path);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {open && (e.children?.length ?? 0) > 0 && (
                <TreeRows
                  projectId={projectId}
                  entries={e.children ?? []}
                  depth={depth + 1}
                  collapsed={collapsed}
                  selected={selected}
                  onToggle={onToggle}
                  onSelect={onSelect}
                  onDelete={onDelete}
                />
              )}
            </div>
          );
        }

        return (
          <div
            key={e.path}
            className={`ft-row file ${selected === e.path ? "selected" : ""}`}
            style={indent}
            title={e.path}
            onClick={() => onSelect(e.path)}
          >
            <span className="ft-chevron spacer" />
            {IMAGE_RE.test(e.name) && (
              <img className="ft-thumb" src={artifactUrl(projectId, e.path)} alt="" loading="lazy" />
            )}
            <span className="ft-name">{e.name}</span>
          </div>
        );
      })}
    </>
  );
}

/** The artifacts directory path, copyable in the tree footer. */
function DirFooter({ dir, onOpenStorage }: { dir: string; onOpenStorage: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ftree-footer" title={dir}>
      <code>{dir}</code>
      <button
        className="icon-btn tip-up"
        data-tip={copied ? "Copied!" : "Copy path"}
        aria-label="Copy artifacts directory path"
        onClick={() => {
          void navigator.clipboard?.writeText(dir);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <button
        className="icon-btn tip-up"
        data-tip="Storage settings"
        data-tip-align="end"
        aria-label="Storage settings"
        onClick={onOpenStorage}
      >
        <Settings2 size={12} />
      </button>
    </div>
  );
}

/** Middle-pane Artifacts tab — a split explorer over the project's durable outputs
 * on disk. Tree on the left; the selected entry renders inline on the right
 * (markdown as documents, images and PDFs directly, code as highlighted source). */
export function ArtifactsTab({
  project,
  artifacts,
  onChanged,
  onOpenStorage,
}: {
  project: Project;
  artifacts: ProjectArtifacts | null;
  onChanged: () => void;
  /** Navigate to Settings → Storage (where the data dir can be changed). */
  onOpenStorage: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // Folders are open by default — including ones that appear later — so this
  // tracks what the user closed instead.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapsed(project.id));
  const [treeWidth, setTreeWidth] = useState(initialTreeWidth);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(
        `${COLLAPSED_DIRS_KEY_PREFIX}${project.id}`,
        JSON.stringify([...collapsed]),
      );
    } catch {
      // best-effort persistence
    }
  }, [project.id, collapsed]);

  // Drag the divider to resize the tree pane; width persists across reloads.
  // Mirrors App's right-panel resizer: capture the pointer so views under the
  // cursor don't steal the drag, and suppress text selection while dragging.
  const resizeTree = (e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const left = treeRef.current?.getBoundingClientRect().left ?? 0;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const w = Math.round(ev.clientX - left);
      const clamped = Math.min(Math.max(w, TREE_MIN_WIDTH), TREE_MAX_WIDTH);
      setTreeWidth(clamped);
      try {
        localStorage.setItem(TREE_WIDTH_KEY, String(clamped));
      } catch {
        // best-effort persistence
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.userSelect = prevUserSelect;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  // Clear a selection that vanished or became a directory on disk.
  useEffect(() => {
    if (!selected || !artifacts) return;
    const entry = findEntry(artifacts.entries, selected);
    if (!entry || entry.isDir) setSelected(null);
  }, [selected, artifacts]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const remove = (path: string) => {
    if (selected === path || selected?.startsWith(path + "/")) setSelected(null);
    void deleteArtifact(project.id, path)
      .catch(() => {})
      .finally(onChanged);
  };

  if (!artifacts) {
    return (
      <div className="files-tab">
        <div className="settings-loading" style={{ padding: 20 }}>
          <span className="spinner" /> Loading artifacts…
        </div>
      </div>
    );
  }

  const tree = (entries: ArtifactEntry[]) => (
    <TreeRows
      projectId={project.id}
      entries={entries}
      depth={0}
      collapsed={collapsed}
      selected={selected}
      onToggle={toggle}
      onSelect={setSelected}
      onDelete={remove}
    />
  );
  const selectedEntry = selected ? findEntry(artifacts.entries, selected) : null;

  if (artifacts.entries.length === 0) {
    return (
      <div className="files-tab">
        <div className="files-empty-state">
          <FolderOpen size={28} strokeWidth={1.5} />
          <h3>No artifacts yet</h3>
          <p>
            This is the project's durable output space for reports, figures, images, CSVs, PDFs,
            and other research artifacts. Ask the agent for a write-up or add your own files:
          </p>
          <DirFooter dir={artifacts.dir} onOpenStorage={onOpenStorage} />
        </div>
      </div>
    );
  }

  return (
    <div className="files-tab">
      <div className="ftree-pane" ref={treeRef} style={{ width: treeWidth }}>
        <div className="ftree-resizer" onPointerDown={resizeTree} />
        <div className="ftree-scroll">
          {tree(artifacts.entries)}
          {artifacts.truncated && (
            <p className="files-truncated">Listing truncated — the folder has more artifacts.</p>
          )}
        </div>
        <DirFooter dir={artifacts.dir} onOpenStorage={onOpenStorage} />
      </div>
      {selectedEntry ? (
        // Keyed by path so per-file view state (source toggle, fetched body)
        // starts fresh on every selection instead of leaking across artifacts.
        <PreviewPane
          key={selectedEntry.path}
          projectId={project.id}
          entry={selectedEntry}
          onDelete={remove}
        />
      ) : (
        <div className="fpreview fpreview-none">
          <MousePointerClick size={22} strokeWidth={1.5} />
          <span>Click an artifact to view it</span>
        </div>
      )}
    </div>
  );
}
