---
name: orx-git
description: "Read, edit, commit, and diff experiment code for a local-only Windows project without implying that experiments can run locally."
---

Work on the branch printed by `orx exp status <expId>`. Make focused changes,
review the diff, and commit them. Do not push while the project remains
local-only.

Experiment execution is unavailable for local-only projects on Windows. Do not
launch a run or invent an untracked local execution path. Ask the user to enable
GitHub syncing first; after that, push the experiment branch and use a supported
remote backend through `orx exp run`.
