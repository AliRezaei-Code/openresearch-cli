import { useEffect, useState } from "react";
import { getExperimentDiff, type DiffPayload, type Experiment } from "../api";
import { GitDiffExplorer, TruncatedDiffNotice } from "./GitDiff";

export function BranchChanges({
  experiment,
  refreshKey,
  onLoadingChange,
}: {
  experiment: Experiment;
  refreshKey: number;
  onLoadingChange: (loading: boolean) => void;
}) {
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    onLoadingChange(true);
    setError(null);
    setDiff(null);
    getExperimentDiff(experiment.id)
      .then((payload) => {
        if (!cancelled) setDiff(payload);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) onLoadingChange(false);
      });
    return () => {
      cancelled = true;
    };
  }, [experiment.id, refreshKey, onLoadingChange]);

  return (
    <div className="code-tab-body branch-changes">
      {error ? (
        <div className="code-tab-note">Failed to load changes: {error}</div>
      ) : !diff ? (
        <div className="code-tab-note">Loading changes…</div>
      ) : !diff.diff.trim() ? (
        <div className="changes-note">
          {experiment.parentExperimentId
            ? "No committed changes from the parent branch."
            : "This is the baseline branch, so there is no parent comparison."}
        </div>
      ) : (
        <>
          {diff.truncated && (
            <TruncatedDiffNotice bytesRead={diff.bytesRead} byteLimit={diff.byteLimit} />
          )}
          <GitDiffExplorer diff={diff.diff} partial={diff.truncated} />
        </>
      )}
    </div>
  );
}
