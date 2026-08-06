import { GitBranch } from "lucide-react";
import { useState } from "react";
import { runDisplayStatus, shortId, timeAgo, type Experiment, type Run } from "../api";
import { StatusBadge } from "./StatusBadge";

// Legacy alias kept for external imports; StatusBadge owns the styling.
export function StatusChip({ status }: { status: string }) {
  return <StatusBadge status={status} />;
}

export function RunsTable({
  runs,
  experiments,
  emptyHint,
  onOpen,
  onOpenChanges,
  onCancel,
}: {
  runs: Run[];
  experiments: Experiment[];
  /** Overrides the empty-state text when the caller pre-filtered `runs`. */
  emptyHint?: string;
  /** Row click — opens the run's experiment overview tab. */
  onOpen: (run: Run) => void;
  /** GitBranch shortcut — opens the experiment's changes tab. */
  onOpenChanges: (experimentId: string) => void;
  onCancel: (runId: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [cancelError, setCancelError] = useState<string | null>(null);
  const slugByExp = new Map(experiments.map((e) => [e.id, e.slug]));
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);

  async function requestCancel(runId: string) {
    setCancelError(null);
    setPending((current) => new Set(current).add(runId));
    try {
      await onCancel(runId);
    } catch (cause) {
      setPending((current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
      setCancelError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        <p>{emptyHint ?? "No runs yet."}</p>
      </div>
    );
  }

  return (
    <div className="runs-table-wrap">
      {cancelError && (
        <div className="runs-table-error" role="alert">
          Cancel failed: {cancelError}
        </div>
      )}
      <table className="runs-table">
        <thead>
          <tr>
            <th>Experiment</th>
            <th>Status</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((run) => {
            const live = run.status === "running" || run.status === "starting";
            const cancelling = live && (run.cancelRequested || pending.has(run.id));
            return (
              <tr key={run.id} className="clickable" onClick={() => onOpen(run)}>
                <td className="mono">{slugByExp.get(run.experimentId) ?? shortId(run.experimentId)}</td>
                <td>
                  <StatusBadge status={cancelling ? "cancelling" : runDisplayStatus(run)} />
                </td>
                <td>{timeAgo(run.createdAt)}</td>
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <button
                      className="icon-btn"
                      title="Open changes"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenChanges(run.experimentId);
                      }}
                    >
                      <GitBranch size={14} />
                    </button>
                    {live && (
                      <button
                        className="btn sm danger"
                        disabled={cancelling}
                        onClick={(e) => {
                          e.stopPropagation();
                          void requestCancel(run.id);
                        }}
                      >
                        {cancelling ? "Cancelling…" : "Cancel"}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
