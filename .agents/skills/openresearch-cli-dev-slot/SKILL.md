---
name: openresearch-cli-dev-slot
description: Required isolated local-development workflow for openresearch-cli. Invoke whenever starting, running, previewing, browser-testing, migrating, seeding, or cleaning up a worktree instance of the CLI backend or UI. Allocates an isolated dev slot and protects the user’s live backend, database, ports, and processes.
---

# OpenResearch CLI Dev Slot

Use one isolated slot per worktree. Never run a worktree build against the default data directory or the user's live backend.

## Allocate a slot

1. Define `WORKTREE_PATH` as the resolved absolute worktree path. Use its filesystem-safe basename only as a display label.
2. Resolve `MAIN_CHECKOUT` from the single `git worktree list --porcelain` entry whose branch is `refs/heads/main`. Set `LAUNCH_REGISTRY=$MAIN_CHECKOUT/.claude/launch.json` and `ALLOCATOR_ROOT=$HOME/.local/share/openresearch-dev`.
3. Create `ALLOCATOR_ROOT`, then in one shell process atomically acquire its `slot-allocator.lock` directory. Install an exit trap, then immediately record `WORKTREE_PATH`, `$$`, and the current timestamp inside it; remove the mutex if any write fails.
4. While that same process holds the mutex, create `"$MAIN_CHECKOUT/.claude"` under `umask 077` and initialize a missing launch registry as `{"version":"0.0.1","configurations":[]}`. Then re-read it and listeners on ports `4901`-`4909` and `5201`-`5209`.
5. Reclaim a current-format entry only when its absolute manifest path's worktree no longer exists and neither reserved port has a listener. After validating its slot key matches `slot-[1-9]`, remove its exact data and config directories before reuse.
6. For a legacy CLI entry with a relative manifest path, resolve it against `MAIN_CHECKOUT`. Treat it as a manual reservation while its worktree exists or either port listens. Otherwise remove only its launch entries; leave legacy data and config directories untouched for manual review.
7. Choose the lowest `N` unused by both the registry and listeners. Set `SLOT_KEY=slot-N`, then add backend `490N` and optional UI `520N` configurations. Encode `WORKTREE_PATH` in the backend's absolute `--manifest-path` argument, `SLOT_KEY` in its `ORX_DATA_DIR`, and the slot config path in `XDG_CONFIG_HOME`; these are the ownership fields used during reclamation.
8. Write the complete launch registry through a temporary JSON file in the same directory, validate it, then atomically rename it over the registry.
9. Release only the allocator mutex whose recorded PID is `$$`. The launch entry is the durable slot reservation.

If the allocator mutex already exists, wait for its owner. Reclaim it only when its recorded PID is dead and its timestamp is older than five minutes. If owner metadata is missing or malformed, use the mutex directory's modification time for the same five-minute recovery threshold. Never edit the registry without holding the mutex.

## Isolated database

Set:

```sh
ORX_DATA_DIR=$HOME/.local/share/openresearch-dev/$SLOT_KEY
XDG_CONFIG_HOME=$HOME/.local/share/openresearch-dev/$SLOT_KEY-config
```

Create both directories before launch. Copy only credentials explicitly needed for the test into the isolated config directory; never let a slot mutate the user's live OpenResearch settings.

For realistic data, take a WAL-safe snapshot:

```sh
mkdir -p "$HOME/.local/share/openresearch-dev/$SLOT_KEY"
sqlite3 "$HOME/.local/share/openresearch/orx.db" \
  ".backup '$HOME/.local/share/openresearch-dev/$SLOT_KEY/orx.db'"
cp -R "$HOME/.local/share/openresearch/run-logs" \
  "$HOME/.local/share/openresearch-dev/$SLOT_KEY/" 2>/dev/null || true
```

Never copy the live SQLite database file directly and never point test code at `$HOME/.local/share/openresearch/orx.db`.

## Launch

Backend:

```sh
ORX_DATA_DIR=$HOME/.local/share/openresearch-dev/$SLOT_KEY \
  XDG_CONFIG_HOME=$HOME/.local/share/openresearch-dev/$SLOT_KEY-config \
  cargo run --manifest-path "$WORKTREE_PATH/Cargo.toml" -- \
  up --no-browser --port 490N
```

HMR UI:

```sh
ORX_BACKEND=http://127.0.0.1:490N \
  pnpm -C "$WORKTREE_PATH/ui" dev --port 520N --strictPort
```

Without HMR, build `ui/` once and let the debug backend serve `ui/dist`.

## Migration protocol

1. Refresh the slot from a safe snapshot before first launch.
2. Start the branch only with the slot's `ORX_DATA_DIR`.
3. Allow startup migrations to advance only that slot database.
4. Treat the migrated slot as owned by that branch and schema version.
5. Recreate it from a fresh snapshot before testing older code that expects the previous schema.

## Process safety and cleanup

- Protect the user's default backend/UI ports `4791` and `5173`.
- Never use broad `pkill` or `killall` patterns.
- Capture PIDs for processes started by the agent and stop only those exact PIDs.
- Remove launch entries only when their recorded worktree path matches `WORKTREE_PATH` and its captured processes have stopped.
- Remove that entry's slot-keyed data and config directories only after its captured processes have stopped.
- Update cleanup-sensitive registry state under the same allocator mutex used for allocation.
