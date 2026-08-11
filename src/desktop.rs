#[cfg(unix)]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};

const DASHBOARD_URL: &str = "http://127.0.0.1:4791";
const HEALTH_URL: &str = "http://127.0.0.1:4791/api/health";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    version: Option<String>,
    service: Option<String>,
    pid: Option<u32>,
    desktop_instance_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopProcess {
    pid: u32,
    version: String,
    instance_id: String,
}

pub async fn launch() -> Result<()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1))
        .build()?;

    if existing_server(&client)
        .await
        .is_some_and(|health| !desktop_upgrade_needed(&health))
    {
        return open_dashboard();
    }

    let lock_path = config_dir().join("desktop-launch.lock");
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Could not create {}", parent.display()))?;
    }
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .with_context(|| format!("Could not open {}", lock_path.display()))?;
    let mut lock = fd_lock::RwLock::new(lock_file);
    let _guard = lock
        .write()
        .context("Could not coordinate with another OpenResearch launcher")?;

    let mut staged_orx = None;
    if let Some(health) = existing_server(&client).await {
        if let Some(pid) = desktop_upgrade_pid(&health) {
            staged_orx = Some(server_orx_path(&std::env::current_exe()?)?);
            stop_process(pid);
            wait_for_server_exit(&client).await?;
        } else {
            return open_dashboard();
        }
    }

    let orx = match staged_orx {
        Some(orx) => orx,
        None => server_orx_path(&std::env::current_exe()?)?,
    };
    let log_path = config_dir().join("desktop.log");
    let log = open_log(&log_path)?;
    let instance_id = uuid::Uuid::new_v4().to_string();
    let mut child = spawn_server(&orx, log, &instance_id).await?;

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(health) = existing_server(&client).await {
            if !health_matches_process(&health, child.id(), &instance_id) {
                if child
                    .try_wait()
                    .context("Could not inspect orx up")?
                    .is_none()
                {
                    stop_server(&mut child);
                }
                return open_dashboard();
            }
            let process = DesktopProcess {
                pid: child.id(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                instance_id: instance_id.clone(),
            };
            if let Err(error) = write_desktop_process(&process) {
                stop_server(&mut child);
                return Err(error);
            }
            cleanup_old_desktop_files(&instance_id);
            return open_dashboard();
        }
        if let Some(status) = child.try_wait().context("Could not inspect orx up")? {
            return Err(anyhow!(
                "The local dashboard exited during startup ({status}). See {} for details.",
                log_path.display()
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }

    stop_server(&mut child);
    Err(anyhow!(
        "The local dashboard did not become ready within {} seconds, so it was stopped. See {} for details.",
        STARTUP_TIMEOUT.as_secs(),
        log_path.display()
    ))
}

fn health_matches_process(health: &HealthResponse, pid: u32, instance_id: &str) -> bool {
    health.service.as_deref() == Some("openresearch")
        && health.version.as_deref() == Some(env!("CARGO_PKG_VERSION"))
        && health.pid == Some(pid)
        && health.desktop_instance_id.as_deref() == Some(instance_id)
}

fn open_dashboard() -> Result<()> {
    crate::browser::try_open_browser(DASHBOARD_URL).with_context(|| {
        format!("Could not open the default browser. Open {DASHBOARD_URL} manually")
    })
}

async fn dashboard_ready(client: &reqwest::Client) -> bool {
    existing_server(client).await.is_some()
}

async fn existing_server(client: &reqwest::Client) -> Option<HealthResponse> {
    let Ok(response) = client.get(HEALTH_URL).send().await else {
        return None;
    };
    if !response.status().is_success() {
        return None;
    }
    let Ok(body) = response.text().await else {
        return None;
    };
    parse_health_response(&body)
}

fn parse_health_response(body: &str) -> Option<HealthResponse> {
    serde_json::from_str::<HealthResponse>(body)
        .ok()
        .filter(|health| {
            health.ok
                && (health.service.as_deref() == Some("openresearch") || health.version.is_some())
        })
}

fn desktop_upgrade_needed(health: &HealthResponse) -> bool {
    desktop_upgrade_pid(health).is_some()
}

fn desktop_upgrade_pid(health: &HealthResponse) -> Option<u32> {
    let state = read_desktop_process(health.desktop_instance_id.as_deref()?)?;
    matching_upgrade_pid(health, &state)
}

fn matching_upgrade_pid(health: &HealthResponse, state: &DesktopProcess) -> Option<u32> {
    let launcher = semver::Version::parse(env!("CARGO_PKG_VERSION")).ok()?;
    let running = semver::Version::parse(health.version.as_deref()?).ok()?;
    (launcher > running
        && health.service.as_deref() == Some("openresearch")
        && health.pid == Some(state.pid)
        && health.version.as_deref() == Some(state.version.as_str())
        && health.desktop_instance_id.as_deref() == Some(state.instance_id.as_str()))
    .then_some(state.pid)
}

async fn wait_for_server_exit(client: &reqwest::Client) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if !dashboard_ready(client).await {
            return Ok(());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    Err(anyhow!(
        "The previous desktop dashboard did not stop during the upgrade"
    ))
}

fn sibling_orx_path(launcher: &Path) -> Result<PathBuf> {
    let directory = launcher
        .parent()
        .ok_or_else(|| anyhow!("Could not locate the OpenResearch installation"))?;
    let orx = directory.join(format!("orx{}", std::env::consts::EXE_SUFFIX));
    if orx.is_file() {
        Ok(orx)
    } else {
        Err(anyhow!(
            "The OpenResearch installation is incomplete: {} is missing",
            orx.display()
        ))
    }
}

fn server_orx_path(launcher: &Path) -> Result<PathBuf> {
    let bundled = sibling_orx_path(launcher)?;
    install_desktop_orx(&bundled)
}

fn install_desktop_orx(bundled: &Path) -> Result<PathBuf> {
    let directory = desktop_binary_base().join(env!("CARGO_PKG_VERSION"));
    let installed = directory.join(format!("orx{}", std::env::consts::EXE_SUFFIX));
    if installed.is_file() && files_equal(bundled, &installed).unwrap_or(false) {
        return Ok(installed);
    }

    std::fs::create_dir_all(&directory)
        .with_context(|| format!("Could not create {}", directory.display()))?;
    let temporary = directory.join(format!(".orx-{}", uuid::Uuid::new_v4()));
    std::fs::copy(bundled, &temporary).with_context(|| {
        format!(
            "Could not install the desktop dashboard binary at {}",
            temporary.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(windows)]
    if installed.is_file() {
        std::fs::remove_file(&installed)
            .with_context(|| format!("Could not replace {}", installed.display()))?;
    }
    std::fs::rename(&temporary, &installed).with_context(|| {
        format!(
            "Could not finish installing the desktop dashboard binary at {}",
            installed.display()
        )
    })?;
    Ok(installed)
}

fn files_equal(left: &Path, right: &Path) -> std::io::Result<bool> {
    if std::fs::metadata(left)?.len() != std::fs::metadata(right)?.len() {
        return Ok(false);
    }
    let mut left = File::open(left)?;
    let mut right = File::open(right)?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_read = left.read(&mut left_buffer)?;
        let right_read = right.read(&mut right_buffer)?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn desktop_binary_base() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local/share")
        })
        .join("openresearch/desktop")
}

fn open_log(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Could not create {}", parent.display()))?;
    }

    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .with_context(|| format!("Could not open {}", path.display()))
}

async fn spawn_server(orx: &Path, log: File, instance_id: &str) -> Result<Child> {
    let stderr = log
        .try_clone()
        .context("Could not prepare dashboard logging")?;
    let mut command = Command::new(orx);
    command
        .args(["up", "--no-browser"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(stderr));
    if let Some(environment) = login_shell_environment().await {
        command.envs(environment);
    }
    command.env("ORX_DESKTOP_INSTANCE_ID", instance_id);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_NO_WINDOW);
    }

    command
        .spawn()
        .with_context(|| format!("Could not start {} up", orx.display()))
}

