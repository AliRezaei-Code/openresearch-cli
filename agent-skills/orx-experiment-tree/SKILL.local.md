---
name: orx-experiment-tree
description: "The experiment-tree model and the auto-research loop: shape the tree (stacked bushes), branch/launch/wait/promote, and `orx exp desc` notes. Use before creating, planning, or reorganizing experiments, when deciding what to try next, when a round of runs finishes, or whenever you're unsure how work maps onto the tree."
---

A project is a **tree of experiment nodes**. The root (**baseline**) holds the
starting code and a **run command** — the single shell command that trains or
evaluates the node and prints its results to the run log. Every other node is a
**child** branched off a parent, inheriting its code and its run command. The two
rules this depends on — **never edit a node that has measured something** and
**the run command + env is a fixed contract** — are the cardinal rules;
everything below assumes them.

## A node is an evidence contract — provisional until it measures something

A node exists to answer **one question**, and it is finished when it has produced
the **measurement** that answers it. Until then it has produced nothing, and
there is nothing to protect.

**The freeze test — a node is FROZEN the moment ANY of its runs is
*evidence-valid*:**

> A run is **evidence-valid** when its log carries the measurement this node
> owes — the metric its `orx exp desc` names, the number you would put in a
> comparison table against a sibling. Not "it exited `done`". Not "it printed
> something". A partial trace — a step-0 loss, a warmup value, a config echo —
> is **not** the measurement unless the node's question is about early
> training; a run that died before reaching the stated metric measured nothing.
>
> A run that failed **because of the change this node makes** — diverged to NaN,
> OOMed on the bigger model, timed out on the slower config — is also
> evidence-valid: that failure *is* the node's answer.
>
> The one exception is narrow and **syntactic**: the code never expressed the
> idea at all — a `NameError`, a syntax error, a kwarg the callee *rejects*
> (`TypeError: unexpected keyword argument`), a shape mismatch **inside the
> lines you edited**. Repair those. The counterfactual is over **the diff you
> actually wrote**, never over the idea in the abstract: ask "is this diff
> malformed?", not "could a better version of this idea have avoided it?" —
> the answer to the second is always yes and it is not a licence to repair.
>
> So: **resource and dynamics failures are never defects.** OOM, timeout, NaN,
> divergence, instability — if this node's change grew the model, the batch,
> the sequence length, or the runtime, that failure *is* the result. "A correct
> implementation would have used gradient checkpointing" is **a new idea for a
> child**, not a repair of this one. A kwarg *value* you now regret is the
> hypothesis, not a typo. And a shape mismatch where your edit is internally
> consistent but collides with code you did not touch is the finding that the
> idea does not fit this architecture — freeze it, redesign on a child.
>
> **No metric named?** If the node's `orx exp desc` names none, infer it from
> the node's title and its siblings' descriptions, write it there, and judge
> against that. If it still cannot be pinned down, treat the run as
> evidence-valid — uncertainty freezes.
>
> **Deciding which it was.** The parent's run is on record — read it
> (`orx logs` on the parent's latest run; a root has no parent, so judge it
> against the node's own idea). If the parent hit the same thing, it's a
> defect: repair. A run that produced **no log to judge** — the box never came
> up, the job was preempted, the output is empty — is not a result at all:
> repair or relaunch. If you cannot point to a concrete, node-independent
> cause in the log (a missing module, a bad path, an env that didn't activate),
> **uncertainty freezes**: treat it as the node's result and branch a child.
> "Probably a bad seed" is not a concrete cause. Freezing wrongly costs one
> extra node; repairing wrongly destroys a measurement and cannot be undone.

| What `orx runs` / `orx logs` show | State | What you may do |
|---|---|---|
| No runs at all | provisional | edit the node's branch in place |
| Every run `failed` / `cancelled` **before the owed metric appeared**, none for a reason this node introduced | provisional | edit the node's branch in place |
| No judgeable log — spin-up failure, preemption, empty or truncated output | provisional | nothing to judge; repair or relaunch |
| Failed for a reason unrelated to this node's change — deps, imports, paths, env, a mis-sized flavor | provisional | edit in place — this is Repair |
| Failed *because of* this node's own change — diverged, OOM on the bigger model, timed out on the slower config | **FROZEN** | that failure is the result; branch a child to follow up |
| **Any** run whose log carries the measurement this node owes | **FROZEN** | never edit this branch again; branch a child |

Frozen is **permanent and per-node** — it never un-freezes: not after a later
failure, and not because the number disappointed you. A node that ran correctly
and produced a **bad** measurement is FROZEN — a negative result is a result.

The node's question and the numbers it owes live in `orx exp desc <expId>` —
write them there when you create it, so "did the measurement land?" stays
answerable later, and record the judgement there when you make it.

## Shape the tree — stacked bushes, not a flat fan or a noodle

The single most common way to drive a project badly is to get the **shape** wrong.
There are two opposite failures, and the right shape sits between them:

```
FLAT FAN (wrong)            NOODLE (wrong)            STACKED BUSHES (right)
root                        root                      root
├ a ├ b ├ c ... ├ n         └ a                       └ lr-head        ┐ round 1:
                              └ b                        ├ lr 2e-5     │ a small fan of
                                └ c                      └ lr 3e-5     ┘ co-equal options
                                  └ d ...                   └ winner ── arch-head   ┐ round 2
                                                               ├ arch-A             │ descends onto
                                                               └ arch-B             ┘ round 1's winner
```

- **Flat fan** (your whole sweep hanging off the root): every result is measured
  against the *start*, so wins never accumulate and the tree never makes progress.
- **Noodle** (a long single-child chain): depth manufactured for its own sake —
  each step doesn't actually build on the one above it.
- **Stacked bushes** (correct): a *small fan within a round* (the options of one
  decision), then **descend onto that round's winner** for the next round.

**The one rule that produces this shape.** Before you make X a child of Y, name
what Y established that X builds on:

- **You can name it** ("Y is the LR winner; X keeps that LR and changes the
  architecture") → real depth. X is a **child** of Y. Descend.
- **You can't — X and Y are co-equal options you're trying at the same time**
  (lr 2e-5 vs lr 3e-5) → they don't build on each other. They're **siblings** in
  the same bush. Fan, don't chain.

So: **width = the open options of one decision** (fan freely — a 3-way LR sweep
*should* be three siblings under a common head); **depth = decisions already
resolved, stacked** (one level down per winner kept). A new *round* never hangs off
the root — it hangs off the previous round's winner. That keeps the tree moving
**downward** as research progresses, without stringing unrelated nodes into a line.

Re-read the tree each round — `orx project view <projectId>` lists every node
(id, title, branch; roots marked `[root]`) — and check the shape: a wide row of
direct children off the root with no grandchildren means you're fanning when you
should be descending; a long depth-N chain with no branching means you're chaining
co-equal variants that should have been siblings.

## Classify before you create — remediation is neither width nor depth

Width is **the open options of one decision**. Depth is **decisions already
resolved, stacked**. Engineering remediation — making the code run at all — is
**neither**: no hypothesis, no comparison, no result. A chain of nodes each
fixing the next error is a **noodle made of non-experiments**.

Before every `orx create-experiment`, answer in one sentence:

> **"What will this node measure that no existing node measures?"**

If the honest answer is a *fix* ("it will finally import torch", "it will run
without the CUDA error"), **it is not a node.** Repair the provisional node you
already have and re-run it.

| Situation | Move | Why |
|---|---|---|
| Failed for a reason unrelated to this node's change | **Repair** the node | no hypothesis was tested |
| Failed *because of* this node's own change | **FROZEN** — that failure is the result | branch a child to follow up |
| Same measurement, different hyperparameter | **Sibling** child | co-equal option of one decision |
| New idea built on a node's confirmed result | **Child** of that node | real depth |
| Node measured something; you want a *variant* | **Child** — node is frozen | never edit a frozen branch |
| 2 runs in a row measuring nothing on one node | **Ask the user** | repair cap |

**The repair loop is not a research loop.** Repairs do not count toward "~3
consecutive failed or regressed runs" — that counter is about *scientific*
failure. The repair cap is separate and hard: two runs in a row that measure
nothing, then ask. **Different errors still count as consecutive**, and
switching flavor, provider, or backend is itself a repair — only a run that
measures something resets the count.

## The auto-research loop

To drive a project toward a goal (e.g. "best convergence for d=8"), this is the
intended flow — do **not** edit a frozen node or rewrite the run command:

1. **Read the baseline's code.** You already sit in a private git worktree of the
   project's repo — `git fetch origin && git checkout <branch>` and read it with
   your normal tools (see the `orx-git` skill). See the node's run command with
   `orx exp status <expId>` and find where the knobs live (config files,
   hyperparameters, model defs).
2. **Form one round's worth of hypotheses** — the co-equal options of a *single*
   decision (which LR? which schedule? which init?), each a concrete change you can
   make and measure against the others in this round. Don't mix decisions from
   different rounds into one batch — that's what produces the flat fan.
3. **Create the round as a bush, and pick its parent deliberately.** All of this
   round's options are **siblings under one parent** — the title is the idea, the
   description is the concrete change you'll make on that node's branch **and
   the measurement it owes** — the freeze test reads that metric, so a node
   without one cannot be judged. The parent is:
   - the **baseline**, only for the very first round (nothing has been won yet); or
   - the **previous round's confirmed winner**, for every round after — so this
     round's changes build *on top of* the last gain instead of resetting to the
     start. This is what walks the tree downward (see "Shape the tree" above).

   ```sh
   # Round 1 — one decision (the LR), its options fanned off the baseline:
   orx create-experiment <projectId> --parent <baseId> --title "LR 2e-5" \
     --description "Set the LR in config.yaml to 2e-5; change nothing else. Measures: final eval accuracy."
   orx create-experiment <projectId> --parent <baseId> --title "LR 3e-5" \
     --description "Set the LR in config.yaml to 3e-5; change nothing else. Measures: final eval accuracy."

   # Round 2 — LR 3e-5 won → the next decision (architecture) descends onto it:
   orx create-experiment <projectId> --parent <lr3e5WinnerId> --title "Wider MLP" \
     --description "On top of the LR-3e-5 winner, widen the MLP hidden dim 1024→2048 in model.py. Measures: final eval accuracy."
   ```
   The child inherits its parent's run command automatically — you don't set it,
   and you never give siblings different commands or env vars (cardinal rule 2).
4. **Implement each child's change on its git branch** — `orx create-experiment`
   prints the child's branch (`orx/<slug>`); in your worktree:
   ```sh
   git fetch origin && git checkout orx/<child-slug>
   git merge --ff-only origin/orx/<child-slug>
   #   …edit only the files that idea touches…
   git commit -am "cosine LR + warmup" && git push
   ```
   **Leave the run command alone.** While you're in the code, **make the run
   print the evidence you'll need to judge it** — final metrics, a compact
   summary block, the key config it actually used — because in local mode the
   run log is the only evidence channel (see the `orx-evidence` skill). A run
   whose output isn't in its log is lost.
5. **Launch the round's ready children**: `orx exp run <childId> --backend <b>`
   (or omit `--backend` when a default target is set — flags and flavors: the
   `orx-compute` skill). Remote backends can run siblings in parallel;
   `--backend local` shares this machine's CPU/RAM/GPU, so run those one or
   two at a time.
6. **Keep the round moving — drive a per-completion loop, not a wait-for-all
   barrier.** You want control back the moment *any one* run finishes so you can
   analyze it and either refill its slot or stop — not after the whole batch
   drains. `orx exp wait --project <projectId>` is built for exactly this: it
   returns on the **first** completion. Treat it as one **tick** of a loop, where
   *you* are the loop body:

   ```
   # after launching your runs, loop until the project is drained:
   loop:
     orx exp wait --project <projectId>   # sleeps; returns on the first completion
     orx runs <projectId>                 # SOURCE OF TRUTH: re-read all run states
     # for each run now terminal that you haven't handled yet:
     #   - read its results (step 7) and decide: launch a refill? promote it? stop?
     #   - launch the next queued child to refill the freed slot (step 5)
     # if `exp wait` printed "drained: no runs in flight"  → batch is done, break
   ```

   Three things make this robust — follow all of them:
   - **`exp wait --project` is a sleep-until-change signal, not the source of
     truth.** It only reports completions it observed *during that one call*. A
     run that finishes while you're analyzing the previous one is already terminal
     by the next call and **won't be reported**. So on every wake, re-read
     `orx runs <projectId>` and reconcile against the set of runs you've already
     handled — act on *every* newly-terminal run, not just the line `exp wait`
     printed. (This is the one time you do look at `orx runs` in a loop — as the
     reconcile after each wake, **not** as a tight poll in place of `exp wait`.)
   - **Re-issue `exp wait` each tick.** One completion → one return → you decide →
     you call it again. Don't expect a single `exp wait` to block until everything
     is done; that's the failure mode this loop avoids.
   - **Terminate on drained.** When no runs are in flight, `exp wait --project`
     returns immediately printing `drained: no runs in flight`. That — or seeing
     every run terminal in `orx runs` with no more children to launch — is your
     exit condition. Don't keep calling it into a timeout.
7. **Analyze each finish as it lands, then iterate.** Do the per-completion read
   *inside the loop above*, not deferred to the end — when a run finishes,
   **actually read its results**: `orx logs <runId>` (see the `orx-evidence`
   skill). To see exactly what a finished node changed, diff its branch against
   its parent's (see the `orx-git` skill). Don't infer from status alone. Each
   completion is a decision point with four moves:
   - **Repair** — the run produced no measurement for a reason unrelated to
     this node's change (deps, imports, paths, env, truncated output; an OOM or
     timeout only when it isn't this node's own change — see the freeze test).
     The node is still **provisional**: fix its branch in
     place, push, and re-launch the *same* node. Do not create a child for a
     fix. Cap: two runs in a row measuring nothing → stop and ask the user.
   - **Refill** — result is mediocre or inconclusive: launch the next queued child to
     keep the round moving (step 5).
   - **Promote** — result is a clear win: this node becomes the **parent for the next
     round**. The next batch of children branch off *it*, not the baseline, so the win
     carries forward and the next ideas stack on top of it. This is the move that makes
     the tree grow deeper; skipping it is what produces a flat, sweep-only tree.
   - **Stop** — goal met, or the branch is exhausted.

   Frozen nodes stay untouched throughout — promotion moves the *focal parent*
   down the tree, it never rewrites a node that already measured something.

Stop when the goal is met, or after ~3 consecutive failed or regressed runs.
When you stop, write up the tree as a report in the project's files dir — see
the `orx-reports` skill for the folder layout and section structure.

## Experiment description / notes — `orx exp desc`

Each experiment node carries a free-form **description** (markdown) — the same
field set by `create-experiment --description`. Use it for notes: observations,
hypotheses, or a running summary. It is a whole-document field: writing
overwrites whatever was there.

```sh
orx exp desc <expId>                          # print the description to stdout (empty → hint on stderr)
orx exp desc <expId> --set "tried lr=3e-4, diverged at step 4k"   # overwrite with a short note
cat notes.md | orx exp desc <expId> --stdin   # overwrite from stdin (long markdown)
```

- **Read** prints the text to **stdout** (pipe/redirect-friendly); when empty, a
  hint is printed to **stderr** and stdout stays empty.
- **Write** with exactly one of `--set` (inline) or `--stdin` (whole of stdin).
  Passing both is an error. Writing **replaces** the entire description — to
  append, read first, edit, and write back.
- `<expId>` comes from `orx create-experiment` output or `orx project view
  <projectId>` (the experiment id, not a run or project id).
