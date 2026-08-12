// Mirror of openresearch.sh's AgentFileView: one file from the project —
// a branch's committed copy when the tab carries a ref, else the chat
// session's worktree, else the hub clone, else the project's artifacts —
// refractor-highlighted, opened as a right-pane tab from chat tool rows or
// the code browser.

import { Code, FileText, GitBranch, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  artifactUrl,
  getArtifactFileMetadata,
  getArtifactFileText,
  getProjectFile,
  projectFileUrl,
  type CheckoutRoot,
  type ProjectFile,
} from "../api";
import { CodeView } from "./CodeView";
import { ArtifactMarkdown } from "./ArtifactsTab";
import { isMarkdownFile } from "./FileTypeIcon";
import { MediaPreview, mediaPreviewKind } from "./MediaPreview";
import { Md } from "./Md";
import { ICON_BUTTON_CLASS_NAME, SPINNER_CLASS_NAME } from "../styleClasses";

type ArtifactPreviewFile = Omit<ProjectFile, "root">;
type LoadedFile =
  | { source: "checkout"; file: ProjectFile }
  | { source: "artifact"; file: ArtifactPreviewFile; checkoutRoot?: CheckoutRoot };

export function FileViewer({
  projectId,
  path,
  source = "repo",
  sessionId,
  gitRef,
  line,
  branchLabel,
  onOpenFile,
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
  const data = loaded?.file ?? null;
  const mediaKind = mediaPreviewKind(data?.presentation);
  const viaArtifacts = loaded?.source === "artifact" && !isArtifacts;
  const artifactsMode = isArtifacts || loaded?.source === "artifact";
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
      <div className="file-view-body flex-1 min-h-0 overflow-auto bg-background">
        {!error && loaded?.source === "checkout" && !loaded.file.notFound && !gitRef && sessionId && loaded.file.root === "clone" && (
          <div className="file-view-note py-2.5 px-4 text-sm text-muted">
            This session&apos;s worktree isn&apos;t available — showing the project clone&apos;s copy.
          </div>
        )}
        {!error && loaded?.source === "artifact" && !loaded.file.notFound && viaArtifacts && (
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
        ) : (
          <>
            {isMarkdown && !showSource ? (
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
            ) : (
              <CodeView text={data.content} path={path} highlightLine={line} />
            )}
            {data.truncated && (
              <div className="file-view-note py-2.5 px-4 text-sm text-muted">File truncated — showing the first 512 KB.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
