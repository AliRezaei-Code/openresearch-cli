//!
//! Creates an experiment node in a local `orx up` project. Shapes, picked by flags:
//!   --parent <id>   -> child experiment branched off that parent
//!   --baseline      -> a new baseline (root), even when roots already exist —
//!                      projects may hold multiple baselines
//!   (no flags)      -> the oldest project root when one exists, or the
//!                      baseline (root) when the tree is empty
//! A title is always required.

use crate::error::Result;
use crate::plane::{resolve_project, CreateExperimentSpec};
use crate::store::Store;

const USAGE: &str = "Usage: orx create-experiment <projectId> --title \"<title>\" [--parent <experimentId>] [--description \"<text>\"] [--run-command \"<cmd>\"]";

pub async fn run(mut args: crate::CreateExperimentArgs) -> Result<()> {
    let title = match args.title.take() {
        Some(t) => t,
        None => {
            eprintln!("{}", USAGE);
            std::process::exit(1);
        }
    };

    // The server plane rejects this verb without making an API request.
    let store = Store::open()?;
    let plane = resolve_project(store, &args.project_id)?;
    plane
        .create_experiment(CreateExperimentSpec {
            title,
            parent: args.parent,
            baseline: args.baseline,
            description: args.description,
            run_command: args.run_command,
        })
        .await?;
    // Success is local-only because the server plane always returns above.
    crate::telemetry::capture_experiment_started("create", true, None);
    Ok(())
}
