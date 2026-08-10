import { CircleStop, FolderTree, GitBranch, Terminal } from "lucide-react";
import { useState } from "react";
import { runDisplayStatus, timeAgo, type Experiment, type Run } from "../api";
import { StatusBadge } from "./StatusBadge";

export function ExperimentsTable({
  runs,
  experiments,
  emptyHint,
  onOpen,
  onOpenLogs,
  onOpenCode,
  onCancel,
}: {
  runs: Run[];
  experiments: Experiment[];
  emptyHint?: string;
  onOpen: (experiment: Experiment) => void;
  onOpenLogs: (experimentId: string, runId: string) => void;
  onOpenCode: (experimentId: string) => void;
  onCancel: (runId: string) => Promise<void>;
}) {
  const [pendingCancellation, setPendingCancellation] = useState<ReadonlySet<string>>(new Set());
  const [cancelError, setCancelError] = useState<string | null>(null);
  const runsByExperiment = new Map<string, Run[]>();
  for (const run of runs) {
    const experimentRuns = runsByExperiment.get(run.experimentId);
    if (experimentRuns) experimentRuns.push(run);
    else runsByExperiment.set(run.experimentId, [run]);
  }
  for (const experimentRuns of runsByExperiment.values()) {
    experimentRuns.sort((a, b) => b.createdAt - a.createdAt);
  }

  const sortedExperiments = [...experiments].sort((a, b) => {
    const aActivity = runsByExperiment.get(a.id)?.[0]?.createdAt ?? a.createdAt;
    const bActivity = runsByExperiment.get(b.id)?.[0]?.createdAt ?? b.createdAt;
    return bActivity - aActivity;
  });

  if (sortedExperiments.length === 0) {
    return (
      <div className="empty-state experiments-empty-state">
        <p>{emptyHint ?? "No experiments yet."}</p>
      </div>
    );
  }

  async function requestCancel(runId: string) {
    setCancelError(null);
    setPendingCancellation((current) => new Set(current).add(runId));
    try {
      await onCancel(runId);
    } catch (cause) {
      setPendingCancellation((current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
      setCancelError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="experiments-table-wrap">
      {cancelError && (
        <div className="experiments-table-error" role="alert">
          Stop failed: {cancelError}
        </div>
      )}
      <div className="experiments-table" role="list" aria-label="Experiments">
        {sortedExperiments.map((experiment) => {
          const experimentRuns = runsByExperiment.get(experiment.id) ?? [];
          const latestRun = experimentRuns[0] ?? null;
          const liveRun = experimentRuns.find(
            (run) => run.status === "running" || run.status === "starting",
          );
          const logsRun = liveRun ?? latestRun;
          const cancelling = Boolean(
            liveRun && (liveRun.cancelRequested || pendingCancellation.has(liveRun.id)),
          );
          const status = liveRun
            ? cancelling
              ? "cancelling"
              : runDisplayStatus(liveRun)
            : latestRun
              ? runDisplayStatus(latestRun)
              : "idle";

          return (
            <div
              key={experiment.id}
              className="experiment-table-group"
              role="listitem"
              onClick={() => onOpen(experiment)}
            >
              <div className="experiment-table-name">
                <button
                  type="button"
                  className="experiment-table-title"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(experiment);
                  }}
                >
                  {experiment.title || experiment.slug}
                </button>
                <span className="experiment-table-subtitle" title={experiment.branchName}>
                  <GitBranch size={14} aria-hidden="true" />
                  <code>{experiment.branchName}</code>
                </span>
              </div>
              <div className="experiment-table-meta">
                <div className="experiment-table-status">
                  <StatusBadge status={status} />
                </div>
                <div className="experiment-run-summary">
                  <span>
                    {experimentRuns.length} {experimentRuns.length === 1 ? "run" : "runs"}
                  </span>
                </div>
                <div className="experiment-table-latest">
                  <span>{latestRun ? timeAgo(latestRun.createdAt) : "Not run yet"}</span>
                </div>
              </div>
              <div
                className="experiment-table-actions"
                role="group"
                aria-label={`Actions for ${experiment.title || experiment.slug}`}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  className="experiment-table-action"
                  disabled={!logsRun}
                  title={logsRun ? "Open logs" : "No runs yet"}
                  onClick={() => logsRun && onOpenLogs(experiment.id, logsRun.id)}
                >
                  <Terminal size={15} />
                  Logs
                </button>
                <button
                  className="experiment-table-action"
                  title={`Browse code on ${experiment.branchName}`}
                  onClick={() => onOpenCode(experiment.id)}
                >
                  <FolderTree size={15} />
                  Code
                </button>
                {liveRun && (
                  <button
                    className="experiment-table-action danger"
                    disabled={cancelling}
                    title={cancelling ? "Stop requested" : "Stop run"}
                    onClick={() => void requestCancel(liveRun.id)}
                  >
                    <CircleStop size={15} />
                    {cancelling ? "Stopping…" : "Stop"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
