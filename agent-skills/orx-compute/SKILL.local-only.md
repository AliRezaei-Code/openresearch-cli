---
name: orx-compute
description: "Launch committed experiments on this machine with `orx exp run --backend local`, choose `orx exp wait` vs `orx exp wake`, and inspect logs. Use before launching or repairing any run in a local-only project."
---

This project is local-only, so every experiment runs on this machine. Commit
the experiment branch first, then launch without selecting an external backend:

```sh
orx exp status <expId>
orx exp run <expId> --backend local
orx exp wait --project <projectId>
orx exp wake <expId>                    # alternative: go idle and resume later
orx runs <projectId>
orx logs <runId>
```

The runner clones the recorded commit from the project folder and checks out
that exact commit detached. Uncommitted changes are excluded. A run returns
immediately; use `orx exp wait --project` as a wake-up signal and reconcile
terminal state with `orx runs` after every wake.

If you want to end the current turn instead of blocking, call `orx exp wake
<expId>` after launch. It resumes this agent when the latest run reaches `done`
or `failed`; cancellation intentionally does not wake the agent. Do not use
`exp wait` and `exp wake` for the same run.

External compute is intentionally unavailable. If the user explicitly wants
it, ask them to enable GitHub syncing for this project; do not attempt provider
setup or publication on their behalf.
