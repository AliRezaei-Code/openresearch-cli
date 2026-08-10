import { GitBranch, RotateCw } from "lucide-react";

export type CodeBrowserView = "files" | "changes";

export function CodeBrowserHeader({
  view,
  onViewChange,
  showViewToggle = true,
  branchLabel,
  branchTitle,
  refreshing,
  onRefresh,
}: {
  view: CodeBrowserView;
  onViewChange: (view: CodeBrowserView) => void;
  showViewToggle?: boolean;
  branchLabel?: string;
  branchTitle?: string;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="code-tab-header">
      {showViewToggle && (
        <div className="seg" role="group" aria-label="Code browser view">
          <button
            type="button"
            className={view === "files" ? "active" : ""}
            aria-pressed={view === "files"}
            onClick={() => onViewChange("files")}
          >
            Files
          </button>
          <button
            type="button"
            className={view === "changes" ? "active" : ""}
            aria-pressed={view === "changes"}
            onClick={() => onViewChange("changes")}
          >
            Changes
          </button>
        </div>
      )}
      {branchLabel && (
        <span className="wt-branch-chip" title={branchTitle}>
          <GitBranch size={12} />
          <span className="wt-branch-name">{branchLabel}</span>
        </span>
      )}
      <span style={{ flex: 1 }} />
      <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={onRefresh}>
        {refreshing ? <span className="spinner" /> : <RotateCw size={13} />}
      </button>
    </div>
  );
}
