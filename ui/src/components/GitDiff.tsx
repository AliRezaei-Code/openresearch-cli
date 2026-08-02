// Mirror of openresearch.sh's GitDiff: per-file collapsible cards over
// react-diff-view's unified view, with refractor syntax highlighting.

import "react-diff-view/style/index.css";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Diff,
  type ChangeData,
  type FileData,
  type HunkTokens,
  type RenderGutter,
  markEdits,
  parseDiff,
  tokenize,
} from "react-diff-view";
import { refractor } from "refractor";
import { detectSyntaxLanguageFromFilePath } from "../syntaxLanguage";

const HIGHLIGHT_MAX = 2000; // above this many changed lines, skip tokenizing

const REACT_DIFF_VIEW_REFRACTOR = {
  highlight(code: string, language: string) {
    return refractor.highlight(code, language).children;
  },
};

function getUnifiedLineNumber(change: ChangeData): number {
  if (change.type === "normal") return change.newLineNumber;
  return change.lineNumber;
}

export function countChanges(file: FileData) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (change.type === "insert") additions++;
      else if (change.type === "delete") deletions++;
    }
  }
  return { additions, deletions };
}

function getHighlightPath(file: FileData): string | null {
  if (file.newPath === "/dev/null") return file.oldPath;
  if (file.oldPath === "/dev/null") return file.newPath;
  return file.newPath;
}

function formatDiffFilePath(file: FileData): string {
  switch (file.type) {
    case "delete":
      return file.oldPath;
    case "add":
    case "modify":
      return file.newPath;
    case "rename":
    case "copy":
      return `${file.oldPath} → ${file.newPath}`;
  }
}

function tokenizeDiffFile(file: FileData): HunkTokens {
  const enhancers = [markEdits(file.hunks, { type: "line" })];
  const language = detectSyntaxLanguageFromFilePath(getHighlightPath(file));
  if (language && refractor.registered(language)) {
    return tokenize(file.hunks, {
      enhancers,
      highlight: true,
      language,
      refractor: REACT_DIFF_VIEW_REFRACTOR,
    });
  }
  return tokenize(file.hunks, { enhancers, highlight: false });
}

function parseDiffFiles(diff: string, partial: boolean): { files: FileData[]; failed: boolean } {
  if (!diff.trim()) return { files: [], failed: false };
  try {
    return { files: parseDiff(diff, { nearbySequences: "zip" }), failed: false };
  } catch {
    if (partial) {
      const starts = Array.from(diff.matchAll(/^diff --git /gm), (match) => match.index);
      const lastStart = starts[starts.length - 1];
      if (starts.length > 1 && lastStart !== undefined) {
        try {
          return {
            files: parseDiff(diff.slice(0, lastStart), { nearbySequences: "zip" }),
            failed: false,
          };
        } catch {
          return { files: [], failed: true };
        }
      }
    }
    return { files: [], failed: true };
  }
}

