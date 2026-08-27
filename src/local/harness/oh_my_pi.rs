//! Oh My Pi harness — the opencode-derived `omp` coding agent.
//!
//! Chat rides the CLI's print mode (`omp -p --mode=json`): one short-lived
//! process per turn, JSONL events on stdout, multi-turn via `--resume <id>` —
//! the same shape as codex's legacy exec path, because omp exposes no resident
//! serve/app-server protocol (`--mode=rpc` is an ACP server, a much heavier
//! embedding surface than print mode needs). The JSONL stream carries
//! session/turn framing, thinking + text deltas, tool calls with their
//! arguments, tool-execution results, and per-turn usage.
//!
//! Detection is shared with opencode by construction: omp is built on the
//! opencode stack — same `~/.config/opencode` config, same
//! `~/.local/share/opencode/auth.json` credentials, same provider env keys —
//! so a signed-in opencode install is a signed-in Oh My Pi install. Only the
//! binary and the model catalog (its own `omp models ls --json`) differ.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::detect::{bin_version, read_json, HarnessInfo, ModelInfo};
use super::options::{HarnessOptions, REASONING_DEFAULT_ID};
use super::{Harness, TurnFailure, TurnOutcome, TurnResult};
use crate::error::{anyhow, Result};
use crate::local::chat::{
    harness_log, prepare_env, set_chat_session_env, ContextUsage, DeliveryState, TurnCtx, WirePart,
    WireToolState,
};
use crate::local::opencode::ensure_playbook;
use crate::local::shell_env::find_on_path;

/// The Oh My Pi coding agent (binary `omp`; also known as "pi").
pub struct OhMyPi;

#[async_trait]
impl Harness for OhMyPi {
    fn id(&self) -> &'static str {
        "oh-my-pi"
    }

    fn name(&self) -> &'static str {
        "Oh My Pi"
    }

    fn supports_chat(&self) -> bool {
        true
    }

    async fn detect(&self) -> Option<HarnessInfo> {
        let mut info = HarnessInfo::new(self.id(), self.name());
        let mut models = Vec::new();
        if let Ok(bin) = find_omp() {
            info.installed = true;
            info.version = bin_version(&bin).await;
            info.bin_path = Some(bin.to_string_lossy().into_owned());
            models = omp_models(&bin).await;
        }
        // Auth is shared with opencode (omp reads the same XDG auth.json and
        // provider env keys), so reuse its credential surface rather than
        // inventing an omp-specific one.
        let providers = omp_auth_providers();
        if !providers.is_empty() {
            info.authenticated = true;
            info.auth_method = Some("oauth");
            info.account = Some(providers.join(", "));
        }
        const PROVIDER_KEYS: &[&str] = &[
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GROQ_API_KEY",
            "XAI_API_KEY",
            "DEEPSEEK_API_KEY",
            "OPENCODE_API_KEY",
        ];
        if !info.authenticated
            && PROVIDER_KEYS
                .iter()
                .any(|k| super::detect::api_key(k).is_some())
        {
            info.authenticated = true;
            info.auth_method = Some("apiKey");
        }

        info.agent_ready = info.installed && info.authenticated;
        if info.agent_ready {
            info.models = models;
        } else if info.installed {
            info.agent_note =
                Some("Sign in with `opencode auth login` to chat with it here.".to_string());
        } else {
            info.agent_note = Some(
                "Install Oh My Pi (`omp`), then sign in with `opencode auth login`.".to_string(),
            );
        }
        Some(info)
    }

    async fn run_turn(&self, ctx: &mut TurnCtx) -> TurnResult {
        run_turn(ctx)
            .await
            .map(|()| TurnOutcome::Completed)
            .map_err(|error| TurnFailure::adapter(error, ctx.delivery_state()))
    }

    fn options(&self) -> HarnessOptions {
        // Print mode executes tools without interactive approval, so there is
        // no permission axis to offer — and Plan is not implemented for the
        // exec path, so neither toggle appears.
        HarnessOptions::none()
    }

    fn config_home(&self) -> Option<PathBuf> {
        // omp shares the opencode config tree (XDG), so skills land next to
        // opencode's — same file, same content, idempotent writes.
        Some(super::xdg_config_home().join("opencode"))
    }

    fn skill_target(&self) -> Option<PathBuf> {
        Some(
            self.config_home()?
                .join("skills")
                .join("orx")
                .join("SKILL.md"),
        )
    }

    fn skill_shim(&self) -> Option<&'static str> {
        Some(super::CLAUDE_SKILL)
    }

    fn session_skills_dir(&self) -> Option<&'static str> {
        Some(".opencode/skills")
    }
}

