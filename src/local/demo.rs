//! The first-run nanochat project: embedded source, deterministic local Git
//! history, and one curated harness-native conversation.

use std::path::{Path, PathBuf};
use std::process::Command;

use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{anyhow, Result};
use crate::store::{Store, StoredChatMessage, StoredChatSession, StoredRun};

use super::chat::{WirePart, WireToolState};
use super::model::{LocalExperiment, LocalProject};

pub const PROJECT_ID: &str = "demo_nanochat_v1";
const EXPERIMENT_ID: &str = "demo_nanochat_cpu_v1";
const RUN_ID: &str = "demo_nanochat_run_v1";
const SESSION_ID: &str = "chat_demo_nanochat_v1";
const USER_MESSAGE_ID: &str = "msg_demo_nanochat_user_v1";
const ASSISTANT_MESSAGE_ID: &str = "msg_demo_nanochat_assistant_v1";
const OWNER: &str = "openresearch-demo";
const REPO: &str = "nanochat";
const BRANCH: &str = "orx/cpu-apple-silicon-end-to-end-baseline";
const BASELINE_SHA: &str = "1b3a42272a65478d26306696cb7bcb80e26c2e18";
const EXPERIMENT_SHA: &str = "346231fe75f91cd62b3040195993f33dc0e1853b";

const USER_PROMPT: &str = "Run nanochat's CPU/Apple-Silicon pipeline end-to-end with bash runs/runcpu.sh (the local shrunk-down version, not speedrun.sh, ~40 min), streaming output and surfacing val_bpb/eval numbers as they appear, fixing any setup errors in place, and when it finishes chat with the model via python -m scripts.chat_cli -p \"What is the capital of France?\" to confirm it works.";

const BOOTSTRAP_CONTEXT: &str = r#"You are continuing a live OpenResearch demo session. The following exchange already happened and is authoritative project context.

The user asked you to run nanochat's CPU/Apple-Silicon pipeline end to end, surface validation and evaluation metrics, repair setup issues, and confirm the trained model can answer the capital of France.

You inspected the repository and prepared the CPU pipeline before launching it: caches were made checkout-local, SFT conversations longer than a row were excluded, all-masked SFT batches were guarded, periodic ChatCORE was disabled for Apple-Silicon memory safety, and the chat CLI was made to re-enter the project environment. You created the CPU baseline experiment and completed one successful run.

Recorded results: a 6-layer 73.5M-parameter model trained for 5,000 base steps over 81.92M tokens; final training validation BPB 1.165758; base-eval train/validation BPB 1.152185/1.119301; SFT completed 1,500 steps with final validation BPB 0.7389. The final CLI loaded the SFT checkpoint and answered that the capital of France is Paris. The results are saved in cpu-apple-silicon-pipeline-results.md.

Continue naturally from this completed state. Do not claim you are rerunning the historical training unless the user asks you to."#;

const RESULT_MARKDOWN: &str = r#"Completed the nanochat CPU / Apple-Silicon pipeline end to end.

- Base training: 5,000 steps, 81.92M tokens, final validation BPB 1.165758
- Base evaluation: train BPB 1.152185, validation BPB 1.119301
- SFT: 1,500 steps, final validation BPB 0.7389
- Chat confirmation: the model answered that the capital of France is Paris
"#;

const REPORT: &str = r#"# nanochat CPU / Apple-Silicon pipeline results

This bundled demo records a completed local `runs/runcpu.sh` pipeline on Apple Silicon. It is historical evidence included with OpenResearch; onboarding does not rerun training on the new user's machine.

## Base training and evaluation

- Model: d6, 6 layers, 73.5M parameters, sequence length 512
- Training: 5,000 steps, 81.92M tokens, 131.55 minutes
- Final training-loop validation BPB: 1.165758
- Base-eval train BPB: 1.152185
- Base-eval validation BPB: 1.119301
- CORE accuracy: wikidata 0.0000, openbook 0.2500, winogrande 0.5625, operators 0.0000

## Supervised fine-tuning

- Started from the validated base checkpoint with a fresh optimizer
- Training: 1,500 steps, 39.07 minutes
- Validation BPB: 1.0174 → 1.0580 → 0.9914 → 0.9513 → 0.9141 → 0.8483 → 0.7950 → 0.7486 → 0.7389
- Final/minimum validation BPB: 0.7389

## Chat confirmation

The final command loaded the step-1499 SFT checkpoint on MPS and answered: “Paris … The capital of France is Paris.”

## Portable setup repairs

