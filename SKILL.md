---
name: openresearch-cli
description: Use the `orx` CLI to run local OpenResearch projects from a terminal — create experiment branches, launch and supervise compute, inspect logs and evidence, and read legacy API records. Experiment code and execution are owned by the local `orx up` project. Read this before driving `orx` programmatically.
---

# OpenResearch CLI (`orx`)

`orx up` owns new projects, experiment branches, and execution in a local Git
repository and local database. The CLI also reads retained project, experiment,
run, and report records from the OpenResearch API. Those legacy API records do
not support project creation, experiment creation, or hosted execution. Use the
local session worktree to read, diff, and edit code (see `orx-git`).

This overview is deliberately short: it carries the cardinal rules and a command
quick-reference, then points at focused **modules** for everything else. Load a
module with `orx skill <name>` (the live index is printed at the end of `orx
skill` output).

## Cardinal rules — read before doing anything else

These four govern everything below. Breaking any one silently invalidates your
results — they are not style preferences. The `orx-experiment-tree` module
expands on the why; these are the non-negotiables.

1. **Never edit a node once a run has answered it.** A node freezes the moment
   a run establishes its baseline or tests its hypothesis — that includes the
   root — and freezing is permanent: a disappointing result is still a result.
   Until then it is **provisional**: seeding it, fixing its deps, and making it
   run all happen on its own branch (`orx-experiment-tree`). To try an idea,
   branch a **child** and edit the child.
2. **The run command *and* the environment are a fixed contract — identical on
   every node.** A child inherits its parent's run command verbatim; leave it
   alone. Do **not** give nodes different start commands, and do **not** vary
   behavior through environment variables or env-prefixed commands
   (`LR=3e-4 python …`). The *only* thing that may differ between nodes is the
   **committed code/config** on the node's git branch. Set the local project's
   command once with `orx project edit <projectId> --run-command '<cmd>'`.
3. **Vary code, not knobs-in-the-command.** Encode hyperparameters in the
   code/config files and branch a child per variant — never sweep them by editing
   the run command or passing env vars. Every node runs the *same* command over
   *different code*, so their `EVAL.md` outputs stay comparable.
4. **Grow the tree downward, not sideways.** Fan a little *within* a round (the
   options of one decision), then **descend onto that round's winner** for the
   next round. A root with a long row of direct children and no grandchildren is
   the failure mode. See "Shape the tree" in the `orx-experiment-tree` module.

If you're ever tempted to change the command, pass an env var, or pile another
node onto the root instead of branching a child, editing its branch, and
descending — stop. That's the anti-pattern, not a shortcut.

## Setup

```sh
orx login          # opens a browser, stores a token at ~/.config/openresearch/credentials.json
orx logout         # remove the stored token
```

- The API base URL resolves from `--api-url` → `OPENRESEARCH_API_URL` → a built-in
  default. Set `OPENRESEARCH_API_URL` for non-local use.
- Local `orx up` project and run commands do not require a token. API-backed
  reads, reports, instance provisioning, and account settings require `orx login`.

## Command quick-reference

Project-scoped commands take a **project id**; experiment-scoped commands take an
**experiment id**; run-scoped commands take a **run id**. Don't mix them — get
ids from `orx projects`, `orx experiments`, and `orx runs` respectively. Each
group below has a module (`orx skill <name>`) with the full flags and rules.

### Auth
| Command | What it does |
|---|---|
| `orx login [--api-url <url>]` | Open a browser, do loopback OAuth, store a token. |
| `orx logout` | Remove the stored token. |

### Discover (project- and experiment-scoped)
| Command | What it does |
|---|---|
| `orx projects [--all] [--json]` | List local `orx up` projects plus retained API project records. Local rows include their working directory; API rows remain readable history. |
| `orx explore [--json]` | List public API project records (id + name + repo). Drill in with `orx project view` / `orx experiments` / `orx runs`. |
| `orx project view <projectId>` | Overview of one project: details, its experiment tree, and its reports. Works on any public project or any private one in your orgs. |
| `orx experiments <projectId>` | Print the project's experiments as an indented tree. **Experiment ids come from here.** |
| `orx runs <projectId> [--experiment <id>]` | List runs as a table, newest first. **Run ids come from here.** |
| `orx env <projectId>` | For an API project record, list environment-variable names and their source. Values are never returned. |

