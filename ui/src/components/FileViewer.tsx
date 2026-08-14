// Mirror of openresearch.sh's AgentFileView: one file from the project —
// a branch's committed copy when the tab carries a ref, else the chat
// session's worktree, else the hub clone, else the project's artifacts —
// refractor-highlighted, opened as a right-pane tab from chat tool rows or
// the code browser.

import { Code, ExternalLink, FileText, GitBranch, RotateCw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  artifactUrl,
  getArtifactFileMetadata,
  getArtifactFileText,
  getProjectFile,
  openFileInEditor,
  projectFileUrl,
  saveProjectFile,
  type CheckoutRoot,
  type ProjectFile,
} from "../api";
import { CodeView } from "./CodeView";
import { CodeEditor } from "./CodeEditor";
import { ArtifactMarkdown } from "./ArtifactsTab";
import { isMarkdownFile } from "./FileTypeIcon";
import { MediaPreview, mediaPreviewKind } from "./MediaPreview";
import { Md } from "./Md";
import { ICON_BUTTON_CLASS_NAME, SPINNER_CLASS_NAME } from "../styleClasses";

type ArtifactPreviewFile = Omit<ProjectFile, "root">;
type LoadedFile =
  | { source: "checkout"; file: ProjectFile }
  | { source: "artifact"; file: ArtifactPreviewFile; checkoutRoot?: CheckoutRoot };

export interface FileScrollPosition {
  top: number;
  left: number;
}

