//! The `project` command group: operate on a single project by id.
//!
//!   orx project edit <projectId> [--name …] [--description … | --description-stdin] [--public | --private]
//!
//! Sibling to `orx projects` (which lists): the plural lists, the singular edits
//! one — mirroring `orx experiments` (list) vs `orx exp` (operate). Project ids
//! come from `orx projects`.

use crate::error::{anyhow, Result};
use crate::local::resolve::ProjectRef;
use crate::plane::{resolve_project, ProjectEdit};
use crate::{ProjectBriefCommand, ProjectCommand};

async fn run_brief(command: ProjectBriefCommand) -> Result<()> {
    let project_id = match &command {
        ProjectBriefCommand::Show { project_id }
        | ProjectBriefCommand::Update { project_id, .. } => project_id,
    };
    let store = crate::store::Store::open()?;
    let project = match crate::local::resolve::resolve_project(&store, project_id)? {
        ProjectRef::Local(project) => project,
        ProjectRef::Server(_) => {
            return Err(anyhow!(
                "`orx project brief` is available only for local OpenResearch projects"
            ));
        }
    };

    match command {
        ProjectBriefCommand::Show { .. } => {
            print!("{}", crate::local::files::read_project_brief(&project)?);
            Ok(())
        }
        ProjectBriefCommand::Update { .. } => {
            use tokio::io::AsyncReadExt as _;
            let mut content = String::new();
            tokio::io::stdin().read_to_string(&mut content).await?;
            if content.len() > crate::local::files::MAX_PROJECT_BRIEF_BYTES {
                return Err(anyhow!(
                    "PROJECT.md is too large; keep the project brief under 256 KiB"
                ));
            }
            crate::local::files::write_project_brief(&project, &content)?;
            println!("✓ Updated PROJECT.md");
            Ok(())
        }
    }
}

pub async fn run(args: crate::ProjectArgs) -> Result<()> {
    match args.command {
        ProjectCommand::Brief { command } => run_brief(command).await,
        ProjectCommand::View { project_id } => {
            let store = crate::store::Store::open()?;
            resolve_project(store, &project_id)?.view_project().await
        }
        ProjectCommand::Edit {
            project_id,
            name,
            description,
            description_stdin,
            public,
            private,
            run_command,
        } => {
            let store = crate::store::Store::open()?;
            resolve_project(store, &project_id)?
                .edit_project(ProjectEdit {
                    name,
                    description,
                    description_stdin,
                    public,
                    private,
                    run_command,
                })
                .await
        }
    }
}