- Kept nanochat and uv caches inside the checkout.
- Excluded conversations longer than the SFT row capacity and guarded all-masked batches.
- Disabled memory-heavy periodic ChatCORE while retaining validation BPB.
- Made the chat CLI reuse the project environment and recorded cache location.
"#;

const RUN_LOG: &str = r#"nanochat CPU / Apple-Silicon demo run
command: bash runs/runcpu.sh

Tokenizer trained: vocab_size=32768, validation compression=4.69 bytes/token
Base model: depth=6, parameters=73.5M, sequence_length=512
step 0    val_bpb 3.195800
step 100  val_bpb 1.940739
step 1000 val_bpb 1.371813
step 2500 val_bpb 1.248040
step 4000 val_bpb 1.187774
step 5000 val_bpb 1.165758
base training complete: 81.92M tokens in 131.55 minutes

base_eval train_bpb=1.152185 val_bpb=1.119301
CORE bigbench_qa_wikidata accuracy=0.0000
CORE openbook_qa accuracy=0.2500
CORE winogrande accuracy=0.5625 centered=0.1250
CORE bigbench_operators accuracy=0.0000

SFT step 0    val_bpb 1.0174
SFT step 200  val_bpb 1.0580
SFT step 400  val_bpb 0.9914
SFT step 600  val_bpb 0.9513
SFT step 800  val_bpb 0.9141
SFT step 1000 val_bpb 0.8483
SFT step 1200 val_bpb 0.7950
SFT step 1400 val_bpb 0.7486
SFT step 1499 val_bpb 0.7389
SFT complete in 39.07 minutes

Loaded SFT checkpoint model_001499.pt on MPS
Assistant: Paris is a city known for its historical and cultural significance. The capital of France is Paris.

run completed successfully
"#;

#[derive(RustEmbed)]
#[folder = "demo/nanochat/base/"]
struct BaseAssets;

#[derive(RustEmbed)]
#[folder = "demo/nanochat/experiment/"]
struct ExperimentAssets;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DemoSelection {
    pub harness: String,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_level: Option<String>,
}

#[derive(Debug)]
pub struct DemoCompletion {
    pub project: LocalProject,
    pub selection: DemoSelection,
    pub newly_created: bool,
}

/// Install or return the first-run demo under production data/cache roots.
pub fn complete_onboarding(selection: DemoSelection) -> Result<DemoCompletion> {
    let store = Store::open()?;
    let data_root = crate::store::data_dir();
    let repo = super::git::clone_path(OWNER, REPO);
    seed_at(&store, &data_root, &repo, selection)
}

pub(crate) fn installed_origin(owner: &str, repo: &str) -> Option<PathBuf> {
    if owner != OWNER || repo != REPO {
        return None;
    }
    Store::open().ok()?.get_local_project(PROJECT_ID).ok()??;
    let origin = crate::store::data_dir().join("demo-repos/nanochat.git");
    origin.exists().then_some(origin)
}

pub(crate) fn session_start_ref(owner: &str, repo: &str, session_id: &str) -> Option<&'static str> {
    (owner == OWNER && repo == REPO && session_id == SESSION_ID).then_some(EXPERIMENT_SHA)
}

/// Repoint the embedded demo's local origin after the data directory moves.
pub fn repair_installed_origin(data_root: &Path) -> Result<()> {
    repair_installed_origin_at(data_root, &super::git::clone_path(OWNER, REPO))
}

fn repair_installed_origin_at(data_root: &Path, repo: &Path) -> Result<()> {
    let store = Store::open_at(data_root.to_path_buf())?;
    let Some(project) = store.get_local_project(PROJECT_ID)? else {
        return Ok(());
    };
    if project.repo_path != repo.to_string_lossy() {
        return Err(anyhow!(
            "the installed nanochat demo repository is not at its reserved cache path"
        ));
    }
    if !repo.join(".git").is_dir() {
        return Ok(());
    }
    let bare = data_root.join("demo-repos/nanochat.git");
    if !matches!(
        git(&bare, &["rev-parse", "--is-bare-repository"]).as_deref(),
        Ok("true")
    ) {
        return Err(anyhow!(
            "the moved nanochat demo origin at {} is not a bare Git repository",
            bare.display()
        ));
    }
    let origin = bare.to_string_lossy();
    if git(repo, &["remote", "get-url", "origin"]).is_ok() {
        git(repo, &["remote", "set-url", "origin", origin.as_ref()])?;
    } else {
        git(repo, &["remote", "add", "origin", origin.as_ref()])?;
    }
    Ok(())
}

