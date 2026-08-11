//! OpenResearch backend — an ephemeral platform box per run.
//!
//! Unlike the other backends, the compute itself comes from the OpenResearch
//! API: submit provisions an org-billed GPU/CPU sandbox (`POST /sandboxes`),
//! the supervisor polls `GET /sandboxes/{id}` until the box is online, runs
//! the clone-and-run payload on it over ssh (the ssh backend's transport and
//! run-dir layout, via `BackendDescriptor::openresearch_ssh_target`), and
//! deletes the box (`DELETE /sandboxes/{id}`) once the run is terminal.
//! Auth is the `orx login` credentials, not a backend-specific token.

use std::time::Duration;

use crate::client::{delete_sandbox, get_sandbox, Sandbox, SandboxTarget};
use crate::config::Credentials;
use crate::error::{anyhow, Result};

/// How long provisioning may take before the run is failed and the box
/// deleted. GPU boxes usually come online in single-digit minutes; a box
/// stuck longer is billing for nothing.
pub const PROVISION_DEADLINE: Duration = Duration::from_secs(5 * 60);

const POLL_INTERVAL: Duration = Duration::from_secs(5);

fn sandbox_created_at_ms(sandbox_id: &str) -> Option<u64> {
    let timestamp_hex = sandbox_id
        .chars()
        .filter(|character| *character != '-')
        .take(12)
        .collect::<String>();
    if timestamp_hex.len() != 12 {
        return None;
    }
    u64::from_str_radix(&timestamp_hex, 16).ok()
}

fn provisioning_timed_out(
    sandbox_id: &str,
    fallback_elapsed: Duration,
    observed_at_ms: u64,
    deadline: Duration,
) -> bool {
    match sandbox_created_at_ms(sandbox_id) {
        Some(created_at_ms) if created_at_ms <= observed_at_ms => {
            observed_at_ms - created_at_ms >= deadline.as_millis() as u64
        }
        _ => fallback_elapsed >= deadline,
    }
}

fn provisioning_remaining(
    sandbox_id: &str,
    fallback_elapsed: Duration,
    observed_at_ms: u64,
    deadline: Duration,
) -> Duration {
    match sandbox_created_at_ms(sandbox_id) {
        Some(created_at_ms) if created_at_ms <= observed_at_ms => deadline.saturating_sub(
            Duration::from_millis(observed_at_ms.saturating_sub(created_at_ms)),
        ),
        _ => deadline.saturating_sub(fallback_elapsed),
    }
}

/// The remote run dir for a run, relative to `$HOME` (shared convention with
/// the ssh backend; derived, not stored in the descriptor).
pub fn run_dir(run_id: &str) -> String {
    format!(".orx/runs/{run_id}")
}

/// Parse `--flavor` into a `POST /sandboxes` target: `<gpu_id>[:count]`
/// (e.g. `h100_sxm:2`) or a CPU flavor `cpu…[:vcpus]` (e.g. `cpu5c:8`).
/// Ids are validated server-side against the live catalog (400 on unknown),
/// same as the managed `--gpu` path — see `orx compute` for what exists.
pub fn parse_flavor(flavor: &str, disk_gb: i64, provider: Option<String>) -> Result<SandboxTarget> {
    let flavor = flavor.trim();
    let (base, count) = match flavor.split_once(':') {
        Some((base, count)) => {
            let count: i64 = count.parse().ok().filter(|c| *c >= 1).ok_or_else(|| {
                anyhow!(
                    "Bad --flavor '{flavor}': the ':{count}' suffix must be a positive \
                     count (GPUs) or vCPU tier. See `orx compute` for available shapes."
                )
            })?;
            (base, Some(count))
        }
        None => (flavor, None),
    };
    if base.is_empty() {
        return Err(anyhow!(
            "--flavor is empty. Pass a GPU id like h100_sxm[:count] or a CPU flavor \
             like cpu5c[:vcpus] — see `orx compute`."
        ));
    }
    if base.starts_with("cpu") {
        Ok(SandboxTarget::NewCpu {
            cpu_flavor: base.to_string(),
            vcpu_count: count.unwrap_or(8),
        })
    } else {
        Ok(SandboxTarget::New {
            gpu: base.to_ascii_uppercase(),
            gpu_count: count.unwrap_or(1),
            disk_gb,
            provider,
        })
    }
}

/// Wrap the clone-and-run payload in a wall-clock guard so a hung run can't
/// bill the box forever. TERM first (checkpoint-friendly), KILL 30s later.
/// GNU coreutils `timeout` is on the box image.
pub fn wrap_with_timeout(script: &str, timeout_secs: u64) -> String {
    format!(
        "timeout --signal=TERM --kill-after=30s {timeout_secs} bash -c {q}\n\
         rc=$?\n\
         if [ \"$rc\" = 124 ]; then echo \"orx: run timed out after {timeout_secs}s\" >&2; fi\n\
         exit $rc",
        q = super::ssh::sh_quote(script),
    )
}