const renderUnifiedGutter: RenderGutter = ({ change, side }) => {
  if (side === "old") return null;
  return getUnifiedLineNumber(change);
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function TruncatedDiffNotice({
  bytesRead,
  byteLimit,
}: {
  bytesRead: number;
  byteLimit: number;
}) {
  return (
    <div className="truncated-notice">
      <h4>Diff preview truncated</h4>
      <p>
        Showing the first {formatBytes(byteLimit)} ({formatBytes(bytesRead)} read). View the complete
        diff locally with git.
      </p>
    </div>
  );
}

function DiffFileCard({
  file,
  defaultExpanded,
}: {
  file: FileData;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const { additions, deletions } = useMemo(() => countChanges(file), [file]);
  const shouldTokenize = expanded && additions + deletions <= HIGHLIGHT_MAX;
  const tokens = useMemo<HunkTokens | undefined>(() => {
    if (!shouldTokenize) return undefined;
    try {
      return tokenizeDiffFile(file);
    } catch {
      return undefined; // tokenizing is best-effort
    }
  }, [file, shouldTokenize]);

  return (
    <section className={`diff-file-card ${expanded ? "expanded" : ""}`}>
      <button
        className="diff-file-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="chev">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="path">
          <code>{formatDiffFilePath(file)}</code>
        </span>
        <span className="stats">
          <span className="diff-stat-add">+{additions}</span>
          <span className="diff-stat-del">−{deletions}</span>
        </span>
      </button>
      {expanded &&
        (file.hunks.length === 0 ? (
          <div className="diff-empty">No textual diff for this file.</div>
        ) : (
          <div className="diff-file-body">
            <Diff
              className="openresearch-diff-file"
              diffType={file.type}
              gutterType="default"
              hunks={file.hunks}
              renderGutter={renderUnifiedGutter}
              tokens={tokens}
              viewType="unified"
            />
          </div>
        ))}
    </section>
  );
}

function DiffFiles({ files, className }: { files: FileData[]; className?: string }) {
  return (
    <div className={className ? `openresearch-diff ${className}` : "openresearch-diff"}>
      {files.map((file, i) => (
        <DiffFileCard
          key={`${file.oldPath}→${file.newPath}#${i}`}
          file={file}
          defaultExpanded={i === 0}
        />
      ))}
    </div>
  );
}

export function GitDiff({ diff, className }: { diff: string; className?: string }) {
  const parsed = useMemo(() => parseDiffFiles(diff, false), [diff]);
  if (parsed.failed) return <div className="diff-empty">Unable to parse this diff.</div>;
  if (parsed.files.length === 0) return <div className="diff-empty">No changes.</div>;
  return <DiffFiles files={parsed.files} className={className} />;
}

function fileStatus(file: FileData): string {
  switch (file.type) {
    case "add":
      return "A";
    case "delete":
      return "D";
    case "rename":
      return "R";
    case "copy":
      return "C";
    case "modify":
      return "M";
  }
}

export function GitDiffExplorer({ diff, partial = false }: { diff: string; partial?: boolean }) {
  const parsed = useMemo(() => parseDiffFiles(diff, partial), [diff, partial]);
  const files = parsed.files;
  const items = useMemo(
    () =>
      files.map((file, index) => ({
        file,
        key: `${file.oldPath}→${file.newPath}#${index}`,
        changes: countChanges(file),
      })),
    [files],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const showingFullDiff = showFullDiff && !partial;
  const activeKey = items.some((item) => item.key === selectedKey)
    ? selectedKey
    : (items[0]?.key ?? null);
  const selected = items.find((item) => item.key === activeKey) ?? null;

  if (parsed.failed) {
    return (
      <div className="diff-empty">
        {partial ? "No complete file preview was available before the cutoff." : "Unable to parse this diff."}
      </div>
    );
  }
  if (items.length === 0) return <div className="diff-empty">No changes.</div>;

  return (
    <div className="diff-explorer">
      <div className="diff-explorer-toolbar">
        <strong>
          {partial
            ? `${items.length} ${items.length === 1 ? "file" : "files"} shown (partial)`
            : items.length === 1
              ? "1 changed file"
              : `${items.length} changed files`}
        </strong>
        {!partial && (
          <button type="button" onClick={() => setShowFullDiff((current) => !current)}>
            {showingFullDiff ? "Back to preview" : "View full diff"}
          </button>
        )}
      </div>
      {showingFullDiff ? (
        <DiffFiles files={files} />
      ) : (
        <div className="diff-explorer-layout">
          <div className="diff-explorer-files" aria-label="Changed files">
            {items.map((item) => (
              <button
                type="button"
                key={item.key}
                className={item.key === activeKey ? "active" : ""}
                aria-pressed={item.key === activeKey}
                onClick={() => setSelectedKey(item.key)}
              >
                <span className={`diff-file-status status-${item.file.type}`}>
                  {fileStatus(item.file)}
                </span>
                <code title={formatDiffFilePath(item.file)}>{formatDiffFilePath(item.file)}</code>
                <span className="diff-explorer-stat diff-stat-add">+{item.changes.additions}</span>
                <span className="diff-explorer-stat diff-stat-del">−{item.changes.deletions}</span>
              </button>
            ))}
          </div>
          <div className="diff-explorer-preview openresearch-diff">
            {selected && (
              <DiffFileCard
                key={selected.key}
                file={selected.file}
                defaultExpanded
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