fn seed_at(
    store: &Store,
    data_root: &Path,
    repo: &Path,
    selection: DemoSelection,
) -> Result<DemoCompletion> {
    let bare = data_root.join("demo-repos").join("nanochat.git");
    let commit_sha = install_repository(repo, &bare)?;

    let files = data_root.join("files").join("nanochat");
    std::fs::create_dir_all(&files)?;
    std::fs::write(files.join("cpu-apple-silicon-pipeline-results.md"), REPORT)?;
    let logs = data_root.join("run-logs");
    std::fs::create_dir_all(&logs)?;
    std::fs::write(logs.join(format!("{RUN_ID}.log")), RUN_LOG)?;

    let project = LocalProject {
        id: PROJECT_ID.into(),
        name: "nanochat".into(),
        slug: "nanochat".into(),
        github_owner: OWNER.into(),
        github_repo: REPO.into(),
        github_sync_enabled: false,
        baseline_branch: "main".into(),
        repo_path: repo.to_string_lossy().into_owned(),
        run_command: Some("bash runs/runcpu.sh".into()),
        paper_id: None,
        created_at: 1_785_812_413_316,
        updated_at: 1_785_879_263_859,
    };
    let experiment = LocalExperiment {
        id: EXPERIMENT_ID.into(),
        project_id: PROJECT_ID.into(),
        parent_experiment_id: None,
        slug: "cpu-apple-silicon-end-to-end-baseline".into(),
        branch_name: BRANCH.into(),
        title: Some("CPU Apple-Silicon end-to-end baseline".into()),
        description: Some(
            "Completed a portable CPU/MPS pipeline: 5,000 base steps, base evaluation, 1,500 SFT steps, and a successful Paris chat confirmation. Final base validation BPB was 1.165758 and final SFT validation BPB was 0.7389."
                .into(),
        ),
        run_command: project.run_command.clone().unwrap_or_default(),
        agent_status: "idle".into(),
        created_at: 1_785_824_322_614,
        updated_at: 1_785_879_252_272,
        chat_session_id: Some(SESSION_ID.into()),
    };
    let run = StoredRun {
        id: RUN_ID.into(),
        experiment_id: EXPERIMENT_ID.into(),
        project_id: PROJECT_ID.into(),
        status: "done".into(),
        backend_json: json!({ "kind": "local_job", "jobId": "demo:nanochat" }).to_string(),
        command: project.run_command.clone().unwrap_or_default(),
        created_at: 1_785_865_810_129,
        updated_at: 1_785_879_208_664,
        ended_at: Some(1_785_879_208_664),
        exit_code: Some(0),
        commit_sha: Some(commit_sha.clone()),
        result_markdown: Some(RESULT_MARKDOWN.into()),
        cancel_requested: false,
        chat_session_id: None,
    };
    let session = StoredChatSession {
        id: SESSION_ID.into(),
        project_id: PROJECT_ID.into(),
        harness: selection.harness.clone(),
        native_session_id: None,
        title: Some("Run Nanochat CPU Pipeline End-to-End".into()),
        title_source: Some("generated".into()),
        model: selection.model,
        permission_mode: selection.permission_mode,
        reasoning_level: selection.reasoning_level,
        archived: false,
        context_usage_json: None,
        bootstrap_context: Some(BOOTSTRAP_CONTEXT.into()),
        created_at: 1_785_824_322_614,
        updated_at: 1_785_879_263_859,
    };
    let user = StoredChatMessage {
        id: USER_MESSAGE_ID.into(),
        session_id: SESSION_ID.into(),
        role: "user".into(),
        parts_json: serde_json::to_string(&vec![WirePart::text("user-prompt", USER_PROMPT)])?,
        created_at: 1_785_824_322_627,
    };
    let assistant = StoredChatMessage {
        id: ASSISTANT_MESSAGE_ID.into(),
        session_id: SESSION_ID.into(),
        role: "assistant".into(),
        parts_json: serde_json::to_string(&assistant_parts(&selection.harness))?,
        created_at: 1_785_824_322_629,
    };
    let cache_root = repo
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| anyhow!("demo repository is not under the reserved cache layout"))?;
    let worktree = cache_root
        .join("worktrees")
        .join(PROJECT_ID)
        .join(SESSION_ID);
    super::git::ensure_worktree_at(repo, &worktree, &commit_sha)?;
    let newly_created =
        store.create_demo_snapshot(&project, &experiment, &run, &session, &[user, assistant])?;
    validate_snapshot(store, repo, newly_created)
}