/// What `wait_online` resolved to when it didn't error.
pub enum WaitOutcome {
    /// The box is online with its SSH endpoint populated.
    Online(Box<Sandbox>),
    /// The caller's cancel check fired first; the box may still be booting.
    Cancelled,
    /// The API recorded a terminal provisioning failure and owns provider
    /// cleanup; the retained sandbox row carries the reason.
    Failed(String),
    /// The user-facing five-minute SLA elapsed. The caller must reconcile the
    /// retained row before deciding whether explicit deletion is appropriate.
    TimedOut(String),
}

pub(crate) fn failed_sandbox_message(sandbox: &Sandbox) -> String {
    let stage = sandbox
        .provision_error_code
        .as_ref()
        .and(sandbox.provision_stage.as_deref())
        .map(|stage| format!(" during {stage}"))
        .unwrap_or_default();
    let code = sandbox
        .provision_error_code
        .as_deref()
        .map(|code| format!(" ({code})"))
        .unwrap_or_default();
    let detail = sandbox
        .provision_error_message
        .as_deref()
        .or(sandbox.last_health_error.as_deref())
        .or(sandbox.provision_warnings.as_deref())
        .unwrap_or("the provider did not return a failure reason");
    format!("Box {} failed{stage}{code}: {detail}.", sandbox.id)
}

