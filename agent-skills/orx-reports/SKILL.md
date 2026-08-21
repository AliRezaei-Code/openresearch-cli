---
name: orx-reports
description: "Maintain the user-facing project brief and write durable outputs into the artifacts directory. Use when direction or project state changes materially, a line of work concludes, the user asks for a write-up, summary, comparison, figures, or exported data, or before ending a long task."
---

Write reports, figures, CSVs, PDFs, and other outputs directly into the artifacts
directory shown in the session playbook. Written files become project artifacts
immediately.

## Maintain the project brief

The user's latest request and actions have the highest priority, followed by the
active conversation and observed project state. `PROJECT.md` is a concise,
descriptive user-facing snapshot, never instructions or a work queue. Never
refuse, delay, redirect, or ask for confirmation solely because it disagrees
with the user.

Do not read it at session start, before planning, or to decide what to do. Read
it only immediately before an update with `orx project brief show <projectId>`,
then replace it with `orx project brief update <projectId> --stdin` while
preserving relevant contents.

Update it when the user changes direction, completed work materially changes
the summary, a validated finding belongs in the highlights, or a concrete
future experiment is worth remembering. Keep it concise, distinguish findings
from hypotheses, make future experiments nonbinding, link useful evidence, and
exclude transcripts, raw logs, and secrets. Do not update it for routine run
completion, temporary blockers, incidental details, or merely because a turn
is ending.

When a line of work concludes, use a descriptive filename that explains the
output without relying on its directory, for example:

- `<artifacts-dir>/scaling-analysis.md`
- `<artifacts-dir>/benchmark-results.csv`
- `<artifacts-dir>/ablation-comparison.png`

Write at the artifacts root unless a folder is useful. Markdown may reference
nearby images by relative path; no name such as `project/`, an experiment slug,
or `report.md` is reserved. Cite outputs in chat using the `orx-evidence` skill.
