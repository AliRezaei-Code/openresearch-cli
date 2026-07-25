---
name: orx-git
description: "Read, edit, and diff a node's code with plain git: sync, commit, and push before running. Use whenever you touch experiment code — before editing any branch, when a checkout or push fails, when comparing two nodes' code, or when a run seems to have picked up stale code."
---

Every experiment node **is a git branch** (`orx/<slug>`) on the project's GitHub
repo — `orx create-experiment` prints it. There is no dev box and no `orx` code
command: the **local clone in the cache dir is the standard way to interface
with code** — reading a node's files, diffing what a run changed, and editing —
all with plain git and your own tools.

(In a local `orx up` session you already sit in a private git worktree of the
project repo, so you can edit the checked-out branch in place — `git fetch origin
&& git checkout <branch>`, edit, commit, push. The cache-dir clone below is the
flow for everything outside a live session, and for cloud/full-set contexts.)

**Clone into the openresearch cache dir, not your cwd.** The canonical location,
keyed by repo so the same clone is reused across all of a project's experiments:

```
~/.cache/openresearch/repos/<owner>/<repo>
```

`<owner>/<repo>` comes from `orx projects`. **Never** clone into your current
directory or the user's project folders — clones accreting in `~/projects` is the
failure mode this avoids.

This is how you **realize a child's hypothesis**: after `create-experiment
--parent`, check out the child's branch and make the specific code/config edits
its description calls for — then commit, push, and run. Edit only the files that
idea touches, and **don't touch the run command** (it's inherited; see the
`orx-experiment-tree` skill). Edit the node whose branch you own; a node that
has measured something is frozen — branch a child instead (see
`orx-experiment-tree`: the freeze test).

The sync recipe is **idempotent** — run it verbatim whether or not the clone
already exists from a previous session. Always fetch + fast-forward before
editing, so a reused clone is never stale (and the experiment's branch, created
server-side, is fetched even when it's brand-new and not in your local clone
yet):

```sh
DIR=~/.cache/openresearch/repos/<owner>/<repo>

# Clone once (skips if it already exists), then ALWAYS sync before touching a branch:
[ -d "$DIR" ] || git clone https://github.com/<owner>/<repo> "$DIR"
git -C "$DIR" fetch origin
git -C "$DIR" checkout orx/<slug>                 # creates a tracking branch if it's remote-only
git -C "$DIR" merge --ff-only origin/orx/<slug>   # fails loudly rather than discarding unpushed work

#   …edit files under "$DIR" with your normal tools…
git -C "$DIR" commit -am "tune lr"     # one or more commits — your call
git -C "$DIR" push                     # push so runs and the tree see the change
```

Rules and notes:
- **Always sync first — but never blow away unpushed work.** `merge --ff-only`
  fails loudly instead of silently discarding commits you never pushed — a real
  hazard when a push has failed and you're returning to a branch to repair it.
  Never use `checkout -B <branch> origin/<branch>`: it hard-resets to the GitHub
  tip and throws that work away. The contract is still commit + push before
  moving on.
- **Auth is your own git.** Clone/push use whatever GitHub credentials your `git`
  already has — the repo lives under your account or your org, so access is the
  same as any of your repos. If a clone or push fails on auth, authenticate git
  for github.com (e.g. `gh auth login` or an SSH key) and retry.
- **Push before you run.** `orx exp run` launches from the branch's pushed tip on
  GitHub — uncommitted or unpushed edits won't be in the run. Commit and push
  first.
- **Never merge or rebase a branch once its node is frozen** (cardinal rule) —
  frozen meaning one of its runs put two or more metric lines in the log (see
  `orx-experiment-tree`: the freeze test). Its history is the code those results
  came from. To bring in changes from another branch, create a **child**
  experiment and put the merge commit on the child's branch. On a *provisional*
  node a plain `git merge origin/<parent-branch>` to pick up an upstream fix is
  fine. And never rewrite history anywhere — no rebase, `commit --amend`,
  `reset --hard`, or force-push: the tree records what actually ran.
- **Reading another node's code** without disturbing your checkout: that branch is
  already in the clone after a fetch — `git -C "$DIR" show origin/orx/<slug>:<path>`.

## Code diffs — local git

What did a run change vs. its parent experiment? `orx exp status <expId>` prints
the parent's branch, the latest run's full commit SHA, and this exact recipe —
compute the diff locally in the same clone:

```sh
DIR=~/.cache/openresearch/repos/<owner>/<repo>   # owner/repo from `orx projects`
[ -d "$DIR" ] || git clone https://github.com/<owner>/<repo> "$DIR"   # cold cache → clone first
git -C "$DIR" fetch origin                        # ALWAYS fetch first — the commit and parent tip live on GitHub
git -C "$DIR" diff origin/<parent-branch>...<full-commit-sha>
```

- The **three-dot** form diffs from the merge-base — what the run's branch
  changed, not what the parent gained since the fork. That's the cumulative
  "what this experiment did to the code" view.
- Fetch first is mandatory: the run's commit and the parent's tip exist on
  GitHub and may not be in your clone yet.
- Root experiments have no parent — there is no diff base, by definition.

## Repairing a node in place (`orx up` worktrees)

A node that has produced **no measurement** is provisional: you fix it on its
own branch and re-run it — you do **not** create a child (see
`orx-experiment-tree`: the freeze test). In a live `orx up` session that means
re-checking-out a branch you may have already left, in a **worktree** where
"one branch, one owner" applies.

```sh
git fetch origin
git checkout orx/<slug>            # the SAME branch — not a new one
git merge --ff-only origin/orx/<slug>   # a previous repair may already be pushed
#   …fix the dependency / import / path…
git commit -am "repair: pin numpy<2 for the CUDA image"
git push
orx exp run <expId> --backend <b>  # re-run the SAME node
```

(Outside a live session — the cloud/full flow — do the same thing in the
cache-dir clone with `git -C "$DIR" …`.)

**If that checkout fails with "already checked out at …":**

1. **If the path it names is your own worktree** — you already have it; just
   `git status` and keep editing. This is the common case and is not an error.
2. **If it names another session's worktree** — another agent owns that node.
   Leave it alone and work on your own; do **not** create a child to dodge the
   lock, and never `git worktree remove`/`prune --force` or force a checkout to
   break someone else's. If the repair is genuinely yours, note it in
   `orx exp desc <expId>` and tell the user.

**Reading or fixing without owning the branch:** you can always inspect it
without checking out — `git show origin/orx/<slug>:<path>`,
`git log origin/orx/<slug>`, `git diff origin/<parent-branch>...origin/orx/<slug>`.

**Repair commits are first-class history.** Each run recorded its own
`commit_sha`, so failed attempts stay resolvable from `orx runs`; a repair is a
*new commit on top*, which is exactly the record you want.