fn validate_snapshot(store: &Store, repo: &Path, newly_created: bool) -> Result<DemoCompletion> {
    let project = store
        .get_local_project(PROJECT_ID)?
        .ok_or_else(|| anyhow!("demo project seed did not persist"))?;
    if project.repo_path != repo.to_string_lossy()
        || project.github_owner != OWNER
        || project.github_repo != REPO
        || project.baseline_branch != "main"
    {
        return Err(anyhow!(
            "the reserved demo project already exists with unexpected repository metadata; delete it and retry onboarding"
        ));
    }
    let experiments = store.list_experiments_by_project(PROJECT_ID)?;
    let runs = store.list_runs_by_project(PROJECT_ID)?;
    let sessions = store.list_chat_sessions_by_project(PROJECT_ID)?;
    if experiments.len() != 1
        || experiments[0].id != EXPERIMENT_ID
        || experiments[0].branch_name != BRANCH
        || runs.len() != 1
        || runs[0].id != RUN_ID
        || runs[0].status != "done"
        || runs[0].exit_code != Some(0)
        || runs[0].commit_sha.as_deref() != Some(EXPERIMENT_SHA)
        || sessions.len() != 1
        || sessions[0].id != SESSION_ID
    {
        return Err(anyhow!(
            "the reserved demo project is incomplete or modified; delete it and retry onboarding"
        ));
    }
    let messages = store.list_chat_messages(SESSION_ID)?;
    if messages.len() != 2
        || messages[0].id != USER_MESSAGE_ID
        || messages[0].role != "user"
        || messages[1].id != ASSISTANT_MESSAGE_ID
        || messages[1].role != "assistant"
    {
        return Err(anyhow!(
            "the reserved demo conversation is incomplete or modified; delete it and retry onboarding"
        ));
    }
    let stored = &sessions[0];
    Ok(DemoCompletion {
        project,
        newly_created,
        selection: DemoSelection {
            harness: stored.harness.clone(),
            model: stored.model.clone(),
            permission_mode: stored.permission_mode.clone(),
            reasoning_level: stored.reasoning_level.clone(),
        },
    })
}