export function FileViewer({
  projectId,
  path,
  source = "repo",
  sessionId,
  gitRef,
  line,
  branchLabel,
  onOpenFile,
  scrollPosition,
  onScrollPositionChange,
  lineScrollRequest,
  onLineScrollRequestHandled,
}: {
  projectId: string;
  path: string;
  /** Which backend serves this file. "artifacts" reads the project's durable
   * output directory, else the repo/worktree checkout. */
  source?: "repo" | "artifacts";
  /** Chat session whose worktree holds the file (absent → hub clone).
   * Never set for tabs opened with source:"artifacts". */
  sessionId?: string;
  /** Branch whose committed copy to show — overrides the live checkout.
   * (Named gitRef because `ref` is reserved on React components.) */
  gitRef?: string;
  /** 1-based line to scroll to and highlight once the source renders. */
  line?: number;
  /** The git branch this file's contents came from (experiment branch, or the
   * baseline) — shown in the header so a code tab always names its branch. */
  branchLabel?: string;
  /** Open a linked file as another tab (rendered-markdown links). */
  onOpenFile?: (path: string, sessionId?: string, ref?: string) => void;
  scrollPosition?: FileScrollPosition;
  onScrollPositionChange?: (position: FileScrollPosition) => void;
  lineScrollRequest?: number;
  onLineScrollRequestHandled?: () => void;
}) {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const isArtifacts = source === "artifacts";
  // Markdown renders by default; the header toggle shows the raw source.
  const isMarkdown = isMarkdownFile(path);
  const artifactsFolder = path.split("/").slice(0, -1).join("/");
  const [showSource, setShowSource] = useState(false);
  // Live edit buffer for the code file. It IS the view for editable files (no
  // edit mode); it tracks the loaded content and diverges as the user types.
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef(scrollPosition);
  const data = loaded?.file ?? null;
  const mediaKind = mediaPreviewKind(data?.presentation);
  const viaArtifacts = loaded?.source === "artifact" && !isArtifacts;
  const artifactsMode = isArtifacts || loaded?.source === "artifact";
  // A file that exists in the live checkout on disk (not a committed branch tree
  // or an artifact) — the only source the write/open endpoints can resolve.
  const onDisk =
    !isArtifacts && !gitRef && loaded?.source === "checkout" && data != null && !data.notFound;
  // Editable = a live checkout text file. A session read that fell back to the
  // clone (root "clone" with a sessionId) is not the worktree it names, so it
  // stays read-only rather than silently editing another checkout; a truncated
  // read can't be saved whole, and binary/media have no text form.
  const editable =
    onDisk &&
    data != null &&
    !data.binary &&
    !data.truncated &&
    !mediaKind &&
    !(sessionId != null && loaded?.source === "checkout" && loaded.file.root === "clone");
  // The editor replaces the read-only view for editable files — except markdown,
  // which stays rendered until its source toggle is on.
  const showingEditor = editable && !(isMarkdown && !showSource);
  // A <textarea> normalizes line endings to LF, so track/compare the buffer in
  // LF and re-apply the file's original EOL on write (else a one-char edit to a
  // CRLF file rewrites every line).
  const baseline = useMemo(() => (data?.content ?? "").replace(/\r\n/g, "\n"), [data?.content]);
  const dirty = editable && draft !== baseline;

  // Reseed the buffer only on a genuine load/reload — skip the optimistic
  // baseline bump `save()` makes, so a keystroke typed mid-save isn't clobbered.
  const lastWriteRef = useRef<string | null>(null);
  useEffect(() => {
    const incoming = data?.content ?? "";
    if (lastWriteRef.current !== null && incoming === lastWriteRef.current) {
      lastWriteRef.current = null;
      return;
    }
    setDraft(incoming.replace(/\r\n/g, "\n"));
    setSaveError(null);
  }, [data?.content, path]);

  const save = async () => {
    if (!editable || data == null || !dirty || saving) return;
    const content = data.content.includes("\r\n") ? draft.replace(/\n/g, "\r\n") : draft;
    setSaving(true);
    setSaveError(null);
    try {
      await saveProjectFile(projectId, path, content, { sessionId });
      // Advance the baseline to what we wrote so `dirty` clears without a refetch;
      // mark it so the reseed effect ignores this self-inflicted change.
      lastWriteRef.current = content;
      setLoaded((prev) =>
        prev && prev.source === "checkout"
          ? { source: "checkout", file: { ...prev.file, content } }
          : prev,
      );
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const [openingEditor, setOpeningEditor] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  // Hand the file to the OS, which opens it in the user's default app for the
  // type (their editor for source files) — no picker.
  const openInEditor = async () => {
    setOpeningEditor(true);
    setEditorError(null);
    try {
      await openFileInEditor(projectId, path, { sessionId });
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpeningEditor(false);
    }
  };
  const rawUrlBase = artifactsMode
    ? artifactUrl(projectId, path)
    : projectFileUrl(projectId, path, { sessionId, ref: gitRef });
  const rawUrl = `${rawUrlBase}&v=${nonce}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Artifacts come from the compatibility /files endpoint (no session/branch);
    // repo files from the checkout-aware /file endpoint. All paths normalize
    // into the same ProjectFile-shaped `data` so the render body is shared.
    const fromArtifacts = async (): Promise<ArtifactPreviewFile> => {
      const metadata = await getArtifactFileMetadata(projectId, path);
      const wantsBody = metadata?.presentation === "text" || metadata?.presentation === "unknown";
      const body = metadata && wantsBody
        ? await getArtifactFileText(projectId, path)
        : null;
      const notFound = metadata === null || (wantsBody && body === null);
      return {
        // A missing artifact resolves to null → notFound, so it shows
        // the friendly copy rather than a raw error.
        path,
        content: body?.content ?? "",
        truncated: body?.truncated ?? false,
        binary: body?.binary ?? metadata?.presentation === "download",
        notFound,
        presentation: body
          ? (body.binary ? "download" : "text")
          : (metadata?.presentation ?? "download"),
      };
    };
    // A checkout path the /file endpoint doesn't have may still name an
    // artifact, so try that directory before declaring it missing. Branch tabs
    // do not fall back because a ref names a committed tree.
    const load: Promise<LoadedFile> = isArtifacts
      ? fromArtifacts().then((file) => ({ source: "artifact", file }))
      : getProjectFile(projectId, path, { sessionId, ref: gitRef }).then((d) =>
          d.notFound && !gitRef
            ? fromArtifacts().then((f) =>
                f.notFound
                  ? { source: "checkout", file: d }
                  : { source: "artifact", file: f, checkoutRoot: d.root },
              )
            : { source: "checkout", file: d },
        );
    load
      .then((next) => {
        if (cancelled) return;
        setLoaded(next);
        setError(null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, path, source, sessionId, gitRef, nonce]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const position = scrollPositionRef.current;
    if (!body || !data || !position) return;
    body.scrollTop = position.top;
    body.scrollLeft = position.left;
  }, [data]);

  const notFoundCopy = (d: LoadedFile) => {
    if (isArtifacts) return "Artifact not found in the project.";
    if (gitRef) return `File not found on branch ${gitRef}.`;
    if (sessionId && d.source === "checkout" && d.file.root === "clone")
      return "This session's worktree isn't available, and the file isn't in the project clone or its artifacts.";
    const root = d.source === "checkout" ? d.file.root : d.checkoutRoot;
    return `File not found in the ${root === "worktree" ? "session's worktree" : "project clone"} or the project's artifacts.`;
  };

  return (
    <div className="file-view flex flex-col h-full min-h-0">
      <div className="file-view-header flex items-center gap-2 py-1.5 px-3 border-b border-b-border-variant text-text shrink-0">
        <FileText size={13} style={{ flexShrink: 0 }} />
        <code className="file-view-path font-mono text-sm text-text flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={path}>
          {path}
        </code>
        {branchLabel && (
          <span className="file-view-branch inline-flex items-center gap-1 min-w-0 font-mono text-xs text-muted border border-border-variant rounded-sm py-px px-1.5 max-w-65 overflow-hidden text-ellipsis whitespace-nowrap shrink-0 [&_svg]:flex-none" title={`Branch: ${branchLabel}`}>
            <GitBranch size={11} />
            {branchLabel}
          </span>
        )}
        {showingEditor && (saving || dirty || saveError) && (
          <span
            className={`file-view-save-status inline-flex items-center gap-1 text-xs shrink-0 ${saveError ? "text-accent-red" : "text-muted"}`}
            title={saveError ?? (saving ? "Saving…" : "Unsaved — ⌘S or click away to save")}
          >
            {saving ? (
              <>
                <span className={SPINNER_CLASS_NAME} /> Saving…
              </>
            ) : saveError ? (
              "Save failed"
            ) : (
              "Unsaved"
            )}
          </span>
        )}
        {isMarkdown && (
          <button
            className={`${ICON_BUTTON_CLASS_NAME} ${showSource ? "active" : ""}`}
            data-tip={showSource ? "Rendered view" : "View source"}
            data-tip-align="end"
            aria-label={showSource ? "Rendered view" : "View source"}
            onClick={() => setShowSource((s) => !s)}
          >
            <Code size={13} />
          </button>
        )}
        {onDisk && (
          <button
            className={ICON_BUTTON_CLASS_NAME}
            data-tip={editorError ?? "Open in default editor"}
            data-tip-align="end"
            aria-label="Open in default editor"
            disabled={openingEditor}
            onClick={() => void openInEditor()}
          >
            {openingEditor ? <span className={SPINNER_CLASS_NAME} /> : <ExternalLink size={13} />}
          </button>
        )}
        <button
          className={ICON_BUTTON_CLASS_NAME}
          data-tip="Reload file"
          data-tip-align="end"
          aria-label="Reload file"
          onClick={() => setNonce((n) => n + 1)}
        >
          {loading ? <span className={SPINNER_CLASS_NAME} /> : <RotateCw size={13} />}
        </button>
      </div>
      <div
        ref={bodyRef}
        className="file-view-body flex-1 min-h-0 overflow-auto bg-background"
        onScroll={(event) => {
          const position = {
            top: event.currentTarget.scrollTop,
            left: event.currentTarget.scrollLeft,
          };
          scrollPositionRef.current = position;
          onScrollPositionChange?.(position);
        }}
      >
        {!showingEditor && !error && loaded?.source === "checkout" && !loaded.file.notFound && !gitRef && sessionId && loaded.file.root === "clone" && (
          <div className="file-view-note py-2.5 px-4 text-sm text-muted">
            This session&apos;s worktree isn&apos;t available — showing the project clone&apos;s copy.
          </div>
        )}
        {!showingEditor && !error && loaded?.source === "artifact" && !loaded.file.notFound && viaArtifacts && (
          <div className="file-view-note py-2.5 px-4 text-sm text-muted">
            Not in the {loaded.checkoutRoot === "worktree" ? "session's worktree" : "project clone"} —
            showing the copy from the project&apos;s artifacts.
          </div>
        )}
        {error ? (
          <div className="file-view-note py-2.5 px-4 text-sm text-muted">Failed to load file: {error}</div>
        ) : data === null ? (
          <div className="file-view-note py-2.5 px-4 text-sm text-muted">Loading…</div>
        ) : data.notFound ? (
          <div className="file-view-note py-2.5 px-4 text-sm text-muted">
            {loaded ? notFoundCopy(loaded) : "File not found."}
          </div>
        ) : mediaKind ? (
          <MediaPreview
            kind={mediaKind}
            url={rawUrl}
            name={path.split("/").pop() ?? path}
          />
        ) : data.binary ? (
          <div className="file-view-note py-2.5 px-4 text-sm text-muted">
            Binary file — no inline preview. <a href={rawUrl} download={path.split("/").pop() ?? path}>Download</a>
          </div>
        ) : isMarkdown && !showSource ? (
          <div className="file-view-md max-w-readable pt-4.5 px-5 pb-8 [&_.md]:text-base [&_.md_h1]:text-[1.5em] [&_.md_h1]:mt-4.5 [&_.md_h1]:mx-0 [&_.md_h1]:mb-2 [&_.md_h2]:text-[1.25em] [&_.md_h2]:mt-4 [&_.md_h2]:mx-0 [&_.md_h2]:mb-2 [&_.md_h3]:text-[1.1em]">
            {artifactsMode ? (
              <ArtifactMarkdown
                projectId={projectId}
                folder={artifactsFolder}
                markdown={data.content}
              />
            ) : (
              <Md
                text={data.content}
                onOpenFile={onOpenFile && ((p) => onOpenFile(p, sessionId, gitRef))}
              />
            )}
          </div>
        ) : showingEditor ? (
          // Editable files open straight into the editor — click and type.
          <CodeEditor
            value={draft}
            onChange={(next) => {
              setDraft(next);
              if (saveError) setSaveError(null);
            }}
            onSave={() => void save()}
            onBlur={() => void save()}
            path={path}
            highlightLine={line}
            scrollRequest={lineScrollRequest}
            onScrollRequestHandled={onLineScrollRequestHandled}
          />
        ) : (
          <>
            <CodeView
              text={data.content}
              path={path}
              highlightLine={line}
              scrollRequest={lineScrollRequest}
              onScrollRequestHandled={onLineScrollRequestHandled}
            />
            {data.truncated && (
              <div className="file-view-note py-2.5 px-4 text-sm text-muted">File truncated — showing the first 512 KB.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
