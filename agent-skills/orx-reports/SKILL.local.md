---
name: orx-reports
description: "Write durable research outputs into the local project's artifacts directory so they appear in the dashboard's Artifacts tab. Use when a line of work concludes, when the user asks for a write-up, summary, comparison, figures, or exported data, or before ending a long task — findings not written down are lost."
---

In local mode (`orx up`), outputs are written **directly into the project's
artifacts directory** — there is no upload step. Reports, figures, images, CSVs,
PDFs, and other useful outputs appear in the dashboard's Artifacts tab
immediately. The directory path is shown in your session playbook.

When a line of work concludes (or the user asks for a write-up), use a descriptive
filename that explains the output without relying on its directory, for example:

- `<artifacts-dir>/scaling-analysis.md`
- `<artifacts-dir>/benchmark-results.csv`
- `<artifacts-dir>/ablation-comparison.png`

Write directly at the artifacts root by default. Folders and nested files are
fully supported when the user requests them or the output naturally needs them.
Markdown may reference nearby images by relative path; choose descriptive names
for both the document and its assets. No directory name or filename such as
`project/`, an experiment slug, or `report.md` is required or reserved.
