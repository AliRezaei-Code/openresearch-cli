---
name: orx-compute
description: "Launch experiment runs with `orx exp run` on Windows: remote backends (hf, modal, k8s, ssh, slurm, ray, openresearch), flavors, timeouts, images, sizing, and `orx exp wait`. Local compute is unavailable on Windows."
---

Experiment execution on Windows requires GitHub syncing so a supported remote
backend can clone the committed experiment branch. Local compute is unavailable.
If the project is not connected to GitHub, ask the user to enable syncing and do
not launch a run.

Use `orx exp run <expId>` with the configured default, or select one of these
backends explicitly: `hf`, `modal`, `k8s`, `ssh`, `slurm`, `ray`, or
`openresearch`.

```sh
orx exp status <expId>
orx exp run <expId> --backend <backend> [flags]
orx exp wait <expId>
orx exp cancel <expId>
```

The run command is fixed on the project. Commit and push every code or config
change before launching; remote backends clone the pushed branch tip. A launch
queues the run and returns immediately. Follow it with `orx runs <projectId>`,
`orx logs <runId>`, or `orx exp wait`.

Backend requirements:

- `hf`: requires `--flavor` and `HF_TOKEN`; accepts `--timeout` and `--image`.
- `modal`: requires `--flavor` and Modal credentials; accepts `--timeout` and
  `--image`.
- `k8s`: uses the committed `.orx/k8s.yaml` manifest; load
  `orx-compute-k8s` before editing it.
- `ssh`: requires `--host <alias>` from `~/.ssh/config`; takes no flavor.
- `slurm`: uses the configured login node or `--host`; `--flavor` is an
  optional GRES request such as `h100:2`.
- `ray`: uses the configured Ray Jobs address; optional resource hints use
  `--flavor`, for example `gpu:1,cpu:4`.
- `openresearch`: requires `orx login`, a registered SSH key, and a hardware
  `--flavor` from `orx compute`.

When no default is configured and the user has not named a backend, ask before
launching. A configured credential is not permission to choose that provider.
Use the smallest appropriate flavor, size timeouts for the complete run, and
relaunch the same experiment after infrastructure failures instead of creating
a new experiment node.
