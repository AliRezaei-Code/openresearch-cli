//! The `agent` command group: delegate work to a second agent session.
//!
//!   orx agent spawn "<task>"   start a helper agent on its own top-level session
//!
//! Only meaningful inside a local `orx up` agent session, which exports
//! `ORX_CHAT_SESSION_ID` (see `local::chat::set_chat_session_env`) — that env
//! var is how this subprocess knows which session is doing the spawning.
//!
//! This command only writes the child's session row and a `chat_spawns` record;
//! it never runs the child itself. The resident `orx up` picks the record up,
//! starts the child's first turn, and (unless `--no-wake`) wakes the parent when
//! the child is done. Same store-and-watcher split as `orx exp wake`, and for
//! the same reason: the CLI is a short-lived subprocess with no harness of its
//! own to run a turn on.

use std::io::Read;

use crate::error::{anyhow, Result};
use crate::store::{now_ms, ChatSpawn, ChatSpawnState, Store, StoredChatSession};
use crate::AgentCommand;

pub async fn run(args: crate::AgentArgs) -> Result<()> {
    let store = Store::open()?;
    match args.command {
        AgentCommand::Spawn {
            task,
            stdin,
            title,
            harness,
            model,
            no_wake,
        } => spawn(&store, task, stdin, title, harness, model, !no_wake),
    }
}

/// Read the task from the positional argument or, with `--stdin`, from the
/// whole of stdin (agents write multi-paragraph briefs as heredocs).
fn task_text(task: Option<String>, stdin: bool) -> Result<String> {
    if stdin {
        if task.is_some() {
            return Err(anyhow!(
                "Pass the task as an argument or --stdin, not both."
            ));
        }
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| anyhow!("Could not read the task from stdin: {e}"))?;
        return non_empty(buf);
    }
    non_empty(task.unwrap_or_default())
}

fn non_empty(text: String) -> Result<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(anyhow!(
            "Describe the task for the spawned agent: `orx agent spawn \"<task>\"`."
        ));
    }
    Ok(trimmed.to_string())
}

fn spawn(
    store: &Store,
    task: Option<String>,
    stdin: bool,
    title: Option<String>,
    harness: Option<String>,
    model: Option<String>,
    notify_parent: bool,
) -> Result<()> {
    if !crate::local::chat::in_local_session() {
        return Err(anyhow!(
            "`orx agent spawn` is only available inside a local `orx up` agent session."
        ));
    }
    let parent_id = crate::local::chat::launching_chat_session()
        .ok_or_else(|| anyhow!("This agent session has no chat id to spawn from."))?;
    let parent = store
        .get_chat_session(&parent_id)?
        .ok_or_else(|| anyhow!("The current chat session no longer exists."))?;
    // One level only. A helper that can spawn helpers turns a single request
    // into an unbounded tree of paid sessions, and nothing downstream bounds it.
    if parent.parent_session_id.is_some() {
        return Err(anyhow!(
            "This session was itself spawned by another agent, and spawned agents cannot spawn \
             their own. Do the task here, or report back so the session that spawned you can \
             delegate it."
        ));
    }
    let prompt = task_text(task, stdin)?;
    let harness = harness.unwrap_or_else(|| parent.harness.clone());
    if !crate::local::harness::is_chat_harness(&harness) {
        return Err(anyhow!("Unknown harness: {harness}"));
    }
    // Settings only carry over when the child runs the same harness; a model or
    // permission-mode id from one CLI is meaningless to another.
    let inherits = harness == parent.harness;
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    let session = StoredChatSession {
        id: format!("chat_{}", uuid::Uuid::new_v4()),
        project_id: parent.project_id.clone(),
        harness,
        native_session_id: None,
        title_source: title.as_ref().map(|_| "user".to_string()),
        title,
        model: model.or_else(|| inherits.then(|| parent.model.clone()).flatten()),
        permission_mode: inherits.then(|| parent.permission_mode.clone()).flatten(),
        // A helper agent is spawned to *do* the task, so it never starts gated
        // behind Plan even when the parent is planning.
        plan_mode: false,
        plan_reset_pending: false,
        reasoning_level: inherits.then(|| parent.reasoning_level.clone()).flatten(),
        archived: false,
        context_usage_json: None,
        bootstrap_context: None,
        active_leaf_id: None,
        parent_session_id: Some(parent_id.clone()),
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    store.create_chat_session(&session)?;
    store.create_chat_spawn(&ChatSpawn {
        session_id: session.id.clone(),
        parent_session_id: parent_id,
        prompt,
        notify_parent,
        state: ChatSpawnState::Pending,
    })?;
    println!("Spawned agent session {}.", session.id);
    println!("It starts within a few seconds and works in its own git worktree.");
    if notify_parent {
        println!("This chat will be resumed with its result when it finishes.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::task_text;

    #[test]
    fn a_task_is_required_and_comes_from_one_place() {
        assert_eq!(
            task_text(Some("  Sweep the literature  ".into()), false).unwrap(),
            "Sweep the literature"
        );
        assert!(task_text(None, false).is_err());
        assert!(task_text(Some("   ".into()), false).is_err());
        // --stdin and a positional together are ambiguous, so neither is used.
        assert!(task_text(Some("from the args".into()), true).is_err());
    }
}
