---
name: orx-experiment-tree
description: "Plan and run experiment trees on Windows using GitHub-backed remote compute. Use before creating, branching, launching, or promoting experiments."
---

Each experiment is one committed branch and one scientific question. Keep the
project's run command fixed; vary code or configuration on child branches.

Before launching on Windows, confirm the project has GitHub syncing enabled,
commit and push the branch, and load `orx-compute` for the selected remote
backend. Local compute is unavailable on Windows.

```sh
orx create-experiment <projectId> --title <name> --description <hypothesis>
orx exp status <expId>
orx exp run <expId> --backend <remote-backend> [flags]
orx exp wait --project <projectId>
orx runs <projectId>
orx logs <runId>
orx exp desc <expId> --set <finding>
```

Use shallow, parallel branches for independent hypotheses and deeper branches
only when a result justifies the next change; pass `--parent <expId>` when
creating a child. Repair infrastructure failures on
the same node; create a child only for a meaningful new scientific variant.
After each completion, read the logs, record the evidence and compute used, then
decide whether to promote, refine, or stop.