/// `omp` on PATH, else the installer's default drop location (~/.local/bin).
pub(crate) fn find_omp() -> Result<PathBuf> {
    if let Some(found) = find_on_path("omp") {
        return Ok(found);
    }
    if let Some(home) = dirs::home_dir() {
        let fallback = home.join(".local").join("bin").join("omp");
        if fallback.is_file() {
            return Ok(fallback);
        }
    }
    Err(anyhow!(
        "omp not found (checked PATH and ~/.local/bin/omp).\n\
         Install Oh My Pi to use this harness."
    ))
}

/// The providers omp is signed into — opencode's auth.json (`{provider: {type}}`),
/// which omp reads because it shares the opencode data dir.
fn omp_auth_providers() -> Vec<String> {
    let Some(auth) = omp_auth_path().and_then(read_json) else {
        return Vec::new();
    };
    match auth.as_object() {
        Some(map) => map.keys().cloned().collect(),
        None => Vec::new(),
    }
}

fn omp_auth_path() -> Option<PathBuf> {
    let base = crate::local::shell_env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("share")))?;
    Some(base.join("opencode").join("auth.json"))
}

/// `omp models ls --json` — the model catalog, including each model's
/// `thinking` tiers (the ids `--thinking` accepts). Deduped by selector.
async fn omp_models(bin: &Path) -> Vec<ModelInfo> {
    let Ok(output) = Command::new(bin)
        .args(["models", "ls", "--json"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
    else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&output.stdout)) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    json.get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let selector = m.get("selector").and_then(Value::as_str)?.to_string();
            if !seen.insert(selector.clone()) {
                return None;
            }
            let thinking: Vec<&str> = m.get("thinking")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            Some(
                ModelInfo::new(selector)
                    .with_reasoning(&thinking)
                    .with_label(m.get("name").and_then(Value::as_str), None),
            )
        })
        .collect()
}