#[cfg(unix)]
async fn login_shell_environment() -> Option<Vec<(OsString, OsString)>> {
    use tokio::io::AsyncReadExt;

    let shell = std::env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/sh"));
    let helper = std::env::current_exe().ok()?;
    let mut shell_command = tokio::process::Command::new(shell);
    shell_command
        .args([
            OsStr::new("-ilc"),
            OsStr::new(
                "printf '\\0__ORX_DESKTOP_ENV__\\0'; \"$ORX_DESKTOP_ENV_HELPER\" --print-environment",
            ),
        ])
        .env("ORX_DESKTOP_ENV_HELPER", helper)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    use std::os::unix::process::CommandExt;
    shell_command.as_std_mut().process_group(0);
    let mut child = shell_command.spawn().ok()?;
    let shell_pid = child.id()?;
    let stdout = child.stdout.take()?;
    let mut reader = tokio::spawn(async move {
        let mut output = Vec::new();
        stdout
            .take(256 * 1024)
            .read_to_end(&mut output)
            .await
            .ok()?;
        Some(output)
    });
    let capture = async {
        let status = child.wait().await.ok()?;
        let output = (&mut reader).await.ok()??;
        Some((status, output))
    };
    let (status, output) = match tokio::time::timeout(Duration::from_secs(5), capture).await {
        Ok(Some(captured)) => captured,
        _ => {
            unsafe {
                libc::kill(-(shell_pid as i32), libc::SIGTERM);
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            reader.abort();
            return None;
        }
    };
    status.success().then(|| parse_shell_environment(&output))
}

#[cfg(unix)]
pub fn print_environment() {
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;

    let mut output = std::io::stdout().lock();
    for (key, value) in std::env::vars_os() {
        let _ = output.write_all(key.as_os_str().as_bytes());
        let _ = output.write_all(b"=");
        let _ = output.write_all(value.as_os_str().as_bytes());
        let _ = output.write_all(b"\0");
    }
}

#[cfg(not(unix))]
async fn login_shell_environment() -> Option<Vec<(OsString, OsString)>> {
    None
}

#[cfg(unix)]
fn parse_shell_environment(output: &[u8]) -> Vec<(OsString, OsString)> {
    use std::os::unix::ffi::OsStringExt;

    let mut entries = output.split(|byte| *byte == 0);
    entries.find(|entry| *entry == b"__ORX_DESKTOP_ENV__");
    entries
        .filter_map(|entry| {
            let separator = entry.iter().position(|byte| *byte == b'=')?;
            let (key, value) = entry.split_at(separator);
            (!key.is_empty()).then(|| {
                (
                    OsString::from_vec(key.to_vec()),
                    OsString::from_vec(value[1..].to_vec()),
                )
            })
        })
        .collect()
}

fn stop_server(child: &mut Child) {
    stop_process(child.id());
    let _ = child.wait();
}

fn stop_process(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn config_dir() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".config")
        });
    base.join("openresearch")
}