fn assistant_parts(harness: &str) -> Vec<WirePart> {
    let mut parts = vec![WirePart::text(
        "intro",
        "I’ll inspect the local CPU path, make the known portability and SFT safeguards part of the experiment before launch, then run the full pipeline once and surface the meaningful checkpoints through the final chat confirmation.",
    )];
    if harness == "opencode" {
        parts.push(tool_part(
            "todo",
            "todowrite",
            json!({ "todos": [
                { "content": "Inspect and harden the CPU pipeline", "status": "completed", "priority": "high" },
                { "content": "Run base training, evaluation, and SFT", "status": "completed", "priority": "high" },
                { "content": "Confirm chat output and save results", "status": "completed", "priority": "medium" }
            ]}),
            None,
            Some("Track nanochat demo"),
        ));
    }
    let (read_name, read_input, edit_name, edit_input, shell_name) = match harness {
        "claude-code" => (
            "Read",
            json!({ "file_path": "runs/runcpu.sh", "filePath": "runs/runcpu.sh" }),
            "Edit",
            json!({
                "file_path": "runs/runcpu.sh",
                "filePath": "runs/runcpu.sh",
                "old_string": "export NANOCHAT_BASE_DIR=\"$HOME/.cache/nanochat\"\nmkdir -p $NANOCHAT_BASE_DIR",
                "new_string": "export NANOCHAT_BASE_DIR=\"$PWD/.cache/nanochat\"\nexport UV_CACHE_DIR=\"$PWD/.cache/uv\"\nmkdir -p \"$NANOCHAT_BASE_DIR\" \"$UV_CACHE_DIR\""
            }),
            "Bash",
        ),
        "opencode" => (
            "read",
            json!({ "filePath": "runs/runcpu.sh" }),
            "bash",
            json!({ "command": "git diff --check && git diff --stat" }),
            "bash",
        ),
        _ => (
            "bash",
            json!({ "command": "sed -n '1,220p' runs/runcpu.sh scripts/chat_sft.py scripts/chat_cli.py" }),
            "edit",
            json!({ "changes": [
                { "path": "runs/runcpu.sh", "kind": "update" },
                { "path": "scripts/chat_sft.py", "kind": "update" },
                { "path": "scripts/chat_cli.py", "kind": "update" }
            ]}),
            "bash",
        ),
    };
    parts.push(tool_part(
        "inspect",
        read_name,
        read_input,
        Some("CPU pipeline, SFT packing, and chat entry point inspected."),
        Some("Inspect CPU pipeline"),
    ));
    parts.push(WirePart::text(
        "inspection-summary",
        "The run is suitable for a local MPS baseline, but I’m hardening four failure boundaries before spending compute: keep caches inside the checkout, reject overlength SFT conversations, skip batches with no supervised targets, and disable periodic ChatCORE so unified-memory pressure cannot kill an otherwise healthy SFT run.",
    ));
    parts.push(tool_part(
        "portable-fixes",
        edit_name,
        edit_input,
        Some("Portable CPU/SFT safeguards applied."),
        Some("Apply portable safeguards"),
    ));
    parts.push(WirePart::text(
        "experiment-created",
        "With those safeguards committed, I created the CPU / Apple-Silicon end-to-end baseline experiment. I’m launching its single local run now.",
    ));
    parts.push(tool_part(
        "launch",
        shell_name,
        json!({ "command": "orx exp run demo_nanochat_cpu_v1 --backend local --force" }),
        Some("Run started on Apple Silicon (MPS)."),
        Some("Launch the new baseline experiment"),
    ));
    parts.push(WirePart::text(
        "base-progress",
        "Tokenizer training completed at 4.69 bytes/token. The 6-layer, 73.5M-parameter base model then trained for 5,000 steps over 81.92M tokens. Validation BPB improved from 3.195800 initially to 1.371813 at step 1,000, 1.248040 at step 2,500, and 1.165758 at step 5,000.",
    ));
    parts.push(tool_part(
        "evaluate",
        shell_name,
        json!({ "command": "orx logs demo_nanochat_run_v1 --bytes 16000" }),
        Some("base_eval train_bpb=1.152185 val_bpb=1.119301\nCORE openbook_qa=0.2500 winogrande=0.5625"),
        Some("Read evaluation and SFT progress"),
    ));
    parts.push(WirePart::text(
        "sft-progress",
        "Base evaluation finished at train/validation BPB 1.152185/1.119301. SFT stayed finite through all 1,500 steps and improved validation BPB from 1.0174 to 0.7389, with intermediate checkpoints at 0.9914, 0.9141, 0.8483, 0.7950, and 0.7486.",
    ));
    parts.push(tool_part(
        "confirm",
        shell_name,
        json!({ "command": "orx logs demo_nanochat_run_v1 --bytes 4000" }),
        Some("Paris is a city known for its historical and cultural significance. The capital of France is Paris."),
        Some("Confirm the trained chat model"),
    ));
    let (report_tool, report_input) = match harness {
        "claude-code" => (
            "Bash",
            json!({ "command": "printf '%s\\n' '# nanochat CPU / Apple-Silicon pipeline results' 'Base validation BPB: 1.165758' 'SFT validation BPB: 0.7389' 'Chat confirmation: Paris' > cpu-apple-silicon-pipeline-results.md" }),
        ),
        "opencode" => (
            "bash",
            json!({ "command": "printf '%s\\n' '# nanochat CPU / Apple-Silicon pipeline results' 'Base validation BPB: 1.165758' 'SFT validation BPB: 0.7389' 'Chat confirmation: Paris' > cpu-apple-silicon-pipeline-results.md" }),
        ),
        _ => (
            edit_name,
            json!({ "changes": [{ "path": "cpu-apple-silicon-pipeline-results.md", "kind": "add" }] }),
        ),
    };
    parts.push(tool_part(
        "report",
        report_tool,
        report_input,
        Some("Results artifact saved."),
        Some("Save durable results"),
    ));
    parts.push(WirePart::text(
        "final",
        "The single end-to-end run is complete. Base training finished at validation BPB **1.165758**, base evaluation reported **1.152185 / 1.119301** train/validation BPB, SFT converged to **0.7389**, and the saved checkpoint correctly answered **Paris**. I preserved the cleaned log and full results in the project artifact.",
    ));
    parts
}

fn tool_part(
    id: &str,
    tool: &str,
    input: Value,
    output: Option<&str>,
    title: Option<&str>,
) -> WirePart {
    WirePart {
        id: id.into(),
        kind: "tool".into(),
        text: None,
        tool: Some(tool.into()),
        state: Some(WireToolState {
            status: "completed".into(),
            input: Some(input),
            output: output.map(str::to_string),
            error: None,
            title: title.map(str::to_string),
        }),
        prompt: None,
        children: Vec::new(),
    }
}

fn install_repository(repo: &Path, bare: &Path) -> Result<String> {
    if repo.exists() {
        validate_worktree(repo)?;
    } else {
        let parent = repo
            .parent()
            .ok_or_else(|| anyhow!("demo repository has no parent directory"))?;
        std::fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(".nanochat-demo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp)?;
        let result = build_worktree(&tmp)
            .and_then(|_| validate_worktree(&tmp))
            .and_then(|_| match std::fs::rename(&tmp, repo) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    validate_worktree(repo)
                }
                Err(error) => Err(anyhow!("could not install demo repository: {error}")),
            });
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&tmp);
        }
        result?;
    }
    ensure_local_origin(repo, bare)?;
    git(repo, &["rev-parse", BRANCH])
}

