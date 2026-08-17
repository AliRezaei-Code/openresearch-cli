---
name: orx-compute
description: "Launch experiment runs with `orx exp run`: backends (hf, modal, k8s, ssh, slurm, ray, openresearch, local), flavors, timeouts, images, sizing, and `orx exp wait`. Use before launching or re-launching any run, when choosing or switching a backend or GPU flavor, when a job OOMs, stalls, or times out, or when deciding GPU vs CPU."
---

Hosted server projects are read-only execution history. To launch an experiment,
clone its repository, initialize it with `orx up`, and choose a local execution
backend. The backend is explicit on each launch or comes from the machine-wide
default target.

```sh
orx exp status <expId>                 # status, branch, parent, run command, latest run + commit, local diff recipe
orx compute                            # browse GPU offers across all providers (price-sorted)
orx compute --gpu H100_SXM --count 1   # filter by gpu / count
orx compute --provider vast            # filter by provider
orx compute --cpu                      # browse CPU-only offers (price-sorted)
orx up                                        # initialize the cloned repository
orx exp run <expId> --backend openresearch --flavor h100_sxm
orx exp run <expId> --backend openresearch --flavor cpu5c:8
orx exp cancel <expId>                 # cancel the in-flight run
```

Rules and notes:
- **The run command is a fixed contract — set it once on the baseline, then leave
  it alone.** Children inherit it (see the `orx-experiment-tree` skill). Don't
  `--set` a different command per child, and don't bake swept hyperparameters into
  it — vary the **code/config** on a child's git branch instead, so every variant
  runs the same command and their `EVAL.md`s stay comparable. The normal reason to
  touch a command is the baseline having none yet.
- **Set a run command before launching.** Local projects inherit it from the
  project; set it with `orx project edit <projectId> --run-command '<cmd>'`.
- **Commit your edits before launching.** Every backend runs an immutable source
  snapshot of the committed branch and never needs a GitHub push.
- **Pick an execution backend.** OpenResearch compute uses `--backend
  openresearch --flavor <shape>`; other supported backends include `hf`,
  `modal`, `k8s`, `ssh`, `slurm`, `ray`, and `local`.
- `orx exp run` **queues** the run and returns immediately — it does not wait.
  Follow progress with `orx runs <projectId>` and `orx logs <runId>`, or block
  with `orx exp wait` (below).

## The default compute target (local projects)

A local project can launch on this machine or transfer its immutable source
snapshot directly to a remote backend. The user may configure a **default
compute target** that is machine-wide and shared by local projects. When one is
set, `orx exp run <expId>` with no
`--backend` launches there with the saved default flavor — omitting the flag is
how you use it (flavor-required backends still need `--flavor` if no default
flavor is saved). When none is set, ask the user to choose an explicit backend.
Hosted server projects cannot launch runs; initialize the repository with
`orx up` first.

## Running on Hugging Face Jobs — `--backend hf`

**`--backend hf` requires a local project (`orx up`); use it ONLY when
the user explicitly asks for Hugging Face Jobs**
(e.g. "run this on HF", "use my huggingface account"), it is the configured
default target, or the project context says to
prefer it. A connected HF token by itself is NOT a signal to switch — it just
means the option exists. When in doubt, ask which backend to use.

With `--backend hf`, the job runs on the user's own HF account (requires
`HF_TOKEN` in the environment — orgs that connect their HF account in compute
settings get it synced automatically) and is billed there per minute; no
OpenResearch balance is spent.

```sh
orx exp run <expId> --backend hf --flavor a10g-small              # one GPU job
orx exp run <expId> --backend hf --flavor a100-large --timeout 8h
orx exp run <expId> --backend hf --flavor cpu-upgrade --image python:3.12
```

Rules and notes:
- **`--flavor` is required.** Common
  flavors: `t4-small`, `a10g-small`, `a10g-large`, `l4x1`, `l40sx1`,
  `a100-large`, `h100`, `h200` (and `x2/x4/x8` multiples); CPU: `cpu-basic`,
  `cpu-upgrade`. Prefer the smallest flavor that fits.
- **Set `--timeout` to cover the whole run** (default `4h`). HF kills the job
  at the timeout; a killed job reads as a failed run.
- For a local project, `orx` uploads the committed source snapshot into a
  private job volume before starting the fixed run command. The job never
  clones a repository and does not need repository credentials.
- `--image` overrides the container (default: a CUDA pytorch image on GPU
  flavors, `python:3.12` on cpu flavors). Pick an image with your deps baked
  in when pip-install time dominates the run.
