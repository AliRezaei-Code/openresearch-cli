// Floating detail card shown while hovering an experiment node in the tree.
// Rendered through a portal at a fixed viewport position (never inside the
// ReactFlow node: the canvas transform would scale it with zoom, and growing
// the node itself would invalidate the tree layout's fixed NODE_W/NODE_H).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitBranch } from "lucide-react";
import {
  backendKind,
  fmtDuration,
  getRunDiff,
  timeAgo,
  type Experiment,
  type Run,
} from "../api";
import { BackendBadge } from "./BackendLogos";
import { StatusBadge } from "./StatusBadge";

const CARD_W = 380;
const GAP = 12; // node ↔ card, and card ↔ viewport edge
const MAX_FILES_SHOWN = 3;

interface DiffStat {
  files: string[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

function parseDiffStat(diff: string, truncated: boolean): DiffStat {
  const files: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/<path> b/<path>` — take the b/ path.
      const b = line.lastIndexOf(" b/");
      if (b !== -1) files.push(line.slice(b + 3));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { files, additions, deletions, truncated };
}

function fmtCreated(ms: number): string {
  const d = new Date(ms);
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === new Date().getFullYear()
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" };
  return d.toLocaleDateString(undefined, opts);
}

export function ExpHoverCard({
  exp,
  runs,
  latestRun,
  parentSlug,
  anchor,
  onMouseEnter,
  onMouseLeave,
  onClose,
}: {
  exp: Experiment;
  runs: Run[];
  latestRun: Run | null;
  parentSlug: string | null;
  /** Viewport rect of the hovered node at open time. */
  anchor: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** Immediate dismiss (canvas zoom/pan under the cursor). */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Start off-screen until the first layout pass has measured the card.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [diffStat, setDiffStat] = useState<DiffStat | null>(null);

  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    // Right of the node, flipped to the left when the viewport is short.
    let left = anchor.right + GAP;
    if (left + CARD_W + GAP > window.innerWidth) left = anchor.left - GAP - CARD_W;
    left = Math.max(GAP, left);
    const top = Math.max(GAP, Math.min(anchor.top, window.innerHeight - h - GAP));
    setPos({ left, top });
  }, [anchor, diffStat]);

  // Zooming or trackpad-panning the canvas moves the node out from under the
  // card's anchor; dismiss rather than float detached.
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("wheel", close, { capture: true, passive: true });
    return () => window.removeEventListener("wheel", close, { capture: true });
  }, [onClose]);

  // Diff vs the parent branch — only defined for non-baseline runs that
  // committed something (the endpoint 400s otherwise).
  const diffRunId =
    exp.parentExperimentId && latestRun?.commitSha ? latestRun.id : null;
  useEffect(() => {
    if (!diffRunId) return;
    let stale = false;
    getRunDiff(diffRunId)
      .then((p) => {
        if (!stale) setDiffStat(parseDiffStat(p.diff, p.truncated));
      })
      .catch(() => {
        // Diffstat is a nice-to-have; drop the row on any failure.
      });
    return () => {
      stale = true;
    };
  }, [diffRunId]);

  const passed = runs.filter((r) => r.status === "done").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const duration =
    latestRun?.endedAt != null ? fmtDuration(latestRun.endedAt - latestRun.createdAt) : null;
  // Local runs leave resultMarkdown empty on success (the agent freezes its
  // findings into the experiment description instead); on failure it holds a
  // short error worth surfacing.
  const failureNote =
    latestRun?.status === "failed" && latestRun.resultMarkdown
      ? latestRun.resultMarkdown
      : null;
  const body = exp.description || latestRun?.resultMarkdown || null;
  const moreFiles = diffStat ? diffStat.files.length - MAX_FILES_SHOWN : 0;

  return createPortal(
    <div
      ref={ref}
      className="exp-hover-card"
      style={{
        width: CARD_W,
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="hc-head">
        <span className="hc-slug">{exp.slug}</span>
        <StatusBadge status={latestRun?.status ?? "idle"} />
      </div>
      {exp.title && <div className="hc-title">{exp.title}</div>}
      {body && <div className="hc-body">{body}</div>}
      {failureNote && <div className="hc-failure">{failureNote}</div>}
      <div className="hc-stats">
        <span>
          {runs.length === 1 ? "1 run" : `${runs.length} runs`}
          {passed > 0 && ` · ${passed} passed`}
          {failed > 0 && ` · ${failed} failed`}
        </span>
        {latestRun && backendKind(latestRun.backend) && <BackendBadge backend={latestRun.backend} />}
        {duration && <span>{duration}</span>}
        {latestRun && <span>{timeAgo(latestRun.createdAt)}</span>}
      </div>
      <div className="hc-git">
        <div className="hc-git-row">
          <span className="hc-branch" title={exp.branchName}>
            <GitBranch size={12} />
            {exp.branchName}
          </span>
          {parentSlug && (
            <span className="hc-from">
              from <span className="mono">{parentSlug}</span>
            </span>
          )}
        </div>
        {diffStat && (
          <div className="hc-git-row">
            <span>
              <span className="hc-add">+{diffStat.additions}</span>{" "}
              <span className="hc-del">−{diffStat.deletions}</span>
              {" · "}
              {diffStat.files.length === 1 ? "1 file" : `${diffStat.files.length} files`}
              {diffStat.truncated && " (truncated)"}
            </span>
            <span className="hc-files mono">
              {diffStat.files.slice(0, MAX_FILES_SHOWN).join(" · ")}
              {moreFiles > 0 && ` +${moreFiles} more`}
            </span>
          </div>
        )}
      </div>
      <div className="hc-foot">
        <span className="mono">$ {exp.runCommand}</span>
        <span>created {fmtCreated(exp.createdAt)}</span>
      </div>
    </div>,
    document.body,
  );
}
