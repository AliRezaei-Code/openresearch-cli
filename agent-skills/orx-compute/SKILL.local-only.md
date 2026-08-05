---
name: orx-compute
description: "Launch committed experiments on this machine with `orx exp run --backend local`, wait for completion, and inspect logs. Use before launching or repairing any run in a local-only project."
---

This project is local-only, so every experiment runs on this machine. Commit
the experiment branch first, then launch without selecting an external backend:

```sh
orx exp status <expId>
orx exp run <expId> --backend local
orx exp wait --project <projectId>
orx runs <projectId>
orx logs <runId>
```

The runner clones the recorded commit from the project folder and checks out
that exact commit detached. Uncommitted changes are excluded. A run returns
immediately; use `orx exp wait --project` as a wake-up signal and reconcile
terminal state with `orx runs` after every wake.

External compute is intentionally unavailable. If the user explicitly wants
it, ask them to enable GitHub for this project in the dashboard's Git tab;
do not attempt provider setup or publication on their behalf.
