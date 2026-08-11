//! `orx supervise <runId>` — the lens beside an external job.
//!
//! Spawned detached by `orx exp run --backend hf`; restart-idempotent (state
//! is the local store + the backend itself, and log dedup resumes from the
//! store's log file). Two concurrent halves: a tail task streams backend logs
//! into the run's log file, while the main loop polls job state, mirrors
//! transitions to the api (whose PATCH response carries cancel intent), and on
//! terminal status uploads the log via presigned PUT.
//!
//! API unreachability never kills supervision: the local store stays correct
//! and mirroring resumes on the next transition.
//!
//! Local-mode runs (`orx up`, experiment in `local_experiments`) skip the api
//! entirely: no credentials, no mirror, no upload — cancel intent comes from
//! the local run row's `cancel_requested` flag instead.

use std::io::{Seek as _, Write as _};
use std::time::Duration;

use serde_json::json;

use crate::client::{presign_external_run_log, update_external_run, upload_to_presigned};
use crate::config::Credentials;
use crate::error::{anyhow, require_credentials, Result};
use crate::jobs::huggingface as hf;
use crate::jobs::kubernetes as k8s;
use crate::jobs::localbox;
use crate::jobs::modal;
use crate::jobs::openresearch;
use crate::jobs::ray;
use crate::jobs::slurm;
use crate::jobs::ssh;
use crate::jobs::{is_terminal_stage, stage_to_run_status, BackendDescriptor};
use crate::store::{log_path, now_ms, Store};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// How long a silent log stream is held before re-checking job state.
const LOG_IDLE: Duration = Duration::from_secs(30);
const SSH_LOSS_DEADLINE: Duration = Duration::from_secs(2 * 60);
const SSH_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

fn open_supervisor_lock(path: &std::path::Path) -> Result<fd_lock::RwLock<std::fs::File>> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    Ok(fd_lock::RwLock::new(file))
}

