---
name: orx-experiment-tree
description: "The experiment-tree model and the auto-research loop: shape the tree (stacked bushes), branch/launch/wait/promote, and `orx exp desc` notes. Use before creating, planning, or reorganizing experiments, when deciding what to try next, when a round of runs finishes, or whenever you're unsure how work maps onto the tree."
---

A project is a tree of experiment nodes. The root establishes the baseline;
children inherit their parent's code and fixed run command. Every node has a
local `orx/<slug>` branch.

Use stacked bushes: siblings are co-equal options for one decision, while the
next round descends from the previous round's winner. Do not build a flat fan
off the root or a single chain of unrelated changes.

For each round:

1. Inspect `orx project view <projectId>` and choose the parent deliberately.
2. Create sibling experiments with `orx create-experiment`.
3. Check out each printed branch, implement only its hypothesis, and commit it.
4. Launch with `orx exp run <expId> --backend local`.
5. Call `orx exp wait --project <projectId>`, then reconcile with `orx runs`.
6. Read `orx logs <runId>` and record the result with `orx exp desc`.
7. Descend from the winner for the next round.

A node that produced a meaningful result is frozen. If a run answered nothing
because of an implementation error, repair the same branch and rerun it; after
two non-answers, stop and ask the user. Keep the run command fixed and make the
program print all evidence needed for comparison.
