---
name: orx-git
description: "Read, edit, commit, and diff experiment code with local Git. Use whenever you touch an experiment branch, compare nodes, prepare a run, or diagnose stale code."
---

Git records every experiment locally. GitHub publication may be enabled for
collaborator visibility, but it is never part of compute transport. Follow the
project playbook's publication status; do not push merely to launch compute and
do not fetch from or publish back to the paper's upstream repository.

Each experiment node has a local `orx/<slug>` branch. `orx
create-experiment` creates it from its parent. Work in the session worktree,
check out the printed branch, make only that experiment's change, and commit it:

```sh
git checkout orx/<slug>
git status --short
git add <changed files>
git commit -m "describe the experiment change"
```

The runner builds an immutable source archive from the recorded commit, so
committed work is sufficient on every backend. Uncommitted files are never
included in a run. Before launching, confirm `git status --short` is empty and
inspect the recorded commit with `git show --stat --oneline HEAD`.

To compare a child with its parent, use local refs only:

```sh
git diff <parent-branch>...orx/<child-slug>
git log --oneline <parent-branch>..orx/<child-slug>
```

Once a run answers an experiment, treat that branch as immutable and create a
child for the next change.