pub async fn run(args: crate::SuperviseArgs) -> Result<()> {
    let run_id = args.run_id;

    let store = Store::open()?;
    let lock_path = log_path(&run_id).with_extension("supervisor.lock");
    let mut supervisor_lock = open_supervisor_lock(&lock_path)?;
    let _supervisor_guard = match supervisor_lock.try_write() {
        Ok(guard) => guard,
        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    let stored = match store.get_run(&run_id)? {
        Some(stored) => stored,
        None => {
            if let Some(cleanup) = store.sandbox_cleanup(&run_id)? {
                resume_sandbox_cleanup(&store, &cleanup, &run_id).await;
                return Ok(());
            }
            return Err(anyhow!("Run {} not found in the local store.", run_id));
        }
    };
    if crate::local::is_terminal(&stored.status) {
        if let Some(cleanup) = store.sandbox_cleanup(&run_id)? {
            resume_sandbox_cleanup(&store, &cleanup, &run_id).await;
        }
        return Ok(());
    }
    let descriptor = match BackendDescriptor::parse(&stored.backend_json) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            if let Some(cleanup) = store.sandbox_cleanup(&run_id)? {
                resume_sandbox_cleanup(&store, &cleanup, &run_id).await;
            }
            return Err(error);
        }
    };
    if descriptor.kind == "openresearch_job" {
        return run_openresearch(store, stored, descriptor, None, run_id).await;
    }
    // Local runs never touch client.rs; credentials load only on the server path.
    let local = store.get_local_experiment(&stored.experiment_id)?.is_some();
    let creds = if local {
        None
    } else {
        Some(require_credentials().await)
    };
    if descriptor.kind == "k8s_job" {
        return run_k8s(store, stored, descriptor, creds, run_id).await;
    }
    if descriptor.kind == "modal_job" {
        return run_modal(store, stored, descriptor, creds, run_id).await;
    }
    if descriptor.kind == "ssh_job" {
        return run_ssh(store, stored, descriptor, creds, run_id).await;
    }
    if descriptor.kind == "slurm_job" {
        return run_slurm(store, stored, descriptor, creds, run_id).await;
    }
    if descriptor.kind == "ray_job" {
        return run_ray(store, stored, descriptor, creds, run_id).await;
    }
    if descriptor.kind == "local_job" {
        return run_local(store, stored, descriptor, creds, run_id).await;
    }
    let (namespace, job_id) = descriptor.hf_ref()?;
    let namespace = namespace.to_string();
    let job_id = job_id.to_string();
    let token = hf::resolve_token()?;

    eprintln!("supervise {run_id}: watching hf job {namespace}/{job_id}");

    // Log tailing runs CONCURRENTLY with status polling — never in series.
    // `stream_logs` blocks for as long as the job keeps printing, so a
    // sequential loop would sit inside the stream until the job ended and only
    // then report `running`… as `done` (the UI would see no live run at all,
    // then the whole log at once). The tail task owns the log file; this loop
    // owns status, mirroring, and cancel intent.
    let path = log_path(&run_id);
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    let mut log_task = tokio::spawn(tail_logs(
        token.clone(),
        namespace.clone(),
        job_id.clone(),
        path.clone(),
        run_id.clone(),
        done_rx,
    ));

    let mut last_status = stored.status.clone();
    let mut cancel_sent = false;

    loop {
        // Where is the job now?
        let job = match hf::inspect_job(&token, &namespace, &job_id).await {
            Ok(j) => j,
            Err(err) => {
                eprintln!("supervise {run_id}: inspect failed (will retry): {err}");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        let stage = job.status.stage.as_str();
        let status = run_status_for_stage(&store, &run_id, creds.is_none(), cancel_sent, stage);

        // Terminal: let the tail drain the stream's remainder, then persist
        // everything BEFORE reporting the final status, so the moment the UI
        // sees done/failed the R2 log already exists (the run page switches
        // from live tail to the persisted log on that flip).
        if is_terminal_stage(stage) {
            store.update_status(&run_id, &status, Some(now_ms()), None)?;
            // Local runs record the failure reason on the row itself — that's
            // what `orx logs`-adjacent surfaces (exp status, runs) read.
            if creds.is_none() && status == "failed" {
                if let Some(msg) = &job.status.message {
                    if let Err(err) =
                        store.set_result_markdown(&run_id, &format!("Job failed: {msg}"))
                    {
                        eprintln!("supervise {run_id}: could not record failure reason: {err}");
                    }
                }
            }
            let _ = done_tx.send(true);
            if tokio::time::timeout(Duration::from_secs(20), &mut log_task)
                .await
                .is_err()
            {
                log_task.abort();
            }
            if let Some(creds) = &creds {
                if let Ok(bytes) = std::fs::read(&path) {
                    if !bytes.is_empty() {
                        match presign_external_run_log(creds, &run_id).await {
                            Ok(presigned) => {
                                if let Err(err) = upload_to_presigned(
                                    &presigned.url,
                                    "application/octet-stream",
                                    bytes,
                                )
                                .await
                                {
                                    eprintln!("supervise {run_id}: log upload failed: {err}");
                                }
                            }
                            Err(err) => eprintln!("supervise {run_id}: log presign failed: {err}"),
                        }
                    }
                }
                if let Err(err) = mirror_status(creds, &run_id, &status, &job.status.message).await
                {
                    eprintln!("supervise {run_id}: final status mirror failed: {err}");
                }
            }
            eprintln!("supervise {run_id}: finished ({status})");
            return Ok(());
        }

        // Mirror a live transition (local store first — it's the truth).
        if status != last_status {
            store.update_status(&run_id, &status, None, None)?;
            let cancel_requested = match &creds {
                Some(creds) => mirror_status(creds, &run_id, &status, &job.status.message)
                    .await
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            eprintln!("supervise {run_id}: {last_status} -> {status} (stage {stage})");
            last_status = status.clone();
            if cancel_requested && !cancel_sent {
                request_backend_cancel(&token, &namespace, &job_id, &run_id, &mut cancel_sent)
                    .await;
            }
        } else if !cancel_sent {
            // No transition to report — poll cancel intent cheaply instead.
            let cancel_requested = match &creds {
                Some(creds) => crate::client::get_external_run_state(creds, &run_id)
                    .await
                    .map(|s| s.cancel_requested)
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            if cancel_requested {
                request_backend_cancel(&token, &namespace, &job_id, &run_id, &mut cancel_sent)
                    .await;
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Local cancel intent from the run row itself. Best-effort — a transient
/// db error must not kill supervision.
fn local_cancel_requested(store: &Store, run_id: &str) -> bool {
    store
        .get_run(run_id)
        .ok()
        .flatten()
        .map(|r| r.cancel_requested)
        .unwrap_or(false)
}

fn should_report_cancelled(
    store: &Store,
    run_id: &str,
    local_mode: bool,
    cancel_sent: bool,
) -> bool {
    cancel_sent || (local_mode && local_cancel_requested(store, run_id))
}

fn run_status_for_stage(
    store: &Store,
    run_id: &str,
    local_mode: bool,
    cancel_sent: bool,
    stage: &str,
) -> String {
    let status = stage_to_run_status(stage);
    if status != "done"
        && is_terminal_stage(stage)
        && should_report_cancelled(store, run_id, local_mode, cancel_sent)
    {
        "cancelled".to_string()
    } else {
        status.to_string()
    }
}

/// PATCH the mirror; returns the server's cancel intent. Best-effort.
async fn mirror_status(
    creds: &Credentials,
    run_id: &str,
    status: &str,
    message: &Option<String>,
) -> Result<bool> {
    // The mirror never accepts "starting" (that's the registration state).
    if status == "starting" {
        return Ok(false);
    }
    let mut body = json!({ "status": status });
    if status == "failed" {
        if let Some(msg) = message {
            body["resultMarkdown"] = json!(format!("Job failed: {msg}"));
        }
    }
    let patched = update_external_run(creds, run_id, body).await?;
    Ok(patched.cancel_requested)
}

/// Tail the job's log stream into the run's log file until told we're done.
/// Reconnects forever (HF replays from the start; `seen` dedups), so a network
/// blip or the stream's own idle-close never loses the tail. Truncates on
/// open: a restarted supervisor rewrites the file from event zero rather than
/// appending a duplicate history.
async fn tail_logs(
    token: String,
    namespace: String,
    job_id: String,
    path: std::path::PathBuf,
    run_id: String,
    done: tokio::sync::watch::Receiver<bool>,
) {
    let mut log_file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(err) => {
            eprintln!(
                "supervise {run_id}: could not open {}: {err}",
                path.display()
            );
            return;
        }
    };
    let mut seen = 0u64;
    loop {
        let mut sink = |line: &str| {
            let _ = writeln!(log_file, "{line}");
        };
        match hf::stream_logs(&token, &namespace, &job_id, seen, LOG_IDLE, &mut sink).await {
            Ok(s) => seen = s,
            Err(err) => eprintln!("supervise {run_id}: log stream error (will retry): {err}"),
        }
        let _ = log_file.flush();
        // Between passes: exit once the job is terminal (the closed stream has
        // been fully drained by the pass above); otherwise breathe and retry.
        if *done.borrow() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn request_backend_cancel(
    token: &str,
    namespace: &str,
    job_id: &str,
    run_id: &str,
    cancel_sent: &mut bool,
) {
    eprintln!("supervise {run_id}: cancel requested — cancelling hf job");
    match hf::cancel_job(token, namespace, job_id).await {
        Ok(()) => *cancel_sent = true,
        Err(err) => eprintln!("supervise {run_id}: hf cancel failed (will retry): {err}"),
    }
}

// --- kubernetes ---------------------------------------------------------------
//
// Same two-half shape as the HF path (concurrent log tail + status poll), with
// kubectl as the transport. Cancel = delete the Job; the next inspect sees
// NotFound (stage DELETED) and the run lands on "cancelled".

async fn run_k8s(
    store: Store,
    stored: crate::store::StoredRun,
    descriptor: BackendDescriptor,
    creds: Option<Credentials>,
    run_id: String,
) -> Result<()> {
    let (namespace, job_name) = descriptor.k8s_ref()?;
    let namespace = namespace.to_string();
    let job_name = job_name.to_string();
    let context = descriptor.context.clone();
    // What cancel deletes: the manifest's recorded resources, or just the Job
    // for runs from before resource recording existed.
    let resources = descriptor
        .resources
        .clone()
        .unwrap_or_else(|| vec![format!("job/{job_name}")]);

    eprintln!("supervise {run_id}: watching k8s job {namespace}/{job_name}");

    let path = log_path(&run_id);
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    let mut log_task = tokio::spawn(tail_logs_k8s(
        context.clone(),
        namespace.clone(),
        job_name.clone(),
        path.clone(),
        run_id.clone(),
        done_rx,
    ));

    let mut last_status = stored.status.clone();
    let mut cancel_sent = false;

    loop {
        let job = match k8s::inspect_job(context.as_deref(), &namespace, &job_name).await {
            Ok(j) => j,
            Err(err) => {
                eprintln!("supervise {run_id}: inspect failed (will retry): {err}");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        let stage = job.stage.as_str();
        let status = run_status_for_stage(&store, &run_id, creds.is_none(), cancel_sent, stage);

        if is_terminal_stage(stage) {
            store.update_status(&run_id, &status, Some(now_ms()), None)?;
            if creds.is_none() && status == "failed" {
                if let Some(msg) = &job.message {
                    if let Err(err) =
                        store.set_result_markdown(&run_id, &format!("Job failed: {msg}"))
                    {
                        eprintln!("supervise {run_id}: could not record failure reason: {err}");
                    }
                }
            }
            let _ = done_tx.send(true);
            if tokio::time::timeout(Duration::from_secs(20), &mut log_task)
                .await
                .is_err()
            {
                log_task.abort();
            }
            if let Some(creds) = &creds {
                if let Ok(bytes) = std::fs::read(&path) {
                    if !bytes.is_empty() {
                        match presign_external_run_log(creds, &run_id).await {
                            Ok(presigned) => {
                                if let Err(err) = upload_to_presigned(
                                    &presigned.url,
                                    "application/octet-stream",
                                    bytes,
                                )
                                .await
                                {
                                    eprintln!("supervise {run_id}: log upload failed: {err}");
                                }
                            }
                            Err(err) => eprintln!("supervise {run_id}: log presign failed: {err}"),
                        }
                    }
                }
                if let Err(err) = mirror_status(creds, &run_id, &status, &job.message).await {
                    eprintln!("supervise {run_id}: final status mirror failed: {err}");
                }
            }
            eprintln!("supervise {run_id}: finished ({status})");
            return Ok(());
        }

        if status != last_status {
            store.update_status(&run_id, &status, None, None)?;
            let cancel_requested = match &creds {
                Some(creds) => mirror_status(creds, &run_id, &status, &job.message)
                    .await
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            eprintln!("supervise {run_id}: {last_status} -> {status} (stage {stage})");
            last_status = status.clone();
            if cancel_requested && !cancel_sent {
                cancel_k8s(
                    context.as_deref(),
                    &namespace,
                    &resources,
                    &run_id,
                    &mut cancel_sent,
                )
                .await;
            }
        } else if !cancel_sent {
            let cancel_requested = match &creds {
                Some(creds) => crate::client::get_external_run_state(creds, &run_id)
                    .await
                    .map(|s| s.cancel_requested)
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            if cancel_requested {
                cancel_k8s(
                    context.as_deref(),
                    &namespace,
                    &resources,
                    &run_id,
                    &mut cancel_sent,
                )
                .await;
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// k8s twin of `tail_logs` — `kubectl logs -f` replays from the pod's start on
/// each reconnect, so the same truncate-and-dedup contract applies. Tails the
/// primary Job's leader pod (index 0 for Indexed jobs).
async fn tail_logs_k8s(
    context: Option<String>,
    namespace: String,
    job_name: String,
    path: std::path::PathBuf,
    run_id: String,
    done: tokio::sync::watch::Receiver<bool>,
) {
    let mut log_file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(err) => {
            eprintln!(
                "supervise {run_id}: could not open {}: {err}",
                path.display()
            );
            return;
        }
    };
    let mut seen = 0u64;
    loop {
        let mut sink = |line: &str| {
            let _ = writeln!(log_file, "{line}");
        };
        match k8s::stream_logs(
            context.as_deref(),
            &namespace,
            &job_name,
            seen,
            LOG_IDLE,
            &mut sink,
        )
        .await
        {
            Ok(s) => seen = s,
            Err(err) => eprintln!("supervise {run_id}: log stream error (will retry): {err}"),
        }
        let _ = log_file.flush();
        if *done.borrow() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn cancel_k8s(
    context: Option<&str>,
    namespace: &str,
    resources: &[String],
    run_id: &str,
    cancel_sent: &mut bool,
) {
    eprintln!("supervise {run_id}: cancel requested — deleting the run's k8s resources");
    match k8s::delete_resources(context, namespace, resources).await {
        Ok(()) => *cancel_sent = true,
        Err(err) => eprintln!("supervise {run_id}: k8s cancel failed (will retry): {err}"),
    }
}

// --- modal --------------------------------------------------------------------
//
// Same two-half shape as the HF/k8s paths (concurrent log tail + status poll),
// with the Modal Python launcher as the transport. Cancel = terminate the
// sandbox; a terminated sandbox polls as a non-zero exit (ERROR), so once a
// cancel has been sent we report the terminal state as `cancelled` rather than
// `failed`.

async fn run_modal(
    store: Store,
    stored: crate::store::StoredRun,
    descriptor: BackendDescriptor,
    creds: Option<Credentials>,
    run_id: String,
) -> Result<()> {
    let sandbox_id = descriptor.modal_ref()?.to_string();

    eprintln!("supervise {run_id}: watching modal sandbox {sandbox_id}");

    let path = log_path(&run_id);
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    let mut log_task = tokio::spawn(tail_logs_modal(
        sandbox_id.clone(),
        path.clone(),
        run_id.clone(),
        done_rx,
    ));

    let mut last_status = stored.status.clone();
    let mut cancel_sent = false;

    loop {
        let job = match modal::inspect_job(&sandbox_id).await {
            Ok(j) => j,
            Err(err) => {
                eprintln!("supervise {run_id}: inspect failed (will retry): {err}");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        let stage = job.stage.as_str();
        // A terminated sandbox reports a non-zero exit; if we asked for the
        // cancel, that terminal state is a cancellation, not a failure.
        let status = run_status_for_stage(&store, &run_id, creds.is_none(), cancel_sent, stage);

        if is_terminal_stage(stage) {
            store.update_status(&run_id, &status, Some(now_ms()), None)?;
            if creds.is_none() && status == "failed" {
                if let Some(msg) = &job.message {
                    if let Err(err) =
                        store.set_result_markdown(&run_id, &format!("Job failed: {msg}"))
                    {
                        eprintln!("supervise {run_id}: could not record failure reason: {err}");
                    }
                }
            }
            let _ = done_tx.send(true);
            if tokio::time::timeout(Duration::from_secs(20), &mut log_task)
                .await
                .is_err()
            {
                log_task.abort();
            }
            if let Some(creds) = &creds {
                if let Ok(bytes) = std::fs::read(&path) {
                    if !bytes.is_empty() {
                        match presign_external_run_log(creds, &run_id).await {
                            Ok(presigned) => {
                                if let Err(err) = upload_to_presigned(
                                    &presigned.url,
                                    "application/octet-stream",
                                    bytes,
                                )
                                .await
                                {
                                    eprintln!("supervise {run_id}: log upload failed: {err}");
                                }
                            }
                            Err(err) => eprintln!("supervise {run_id}: log presign failed: {err}"),
                        }
                    }
                }
                if let Err(err) = mirror_status(creds, &run_id, &status, &job.message).await {
                    eprintln!("supervise {run_id}: final status mirror failed: {err}");
                }
            }
            eprintln!("supervise {run_id}: finished ({status})");
            return Ok(());
        }

        if status != last_status {
            store.update_status(&run_id, &status, None, None)?;
            let cancel_requested = match &creds {
                Some(creds) => mirror_status(creds, &run_id, &status, &job.message)
                    .await
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            eprintln!("supervise {run_id}: {last_status} -> {status} (stage {stage})");
            last_status = status.clone();
            if cancel_requested && !cancel_sent {
                cancel_modal(&sandbox_id, &run_id, &mut cancel_sent).await;
            }
        } else if !cancel_sent {
            let cancel_requested = match &creds {
                Some(creds) => crate::client::get_external_run_state(creds, &run_id)
                    .await
                    .map(|s| s.cancel_requested)
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            if cancel_requested {
                cancel_modal(&sandbox_id, &run_id, &mut cancel_sent).await;
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Modal twin of `tail_logs` — the launcher replays the sandbox's stdout from
/// the start on each connect, so the same truncate-and-dedup contract applies.
async fn tail_logs_modal(
    sandbox_id: String,
    path: std::path::PathBuf,
    run_id: String,
    done: tokio::sync::watch::Receiver<bool>,
) {
    let mut log_file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(err) => {
            eprintln!(
                "supervise {run_id}: could not open {}: {err}",
                path.display()
            );
            return;
        }
    };
    let mut seen = 0u64;
    loop {
        let mut sink = |line: &str| {
            let _ = writeln!(log_file, "{line}");
        };
        match modal::stream_logs(&sandbox_id, seen, LOG_IDLE, &mut sink).await {
            Ok(s) => seen = s,
            Err(err) => eprintln!("supervise {run_id}: log stream error (will retry): {err}"),
        }
        let _ = log_file.flush();
        if *done.borrow() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn cancel_modal(sandbox_id: &str, run_id: &str, cancel_sent: &mut bool) {
    eprintln!("supervise {run_id}: cancel requested — terminating modal sandbox");
    match modal::cancel_job(sandbox_id).await {
        Ok(()) => *cancel_sent = true,
        Err(err) => eprintln!("supervise {run_id}: modal cancel failed (will retry): {err}"),
    }
}

// --- ssh ----------------------------------------------------------------------
//
// Same two-half shape as the other backends, with `ssh` as the transport. The
// remote process has no scheduler; cancel TERMs its process group, which leaves
// it dead without an exit_code (ERROR) — so once cancel is sent we report the
// terminal state as `cancelled`.

async fn run_ssh(
    store: Store,
    stored: crate::store::StoredRun,
    descriptor: BackendDescriptor,
    creds: Option<Credentials>,
    run_id: String,
) -> Result<()> {
    let (host, dir) = descriptor.ssh_ref()?;
    eprintln!("supervise {run_id}: watching ssh job {host}:{dir}");
    let target = ssh::SshTarget::alias(host);
    let dir = dir.to_string();
    watch_ssh_job(
        &store,
        &stored.status,
        target,
        dir,
        &creds,
        &run_id,
        SshWatchOptions {
            loss_deadline: None,
        },
    )
    .await?;
    Ok(())
}

/// The ssh two-half loop, shared by every backend whose job is a run dir on a
/// box we ssh into (ssh itself, openresearch). Runs until the job is terminal;
/// returns the final run status after logs are drained and mirrored.
struct SshWatchOptions {
    loss_deadline: Option<Duration>,
}

async fn watch_ssh_job(
    store: &Store,
    initial_status: &str,
    target: ssh::SshTarget,
    dir: String,
    creds: &Option<Credentials>,
    run_id: &str,
    options: SshWatchOptions,
) -> Result<String> {
    let path = log_path(run_id);
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    let mut initial_log = std::fs::File::create(&path)?;
    for message in store.transport_events(run_id)? {
        writeln!(initial_log, "{message}")?;
    }
    initial_log.flush()?;
    drop(initial_log);
    let mut log_task = tokio::spawn(tail_logs_ssh(
        target.clone(),
        dir.clone(),
        path.clone(),
        run_id.to_string(),
        done_rx,
    ));

    let mut last_status = initial_status.to_string();
    let mut cancel_sent = false;

    loop {
        let probe_started_at = now_ms();
        let probe = if options.loss_deadline.is_some() && local_cancel_requested(store, run_id) {
            Ok(ssh::JobState {
                stage: "ERROR".to_string(),
                message: Some("cancelled while supervising the provider sandbox".to_string()),
            })
        } else if let Some(deadline) = options.loss_deadline {
            let budget = match store.transport_outage(run_id)? {
                Some(outage) => deadline.saturating_sub(elapsed_since(outage.lost_at, now_ms())),
                None => SSH_PROBE_TIMEOUT,
            }
            .min(SSH_PROBE_TIMEOUT);
            if budget.is_zero() {
                Err(anyhow!("persisted SSH outage reached its deadline"))
            } else {
                ssh::inspect_job_bounded(&target, &dir, budget).await
            }
        } else {
            ssh::inspect_job(&target, &dir).await
        };
        let job = match probe {
            Ok(j) => {
                if let Some(deadline) = options.loss_deadline {
                    if let Some(outage) = store.transport_outage(run_id)? {
                        let unavailable_for = elapsed_since(outage.lost_at, now_ms());
                        if unavailable_for >= deadline {
                            let message = format!(
                                "SSH transport to {} was unavailable for {}s before recovering.",
                                target.dest,
                                unavailable_for.as_secs()
                            );
                            let transition = format!("orx: {message}");
                            store.record_transport_event(run_id, &transition)?;
                            append_transport_log_line(run_id, &transition)?;
                            ssh::JobState {
                                stage: "ERROR".to_string(),
                                message: Some(message),
                            }
                        } else {
                            let message = format!(
                                "orx: SSH connection recovered after {}s.",
                                unavailable_for.as_secs()
                            );
                            store.recover_transport_outage(run_id, &message)?;
                            append_transport_log_line(run_id, &message)?;
                            eprintln!("supervise {run_id}: {message}");
                            j
                        }
                    } else {
                        j
                    }
                } else {
                    j
                }
            }
            Err(err) => {
                let Some(deadline) = options.loss_deadline else {
                    eprintln!("supervise {run_id}: inspect failed (will retry): {err}");
                    tokio::time::sleep(POLL_INTERVAL).await;
                    continue;
                };
                let observed_at = now_ms();
                let detail = ssh_failure_detail(&err.to_string());
                let lost_message = format!(
                    "orx: SSH connection lost; retrying for up to {}s: {detail}",
                    deadline.as_secs()
                );
                let (outage, started) = store.record_transport_failure(
                    run_id,
                    &detail,
                    probe_started_at,
                    &lost_message,
                )?;
                if started {
                    append_transport_log_line(run_id, &lost_message)?;
                    eprintln!("supervise {run_id}: {lost_message}");
                }
                let unavailable_for = elapsed_since(outage.lost_at, observed_at);
                if !ssh_outage_timed_out(outage.lost_at, observed_at, deadline) {
                    tokio::time::sleep(POLL_INTERVAL.min(deadline - unavailable_for)).await;
                    continue;
                }
                let message = format!(
                    "SSH transport to {} remained unavailable for {}s: {detail}",
                    target.dest,
                    unavailable_for.as_secs()
                );
                let transition = format!("orx: {message}");
                store.record_transport_event(run_id, &transition)?;
                append_transport_log_line(run_id, &transition)?;
                ssh::JobState {
                    stage: "ERROR".to_string(),
                    message: Some(message),
                }
            }
        };
        let stage = job.stage.as_str();
        let status = run_status_for_stage(store, run_id, creds.is_none(), cancel_sent, stage);

        if is_terminal_stage(stage) {
            store.update_status(run_id, &status, Some(now_ms()), None)?;
            if creds.is_none() && status == "failed" {
                if let Some(msg) = &job.message {
                    if let Err(err) =
                        store.set_result_markdown(run_id, &format!("Job failed: {msg}"))
                    {
                        eprintln!("supervise {run_id}: could not record failure reason: {err}");
                    }
                }
            }
            let _ = done_tx.send(true);
            if tokio::time::timeout(Duration::from_secs(20), &mut log_task)
                .await
                .is_err()
            {
                log_task.abort();
            }
            if let Some(creds) = creds {
                if let Ok(bytes) = std::fs::read(&path) {
                    if !bytes.is_empty() {
                        match presign_external_run_log(creds, run_id).await {
                            Ok(presigned) => {
                                if let Err(err) = upload_to_presigned(
                                    &presigned.url,
                                    "application/octet-stream",
                                    bytes,
                                )
                                .await
                                {
                                    eprintln!("supervise {run_id}: log upload failed: {err}");
                                }
                            }
                            Err(err) => eprintln!("supervise {run_id}: log presign failed: {err}"),
                        }
                    }
                }
                if let Err(err) = mirror_status(creds, run_id, &status, &job.message).await {
                    eprintln!("supervise {run_id}: final status mirror failed: {err}");
                }
            }
            if options.loss_deadline.is_none() {
                store.clear_transport_history(run_id)?;
            }
            eprintln!("supervise {run_id}: finished ({status})");
            return Ok(status);
        }

        if status != last_status {
            store.update_status(run_id, &status, None, None)?;
            let cancel_requested = match creds {
                Some(creds) => mirror_status(creds, run_id, &status, &job.message)
                    .await
                    .unwrap_or(false),
                None => local_cancel_requested(store, run_id),
            };
            eprintln!("supervise {run_id}: {last_status} -> {status} (stage {stage})");
            last_status = status.clone();
            if cancel_requested && !cancel_sent {
                cancel_ssh_for_watch(
                    &target,
                    &dir,
                    run_id,
                    &mut cancel_sent,
                    options.loss_deadline.is_some(),
                )
                .await;
            }
        } else if !cancel_sent {
            let cancel_requested = match creds {
                Some(creds) => crate::client::get_external_run_state(creds, run_id)
                    .await
                    .map(|s| s.cancel_requested)
                    .unwrap_or(false),
                None => local_cancel_requested(store, run_id),
            };
            if cancel_requested {
                cancel_ssh_for_watch(
                    &target,
                    &dir,
                    run_id,
                    &mut cancel_sent,
                    options.loss_deadline.is_some(),
                )
                .await;
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// SSH twin of `tail_logs` — each pass reads the remote log past the lines
/// already consumed, so the same truncate-and-dedup contract applies.
async fn tail_logs_ssh(
    target: ssh::SshTarget,
    dir: String,
    path: std::path::PathBuf,
    run_id: String,
    done: tokio::sync::watch::Receiver<bool>,
) {
    let mut log_file = match std::fs::OpenOptions::new().append(true).open(&path) {
        Ok(f) => f,
        Err(err) => {
            eprintln!(
                "supervise {run_id}: could not open {}: {err}",
                path.display()
            );
            return;
        }
    };
    let mut seen = 0u64;
    loop {
        let mut sink = |line: &str| {
            let _ = writeln!(log_file, "{line}");
        };
        match ssh::stream_logs(&target, &dir, seen, LOG_IDLE, &mut sink).await {
            Ok(s) => seen = s,
            Err(err) => eprintln!("supervise {run_id}: log stream error (will retry): {err}"),
        }
        let _ = log_file.flush();
        if *done.borrow() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn append_transport_log_line(run_id: &str, message: &str) -> Result<()> {
    let path = log_path(run_id);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(file, "{message}")?;
    file.flush()?;
    Ok(())
}

fn elapsed_since(started_at: i64, observed_at: i64) -> Duration {
    Duration::from_millis(observed_at.saturating_sub(started_at).max(0) as u64)
}

fn ssh_outage_timed_out(started_at: i64, observed_at: i64, deadline: Duration) -> bool {
    elapsed_since(started_at, observed_at) >= deadline
}

fn ssh_failure_detail(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    let kind = if lower.contains("permission denied")
        || lower.contains("authentication")
        || lower.contains("publickey")
    {
        "ssh_auth"
    } else if lower.contains("could not resolve hostname")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
    {
        "endpoint"
    } else if lower.contains("connection refused")
        || lower.contains("connection timed out")
        || lower.contains("operation timed out")
        || lower.contains("no route to host")
        || lower.contains("connection reset")
    {
        "tcp"
    } else {
        "ssh"
    };
    format!("{kind}: {message}")
}

#[derive(Debug, PartialEq, Eq)]
enum LaunchState {
    AlreadyLaunched,
    Fresh,
    Cancelled,
    LaunchClaimTimedOut(String),
    TransportTimedOut(String),
}

fn evaluate_launch_probe(
    store: &Store,
    target: &ssh::SshTarget,
    run_id: &str,
    deadline: Duration,
    probe_started_at: i64,
    observed_at: i64,
    probe: Result<openresearch::LaunchProbe>,
) -> Result<Option<LaunchState>> {
    match probe {
        Ok(state) => {
            if let Some(outage) = store.transport_outage(run_id)? {
                let unavailable_for = elapsed_since(outage.lost_at, observed_at);
                if unavailable_for >= deadline {
                    let message = format!(
                        "SSH transport to {} was unavailable for {}s before recovering.",
                        target.dest,
                        unavailable_for.as_secs()
                    );
                    store.record_transport_event(run_id, &format!("orx: {message}"))?;
                    return Ok(Some(LaunchState::TransportTimedOut(message)));
                }
                let message = format!(
                    "orx: SSH connection recovered after {}s.",
                    unavailable_for.as_secs()
                );
                store.recover_transport_outage(run_id, &message)?;
                eprintln!("supervise {run_id}: {message}");
            }

            if state == openresearch::LaunchProbe::Claimed {
                let existing = store.launch_claim_at(run_id)?;
                let claimed_at = store.record_launch_claim(run_id, observed_at)?;
                if existing.is_none() {
                    eprintln!(
                        "supervise {run_id}: remote launch is claimed; waiting up to {}s for pid",
                        deadline.as_secs()
                    );
                }
                if ssh_outage_timed_out(claimed_at, observed_at, deadline) {
                    let message = format!(
                        "Remote launch claim did not publish a pid within {}s.",
                        deadline.as_secs()
                    );
                    store.record_transport_event(run_id, &format!("orx: {message}"))?;
                    return Ok(Some(LaunchState::LaunchClaimTimedOut(message)));
                }
                return Ok(None);
            }

            if state == openresearch::LaunchProbe::Started {
                if let Some(claimed_at) = store.launch_claim_at(run_id)? {
                    store.clear_launch_claim(run_id)?;
                    if ssh_outage_timed_out(claimed_at, observed_at, deadline) {
                        let message = format!(
                            "Remote launch claim exceeded {}s before publishing a pid.",
                            deadline.as_secs()
                        );
                        store.record_transport_event(run_id, &format!("orx: {message}"))?;
                        return Ok(Some(LaunchState::LaunchClaimTimedOut(message)));
                    }
                }
            } else if let Some(claimed_at) = store.launch_claim_at(run_id)? {
                if ssh_outage_timed_out(claimed_at, observed_at, deadline) {
                    let message = format!(
                        "Remote launch intent did not create a job within {}s.",
                        deadline.as_secs()
                    );
                    store.record_transport_event(run_id, &format!("orx: {message}"))?;
                    return Ok(Some(LaunchState::LaunchClaimTimedOut(message)));
                }
            }
            Ok(Some(if state == openresearch::LaunchProbe::Started {
                LaunchState::AlreadyLaunched
            } else {
                LaunchState::Fresh
            }))
        }
        Err(err) => {
            let detail = ssh_failure_detail(&err.to_string());
            let lost_message = format!(
                "orx: SSH connection lost before launch; retrying for up to {}s: {detail}",
                deadline.as_secs()
            );
            let (outage, started) =
                store.record_transport_failure(run_id, &detail, probe_started_at, &lost_message)?;
            if started {
                eprintln!("supervise {run_id}: {lost_message}");
            }
            if let Some(claimed_at) = store.launch_claim_at(run_id)? {
                if ssh_outage_timed_out(claimed_at, observed_at, deadline) {
                    let message = format!(
                        "Remote launch did not complete within {}s.",
                        deadline.as_secs()
                    );
                    store.record_transport_event(run_id, &format!("orx: {message}"))?;
                    return Ok(Some(LaunchState::LaunchClaimTimedOut(message)));
                }
            }
            if ssh_outage_timed_out(outage.lost_at, observed_at, deadline) {
                let message = format!(
                    "SSH transport to {} remained unavailable for {}s before launch: {detail}",
                    target.dest,
                    elapsed_since(outage.lost_at, observed_at).as_secs()
                );
                store.record_transport_event(run_id, &format!("orx: {message}"))?;
                return Ok(Some(LaunchState::TransportTimedOut(message)));
            }
            Ok(None)
        }
    }
}

async fn await_launch_state(
    store: &Store,
    target: &ssh::SshTarget,
    run_id: &str,
    deadline: Duration,
    mut cancel_check: impl FnMut() -> bool,
) -> Result<LaunchState> {
    loop {
        if cancel_check() {
            return Ok(LaunchState::Cancelled);
        }
        let probe_started_at = now_ms();
        let budget = match store.transport_outage(run_id)? {
            Some(outage) => deadline.saturating_sub(elapsed_since(outage.lost_at, now_ms())),
            None => SSH_PROBE_TIMEOUT,
        }
        .min(
            store
                .launch_claim_at(run_id)?
                .map(|claimed_at| deadline.saturating_sub(elapsed_since(claimed_at, now_ms())))
                .unwrap_or(SSH_PROBE_TIMEOUT),
        )
        .min(SSH_PROBE_TIMEOUT);
        let probe = if budget.is_zero() {
            Err(anyhow!("persisted SSH outage reached its deadline"))
        } else {
            openresearch::launched(target, run_id, budget).await
        };
        if let Some(state) = evaluate_launch_probe(
            store,
            target,
            run_id,
            deadline,
            probe_started_at,
            now_ms(),
            probe,
        )? {
            return Ok(state);
        }
        if cancel_check() {
            return Ok(LaunchState::Cancelled);
        }
        let observed_at = now_ms();
        let outage_delay = store
            .transport_outage(run_id)?
            .map(|outage| deadline.saturating_sub(elapsed_since(outage.lost_at, observed_at)))
            .unwrap_or(POLL_INTERVAL);
        let claim_delay = store
            .launch_claim_at(run_id)?
            .map(|claimed_at| deadline.saturating_sub(elapsed_since(claimed_at, observed_at)))
            .unwrap_or(POLL_INTERVAL);
        tokio::time::sleep(POLL_INTERVAL.min(outage_delay).min(claim_delay)).await;
    }
}

fn materialize_transport_log(store: &Store, run_id: &str) -> Result<()> {
    let path = log_path(run_id);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)?;
    for message in store.transport_events(run_id)? {
        writeln!(file, "{message}")?;
    }
    file.flush()?;
    Ok(())
}

async fn cancel_ssh(target: &ssh::SshTarget, dir: &str, run_id: &str, cancel_sent: &mut bool) {
    eprintln!("supervise {run_id}: cancel requested — killing remote process group");
    match ssh::cancel_job(target, dir).await {
        Ok(()) => *cancel_sent = true,
        Err(err) => eprintln!("supervise {run_id}: ssh cancel failed (will retry): {err}"),
    }
}

async fn cancel_ssh_for_watch(
    target: &ssh::SshTarget,
    dir: &str,
    run_id: &str,
    cancel_sent: &mut bool,
    bounded: bool,
) {
    if bounded
        && tokio::time::timeout(
            SSH_PROBE_TIMEOUT,
            cancel_ssh(target, dir, run_id, cancel_sent),
        )
        .await
        .is_err()
    {
        eprintln!(
            "supervise {run_id}: remote cancellation timed out after {}s",
            SSH_PROBE_TIMEOUT.as_secs()
        );
        return;
    }
    if !bounded {
        cancel_ssh(target, dir, run_id, cancel_sent).await;
    }
}

// --- openresearch ---------------------------------------------------------------
//
// The ssh loop with a provisioning prologue and a billing epilogue: the box
// comes from the platform, so the supervisor first waits for it to come online
// (recording the SSH endpoint on the descriptor for restarts), launches the
// payload over ssh, runs the shared watch loop, and deletes the box at the
// end. EVERY exit path tears the box down — a leaked box bills the org.

async fn run_openresearch(
    store: Store,
    stored: crate::store::StoredRun,
    mut descriptor: BackendDescriptor,
    creds: Option<Credentials>,
    run_id: String,
) -> Result<()> {
    let sandbox_id = match descriptor.openresearch_ref() {
        Ok((_organization_id, sandbox_id)) => sandbox_id.to_string(),
        Err(error) => {
            if let Some(cleanup) = store.sandbox_cleanup(&run_id)? {
                resume_sandbox_cleanup(&store, &cleanup, &run_id).await;
            }
            return Err(error);
        }
    };
    if let Err(error) = store.mark_sandbox_cleanup_pending(&run_id, &sandbox_id, true) {
        let cleanup = crate::store::SandboxCleanup {
            sandbox_id: sandbox_id.clone(),
            last_error: Some(error.to_string()),
            retain_failed: true,
        };
        resume_sandbox_cleanup(&store, &cleanup, &run_id).await;
        return Err(error);
    }

    // Lifecycle credentials (poll/teardown) are the user's `orx login` token —
    // needed even though local runs skip the mirror (`creds`). Never
    // `require_credentials()` here: it exit(1)s, and dying silently in a
    // detached process would strand the run as "starting" and leak the box.
    let lifecycle = match crate::config::load_credentials().await {
        Ok(Some(c)) => c,
        _ => {
            let record_result = store
                .update_status(&run_id, "failed", Some(now_ms()), None)
                .and_then(|()| {
                    store.set_result_markdown(
                        &run_id,
                        &format!(
                            "The supervisor found no OpenResearch credentials (`orx login`), so \
                             cleanup for box {sandbox_id} is waiting for refreshed credentials."
                        ),
                    )
                });
            let cleanup = crate::store::SandboxCleanup {
                sandbox_id: sandbox_id.clone(),
                last_error: None,
                retain_failed: true,
            };
            resume_sandbox_cleanup(&store, &cleanup, &run_id).await;
            record_result?;
            return Err(anyhow!("no credentials for the openresearch backend"));
        }
    };

    let dir = openresearch::run_dir(&run_id);

    // Provisioning: wait for the box unless a restarted supervisor already
    // recorded its endpoint.
    let target = match descriptor.openresearch_ssh_target() {
        Some(target) => target,
        None => {
            eprintln!("supervise {run_id}: waiting for box {sandbox_id} to come online");
            let outcome = openresearch::wait_online(
                &lifecycle,
                &sandbox_id,
                openresearch::PROVISION_DEADLINE,
                || local_cancel_requested(&store, &run_id),
            )
            .await;
            let sandbox = match outcome {
                Ok(openresearch::WaitOutcome::Online(sandbox)) => sandbox,
                Ok(openresearch::WaitOutcome::Cancelled) => {
                    eprintln!("supervise {run_id}: cancelled during provisioning");
                    let record_result =
                        store.update_status(&run_id, "cancelled", Some(now_ms()), None);
                    teardown_box(&store, &lifecycle, &sandbox_id, &run_id).await;
                    record_result?;
                    return Ok(());
                }
                Ok(openresearch::WaitOutcome::Failed(message)) => {
                    let record_result = store
                        .update_status(&run_id, "failed", Some(now_ms()), None)
                        .and_then(|()| {
                            store.set_result_markdown(
                                &run_id,
                                &format!("Provisioning failed: {message}"),
                            )
                        });
                    let clear_result = store.clear_sandbox_cleanup(&run_id);
                    record_result?;
                    clear_result?;
                    return Ok(());
                }
                Ok(openresearch::WaitOutcome::TimedOut(message)) => {
                    let record_result = store
                        .update_status(&run_id, "failed", Some(now_ms()), None)
                        .and_then(|()| {
                            store.set_result_markdown(
                                &run_id,
                                &format!("Provisioning failed: {message}"),
                            )
                        });
                    let cleanup = crate::store::SandboxCleanup {
                        sandbox_id: sandbox_id.clone(),
                        last_error: None,
                        retain_failed: true,
                    };
                    resume_sandbox_cleanup(&store, &cleanup, &run_id).await;
                    record_result?;
                    return Ok(());
                }
                Err(err) => {
                    let record_result = store
                        .update_status(&run_id, "failed", Some(now_ms()), None)
                        .and_then(|()| {
                            store.set_result_markdown(
                                &run_id,
                                &format!("Provisioning failed: {err}"),
                            )
                        });
                    teardown_box(&store, &lifecycle, &sandbox_id, &run_id).await;
                    record_result?;
                    return Ok(());
                }
            };
            descriptor.ssh_host = sandbox.ssh_hostname.clone();
            descriptor.ssh_port = sandbox.ssh_port;
            descriptor.ssh_user = sandbox.ssh_username.clone();
            if let Err(error) = store.mark_sandbox_cleanup_pending(&run_id, &sandbox_id, false) {
                teardown_box(&store, &lifecycle, &sandbox_id, &run_id).await;
                return Err(error);
            }
            if let Err(error) = store.set_backend_json(&run_id, &descriptor.to_json()) {
                teardown_box(&store, &lifecycle, &sandbox_id, &run_id).await;
                return Err(error);
            }
            let Some(target) = descriptor.openresearch_ssh_target() else {
                teardown_box(&store, &lifecycle, &sandbox_id, &run_id).await;
                return Err(anyhow!(
                    "box {sandbox_id} came online without an SSH endpoint"
                ));
            };
            target
        }
    };
    if let Err(error) = store.mark_sandbox_cleanup_pending(&run_id, &sandbox_id, false) {
        teardown_box(&store, &lifecycle, &sandbox_id, &run_id).await;
        return Err(error);
    }

    let owned_result: Result<()> = async {
        // Launch only after a successful SSH probe proves the run directory is
        // fresh. A transport error is ambiguous and may hide a running workload,
        // so it shares the durable post-readiness outage deadline instead of being
        // treated as permission to launch again.
        let already_launched =
            match await_launch_state(&store, &target, &run_id, SSH_LOSS_DEADLINE, || {
                local_cancel_requested(&store, &run_id)
            })
            .await?
            {
                LaunchState::AlreadyLaunched => true,
                LaunchState::Fresh => false,
                LaunchState::Cancelled => {
                    store.update_status(&run_id, "cancelled", Some(now_ms()), None)?;
                    return Ok(());
                }
                LaunchState::LaunchClaimTimedOut(message) => {
                    store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                    store.set_result_markdown(&run_id, &format!("Job failed: {message}"))?;
                    materialize_transport_log(&store, &run_id)?;
                    return Ok(());
                }
                LaunchState::TransportTimedOut(message) => {
                    store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                    store.set_result_markdown(&run_id, &format!("Job failed: {message}"))?;
                    materialize_transport_log(&store, &run_id)?;
                    return Ok(());
                }
            };
        if !already_launched {
            // The payload is re-derivable from the store + config, so a restart
            // that died before launching can rebuild it exactly.
            let Some(exp) = store.get_local_experiment(&stored.experiment_id)? else {
                store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                store.set_result_markdown(
                    &run_id,
                    "Local experiment vanished from the store before launch.",
                )?;
                return Ok(());
            };
            let Some(project) = store.get_local_project(&exp.project_id)? else {
                store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                store.set_result_markdown(
                    &run_id,
                    "Local project vanished from the store before launch.",
                )?;
                return Ok(());
            };
            let script = crate::commands::exp::hf_clone_script(
                stored
                    .commit_sha
                    .as_deref()
                    .ok_or_else(|| anyhow!("Remote run is missing its recorded commit SHA."))?,
                &project.github_owner,
                &project.github_repo,
                &stored.command,
            );
            let script = openresearch::wrap_with_timeout(
                &script,
                descriptor.timeout_secs.unwrap_or(4 * 3600),
            );
            let mut env: std::collections::HashMap<String, String> =
                crate::config::list_synced_env().into_iter().collect();
            if let Ok(hf_token) = hf::resolve_token() {
                env.entry("HF_TOKEN".to_string()).or_insert(hf_token);
            }
            if let Some(gh) = crate::local::git::resolve_github_token() {
                env.insert("GITHUB_TOKEN".to_string(), gh);
            }

            // sshd and the org key sync can lag a freshly-online box, so the
            // launch retries for ~2 minutes before giving up.
            let mut launch_err = None;
            for backoff_secs in [0u64, 5, 10, 20, 30, 45] {
                if backoff_secs > 0 {
                    tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
                }
                if local_cancel_requested(&store, &run_id) {
                    eprintln!("supervise {run_id}: cancelled before launch");
                    store.update_status(&run_id, "cancelled", Some(now_ms()), None)?;
                    return Ok(());
                }
                store.record_launch_claim(&run_id, now_ms())?;
                let launch_attempt_started_at = now_ms();
                match ssh::run_job_bounded(
                    &ssh::SshJobSpec {
                        target: target.clone(),
                        run_id: run_id.clone(),
                        script: script.clone(),
                        env: env.clone(),
                    },
                    SSH_PROBE_TIMEOUT,
                )
                .await
                {
                    Ok(_) => {
                        launch_err = None;
                        break;
                    }
                    Err(err) => {
                        eprintln!("supervise {run_id}: launch failed (will retry): {err}");
                        let error_message = err.to_string();
                        let detail = ssh_failure_detail(&error_message);
                        let lost_message = format!(
                            "orx: SSH launch failed; retrying for up to {}s: {detail}",
                            SSH_LOSS_DEADLINE.as_secs()
                        );
                        store.record_transport_failure(
                            &run_id,
                            &detail,
                            launch_attempt_started_at,
                            &lost_message,
                        )?;
                        let state =
                            await_launch_state(&store, &target, &run_id, SSH_LOSS_DEADLINE, || {
                                local_cancel_requested(&store, &run_id)
                            })
                            .await?;
                        match state {
                            LaunchState::AlreadyLaunched => {
                                launch_err = None;
                                break;
                            }
                            LaunchState::Fresh => launch_err = Some(anyhow!(error_message)),
                            LaunchState::Cancelled => {
                                store.update_status(&run_id, "cancelled", Some(now_ms()), None)?;
                                return Ok(());
                            }
                            LaunchState::LaunchClaimTimedOut(message) => {
                                store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                                store.set_result_markdown(
                                    &run_id,
                                    &format!("Job failed: {message}"),
                                )?;
                                materialize_transport_log(&store, &run_id)?;
                                return Ok(());
                            }
                            LaunchState::TransportTimedOut(message) => {
                                store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                                store.set_result_markdown(
                                    &run_id,
                                    &format!("Job failed: {message}"),
                                )?;
                                materialize_transport_log(&store, &run_id)?;
                                return Ok(());
                            }
                        }
                    }
                }
            }
            if let Some(err) = launch_err {
                store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                store.set_result_markdown(
                    &run_id,
                    &crate::local::ssh_identity::explain_launch_failure(
                        &sandbox_id,
                        &err.to_string(),
                    ),
                )?;
                materialize_transport_log(&store, &run_id)?;
                return Ok(());
            }
        }

        match await_launch_state(&store, &target, &run_id, SSH_LOSS_DEADLINE, || {
            local_cancel_requested(&store, &run_id)
        })
        .await?
        {
            LaunchState::AlreadyLaunched => {}
            LaunchState::Fresh => {
                let message = "The remote launch returned success without publishing a pid.";
                store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                store.set_result_markdown(&run_id, &format!("Job failed: {message}"))?;
                return Ok(());
            }
            LaunchState::Cancelled => {
                store.update_status(&run_id, "cancelled", Some(now_ms()), None)?;
                return Ok(());
            }
            LaunchState::LaunchClaimTimedOut(message) | LaunchState::TransportTimedOut(message) => {
                store.update_status(&run_id, "failed", Some(now_ms()), None)?;
                store.set_result_markdown(&run_id, &format!("Job failed: {message}"))?;
                materialize_transport_log(&store, &run_id)?;
                return Ok(());
            }
        }

        eprintln!(
            "supervise {run_id}: watching openresearch box {sandbox_id} ({})",
            target.dest
        );
        // The shared ssh loop owns status/logs/mirror; the box is deleted after
        // it returns (logs are drained from the box BEFORE teardown), and even
        // when it errors.
        watch_ssh_job(
            &store,
            &stored.status,
            target,
            dir,
            &creds,
            &run_id,
            SshWatchOptions {
                loss_deadline: Some(SSH_LOSS_DEADLINE),
            },
        )
        .await?;
        Ok(())
    }
    .await;
    if let Err(error) = &owned_result {
        if store
            .get_run(&run_id)
            .ok()
            .flatten()
            .is_some_and(|run| !crate::local::is_terminal(&run.status))
        {
            let _ = store.update_status(&run_id, "failed", Some(now_ms()), None);
            let _ = store.set_result_markdown(&run_id, &format!("Job failed: {error}"));
        }
    }
    teardown_box(&store, &lifecycle, &sandbox_id, &run_id).await;
    if store
        .get_run(&run_id)
        .ok()
        .flatten()
        .is_some_and(|run| matches!(run.status.as_str(), "done" | "failed" | "cancelled"))
    {
        let _ = store.clear_transport_history(&run_id);
    }
    owned_result
}

/// Keep retrying a durable cleanup intent until deletion or 404 is confirmed.
async fn resume_sandbox_cleanup(
    store: &Store,
    cleanup: &crate::store::SandboxCleanup,
    run_id: &str,
) {
    loop {
        let Ok(Some(lifecycle)) = crate::config::load_credentials().await else {
            eprintln!(
                "supervise {run_id}: cleanup for box {} is waiting for `orx login`",
                cleanup.sandbox_id
            );
            tokio::time::sleep(Duration::from_secs(15)).await;
            continue;
        };
        if cleanup.retain_failed {
            match tokio::time::timeout(
                Duration::from_secs(20),
                crate::client::get_sandbox(&lifecycle, &cleanup.sandbox_id),
            )
            .await
            {
                Ok(Ok(response)) if response.sandbox.status == "failed" => {
                    if store.clear_sandbox_cleanup(run_id).is_ok() {
                        eprintln!(
                            "supervise {run_id}: retained failed box {} for diagnosis",
                            cleanup.sandbox_id
                        );
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                Ok(Err(error)) if crate::client::is_api_status(&error, 404) => {
                    if store.clear_sandbox_cleanup(run_id).is_ok() {
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    let _ = store.record_sandbox_cleanup_error(run_id, &error.to_string());
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    continue;
                }
                Err(_) => {
                    let message = "sandbox cleanup status check timed out after 20s";
                    let _ = store.record_sandbox_cleanup_error(run_id, message);
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    continue;
                }
            }
        }
        teardown_box(store, &lifecycle, &cleanup.sandbox_id, run_id).await;
        return;
    }
}

async fn teardown_box(store: &Store, creds: &Credentials, sandbox_id: &str, run_id: &str) {
    loop {
        let persistence_error = store
            .mark_sandbox_cleanup_pending(run_id, sandbox_id, false)
            .err();
        if let Some(err) = &persistence_error {
            eprintln!("supervise {run_id}: could not persist cleanup for box {sandbox_id}: {err}");
        }
        let active_credentials = crate::config::load_credentials()
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| creds.clone());
        match openresearch::teardown(&active_credentials, sandbox_id).await {
            Ok(()) => {
                if persistence_error.is_none() {
                    if let Err(err) = store.clear_sandbox_cleanup(run_id) {
                        eprintln!(
                            "supervise {run_id}: box {sandbox_id} was deleted but cleanup state could not be cleared: {err}"
                        );
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                }
                eprintln!("supervise {run_id}: box {sandbox_id} deleted");
                return;
            }
            Err(err) => {
                eprintln!("supervise {run_id}: box {sandbox_id} cleanup failed; retrying: {err}");
                let _ = store.record_sandbox_cleanup_error(run_id, &err.to_string());
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        }
    }
}

// --- local ---------------------------------------------------------------------
//
// The ssh loop with the transport removed: the run dir is on this machine, so
// inspect/log reads are plain fs calls. Same cancel semantics — TERM leaves the
// process dead without an exit_code (ERROR), reported as `cancelled`.

async fn run_local(
    store: Store,
    stored: crate::store::StoredRun,
    descriptor: BackendDescriptor,
    creds: Option<Credentials>,
    run_id: String,
) -> Result<()> {
    let dir = std::path::PathBuf::from(descriptor.local_ref()?);

    eprintln!("supervise {run_id}: watching local run {}", dir.display());

    let path = log_path(&run_id);
    std::fs::File::create(&path)?;
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    let mut log_task = tokio::spawn(tail_logs_local(
        dir.clone(),
        path.clone(),
        run_id.clone(),
        done_rx,
    ));

    let mut last_status = stored.status.clone();
    let mut cancel_sent = false;

    loop {
        let job = localbox::inspect_job(&dir);
        let stage = job.stage.as_str();
        let status = run_status_for_stage(&store, &run_id, creds.is_none(), cancel_sent, stage);

        if is_terminal_stage(stage) {
            store.update_status(&run_id, &status, Some(now_ms()), None)?;
            if creds.is_none() && status == "failed" {
                if let Some(msg) = &job.message {
                    if let Err(err) =
                        store.set_result_markdown(&run_id, &format!("Job failed: {msg}"))
                    {
                        eprintln!("supervise {run_id}: could not record failure reason: {err}");
                    }
                }
            }
            let _ = done_tx.send(true);
            if tokio::time::timeout(Duration::from_secs(20), &mut log_task)
                .await
                .is_err()
            {
                log_task.abort();
            }
            if let Some(creds) = &creds {
                if let Err(err) = mirror_status(creds, &run_id, &status, &job.message).await {
                    eprintln!("supervise {run_id}: final status mirror failed: {err}");
                }
            }
            eprintln!("supervise {run_id}: finished ({status})");
            return Ok(());
        }

        if status != last_status {
            store.update_status(&run_id, &status, None, None)?;
            let cancel_requested = match &creds {
                Some(creds) => mirror_status(creds, &run_id, &status, &job.message)
                    .await
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            eprintln!("supervise {run_id}: {last_status} -> {status} (stage {stage})");
            last_status = status.clone();
            if cancel_requested && !cancel_sent {
                cancel_local(&dir, &run_id, &mut cancel_sent);
            }
        } else if !cancel_sent && local_cancel_requested(&store, &run_id) {
            cancel_local(&dir, &run_id, &mut cancel_sent);
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Local twin of `tail_logs_ssh` — mirrors the run dir's log into the store's
/// log file so `orx logs` and the dashboard read the usual place.
async fn tail_logs_local(
    dir: std::path::PathBuf,
    path: std::path::PathBuf,
    run_id: String,
    done: tokio::sync::watch::Receiver<bool>,
) {
    let mut log_file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(err) => {
            eprintln!(
                "supervise {run_id}: could not open {}: {err}",
                path.display()
            );
            return;
        }
    };
    let mut seen = 0u64;
    loop {
        let mut sink = |line: &str| {
            let _ = writeln!(log_file, "{line}");
        };
        match localbox::stream_logs(&dir, seen, &mut sink) {
            Ok(s) => seen = s,
            Err(err) => eprintln!("supervise {run_id}: log stream error (will retry): {err}"),
        }
        let _ = log_file.flush();
        if *done.borrow() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

fn cancel_local(dir: &std::path::Path, run_id: &str, cancel_sent: &mut bool) {
    eprintln!("supervise {run_id}: cancel requested — killing local process group");
    match localbox::cancel_job(dir) {
        Ok(()) => *cancel_sent = true,
        Err(err) => eprintln!("supervise {run_id}: local cancel failed (will retry): {err}"),
    }
}

// --- slurm ----------------------------------------------------------------------
//
// The ssh loop with a scheduler: state comes from the run dir's exit_code file
// first, then squeue/sacct; cancel is `scancel`. Logs reuse `tail_logs_ssh` —
// Slurm appends the job's output to the same `<run dir>/log` file the ssh
// backend uses. A scancel'd job leaves the queue without an exit_code, which
// inspect reports as CANCELED (or ERROR via the GONE fallback) — either way,
// once cancel is sent the terminal state maps to `cancelled`.

async fn run_slurm(
    store: Store,
    stored: crate::store::StoredRun,
    descriptor: BackendDescriptor,
    creds: Option<Credentials>,
    run_id: String,
) -> Result<()> {
    let (host, job_id) = descriptor.slurm_ref()?;
    let host = host.to_string();
    let job_id = job_id.to_string();
    let dir = slurm::run_dir(&run_id);

    eprintln!("supervise {run_id}: watching slurm job {job_id} on {host}");

    let path = log_path(&run_id);
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    let mut log_task = tokio::spawn(tail_logs_ssh(
        ssh::SshTarget::alias(&host),
        dir.clone(),
        path.clone(),
        run_id.clone(),
        done_rx,
    ));

    let mut last_status = stored.status.clone();
    let mut cancel_sent = false;
    // "GONE" (scheduler doesn't know the job, no exit_code) must persist for
    // a full minute before it's believed: it also fires during slurmctld
    // restarts and while the exit_code write is NFS-lagged behind the compute
    // node. Any other observation resets the count.
    const GONE_POLLS_TO_FAIL: u32 = (60 / POLL_INTERVAL.as_secs()) as u32;
    let mut gone_polls = 0u32;

    loop {
        let mut job = match slurm::inspect_job(&host, &run_id, &job_id).await {
            Ok(j) => j,
            Err(err) => {
                eprintln!("supervise {run_id}: inspect failed (will retry): {err}");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        if job.stage == "GONE" {
            gone_polls += 1;
            if gone_polls < GONE_POLLS_TO_FAIL {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            job = slurm::JobState {
                stage: "ERROR".to_string(),
                message: Some(
                    "job left the queue without an exit code (killed or node lost?)".to_string(),
                ),
            };
        } else {
            gone_polls = 0;
        }
        let stage = job.stage.as_str();
        let status = run_status_for_stage(&store, &run_id, creds.is_none(), cancel_sent, stage);

        if is_terminal_stage(stage) {
            store.update_status(&run_id, &status, Some(now_ms()), None)?;
            if creds.is_none() && status == "failed" {
                if let Some(msg) = &job.message {
                    if let Err(err) =
                        store.set_result_markdown(&run_id, &format!("Job failed: {msg}"))
                    {
                        eprintln!("supervise {run_id}: could not record failure reason: {err}");
                    }
                }
            }
            let _ = done_tx.send(true);
            if tokio::time::timeout(Duration::from_secs(20), &mut log_task)
                .await
                .is_err()
            {
                log_task.abort();
            }
            if let Some(creds) = &creds {
                if let Ok(bytes) = std::fs::read(&path) {
                    if !bytes.is_empty() {
                        match presign_external_run_log(creds, &run_id).await {
                            Ok(presigned) => {
                                if let Err(err) = upload_to_presigned(
                                    &presigned.url,
                                    "application/octet-stream",
                                    bytes,
                                )
                                .await
                                {
                                    eprintln!("supervise {run_id}: log upload failed: {err}");
                                }
                            }
                            Err(err) => eprintln!("supervise {run_id}: log presign failed: {err}"),
                        }
                    }
                }
                if let Err(err) = mirror_status(creds, &run_id, &status, &job.message).await {
                    eprintln!("supervise {run_id}: final status mirror failed: {err}");
                }
            }
            eprintln!("supervise {run_id}: finished ({status})");
            return Ok(());
        }

        if status != last_status {
            store.update_status(&run_id, &status, None, None)?;
            let cancel_requested = match &creds {
                Some(creds) => mirror_status(creds, &run_id, &status, &job.message)
                    .await
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            eprintln!("supervise {run_id}: {last_status} -> {status} (stage {stage})");
            last_status = status.clone();
            if cancel_requested && !cancel_sent {
                cancel_slurm(&host, &job_id, &run_id, &mut cancel_sent).await;
            }
        } else if !cancel_sent {
            let cancel_requested = match &creds {
                Some(creds) => crate::client::get_external_run_state(creds, &run_id)
                    .await
                    .map(|s| s.cancel_requested)
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            if cancel_requested {
                cancel_slurm(&host, &job_id, &run_id, &mut cancel_sent).await;
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn cancel_slurm(host: &str, job_id: &str, run_id: &str, cancel_sent: &mut bool) {
    eprintln!("supervise {run_id}: cancel requested — scancel {job_id}");
    match slurm::cancel_job(host, job_id).await {
        Ok(()) => *cancel_sent = true,
        Err(err) => eprintln!("supervise {run_id}: scancel failed (will retry): {err}"),
    }
}

// --- ray ----------------------------------------------------------------------
//
// Poll Ray Jobs status + full-log snapshot (no SSE). Cancel = POST …/stop.

async fn run_ray(
    store: Store,
    stored: crate::store::StoredRun,
    descriptor: BackendDescriptor,
    creds: Option<Credentials>,
    run_id: String,
) -> Result<()> {
    let (address, submission_id) = descriptor.ray_ref()?;
    let address = address.to_string();
    let submission_id = submission_id.to_string();

    eprintln!("supervise {run_id}: watching ray job {submission_id} at {address}");

    let path = log_path(&run_id);
    let (done_tx, done_rx) = tokio::sync::watch::channel(false);
    let mut log_task = tokio::spawn(tail_logs_ray(
        address.clone(),
        submission_id.clone(),
        path.clone(),
        run_id.clone(),
        done_rx,
    ));

    let mut last_status = stored.status.clone();
    let mut cancel_sent = false;
    // "GONE" (a 404 — the cluster no longer knows the job) must persist for a
    // full minute before it's believed: it also fires while a Ray head
    // restarts. Any other observation resets the count.
    const GONE_POLLS_TO_FAIL: u32 = (60 / POLL_INTERVAL.as_secs()) as u32;
    let mut gone_polls = 0u32;

    loop {
        let mut job = match ray::inspect_job(&address, &submission_id).await {
            Ok(j) => j,
            Err(err) => {
                eprintln!("supervise {run_id}: inspect failed (will retry): {err}");
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        if job.stage == "GONE" {
            gone_polls += 1;
            if gone_polls < GONE_POLLS_TO_FAIL {
                tokio::time::sleep(POLL_INTERVAL).await;
                continue;
            }
            job = ray::JobInfo {
                stage: "ERROR".to_string(),
                message: Some(
                    "job no longer known to the cluster (record purged or head restarted?)"
                        .to_string(),
                ),
            };
        } else {
            gone_polls = 0;
        }
        let stage = job.stage.as_str();
        let status = run_status_for_stage(&store, &run_id, creds.is_none(), cancel_sent, stage);

        if is_terminal_stage(stage) {
            store.update_status(&run_id, &status, Some(now_ms()), None)?;
            if creds.is_none() && status == "failed" {
                if let Some(msg) = &job.message {
                    if let Err(err) =
                        store.set_result_markdown(&run_id, &format!("Job failed: {msg}"))
                    {
                        eprintln!("supervise {run_id}: could not record failure reason: {err}");
                    }
                }
            }
            let _ = done_tx.send(true);
            if tokio::time::timeout(Duration::from_secs(20), &mut log_task)
                .await
                .is_err()
            {
                log_task.abort();
            }
            if let Some(creds) = &creds {
                if let Ok(bytes) = std::fs::read(&path) {
                    if !bytes.is_empty() {
                        match presign_external_run_log(creds, &run_id).await {
                            Ok(presigned) => {
                                if let Err(err) = upload_to_presigned(
                                    &presigned.url,
                                    "application/octet-stream",
                                    bytes,
                                )
                                .await
                                {
                                    eprintln!("supervise {run_id}: log upload failed: {err}");
                                }
                            }
                            Err(err) => eprintln!("supervise {run_id}: log presign failed: {err}"),
                        }
                    }
                }
                if let Err(err) = mirror_status(creds, &run_id, &status, &job.message).await {
                    eprintln!("supervise {run_id}: final status mirror failed: {err}");
                }
            }
            eprintln!("supervise {run_id}: finished ({status})");
            return Ok(());
        }

        if status != last_status {
            store.update_status(&run_id, &status, None, None)?;
            let cancel_requested = match &creds {
                Some(creds) => mirror_status(creds, &run_id, &status, &job.message)
                    .await
                    .unwrap_or(false),
                None => local_cancel_requested(&store, &run_id),
            };
            eprintln!("supervise {run_id}: {last_status} -> {status} (stage {stage})");
            last_status = status.clone();
            if cancel_requested && !cancel_sent {
                cancel_ray(&address, &submission_id, &run_id, &mut cancel_sent).await;
            }
        } else {
            // Ray's stop is a request, not a guarantee — once cancel was sent,
            // keep re-issuing until the job actually reaches a terminal stage.
            let cancel_requested = cancel_sent
                || match &creds {
                    Some(creds) => crate::client::get_external_run_state(creds, &run_id)
                        .await
                        .map(|s| s.cancel_requested)
                        .unwrap_or(false),
                    None => local_cancel_requested(&store, &run_id),
                };
            if cancel_requested {
                cancel_ray(&address, &submission_id, &run_id, &mut cancel_sent).await;
            }
        }

        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn tail_logs_ray(
    address: String,
    submission_id: String,
    path: std::path::PathBuf,
    run_id: String,
    done: tokio::sync::watch::Receiver<bool>,
) {
    let mut log_file = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
    {
        Ok(f) => f,
        Err(err) => {
            eprintln!(
                "supervise {run_id}: could not open {}: {err}",
                path.display()
            );
            return;
        }
    };
    let mut last = String::new();
    // Set when a write failed, so the file may not match `last`: forces a
    // wholesale rewrite until one fully succeeds.
    let mut dirty = false;
    loop {
        match ray::fetch_logs(&address, &submission_id).await {
            Ok(full) => {
                // Snapshots normally only grow; append the delta. Anything
                // else (truncation, rotation, a shifted window) invalidates
                // what's on disk, so rewrite the file wholesale.
                let delta = if dirty {
                    None
                } else {
                    full.strip_prefix(last.as_str())
                };
                let ok = match delta {
                    Some(d) => {
                        d.is_empty()
                            || (log_file.write_all(d.as_bytes()).is_ok()
                                && log_file.flush().is_ok())
                    }
                    None => {
                        log_file.rewind().is_ok()
                            && log_file.set_len(0).is_ok()
                            && log_file.write_all(full.as_bytes()).is_ok()
                            && log_file.flush().is_ok()
                    }
                };
                dirty = !ok;
                if ok {
                    last = full;
                } else {
                    eprintln!(
                        "supervise {run_id}: could not write {} (will retry)",
                        path.display()
                    );
                }
            }
            Err(err) => {
                eprintln!("supervise {run_id}: ray log fetch error (will retry): {err}");
            }
        }
        if *done.borrow() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn cancel_ray(address: &str, submission_id: &str, run_id: &str, cancel_sent: &mut bool) {
    eprintln!("supervise {run_id}: cancel requested — stopping ray job {submission_id}");
    match ray::stop_job(address, submission_id).await {
        Ok(()) => *cancel_sent = true,
        Err(err) => eprintln!("supervise {run_id}: ray stop failed (will retry): {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::StoredRun;

    #[test]
    fn recovered_cancel_intent_only_overrides_failed_terminal_state() {
        let dir = std::env::temp_dir().join(format!(
            "orx-supervise-cancel-test-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Store::open_at(dir.clone()).unwrap();
        let run = StoredRun {
            id: "run-1".into(),
            experiment_id: "experiment-1".into(),
            project_id: "project-1".into(),
            status: "running".into(),
            backend_json: "{}".into(),
            command: String::new(),
            created_at: 1,
            updated_at: 1,
            ended_at: None,
            exit_code: None,
            commit_sha: None,
            result_markdown: None,
            cancel_requested: false,
            chat_session_id: None,
        };
        store.upsert_run(&run).unwrap();

        assert_eq!(
            run_status_for_stage(&store, &run.id, true, false, "ERROR"),
            "failed"
        );
        store.set_cancel_requested(&run.id, true).unwrap();
        assert_eq!(
            run_status_for_stage(&store, &run.id, true, false, "ERROR"),
            "cancelled"
        );
        assert_eq!(
            run_status_for_stage(&store, &run.id, true, false, "COMPLETED"),
            "done"
        );
        assert_eq!(
            run_status_for_stage(&store, &run.id, false, false, "ERROR"),
            "failed"
        );

        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_one_supervisor_owns_a_run_lock() {
        let dir =
            std::env::temp_dir().join(format!("orx-supervisor-lock-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("run.lock");
        let mut first = open_supervisor_lock(&path).unwrap();
        let mut second = open_supervisor_lock(&path).unwrap();
        let first_guard = first.try_write().unwrap();

        match second.try_write() {
            Err(err) => assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock),
            Ok(_) => panic!("a second supervisor acquired the same run lock"),
        }

        drop(first_guard);
        drop(first);
        drop(second);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ssh_outage_uses_one_continuous_two_minute_window() {
        let started_at = 1_000;
        assert!(!ssh_outage_timed_out(
            started_at,
            started_at + 119_999,
            SSH_LOSS_DEADLINE
        ));
        assert!(ssh_outage_timed_out(
            started_at,
            started_at + 120_000,
            SSH_LOSS_DEADLINE
        ));
        assert!(!ssh_outage_timed_out(
            started_at,
            started_at - 1,
            SSH_LOSS_DEADLINE
        ));
    }

    #[test]
    fn launch_probe_respects_persisted_outage_and_clears_it_on_recovery() {
        let dir = std::env::temp_dir().join(format!(
            "orx-supervise-launch-probe-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Store::open_at(dir.clone()).unwrap();
        let target = ssh::SshTarget::alias("gpu-box");
        let started_at = 1_000;

        let pending = evaluate_launch_probe(
            &store,
            &target,
            "run-1",
            SSH_LOSS_DEADLINE,
            started_at,
            started_at,
            Err(anyhow!("connection refused")),
        )
        .unwrap();
        assert_eq!(pending, None);

        let recovered = evaluate_launch_probe(
            &store,
            &target,
            "run-1",
            SSH_LOSS_DEADLINE,
            started_at + 119_000,
            started_at + 119_000,
            Ok(openresearch::LaunchProbe::Started),
        )
        .unwrap();
        assert_eq!(recovered, Some(LaunchState::AlreadyLaunched));
        assert_eq!(store.transport_outage("run-1").unwrap(), None);

        evaluate_launch_probe(
            &store,
            &target,
            "run-2",
            SSH_LOSS_DEADLINE,
            started_at,
            started_at,
            Err(anyhow!("connection refused")),
        )
        .unwrap();
        let timed_out = evaluate_launch_probe(
            &store,
            &target,
            "run-2",
            SSH_LOSS_DEADLINE,
            started_at + SSH_LOSS_DEADLINE.as_millis() as i64,
            started_at + SSH_LOSS_DEADLINE.as_millis() as i64,
            Ok(openresearch::LaunchProbe::Started),
        )
        .unwrap();
        assert!(matches!(timed_out, Some(LaunchState::TransportTimedOut(_))));

        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn launch_claim_has_a_distinct_persisted_deadline() {
        let dir = std::env::temp_dir().join(format!(
            "orx-supervise-launch-claim-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Store::open_at(dir.clone()).unwrap();
        let target = ssh::SshTarget::alias("gpu-box");

        evaluate_launch_probe(
            &store,
            &target,
            "run-1",
            SSH_LOSS_DEADLINE,
            1_000,
            1_000,
            Err(anyhow!("connection refused")),
        )
        .unwrap();
        let pending = evaluate_launch_probe(
            &store,
            &target,
            "run-1",
            SSH_LOSS_DEADLINE,
            100_000,
            100_000,
            Ok(openresearch::LaunchProbe::Claimed),
        )
        .unwrap();
        assert_eq!(pending, None);
        assert_eq!(store.transport_outage("run-1").unwrap(), None);
        assert_eq!(store.launch_claim_at("run-1").unwrap(), Some(100_000));

        evaluate_launch_probe(
            &store,
            &target,
            "run-1",
            SSH_LOSS_DEADLINE,
            150_000,
            150_000,
            Err(anyhow!("connection reset")),
        )
        .unwrap();
        assert_eq!(store.launch_claim_at("run-1").unwrap(), Some(100_000));

        let timed_out = evaluate_launch_probe(
            &store,
            &target,
            "run-1",
            SSH_LOSS_DEADLINE,
            220_000,
            220_000,
            Ok(openresearch::LaunchProbe::Claimed),
        )
        .unwrap();
        assert!(matches!(
            timed_out,
            Some(LaunchState::LaunchClaimTimedOut(_))
        ));

        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn prelaunch_probe_honors_cancellation_before_ssh() {
        let dir = std::env::temp_dir().join(format!(
            "orx-supervise-launch-cancel-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Store::open_at(dir.clone()).unwrap();
        let state = await_launch_state(
            &store,
            &ssh::SshTarget::alias("must-not-connect"),
            "run-1",
            SSH_LOSS_DEADLINE,
            || true,
        )
        .await
        .unwrap();
        assert_eq!(state, LaunchState::Cancelled);
        drop(store);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
