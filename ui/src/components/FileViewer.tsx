// Mirror of openresearch.sh's AgentFileView: one file from the project —
// a branch's committed copy when the tab carries a ref, else the chat
// session's worktree, else the hub clone, else the project's files dir —
// refractor-highlighted, opened as a right-pane tab from chat tool rows or
// the code browser.

import { Code, FileText, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getFileReport, getFilesDirFileText, getProjectFile, type ProjectFile } from "../api";
import { CodeView } from "./CodeView";
import { ReportMd } from "./FilesTab";
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
  /** Which backend serves this file. "files" reads the project's files dir
   * (a report/figure the agent wrote), else the repo/worktree checkout. */
  source?: "repo" | "files";
  /** Chat session whose worktree holds the file (absent → hub clone).
   * Never set for tabs opened with source:"files". */
  sessionId?: string;
  /** Branch whose committed copy to show — overrides the live checkout.
   * (Named gitRef because `ref` is reserved on React components.) */
  gitRef?: string;
  /** Open a linked file as another tab (rendered-markdown links). */
  onOpenFile?: (path: string, sessionId?: string, ref?: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ file: ProjectFile; viaFiles: boolean } | null>(null);
  const [binary, setBinary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const isFiles = source === "files";
  // Markdown renders by default; the header toggle shows the raw source.
  const isMarkdown = /\.(md|mdx|markdown)$/i.test(path);
  // `<folder>/report.md` names a files-dir report folder; repo paths can
  // reach the files-dir fallback too, so no isFiles gate.
  const isReport = /(^|\/)report\.md$/i.test(path);
  // Report images resolve against the folder; a bare .md against its parent.
  const filesFolder = isReport
    ? path.replace(/\/?report\.md$/i, "")
    : path.split("/").slice(0, -1).join("/");
  const [showSource, setShowSource] = useState(false);
  const data = loaded?.file ?? null;
  // True when a repo tab's file was served by the files dir instead.
  const viaFiles = loaded?.viaFiles ?? false;
  const filesMode = isFiles || viaFiles;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setBinary(false);
    // Files-dir files come from the /files endpoints (no session/branch);
    // repo files from the checkout-aware /file endpoint. All paths normalize
    // into the same ProjectFile-shaped `data` so the render body is shared.
    const fromFilesDir = (): Promise<ProjectFile> =>
      (isReport && filesFolder
        ? // file_report maps every failure to 404, so a rejection here is a
          // missing report → null (notFound), same as the raw-file path.
          getFileReport(projectId, filesFolder)
            .then((r) => r.markdown as string | null)
            .catch(() => null)
        : getFilesDirFileText(projectId, path)
      ).then((content) => ({
        // A missing files-dir file resolves to null → notFound, so it shows
        // the friendly copy rather than a raw error. `root` is a placeholder:
        // files tabs never read it, and the fallback stamps the checkout root.
        path,
        content: content ?? "",
        truncated: false,
        notFound: content === null,
        root: "clone" as const,
      }));
    // A checkout path the /file endpoint doesn't have may still name a
    // files-dir file — agents link reports by files-dir-relative paths — so
    // try the files dir before declaring it missing. Branch tabs don't fall
    // back: a ref names a committed tree, and files-dir files have no branch.
    const load: Promise<{ file: ProjectFile; viaFiles: boolean }> = isFiles
      ? fromFilesDir().then((file) => ({ file, viaFiles: false }))
      : getProjectFile(projectId, path, { sessionId, ref: gitRef }).then((d) =>
          d.notFound && !gitRef
            ? fromFilesDir().then((f) =>
                f.notFound
                  ? { file: d, viaFiles: false }
                  : { file: { ...f, root: d.root }, viaFiles: true },
              )
            : { file: d, viaFiles: false },
        );
    load
      .then((next) => {
        if (cancelled) return;
        // Guard against dumping a binary files-dir file into a <pre> (NUL byte).
        if ((isFiles || next.viaFiles) && next.file.content.includes("\u0000")) setBinary(true);
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
    // isFiles/isReport/filesFolder are pure derivations of path+source, which
    // are already deps — no need to list them.
  }, [projectId, path, source, sessionId, gitRef, nonce]);

  const notFoundCopy = (d: ProjectFile) => {
    if (isFiles) return "File not found in the project's files.";
    if (gitRef) return `File not found on branch ${gitRef}.`;
    if (sessionId && d.root === "clone")
      return "This session's worktree isn't available, and the file isn't in the project clone or the project's files.";
    return `File not found in the ${d.root === "worktree" ? "session's worktree" : "project clone"} or the project's files.`;
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
            aria-label={showSource ? "Rendered view" : "View source"}
            onClick={() => setShowSource((s) => !s)}
          >
            <Code size={13} />
          </button>
        )}
        <button
          className="icon-btn"
          data-tip="Reload file"
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
        ) : binary ? (
          <div className="file-view-note">Binary file — no inline preview.</div>
        ) : (
          <>
            {!filesMode && !gitRef && sessionId && data.root === "clone" && (
              <div className="file-view-note">
                This session's worktree isn't available — showing the project clone's copy.
              </div>
            )}
            {viaFiles && (
              <div className="file-view-note">
                Not in the {data.root === "worktree" ? "session's worktree" : "project clone"} —
                showing the copy from the project's files.
              </div>
            )}
            {isMarkdown && !showSource ? (
              <div className="file-view-md">
                {filesMode ? (
                  // Files-dir markdown resolves relative image paths against
                  // the report folder — a bare <Md> would 404 the figures.
                  <ReportMd projectId={projectId} folder={filesFolder} markdown={data.content} />
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
            {!filesMode && data.truncated && (
              <div className="file-view-note">File truncated — showing the first 512 KB.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