- Everything downstream is identical: the run appears in the tree, `orx exp
  wait` / `orx runs` / `orx logs` work unchanged, and cancellation through
  OpenResearch or `orx exp cancel` reaches the job within a few seconds. A detached
  `orx supervise` process mirrors status and logs; don't kill it.

## Running on Modal — `--backend modal`

**Same rule as HF: `--backend modal` requires a local project. Use it ONLY when
the user explicitly asks for Modal** ("run this on Modal", "use my Modal
account") or it is the configured default target. Modal runs on the user's own
Modal account, billed there per second; no OpenResearch balance is spent.
It runs the job in a Modal **Sandbox** (an ephemeral container that scales to
zero when the run ends).

orx auto-provisions a managed `modal` environment on the first Modal launch (no
pip-install needed). You only need a Modal token — `MODAL_TOKEN_ID` +
`MODAL_TOKEN_SECRET` in the environment (set them as org or project env vars and
they sync to the box automatically), or `modal token new`.

```sh
orx exp run <expId> --backend modal --flavor a10g               # one GPU sandbox
orx exp run <expId> --backend modal --flavor a100-80gb --timeout 8h
orx exp run <expId> --backend modal --flavor h100:2             # 2× H100
orx exp run <expId> --backend modal --flavor cpu --image python:3.12
```

Rules and notes:
- **`--flavor` is required.** It's a
  Modal GPU: `t4`, `l4`, `a10g`, `a100`, `a100-80gb`, `l40s`, `h100`, `h200`
  (append `:N` for a count, e.g. `h100:2`); or `cpu` / `cpu-large` for CPU-only.
  Prefer the smallest flavor that fits.
- **Set `--timeout` to cover the whole run** (default `4h`). Modal kills the
  sandbox at the timeout; a killed sandbox reads as a failed run.
- `orx` copies the committed source snapshot into the sandbox before starting
  the fixed command; Modal never needs repository access.
- `--image` overrides the container (default: a CUDA pytorch image on GPU
  flavors, `python:3.12` on cpu). Pick one with your deps baked in when
  pip-install time dominates.
- Everything downstream is identical (`orx exp wait` / `orx runs` / `orx logs`,
  cancellation through OpenResearch or `orx exp cancel`). A detached `orx supervise` mirrors
  status and logs; don't kill it.

## Running on your Kubernetes cluster — `--backend k8s`

Requires a local project (`orx up`). Runs the experiment on your own Kubernetes
cluster from a manifest committed on the experiment branch. The full manifest
contract lives in the `orx-compute-k8s` skill — fetch it (`orx skill compute-k8s`)
before your first k8s launch.

## Running on your own box — `--backend ssh`

**Same rule: use `--backend ssh` ONLY when the user explicitly asks to run on
their own machine/server** ("run this on my box", "use my GPU server") or it
is the configured default target (`--host <alias>` is still required per
launch). Local projects (`orx up`) only for now. It runs the experiment as a
detached background process on a host from your `~/.ssh/config`, over `ssh` —
no scheduler, no container, the host's own environment.

```sh
orx exp run <expId> --backend ssh --host my-gpu-box     # ~/.ssh/config alias
```

Rules and notes:
- **`--host` is the ssh host alias** (from `~/.ssh/config`) — a machine, not a
  hardware shape, so there is no `--flavor` here. Use one of the user's
  configured aliases; OpenResearch validates reachability and required tools.
- Auth is your ssh keys/agent — orx never reads a key, it just shells out to
  `ssh <alias>`. The host needs `bash` and `tar`; orx streams the committed
  source snapshot over SSH, extracts it into the run directory, and starts the
  fixed command.
- No `--image` (the host's environment is used as-is) and no `--timeout` (the
  process runs until it exits or you cancel).
- The run lives under `~/.orx/runs/<runId>/` on the host (`run.sh`, `log`,
  `pid`, `exit_code`). Cancellation through OpenResearch or `orx exp cancel` kills the remote
  process group. Everything downstream (`orx exp wait` / `runs` / `logs`) is
  identical; a detached `orx supervise` polls it over ssh — don't kill it.

## Running on your Slurm cluster — `--backend slurm`

**Same rule: use `--backend slurm` ONLY when the user explicitly asks for their
Slurm cluster** ("submit it to the cluster", "run it via sbatch") or it is the
configured default target. Local projects (`orx up`) only. It submits the
experiment as a batch job via `sbatch` on the login node, reached over ssh — the
host's environment as-is, no container.

```sh
orx exp run <expId> --backend slurm --host login-node --flavor h100:2 --timeout 4h
orx exp run <expId> --backend slurm                    # CPU-only, settings default host
```

Rules and notes:
- **`--host` is the login node's `~/.ssh/config` alias**; omit it to use the
  configured Slurm default.
- **`--flavor` is a GRES GPU request** (`h100:2` = two H100s) — omit it for a
  CPU-only job. There is no `--image`; the job runs in the cluster's own
  environment (modules, conda, whatever the login profile provides).
- `--timeout` (default `4h`) applies — size it to cover the whole run; a job
  killed at the timeout reads as a failed run.
- `orx` streams the committed source snapshot to the login node before `sbatch`
  starts the fixed command. Everything downstream (`orx exp wait` / `orx runs`
  / `orx logs` / `orx exp cancel`) is
  identical; a detached `orx supervise` mirrors status and logs — don't kill it.

## Running on a Ray Jobs cluster — `--backend ray`

**Same rule: use `--backend ray` ONLY when the user explicitly asks for their
Ray cluster** ("submit it to ray", "run it on the ray cluster") or it is the
configured default target. Local projects (`orx up`) only. It submits via the
Ray Jobs / Dashboard API — the job runs in the cluster's own runtime
environment, no per-job container.

```sh
orx exp run <expId> --backend ray
orx exp run <expId> --backend ray --flavor gpu:1
orx exp run <expId> --backend ray --flavor cpu:2,mem:8GiB
```

Rules and notes:
- **Address** comes from the user's saved Ray configuration, else
  `ASTROAI_RAY_JOBS_ADDRESS` / `RAY_DASHBOARD_URL`, else
  `http://127.0.0.1:8265` (a local Ray head).
- **`--flavor` is optional** entrypoint resource hints: `cpu[:N]`, `gpu[:N]`,
  `mem:<size>` (comma-separated, e.g. `gpu:1,cpu:4,mem:8GiB`; `mem` is a
  scheduling reservation, not an enforced cap). Omit it to reserve nothing —
  that avoids Pending on small heads.
- No `--image`, `--host`, or `--timeout` — the job runs in the cluster's
  runtime env until it finishes; size and bound work in the run command itself.
- Ray receives the committed snapshot as its `working_dir` package; downstream
  commands stay the same, and a detached
  `orx supervise` mirrors status and logs — don't kill it.

## Running on an OpenResearch box — `--backend openresearch`

**Requires a local project initialized with `orx up`. Use `--backend
openresearch` ONLY when the user explicitly asks for it** ("use an openresearch
box", "bill it to the org") or it is the configured default target. It
provisions an **ephemeral OpenResearch machine
billed to the user's org** — created for this run and deleted when it ends —
from the provider's pinned CUDA base with pinned `uv`. Project dependencies come
from the experiment lockfile. Needs `orx login` and a registered SSH key.

```sh
orx exp run <expId> --backend openresearch --flavor h100_sxm:2 --timeout 4h
orx exp run <expId> --backend openresearch --flavor cpu5c:32 --org <orgId>
```

Rules and notes:
- **`--flavor` is a GPU id from `orx compute`** (`h100_sxm`, `h100_sxm:2` for a
  count) **or a CPU flavor** (`cpu5c` / `cpu5g` / `cpu5m`, with `:vcpus` like
  `cpu5c:32`). Run `orx compute` to see what's available.
- Optional: `--org <id>` (when you belong to several), `--disk <GB>`, and
  `--provider <P>`. No `--image` — the platform's image is fixed.
- `--timeout` (default `4h`) applies — the box is deleted when the run ends
  either way, so nothing persists on it; everything you need must be in the log.
- `orx` streams the committed source snapshot to the provisioned box;
  downstream commands stay the same, and a detached
  `orx supervise` mirrors status and logs — don't kill it.

## Running on this machine — `--backend local`

**Same rule: use `--backend local` ONLY when the user explicitly asks to run
locally** ("run it on this machine", "just run it here") or it is the
configured default target. Local projects (`orx up`) only. It runs the
experiment as a detached background process on the machine running orx — no
scheduler, no container, this machine's own environment.

```sh
orx exp run <expId> --backend local
```

Rules and notes:
- **Nothing to pick** — no `--flavor`, `--host`, `--image`, or `--timeout`
  (the process runs until it exits or you cancel). The hardware is whatever
  this machine has; prefer it for small or CPU-scale runs and use a remote
  backend for anything heavy — it shares CPU/RAM/GPU with everything else on
  the machine.
- The run extracts the committed source snapshot into its own run dir (never
  your checkout) and runs the fixed command. Never run training directly in your
  shell instead: that would be unsupervised and untracked by OpenResearch.
- The run lives under `<orx data dir>/local-runs/<runId>/` (`run.sh`, `log`,
  `pid`, `exit_code`). Cancellation through OpenResearch or `orx exp cancel` TERMs the
  process group. Everything downstream (`orx exp wait` / `orx runs` / `orx logs`) is
  identical; a detached `orx supervise` watches it — don't kill it.

## Spinning up a standalone instance — `orx instance create`

Provision a persistent instance in an **organization**, not tied to any
experiment. Use this for ad-hoc/manual compute (you SSH in yourself); experiment
runs use `orx exp run` instead.

```sh
orx instance create <orgId> --gpu H100_SXM --count 1 [--disk 100]   # GPU box (cheapest provider)
orx instance create <orgId> --gpu H100_SXM --provider runpod        # pin a provider
orx instance create <orgId> --cpu cpu5g --vcpus 8                    # CPU-only box
```

- `<orgId>` comes from `orx projects` (the `org:` line). Choose exactly one of
  `--gpu` or `--cpu`; `--count`/`--disk` apply to `--gpu`, `--vcpus` to `--cpu`.
- Unlike `orx exp run`, omitting `--provider` picks the **cheapest** matching
  offer across all providers; pass `--provider <name>` to pin one.
- The box provisions asynchronously — the command prints its id and current
  status; its SSH host appears once it's online.

## Waiting on runs — `orx exp wait`

Block until a run changes state — useful when driving a research loop and you want
to act as soon as a run finishes. Two modes, picked by argument:

```sh
orx exp wait <expId>                    # level trigger: poll this experiment's latest run
                                        #   until it reaches a terminal state (done/failed/cancelled)
orx exp wait --project <projectId>      # edge trigger: return when the FIRST run in the
                                        #   project COMPLETES (transitions into done/failed/cancelled)
orx exp wait <expId> --interval 10 --timeout 3600   # tune polling
```

- Pass **exactly one** of `<expId>` or `--project` (not both, not neither).
- `--project` is the **budget-loop** primitive: it wakes only on a **completion**
  (a run reaching `done`/`failed`/`cancelled`) — i.e. a freed slot. Run *starts*,
  new queued runs, and `queued→running` transitions are intentionally ignored, so
  it won't wake you on non-events. It returns on the **first** completion — call
  it in a loop, one return per tick, and you (not the CLI) decide what to do with
  each freed slot. See the per-completion loop in the `orx-experiment-tree` skill.
- **It's a sleep-until-change signal, not the source of truth.** It reports only
  completions it saw *during that one call*; a run that finishes between calls is
  already terminal next time and won't be reported. On every return, re-read
  `orx runs <projectId>` and act on *all* newly-terminal runs — don't treat the
  printed line as the complete set, and don't replace `exp wait` with a tight
  `orx runs` poll either (use `exp wait` to sleep, `orx runs` to reconcile).
- Call `--project` **while runs are in flight** (right after launching). If every
  run is already terminal, there's nothing left to complete, so it returns
  immediately printing `drained: no runs in flight` (exit 0) — your loop's
  termination signal.
- `--interval` is seconds between polls (default `5`); `--timeout` gives up after
  N seconds (default `1800`) and exits **non-zero** so callers can branch on it.
  For long training runs, raise `--timeout` (or treat a timeout exit as "nothing
  changed yet, loop again") so a wait that simply outlasts the interval isn't
  mistaken for an error.
- Progress lines go to **stderr**; the final completion line(s) go to **stdout**,
  each as `<runId> <prev> -> <status>` (or `<runId> <status> (new)`), or the
  single line `drained: no runs in flight` when nothing was in flight.
- **When a run is `failed`, a `reason:` line follows it.** Compute spin-up
  failures (no GPU capacity, provider quota/limit hit, transient provider error)
  carry the provider's own message here — the same text the website shows as a
  toast. These are usually **transient and retryable**: wait and re-launch the
  same run, or pick a different GPU/provider, rather than treating the experiment
  as a dead end. If the run instead failed *after* the box came up, the `reason:`
  line points at `orx logs <runId>`, where the traceback/OOM/setup error lives.
  The same `reason:` line appears under `orx exp status <expId>` and beneath the
  `orx runs <projectId>` table.
- **A failed run is not a new node.** Re-launch the same `<expId>` — a failure
  answered nothing, so the node is still repairable in place
  (`orx-experiment-tree`).

## Sizing compute

- **Decide GPU vs CPU first.** API-driven evals, data prep, and CPU-bound
  papers run fine (and far cheaper) on a CPU flavor.
- **Pick the smallest flavor that fits** the model and a minimal batch; don't
  reflexively grab the biggest.
- **Let a real failure escalate you.** OOM or hopelessly-slow → move up a
  tier. That's expected, not a mistake.
- Raise `--timeout` (`--timeout 1d`) only for genuinely long runs.