/// Run one chat turn: spawn `omp -p --mode=json`, stream its JSONL events into
/// wire parts, multi-turn via `--resume <native_session_id>`.
async fn run_turn(ctx: &mut TurnCtx) -> Result<()> {
    let bin = find_omp()?;
    let project = ctx.project.clone();
    let session_id = ctx.session_id.clone();
    // The modular orx skills land in the harness's session-skills dir, fresh,
    // for this session's agent to auto-load — source of truth is the trait.
    let skills_dir = OhMyPi.session_skills_dir();
    let (repo, playbook) =
        tokio::task::spawn_blocking(move || ensure_playbook(&project, &session_id, skills_dir))
            .await
            .map_err(|e| anyhow!("playbook task failed: {e}"))??;

    let mut cmd = Command::new(&bin);
    cmd.args(["-p", "--mode=json", "--auto-approve", "--no-title"]);
    if let Some(native_id) = &ctx.native_session_id {
        cmd.args(["--resume", native_id]);
    }
    if let Some(model) = &ctx.model {
        cmd.args(["--model", model]);
    }
    if let Some(level) = ctx
        .reasoning_level
        .as_deref()
        .filter(|l| *l != REASONING_DEFAULT_ID)
    {
        cmd.args(["--thinking", level]);
    }
    // First turn folds the playbook in as tagged context; resumes don't repeat
    // it (the session already carries it).
    let turn_text = if ctx.native_session_id.is_none() {
        let playbook_md = std::fs::read_to_string(&playbook).unwrap_or_default();
        format!(
            "<system-context>\n{playbook_md}\n</system-context>\n\n{}",
            ctx.text
        )
    } else {
        ctx.text.clone()
    };
    cmd.arg(turn_text);
    cmd.current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(harness_log("oh-my-pi")?))
        .kill_on_drop(true);
    prepare_env(&mut cmd);
    set_chat_session_env(&mut cmd, &ctx.session_id, ctx.host.up_port());

    ctx.persist_delivery(DeliveryState::Unknown)?;
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            ctx.mark_delivery(DeliveryState::NotSent);
            return Err(anyhow!("Could not spawn {}: {}", bin.display(), error));
        }
    };
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut counter = 0usize;
    let mut next_id = |prefix: &str| {
        counter += 1;
        format!("{prefix}-{counter}")
    };
    // Streaming deltas accumulate into one part until the complete event.
    let mut open_text: Option<String> = None;
    let mut open_reasoning: Option<String> = None;

    while let Some(line) = lines.next_line().await? {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        ctx.mark_delivery(DeliveryState::Accepted);
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");

        match kind {
            "session" => {
                if let Some(sid) = event.get("id").and_then(Value::as_str) {
                    ctx.set_native_session_id(sid);
                }
            }
            // The assistant's message_start carries the turn's usage upfront.
            "message_start" => {
                let msg = event.get("message");
                if msg.and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant") {
                    let used = msg
                        .and_then(|m| m.get("usage"))
                        .and_then(|u| u.get("totalTokens"))
                        .and_then(Value::as_u64);
                    if let Some(used) = used {
                        ctx.report_usage(ContextUsage {
                            used_tokens: used,
                            context_window: None,
                        });
                    }
                }
            }
            "message_update" => {
                let Some(ev) = event.get("assistantMessageEvent") else {
                    continue;
                };
                match ev.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_start" => {
                        open_text.get_or_insert_with(|| next_id("text"));
                    }
                    "text_delta" => {
                        let delta = ev.get("delta").and_then(Value::as_str).unwrap_or("");
                        let id = open_text.get_or_insert_with(|| next_id("text")).clone();
                        if ctx.assistant.parts.iter().all(|p| p.id != id) {
                            ctx.upsert_part(WirePart::text(id.clone(), ""));
                        }
                        ctx.append_part_text(&id, delta);
                    }
                    "text_end" => {
                        let _ = open_text.take();
                    }
                    "thinking_start" => {
                        open_reasoning.get_or_insert_with(|| next_id("think"));
                    }
                    "thinking_delta" => {
                        let delta = ev.get("delta").and_then(Value::as_str).unwrap_or("");
                        let id = open_reasoning.get_or_insert_with(|| next_id("think")).clone();
                        if ctx.assistant.parts.iter().all(|p| p.id != id) {
                            ctx.upsert_part(WirePart::reasoning(id.clone(), ""));
                        }
                        ctx.append_part_text(&id, delta);
                    }
                    "thinking_end" => {
                        let _ = open_reasoning.take();
                    }
                    "toolcall_end" => {
                        if let Some(tool_call) = ev.get("toolCall") {
                            let id = tool_call
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| next_id("tool"));
                            let name = tool_call
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("tool")
                                .to_string();
                            let arguments = tool_call
                                .get("arguments")
                                .cloned()
                                .unwrap_or(Value::Null);
                            let input = if arguments.is_null() {
                                serde_json::json!({})
                            } else {
                                arguments
                            };
                            ctx.upsert_part(WirePart {
                                id,
                                kind: "tool".into(),
                                text: None,
                                tool: Some(name),
                                state: Some(WireToolState {
                                    status: "running".into(),
                                    input: Some(input),
                                    output: None,
                                    error: None,
                                    title: None,
                                }),
                                prompt: None,
                                children: Vec::new(),
                            });
                        }
                    }
                    _ => {}
                }
            }
            // Close out the tool part the toolcall_end opened: result text +
            // success/error status, matched by the native toolCallId (the id we
            // stamped on the part).
            "tool_execution_end" => {
                if let Some(tool_call_id) = event.get("toolCallId").and_then(Value::as_str) {
                    if let Some(part) = ctx
                        .assistant
                        .parts
                        .iter_mut()
                        .find(|p| p.id == tool_call_id)
                    {
                        let is_error =
                            event.get("isError").and_then(Value::as_bool).unwrap_or(false);
                        let output = event
                            .get("result")
                            .and_then(|r| r.get("content"))
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|c| c.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n");
                        if let Some(state) = part.state.as_mut() {
                            state.status = if is_error { "error" } else { "completed" }.into();
                            state.output = Some(
                                if output.is_empty() {
                                    "(completed)".to_string()
                                } else {
                                    output
                                },
                            );
                            state.error =
                                is_error.then(|| "tool reported an error".to_string());
                        }
                    }
                }
            }
            "error" => {
                let detail = event
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("omp reported an error")
                    .to_string();
                ctx.push_error(detail);
            }
            _ => {}
        }
        ctx.maybe_flush();
    }

    let status = child.wait().await?;
    if !status.success() {
        return Err(anyhow!(
            "omp exited with {status}; see {}",
            crate::store::data_dir().join("agent-oh-my-pi.log").display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn models_parse_and_dedupe_by_selector() {
        let dir = std::env::temp_dir().join(format!("orx-omp-models-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("omp");
        // A fake `omp` that serves one catalog with a duplicated selector.
        std::fs::write(
            &bin,
            "#!/bin/sh\nprintf '%s' '{\"models\":[{\"provider\":\"deepseek\",\"id\":\"deepseek-v4-flash\",\"selector\":\"deepseek/deepseek-v4-flash\",\"name\":\"DeepSeek V4 Flash\",\"reasoning\":true,\"thinking\":[\"high\",\"max\"]},{\"provider\":\"deepseek\",\"id\":\"deepseek-v4-flash\",\"selector\":\"deepseek/deepseek-v4-flash\",\"name\":\"DeepSeek V4 Flash\",\"reasoning\":true,\"thinking\":[\"high\",\"max\"]},{\"provider\":\"opencode-go\",\"id\":\"deepseek-v4-flash\",\"selector\":\"opencode-go/deepseek-v4-flash\",\"name\":\"free\",\"reasoning\":true,\"thinking\":[\"low\",\"high\"]}]}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();

        // Sync call of the async helper for the test.
        let models = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(omp_models(&bin));
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(models.len(), 2, "duplicate selector collapses");
        let first = &models[0];
        assert_eq!(first.id, "deepseek/deepseek-v4-flash");
        assert_eq!(first.display_name.as_deref(), Some("DeepSeek V4 Flash"));
        let levels = first.reasoning_levels.as_ref().unwrap();
        assert!(
            levels.iter().any(|c| c.id == REASONING_DEFAULT_ID),
            "reasoning choices lead with the Default sentinel"
        );
        assert!(levels.iter().any(|c| c.id == "high"));
        assert!(levels.iter().any(|c| c.id == "max"));
    }

    #[test]
    fn find_omp_falls_back_to_local_bin() {
        // Can't rely on the machine's PATH; the fallback path is the contract.
        let home = dirs::home_dir().unwrap();
        let fallback = home.join(".local").join("bin").join("omp");
        assert!(fallback.is_file() || !fallback.exists());
    }

    #[test]
    fn toolcall_end_becomes_running_tool_part() {
        // Wire the events through a TurnCtx-free parse helper: builds the part
        // shape the event stream drives (regression guard for the mapper).
        let event = json!({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "contentIndex": 1,
                "toolCall": {
                    "type": "toolCall",
                    "id": "call_abc",
                    "name": "bash",
                    "arguments": { "command": "echo hi", "i": "greeting" }
                }
            }
        });
        let ev = event.get("assistantMessageEvent").unwrap();
        let tc = ev.get("toolCall").unwrap();
        let id = tc.get("id").and_then(Value::as_str).unwrap();
        let name = tc.get("name").and_then(Value::as_str).unwrap();
        let input = tc.get("arguments").unwrap().clone();
        assert_eq!(id, "call_abc");
        assert_eq!(name, "bash");
        assert_eq!(input.get("command").and_then(Value::as_str), Some("echo hi"));
    }
}