fn desktop_process_path() -> PathBuf {
    config_dir().join("desktop-processes")
}

fn process_state_path(instance_id: &str) -> Option<PathBuf> {
    let instance_id = uuid::Uuid::parse_str(instance_id).ok()?;
    Some(
        desktop_process_path()
            .join(instance_id.to_string())
            .with_extension("json"),
    )
}

fn read_desktop_process(instance_id: &str) -> Option<DesktopProcess> {
    let body = std::fs::read(process_state_path(instance_id)?).ok()?;
    serde_json::from_slice(&body).ok()
}

fn write_desktop_process(process: &DesktopProcess) -> Result<()> {
    let path = process_state_path(&process.instance_id)
        .ok_or_else(|| anyhow!("Could not record an invalid desktop instance ID"))?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("Could not locate the desktop process directory"))?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("Could not create {}", parent.display()))?;
    let temporary = parent.join(format!(".desktop-process-{}", uuid::Uuid::new_v4()));
    let body = serde_json::to_vec(process)?;
    std::fs::write(&temporary, body).with_context(|| {
        format!(
            "Could not record the desktop process at {}",
            temporary.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&temporary, &path)
        .with_context(|| format!("Could not finish recording {}", path.display()))?;
    Ok(())
}

fn cleanup_old_desktop_files(current_instance_id: &str) {
    if let Ok(entries) = std::fs::read_dir(desktop_process_path()) {
        let current = process_state_path(current_instance_id);
        for path in entries.flatten().map(|entry| entry.path()) {
            if Some(&path) != current.as_ref() {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    if let Ok(entries) = std::fs::read_dir(desktop_binary_base()) {
        for entry in entries.flatten() {
            if entry.file_name() != env!("CARGO_PKG_VERSION") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

pub fn show_error(message: &str) {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let candidates = [
            (
                "zenity",
                vec![
                    "--error",
                    "--title=OpenResearch could not start",
                    "--text",
                    message,
                ],
            ),
            (
                "kdialog",
                vec![
                    "--error",
                    message,
                    "--title",
                    "OpenResearch could not start",
                ],
            ),
            ("xmessage", vec!["-center", message]),
            (
                "notify-send",
                vec![
                    "--urgency=critical",
                    "OpenResearch could not start",
                    message,
                ],
            ),
        ];
        for (program, args) in candidates {
            let status = Command::new(program)
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if status.is_ok_and(|status| status.success()) {
                return;
            }
        }
        return;
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("osascript");
        command.args([
            "-e",
            "on run argv",
            "-e",
            "display alert \"OpenResearch could not start\" message (item 1 of argv) as critical",
            "-e",
            "end run",
            "--",
            message,
        ]);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:ORX_DESKTOP_ERROR, 'OpenResearch could not start')",
            ])
            .env("ORX_DESKTOP_ERROR", message);
        command
    };

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let _ = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_current_and_legacy_health_responses() {
        assert!(parse_health_response(
            r#"{"ok":true,"service":"openresearch","version":"0.1.97"}"#
        )
        .is_some());
        assert!(parse_health_response(r#"{"ok":true,"version":"0.1.96"}"#).is_some());
    }

    #[test]
    fn rejects_unrelated_health_responses() {
        assert!(parse_health_response(r#"{"ok":true}"#).is_none());
        assert!(parse_health_response(
            r#"{"ok":false,"service":"openresearch","version":"0.1.97"}"#
        )
        .is_none());
        assert!(parse_health_response("not json").is_none());
    }

    #[test]
    fn resolves_orx_next_to_launcher() {
        let temp = std::env::temp_dir().join(format!("orx-desktop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let orx = temp.join(format!("orx{}", std::env::consts::EXE_SUFFIX));
        std::fs::write(&orx, b"").unwrap();
        let launcher = temp.join(format!("openresearch{}", std::env::consts::EXE_SUFFIX));

        assert_eq!(sibling_orx_path(&launcher).unwrap(), orx);

        std::fs::remove_dir_all(temp).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn parses_environment_after_shell_startup_output() {
        let output =
            b"startup text\0__ORX_DESKTOP_ENV__\0PATH=/opt/homebrew/bin:/usr/bin\0TOKEN=a=b\0";
        let parsed = parse_shell_environment(output);

        assert_eq!(
            parsed,
            vec![
                (
                    OsString::from("PATH"),
                    OsString::from("/opt/homebrew/bin:/usr/bin")
                ),
                (OsString::from("TOKEN"), OsString::from("a=b"))
            ]
        );
    }

    #[test]
    fn restarts_only_the_matching_desktop_owned_process() {
        let state = DesktopProcess {
            pid: 123,
            version: "0.1.96".to_string(),
            instance_id: "desktop-run".to_string(),
        };
        let mut health = HealthResponse {
            ok: true,
            version: Some("0.1.96".to_string()),
            service: Some("openresearch".to_string()),
            pid: Some(123),
            desktop_instance_id: Some("desktop-run".to_string()),
        };

        assert_eq!(matching_upgrade_pid(&health, &state), Some(123));
        health.version = Some("0.1.98".to_string());
        assert_eq!(matching_upgrade_pid(&health, &state), None);
        health.version = Some("0.1.96".to_string());
        health.desktop_instance_id = None;
        assert_eq!(matching_upgrade_pid(&health, &state), None);
    }

    #[test]
    fn attributes_readiness_only_to_the_spawned_process() {
        let mut health = HealthResponse {
            ok: true,
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            service: Some("openresearch".to_string()),
            pid: Some(123),
            desktop_instance_id: Some("desktop-run".to_string()),
        };

        assert!(health_matches_process(&health, 123, "desktop-run"));
        health.pid = Some(456);
        assert!(!health_matches_process(&health, 123, "desktop-run"));
        health.pid = Some(123);
        health.desktop_instance_id = Some("other-run".to_string());
        assert!(!health_matches_process(&health, 123, "desktop-run"));
    }
}