/// Poll the box until it is online (SSH endpoint known), the deadline passes,
/// or `cancel_check` fires. `offline`/`dead` mid-provision is a hard error —
/// the box will never come up. Transient API errors are retried until the
/// deadline. A server-declared `failed` outcome is distinct because the API
/// owns provider cleanup and retains the row for diagnosis.
pub async fn wait_online(
    creds: &Credentials,
    sandbox_id: &str,
    deadline: Duration,
    mut cancel_check: impl FnMut() -> bool,
) -> Result<WaitOutcome> {
    let started = std::time::Instant::now();
    let mut last_err: Option<String> = None;
    loop {
        if cancel_check() {
            return Ok(WaitOutcome::Cancelled);
        }
        let observed_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let remaining =
            provisioning_remaining(sandbox_id, started.elapsed(), observed_at_ms, deadline);
        if remaining.is_zero() {
            return Ok(WaitOutcome::TimedOut(format!(
                "Box {sandbox_id} did not come online within {}m{}.",
                deadline.as_secs() / 60,
                last_err
                    .map(|error| format!(" (last API error: {error})"))
                    .unwrap_or_default()
            )));
        }
        let request_budget = remaining.min(Duration::from_secs(15));
        match tokio::time::timeout(request_budget, get_sandbox(creds, sandbox_id)).await {
            Err(_) => {
                last_err = Some(format!(
                    "sandbox status request timed out after {}s",
                    request_budget.as_secs()
                ))
            }
            Ok(Ok(envelope)) => {
                let sandbox = envelope.sandbox;
                if sandbox.status == "failed" {
                    return Ok(WaitOutcome::Failed(failed_sandbox_message(&sandbox)));
                }
                let response_at_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                if provisioning_timed_out(sandbox_id, started.elapsed(), response_at_ms, deadline) {
                    return Ok(WaitOutcome::TimedOut(format!(
                        "Box {sandbox_id} did not come online within {}m.",
                        deadline.as_secs() / 60
                    )));
                }
                match sandbox.status.as_str() {
                    "online"
                        if sandbox.ssh_hostname.is_some()
                            && sandbox.ssh_port.is_some()
                            && sandbox.ssh_username.is_some() =>
                    {
                        return Ok(WaitOutcome::Online(Box::new(sandbox)));
                    }
                    "offline" | "dead" => {
                        return Err(anyhow!(
                            "Box {sandbox_id} went {} while provisioning{}.",
                            sandbox.status,
                            sandbox
                                .provision_warnings
                                .map(|w| format!(": {w}"))
                                .unwrap_or_default()
                        ));
                    }
                    _ => {}
                }
                last_err = None;
            }
            Ok(Err(err)) if crate::client::is_api_status(&err, 404) => {
                return Err(anyhow!(
                    "Box {sandbox_id} disappeared after it was created (the API returned 404). \
                     This is a terminal provisioning failure on an older server."
                ));
            }
            Ok(Err(err)) => last_err = Some(err.to_string()),
        }
        let observed_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if provisioning_timed_out(sandbox_id, started.elapsed(), observed_at_ms, deadline) {
            return Ok(WaitOutcome::TimedOut(format!(
                "Box {sandbox_id} did not come online within {}m{}.",
                deadline.as_secs() / 60,
                last_err
                    .map(|e| format!(" (last API error: {e})"))
                    .unwrap_or_default()
            )));
        }
        let remaining =
            provisioning_remaining(sandbox_id, started.elapsed(), observed_at_ms, deadline);
        tokio::time::sleep(POLL_INTERVAL.min(remaining)).await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchProbe {
    Started,
    Fresh,
    Claimed,
}

/// Durable remote launch state. Transport failures remain errors; a claim with
/// no published pid is a distinct reachable state, not an SSH outage.
pub async fn launched(
    target: &super::ssh::SshTarget,
    run_id: &str,
    deadline: Duration,
) -> Result<LaunchProbe> {
    let dir = run_dir(run_id);
    let out = super::ssh::ssh_run_bounded(
        target,
        &format!(
            "d=\"$HOME/{dir}\"; \
             if [ -e \"$d/pid\" ] || [ -e \"$d/exit_code\" ]; then echo STARTED; \
             elif [ -d \"$d/.launch-claim\" ]; then echo CLAIMED; else echo FRESH; fi"
        ),
        None,
        deadline,
    )
    .await?;
    Ok(if out.contains("STARTED") {
        LaunchProbe::Started
    } else if out.contains("CLAIMED") {
        LaunchProbe::Claimed
    } else {
        LaunchProbe::Fresh
    })
}

/// Delete the box, retrying transient failures. A 404 is success — the box is
/// already gone (dashboard delete, billing sweeper) — which makes teardown
/// idempotent across supervisor restarts.
pub async fn teardown(creds: &Credentials, sandbox_id: &str) -> Result<()> {
    let mut last = None;
    for backoff_secs in [0u64, 2, 5, 10] {
        if backoff_secs > 0 {
            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        }
        match tokio::time::timeout(Duration::from_secs(20), delete_sandbox(creds, sandbox_id)).await
        {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(err)) if crate::client::is_api_status(&err, 404) => return Ok(()),
            Ok(Err(err)) => last = Some(err),
            Err(_) => last = Some(anyhow!("sandbox deletion timed out after 20s")),
        }
    }
    Err(last.unwrap_or_else(|| anyhow!("teardown failed")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_flavor_gpu_defaults_to_one() {
        match parse_flavor("h100_sxm", 100, None).unwrap() {
            SandboxTarget::New {
                gpu,
                gpu_count,
                disk_gb,
                provider,
            } => {
                assert_eq!(gpu, "H100_SXM");
                assert_eq!(gpu_count, 1);
                assert_eq!(disk_gb, 100);
                assert!(provider.is_none());
            }
            other => panic!("wrong target: {other:?}"),
        }
    }

    #[test]
    fn parse_flavor_gpu_with_count_and_provider() {
        match parse_flavor("h100_sxm:2", 250, Some("runpod".into())).unwrap() {
            SandboxTarget::New {
                gpu,
                gpu_count,
                disk_gb,
                provider,
            } => {
                assert_eq!(gpu, "H100_SXM");
                assert_eq!(gpu_count, 2);
                assert_eq!(disk_gb, 250);
                assert_eq!(provider.as_deref(), Some("runpod"));
            }
            other => panic!("wrong target: {other:?}"),
        }
    }

    #[test]
    fn parse_flavor_cpu_defaults_to_eight_vcpus() {
        match parse_flavor("cpu5c", 100, None).unwrap() {
            SandboxTarget::NewCpu {
                cpu_flavor,
                vcpu_count,
            } => {
                assert_eq!(cpu_flavor, "cpu5c");
                assert_eq!(vcpu_count, 8);
            }
            other => panic!("wrong target: {other:?}"),
        }
    }

    #[test]
    fn parse_flavor_cpu_with_vcpus() {
        match parse_flavor("cpu5m:32", 100, None).unwrap() {
            SandboxTarget::NewCpu {
                cpu_flavor,
                vcpu_count,
            } => {
                assert_eq!(cpu_flavor, "cpu5m");
                assert_eq!(vcpu_count, 32);
            }
            other => panic!("wrong target: {other:?}"),
        }
    }

    #[test]
    fn parse_flavor_rejects_bad_suffix_and_empty() {
        assert!(parse_flavor("h100_sxm:x", 100, None).is_err());
        assert!(parse_flavor("h100_sxm:0", 100, None).is_err());
        assert!(parse_flavor("", 100, None).is_err());
        assert!(parse_flavor(":2", 100, None).is_err());
    }

    #[test]
    fn timeout_wrapper_quotes_and_guards() {
        let wrapped = wrap_with_timeout("echo 'hi there'", 14400);
        assert!(wrapped.starts_with("timeout --signal=TERM --kill-after=30s 14400 bash -c "));
        // The payload survives quoting (embedded single quotes escaped).
        assert!(wrapped.contains("'echo '\\''hi there'\\'''"));
        assert!(wrapped.contains("rc=$?"));
        assert!(wrapped.trim_end().ends_with("exit $rc"));
    }

    #[test]
    fn run_dir_matches_ssh_convention() {
        assert_eq!(run_dir("abc"), ".orx/runs/abc");
    }

    #[test]
    fn provisioning_deadline_is_anchored_to_the_sandbox_uuid() {
        let sandbox_id = "00000000-03e8-7000-8000-000000000000";
        assert_eq!(sandbox_created_at_ms(sandbox_id), Some(1_000));
        assert!(!provisioning_timed_out(
            sandbox_id,
            Duration::ZERO,
            300_999,
            PROVISION_DEADLINE
        ));
        assert_eq!(
            provisioning_remaining(sandbox_id, Duration::ZERO, 300_999, PROVISION_DEADLINE),
            Duration::from_millis(1)
        );
        assert!(provisioning_timed_out(
            sandbox_id,
            Duration::ZERO,
            301_000,
            PROVISION_DEADLINE
        ));
        assert_eq!(
            provisioning_remaining(sandbox_id, Duration::ZERO, 301_000, PROVISION_DEADLINE),
            Duration::ZERO
        );
    }

    #[test]
    fn legacy_sandbox_ids_use_process_elapsed_time() {
        assert!(provisioning_timed_out(
            "legacy",
            PROVISION_DEADLINE,
            301_000,
            PROVISION_DEADLINE
        ));
    }

    #[test]
    fn failed_sandbox_message_includes_typed_reason() {
        let sandbox: Sandbox = serde_json::from_value(serde_json::json!({
            "id": "sb_1",
            "organizationId": "org_1",
            "projectId": null,
            "sshHostname": null,
            "sshPort": null,
            "sshUsername": null,
            "status": "failed",
            "machineType": "persistent",
            "createdBy": "user_1",
            "updatedAt": "2026-08-10T00:00:00Z",
            "provisionWarnings": null,
            "provisionStage": "ssh_auth",
            "provisionErrorCode": "readiness_timeout",
            "provisionErrorMessage": "The registered key was rejected",
            "providerName": "nebius",
            "providerInstanceId": "instance_1",
            "pricePerHour": 1.0,
            "gpu": "H100_SXM",
            "gpuCount": 1,
            "vcpuCount": null
        }))
        .unwrap();

        assert_eq!(
            failed_sandbox_message(&sandbox),
            "Box sb_1 failed during ssh_auth (readiness_timeout): The registered key was rejected."
        );
    }

    #[test]
    fn failed_sandbox_message_falls_back_for_legacy_payload() {
        let sandbox: Sandbox = serde_json::from_value(serde_json::json!({
            "id": "sb_legacy",
            "organizationId": "org_1",
            "projectId": null,
            "sshHostname": null,
            "sshPort": null,
            "sshUsername": null,
            "status": "failed",
            "machineType": "persistent",
            "createdBy": null,
            "updatedAt": "2026-08-10T00:00:00Z",
            "provisionWarnings": "provider capacity unavailable",
            "providerName": "runpod",
            "providerInstanceId": null,
            "pricePerHour": null,
            "gpu": "H100_SXM",
            "gpuCount": 1,
            "vcpuCount": null
        }))
        .unwrap();

        assert_eq!(
            failed_sandbox_message(&sandbox),
            "Box sb_legacy failed: provider capacity unavailable."
        );
    }

    #[test]
    fn failed_sandbox_message_distinguishes_post_ready_ssh_loss() {
        let sandbox: Sandbox = serde_json::from_value(serde_json::json!({
            "id": "sb_health",
            "organizationId": "org_1",
            "projectId": null,
            "sshHostname": "example.test",
            "sshPort": 22,
            "sshUsername": "root",
            "status": "failed",
            "machineType": "ephemeral",
            "createdBy": null,
            "updatedAt": "2026-08-10T00:00:00Z",
            "provisionWarnings": null,
            "provisionStage": "ready",
            "provisionErrorCode": null,
            "provisionErrorMessage": null,
            "lastHealthError": "ssh_auth: authentication failed",
            "providerName": "vast",
            "providerInstanceId": "instance_1",
            "pricePerHour": 1.0,
            "gpu": "RTX_4090",
            "gpuCount": 2,
            "vcpuCount": null
        }))
        .unwrap();

        assert_eq!(
            failed_sandbox_message(&sandbox),
            "Box sb_health failed: ssh_auth: authentication failed."
        );
    }
}