fn build_worktree(root: &Path) -> Result<()> {
    write_assets::<BaseAssets>(root)?;
    set_executable(root.join("runs/runcpu.sh"))?;
    git(root, &["init", "--object-format=sha1", "-b", "main"])?;
    git(root, &["config", "core.autocrlf", "false"])?;
    git(root, &["config", "core.filemode", "true"])?;
    git(root, &["add", "-A"])?;
    commit(root, "Import nanochat demo baseline")?;
    git(root, &["checkout", "-b", BRANCH])?;
    write_assets::<ExperimentAssets>(root)?;
    set_executable(root.join("runs/runcpu.sh"))?;
    git(root, &["add", "-A"])?;
    commit(root, "Make the CPU pipeline portable and memory-safe")?;
    git(root, &["checkout", "main"])?;
    Ok(())
}

fn ensure_local_origin(repo: &Path, bare: &Path) -> Result<()> {
    if bare.exists() {
        validate_bare_origin(bare)?;
    } else {
        let parent = bare
            .parent()
            .ok_or_else(|| anyhow!("demo origin has no parent directory"))?;
        std::fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(".nanochat-demo-origin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp)?;
        git(&tmp, &["init", "--bare", "--object-format=sha1"])?;
        git(
            repo,
            &[
                "push",
                "--no-verify",
                tmp.to_string_lossy().as_ref(),
                "main",
                BRANCH,
            ],
        )?;
        git(&tmp, &["symbolic-ref", "HEAD", "refs/heads/main"])?;
        if let Err(error) = std::fs::rename(&tmp, bare) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(anyhow!("could not install demo Git origin: {error}"));
            }
            validate_bare_origin(bare)?;
        }
    }
    let origin = bare.to_string_lossy();
    if git(repo, &["remote", "get-url", "origin"]).is_ok() {
        git(repo, &["remote", "set-url", "origin", origin.as_ref()])?;
    } else {
        git(repo, &["remote", "add", "origin", origin.as_ref()])?;
    }
    git(
        repo,
        &["push", "--no-verify", "-u", "origin", "main", BRANCH],
    )?;
    validate_bare_origin(bare)?;
    Ok(())
}

fn validate_bare_origin(bare: &Path) -> Result<()> {
    let baseline = git(bare, &["rev-parse", "refs/heads/main"]);
    let experiment = git(bare, &["rev-parse", &format!("refs/heads/{BRANCH}")]);
    let is_bare = git(bare, &["rev-parse", "--is-bare-repository"]);
    let head = git(bare, &["symbolic-ref", "HEAD"]);
    if !bare.join("HEAD").is_file()
        || !matches!(baseline.as_deref(), Ok(value) if value == BASELINE_SHA)
        || !matches!(experiment.as_deref(), Ok(value) if value == EXPERIMENT_SHA)
        || !matches!(is_bare.as_deref(), Ok("true"))
        || !matches!(head.as_deref(), Ok("refs/heads/main"))
    {
        return Err(anyhow!(
            "the reserved demo origin at {} does not contain the expected OpenResearch refs; move it aside and retry onboarding",
            bare.display()
        ));
    }
    Ok(())
}

fn validate_worktree(repo: &Path) -> Result<()> {
    let baseline = git(repo, &["rev-parse", "refs/heads/main"]);
    let experiment = git(repo, &["rev-parse", &format!("refs/heads/{BRANCH}")]);
    let clean = git(repo, &["status", "--porcelain"]);
    let ancestry = git(
        repo,
        &["merge-base", "--is-ancestor", BASELINE_SHA, EXPERIMENT_SHA],
    );
    if !repo.join(".git").is_dir()
        || !matches!(baseline.as_deref(), Ok(value) if value == BASELINE_SHA)
        || !matches!(experiment.as_deref(), Ok(value) if value == EXPERIMENT_SHA)
        || !matches!(clean.as_deref(), Ok(""))
        || ancestry.is_err()
    {
        return Err(anyhow!(
            "the reserved demo path at {} already exists but is not the OpenResearch nanochat demo; move it aside and retry onboarding",
            repo.display()
        ));
    }
    Ok(())
}

fn write_assets<T: RustEmbed>(root: &Path) -> Result<()> {
    for name in T::iter() {
        let asset = T::get(name.as_ref())
            .ok_or_else(|| anyhow!("embedded demo asset disappeared: {name}"))?;
        let path = root.join(name.as_ref());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, asset.data.as_ref())?;
    }
    Ok(())
}

