---
name: orx-reports
description: "Write durable research outputs into the local project's artifacts directory. Use when a line of work concludes, when the user asks for a write-up, summary, comparison, figures, or exported data, or before ending a long task — findings not written down are lost."
---

In local mode (`orx up`), write reports, figures, CSVs, PDFs, and other outputs
directly into the artifacts directory shown in the session playbook. There is
no upload step; written files become project artifacts immediately.

When a line of work concludes (or the user asks for a write-up), use a descriptive
filename that explains the output without relying on its directory, for example:

- `<artifacts-dir>/scaling-analysis.md`
- `<artifacts-dir>/benchmark-results.csv`
- `<artifacts-dir>/ablation-comparison.png`

Write at the artifacts root unless a folder is useful. Markdown may reference
nearby images by relative path; no name such as `project/`, an experiment slug,
or `report.md` is reserved. In chat, cite every relevant output as raw
<file path="artifacts/<relative-path>" />, never as a bare or backticked path.
