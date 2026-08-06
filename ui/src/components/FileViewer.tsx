// Mirror of openresearch.sh's AgentFileView: one file from the project —
// a branch's committed copy when the tab carries a ref, else the chat
// session's worktree, else the hub clone, else the project's artifacts —
// refractor-highlighted, opened as a right-pane tab from chat tool rows or
// the code browser.

import { Code, FileText, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { artifactUrl, getArtifactFileText, getProjectFile, type ProjectFile } from "../api";
import { CodeView } from "./CodeView";
import { ArtifactMarkdown } from "./ArtifactsTab";
import { Md } from "./Md";

export function FileViewer({
  projectId,
  path,
  source = "repo",
  sessionId,
  gitRef,
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
  /** Open a linked file as another tab (rendered-markdown links). */
  onOpenFile?: (path: string, sessionId?: string, ref?: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ file: ProjectFile; viaArtifacts: boolean } | null>(null);
  const [binary, setBinary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const isArtifacts = source === "artifacts";
  // Markdown renders by default; the header toggle shows the raw source.
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(path);
  const isImage = /\.(png|svg)$/i.test(path);
  const artifactsFolder = path.split("/").slice(0, -1).join("/");
  const [showSource, setShowSource] = useState(false);
  const data = loaded?.file ?? null;
  // True when a repo tab's missing file was found in project artifacts.
  const viaArtifacts = loaded?.viaArtifacts ?? false;
  const artifactsMode = isArtifacts || viaArtifacts;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setBinary(false);
    // Artifacts come from the compatibility /files endpoint (no session/branch);
    // repo files from the checkout-aware /file endpoint. All paths normalize
    // into the same ProjectFile-shaped `data` so the render body is shared.
    const fromArtifacts = (): Promise<ProjectFile> =>
      getArtifactFileText(projectId, path).then((content) => ({
        // A missing artifact resolves to null → notFound, so it shows
        // the friendly copy rather than a raw error. `root` is a placeholder:
        // artifact tabs never read it, and the fallback stamps the checkout root.
        path,
        content: content ?? "",
        truncated: false,
        notFound: content === null,
        root: "clone" as const,
      }));
    // A checkout path the /file endpoint doesn't have may still name an
    // artifact, so try that directory before declaring it missing. Branch tabs
    // do not fall back because a ref names a committed tree.
    const load: Promise<{ file: ProjectFile; viaArtifacts: boolean }> = isArtifacts
      ? fromArtifacts().then((file) => ({ file, viaArtifacts: false }))
      : getProjectFile(projectId, path, { sessionId, ref: gitRef }).then((d) =>
          d.notFound && !gitRef
            ? fromArtifacts().then((f) =>
                f.notFound
                  ? { file: d, viaArtifacts: false }
                  : { file: { ...f, root: d.root }, viaArtifacts: true },
              )
            : { file: d, viaArtifacts: false },
        );
    load
      .then((next) => {
        if (cancelled) return;
        // Guard against dumping a binary artifact into a <pre> (NUL byte).
        if ((isArtifacts || next.viaArtifacts) && next.file.content.includes("\u0000"))
          setBinary(true);
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

  const notFoundCopy = (d: ProjectFile) => {
    if (isArtifacts) return "Artifact not found in the project.";
    if (gitRef) return `File not found on branch ${gitRef}.`;
    if (sessionId && d.root === "clone")
      return "This session's worktree isn't available, and the file isn't in the project clone or its artifacts.";
    return `File not found in the ${d.root === "worktree" ? "session's worktree" : "project clone"} or the project's artifacts.`;
  };

  return (
    <div className="file-view">
      <div className="file-view-header">
        <FileText size={13} style={{ flexShrink: 0 }} />
        <code className="file-view-path" title={path}>
          {path}
        </code>
        {gitRef && (
          <code className="file-view-ref" title={`Committed state of ${gitRef}`}>
            {gitRef}
          </code>
        )}
        {isMarkdown && (
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
        <button
          className="icon-btn"
          data-tip="Reload file"
          data-tip-align="end"
          aria-label="Reload file"
          onClick={() => setNonce((n) => n + 1)}
        >
          {loading ? <span className="spinner" /> : <RotateCw size={13} />}
        </button>
      </div>
      <div className="file-view-body">
        {error ? (
          <div className="file-view-note">Failed to load file: {error}</div>
        ) : data === null ? (
          <div className="file-view-note">Loading…</div>
        ) : data.notFound ? (
          <div className="file-view-note">{notFoundCopy(data)}</div>
        ) : isImage && artifactsMode ? (
          <a
            className="fpreview-image"
            href={artifactUrl(projectId, path)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src={artifactUrl(projectId, path)} alt={path.split("/").pop() ?? path} />
          </a>
        ) : binary ? (
          <div className="file-view-note">Binary file — no inline preview.</div>
        ) : (
          <>
            {!artifactsMode && !gitRef && sessionId && data.root === "clone" && (
              <div className="file-view-note">
                This session's worktree isn't available — showing the project clone's copy.
              </div>
            )}
            {viaArtifacts && (
              <div className="file-view-note">
                Not in the {data.root === "worktree" ? "session's worktree" : "project clone"} —
                showing the copy from the project's artifacts.
              </div>
            )}
            {isMarkdown && !showSource ? (
              <div className="file-view-md">
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
              <CodeView text={data.content} path={path} />
            )}
            {!artifactsMode && data.truncated && (
              <div className="file-view-note">File truncated — showing the first 512 KB.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