### Run evidence (run-scoped) — module `orx-evidence`
| Command | What it does |
|---|---|
| `orx logs <runId> [--head] [--bytes <n>] [--range <s>:<e>]` | Read a run's terminal log. |
| `orx search-logs <projectId> "<pattern>" (--run <id> \| --experiment <id>) [--max <n>]` | Grep run logs for a literal pattern. |
| `orx artifacts <runId>` / `orx artifact <runId> <key> [--head] [--bytes <n>]` | List / read a run's text artifacts. |
| `orx wandb <runId>` | List the W&B runs linked to a run. |
| `orx chart wandb <projectId> --metric "<key>" --run <runId>[:label] ...` | Render a W&B metric across runs to a PNG. |
| `orx query <projectId> "<sql>"` | Run one read-only DuckDB SQL statement against the evidence schema. |

### Create and run experiments (write) — modules `orx-create`, `orx-compute`, `orx-git`
| Command | What it does |
|---|---|
| `orx up` | Open the local dashboard to import or create a local project. |
| `orx project edit <localProjectId> [--name "<n>"] [--run-command "<cmd>"]` | Edit a local project's name or fixed run command. |
| `orx create-experiment <localProjectId> --title "<t>" [...]` | Add a local experiment node; prints its Git branch. |
| `orx compute [--gpu <id>] [--count <n>] [--provider <name>]` / `orx compute --cpu` | List the GPU/CPU compute catalog. |
| `orx instance create <orgId> (--gpu <id> … \| --cpu <flavor> …)` | Spin up a standalone instance in an org. |
| `orx exp status/run/cancel/wait/wake <localExpId>` | Inspect, run, cancel, wait on, or register a wake-up for a local experiment node. |
| `orx exp desc <expId> [--set "<text>" \| --stdin]` | Read or overwrite the experiment's description. |
| `orx report upload/list/show/download <projectId> …` | Publish and read project reports (module `orx-reports`). |

To **read or edit** a node's code—including diffing what a run changed—use plain
Git in the local session worktree. See the `orx-git` module.

### Literature & papers — alphaXiv / OpenAlex / bioRxiv (no login required) — module `orx-lit`
Use before any web search for academic/research queries (paper, author, blog, model release).
| Command | What it does |
|---|---|
| `orx lit "<query>" [--source alphaxiv\|openalex\|biorxiv] [--limit <n>] [--json]` | Full-text search; `--source` picks the corpus (default alphaxiv; openalex = all fields, biorxiv = biology preprints). |
| `orx paper <id\|url> [--source ...] [--full]` | Fetch a paper: alphaXiv report/`--full` text, or OpenAlex/bioRxiv metadata+abstract. Source auto-detected from the id. |

### Meta
| Command | What it does |
|---|---|
| `orx skill [name]` | Print this overview + the live module index (no args), or print one module / fetch a deeper reference doc by name. |

## Modules

The detail lives in focused modules — load one with `orx skill <name>` (the live
list, with one-line descriptions, is printed at the end of `orx skill` output):

- **orx-experiment-tree** — the experiment-tree model, the auto-research loop, and `orx exp desc`.
- **orx-create** — initialize a local project and add local experiment nodes.
- **orx-compute** / **orx-compute-k8s** — launch runs on compute; the k8s manifest contract.
- **orx-git** — read, edit, and diff a node's code with plain git.
- **orx-evidence** — logs, search-logs, artifacts, W&B charts, and the `orx query` evidence DB.
- **orx-reports** — write and publish research reports.
- **orx-lit** — literature search and paper content; the preferred starting point for academic/research queries (not web search).

Deeper API-served references (the project-query schema and worked examples, the
report writing guide) are fetchable too — `orx skill` lists them at the end when
the API is reachable.

## Typical workflow

Orienting in a project (read-only discovery):

```sh
orx projects                     # find the project id
orx experiments <projectId>      # see the tree, pick an experiment id
orx skill experiment-tree        # the model + the auto-research loop
orx runs <projectId>             # find a run id
orx logs <runId>                 # read its output
```

To actually **drive** a project toward a goal — edit each node's code on its git
branch and keep the GPU capacity saturated — follow the auto-research loop in
the `orx-experiment-tree` module. Every completed run is a decision point with
four moves: **repair** the same node when a run answered nothing, **refill**
the round with another sibling, **promote** the winner and descend, or **stop**.
