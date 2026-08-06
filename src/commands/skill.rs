use crate::config;
use crate::error::{anyhow, require_credentials, Result};
use crate::local::agent_skills::{self, SkillSet};

// Bundled top-level overview, shipped with the CLI so `orx skill` works without
// a round-trip. Deeper references are fetched live from the API. Embedded at
// compile time from the repo-root SKILL.md.
const SKILL_MD: &str = include_str!("../../SKILL.md");

/// Which bundled skill set this invocation serves: the Local bodies inside an
/// `orx up` session, the Full ones for a human at a terminal or a cloud box.
fn current_skill_set() -> SkillSet {
    if crate::local::chat::in_local_session() {
        SkillSet::Local
    } else {
        SkillSet::Full
    }
}

fn local_project_publication() -> Option<bool> {
    if !crate::local::chat::in_local_session() {
        return None;
    }
    let enabled = (|| {
        let session_id = crate::local::chat::launching_chat_session()?;
        let store = crate::store::Store::open().ok()?;
        let session = store.get_chat_session(&session_id).ok().flatten()?;
        store
            .get_local_project(&session.project_id)
            .ok()
            .flatten()
            .map(|project| project.github_enabled())
    })()
    .unwrap_or(false);
    Some(enabled)
}

pub async fn run(args: crate::SkillArgs) -> Result<()> {
    let publication = local_project_publication();
    if let Some(path) = args.path {
        // First: a bundled module (with or without the `orx-` prefix). These
        // ship in the binary, so they resolve offline and never drift.
        if let Some(skill) = agent_skills::find(&path, current_skill_set()) {
            if let Some(github_enabled) = publication {
                if !agent_skills::available_in_session(skill, github_enabled) {
                    return Err(anyhow!(
                        "{} requires GitHub. Enable GitHub syncing for this project first.",
                        skill.name
                    ));
                }
                println!(
                    "{}",
                    agent_skills::session_content(skill, github_enabled).trim_end()
                );
            } else {
                println!("{}", skill.content.trim_end());
            }
            return Ok(());
        }
        if publication == Some(false) {
            return Err(anyhow!(
                "Only bundled local-safe skills are available while this project is local-only. Enable GitHub syncing for this project before loading remote references."
            ));
        }
        // Otherwise fetch the canonical doc from the API (same docs the assistant
        // reads), so the schema never drifts from a hand-maintained copy.
        let creds = require_credentials().await;
        let content = crate::client::read_skill(&creds, &path).await?;
        println!("{}", content.content);
        return Ok(());
    }

    // No path: print the bundled overview, then the bundled module index, then
    // list API-fetchable deep references (best effort — skip if unreachable).
    if publication == Some(false) {
        println!(
            "OpenResearch local-only skills. Commit experiment branches locally and run them on this machine. GitHub and external compute remain unavailable until the user enables GitHub syncing for this project."
        );
    } else {
        println!("{}", SKILL_MD);
    }

    println!("\nBundled modules (orx skill <name>):");
    for s in agent_skills::skills(current_skill_set()) {
        let github_enabled = publication.unwrap_or(true);
        if agent_skills::available_in_session(s, github_enabled) {
            println!(
                "  {:<20} {}",
                s.name,
                agent_skills::session_description(s, github_enabled)
            );
        }
    }

    if publication == Some(false) {
        return Ok(());
    }

    let creds = match config::load_credentials().await? {
        Some(c) => c,
        None => return Ok(()),
    };

    // API unreachable — the bundled overview + modules are enough, so ignore Err.
    if let Ok(list) = crate::client::list_skills(&creds).await {
        if !list.skills.is_empty() {
            println!("\nFetchable references (orx skill <path>):");
            for s in &list.skills {
                println!("  {}", s.path);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn bundled_overview_avoids_openresearch_ui_navigation() {
        crate::local::assert_agent_guidance_is_ui_agnostic("orx skill overview", super::SKILL_MD);
    }
}