fn commit(repo: &Path, message: &str) -> Result<()> {
    git(
        repo,
        &[
            "-c",
            "user.name=OpenResearch Demo",
            "-c",
            "user.email=demo@openresearch.sh",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            message,
        ],
    )?;
    Ok(())
}

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    for name in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
        "GIT_TEMPLATE_DIR",
    ] {
        command.env_remove(name);
    }
    let out = command
        .current_dir(dir)
        .args([
            "-c",
            "core.attributesFile=/dev/null",
            "-c",
            "core.excludesFile=/dev/null",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "OpenResearch Demo")
        .env("GIT_AUTHOR_EMAIL", "demo@openresearch.sh")
        .env("GIT_COMMITTER_NAME", "OpenResearch Demo")
        .env("GIT_COMMITTER_EMAIL", "demo@openresearch.sh")
        .env("GIT_AUTHOR_DATE", "2026-08-04T12:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-08-04T12:00:00Z")
        .output()
        .map_err(|e| anyhow!("could not run git: {e}"))?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn set_executable(path: PathBuf) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&path)?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_variants_are_one_turn_and_use_native_tool_names() {
        for (harness, expected) in [
            ("claude-code", ["Read", "Edit", "Bash"]),
            ("codex", ["bash", "edit", "bash"]),
            ("opencode", ["read", "bash", "todowrite"]),
        ] {
            let parts = assistant_parts(harness);
            let encoded = serde_json::to_string(&parts).unwrap();
            let decoded: Vec<WirePart> = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded.len(), parts.len());
            let names: Vec<&str> = parts
                .iter()
                .filter_map(|part| part.tool.as_deref())
                .collect();
            for tool in expected {
                assert!(names.contains(&tool), "{harness} missing {tool}: {names:?}");
            }
            let allowed: &[&str] = match harness {
                "claude-code" => &["Read", "Edit", "Bash"],
                "opencode" => &["read", "bash", "todowrite"],
                _ => &["bash", "edit"],
            };
            assert!(names.iter().all(|name| allowed.contains(name)));
            assert_eq!(parts.iter().filter(|part| part.kind == "prompt").count(), 0);
            for command in parts
                .iter()
                .filter_map(|part| part.state.as_ref())
                .filter_map(|state| state.input.as_ref())
                .filter_map(|input| input.get("command"))
                .filter_map(Value::as_str)
            {
                assert!(!command.contains("--slug"));
                assert!(!command.contains("--tail"));
                assert_ne!(command, "apply the reviewed portability and SFT safeguards");
                assert_ne!(command, "write the consolidated result artifact");
            }
            if harness == "claude-code" {
                for part in parts
                    .iter()
                    .filter(|part| matches!(part.tool.as_deref(), Some("Read") | Some("Edit")))
                {
                    assert!(part
                        .state
                        .as_ref()
                        .and_then(|state| state.input.as_ref())
                        .and_then(|input| input.get("filePath"))
                        .is_some());
                }
            }
        }
    }

    #[test]
    fn repository_and_snapshot_seed_are_idempotent() {
        let root = std::env::temp_dir().join(format!("orx-demo-test-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        let repo = root.join("cache/repos").join(OWNER).join(REPO);
        let store = Store::open_at(data.clone()).unwrap();
        let selection = DemoSelection {
            harness: "codex".into(),
            model: None,
            permission_mode: Some("auto".into()),
            reasoning_level: None,
        };
        let first = seed_at(&store, &data, &repo, selection.clone()).unwrap();
        let second = seed_at(
            &store,
            &data,
            &repo,
            DemoSelection {
                harness: "claude-code".into(),
                ..selection
            },
        )
        .unwrap();
        assert_eq!(first.project.id, second.project.id);
        assert_eq!(second.selection.harness, "codex");
        assert_eq!(store.list_local_projects().unwrap().len(), 1);
        assert_eq!(
            store.list_experiments_by_project(PROJECT_ID).unwrap().len(),
            1
        );
        assert_eq!(store.list_runs_by_project(PROJECT_ID).unwrap().len(), 1);
        assert_eq!(
            store
                .list_chat_sessions_by_project(PROJECT_ID)
                .unwrap()
                .len(),
            1
        );
        let run = store.get_run(RUN_ID).unwrap().unwrap();
        assert_eq!(run.status, "done");
        assert_eq!(run.exit_code, Some(0));
        assert_eq!(run.chat_session_id, None);
        assert_eq!(
            run.commit_sha.as_deref(),
            Some(git(&repo, &["rev-parse", BRANCH]).unwrap().as_str())
        );
        let messages = store.list_chat_messages(SESSION_ID).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[1].role, "assistant");
        let assistant: Vec<WirePart> = serde_json::from_str(&messages[1].parts_json).unwrap();
        assert!(!assistant.is_empty());
        assert!(!messages[1].parts_json.contains("/Users/"));
        assert!(repo.join(".git").is_dir());
        let bare = data.join("demo-repos/nanochat.git");
        assert!(bare.join("HEAD").is_file());
        assert_eq!(
            git(&bare, &["symbolic-ref", "HEAD"]).unwrap(),
            "refs/heads/main"
        );
        assert_eq!(
            git(&repo, &["remote", "get-url", "origin"]).unwrap(),
            bare.to_string_lossy()
        );
        let changed = git(&repo, &["diff", "--name-only", "main", BRANCH]).unwrap();
        assert_eq!(
            changed.lines().collect::<Vec<_>>(),
            [
                ".gitignore",
                "runs/runcpu.sh",
                "scripts/chat_cli.py",
                "scripts/chat_sft.py"
            ]
        );
        assert!(data
            .join("files/nanochat/cpu-apple-silicon-pipeline-results.md")
            .is_file());
        assert_eq!(
            std::fs::read_dir(data.join("files/nanochat"))
                .unwrap()
                .count(),
            1
        );
        assert!(data.join(format!("run-logs/{RUN_ID}.log")).is_file());
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repository_commit_ids_are_deterministic() {
        let root = std::env::temp_dir().join(format!("orx-demo-test-{}", uuid::Uuid::new_v4()));
        let first = root.join("first");
        let second = root.join("second");
        let first_sha = install_repository(&first, &root.join("first.git")).unwrap();
        let second_sha = install_repository(&second, &root.join("second.git")).unwrap();
        assert_eq!(first_sha, second_sha);
        assert_eq!(
            git(&first, &["rev-parse", "refs/heads/main"]).unwrap(),
            git(&second, &["rev-parse", "refs/heads/main"]).unwrap()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn moved_data_dir_repairs_the_local_origin() {
        let root = std::env::temp_dir().join(format!("orx-demo-test-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        let moved = root.join("moved-data");
        let repo = root.join("cache/repos").join(OWNER).join(REPO);
        let store = Store::open_at(data.clone()).unwrap();
        seed_at(
            &store,
            &data,
            &repo,
            DemoSelection {
                harness: "codex".into(),
                model: None,
                permission_mode: None,
                reasoning_level: None,
            },
        )
        .unwrap();
        drop(store);
        std::fs::rename(&data, &moved).unwrap();

        repair_installed_origin_at(&moved, &repo).unwrap();

        assert_eq!(
            git(&repo, &["remote", "get-url", "origin"]).unwrap(),
            moved.join("demo-repos/nanochat.git").to_string_lossy()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleared_cache_restores_from_local_origin_at_experiment_commit() {
        let root = std::env::temp_dir().join(format!("orx-demo-test-{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        let repo = root.join("cache/repos").join(OWNER).join(REPO);
        let worktree = root
            .join("cache/worktrees")
            .join(PROJECT_ID)
            .join(SESSION_ID);
        let store = Store::open_at(data.clone()).unwrap();
        seed_at(
            &store,
            &data,
            &repo,
            DemoSelection {
                harness: "codex".into(),
                model: None,
                permission_mode: None,
                reasoning_level: None,
            },
        )
        .unwrap();
        std::fs::remove_dir_all(&worktree).unwrap();
        std::fs::remove_dir_all(&repo).unwrap();

        crate::local::git::restore_local_clone(
            &repo,
            &data.join("demo-repos/nanochat.git"),
            "main",
        )
        .unwrap();
        crate::local::git::ensure_session_worktree_in(
            &repo, &worktree, OWNER, REPO, "main", SESSION_ID,
        )
        .unwrap();

        assert_eq!(
            git(&worktree, &["rev-parse", "HEAD"]).unwrap(),
            EXPERIMENT_SHA
        );
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_reserved_repository_is_not_overwritten() {
        let root = std::env::temp_dir().join(format!("orx-demo-test-{}", uuid::Uuid::new_v4()));
        let repo = root.join("nanochat");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join("keep-me"), "user data").unwrap();
        let error = install_repository(&repo, &root.join("origin.git")).unwrap_err();
        assert!(error
            .to_string()
            .contains("move it aside and retry onboarding"));
        assert_eq!(
            std::fs::read_to_string(repo.join("keep-me")).unwrap(),
            "user data"
        );
        assert!(!repo.join(".git").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
