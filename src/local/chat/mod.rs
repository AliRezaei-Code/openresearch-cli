//! Unified chat layer for `orx up` — one session/message model over three
//! harness adapters (Claude Code, Codex, OpenCode), each a local child
//! process using the user's own login. orx's SQLite is the system of record
//! for transcripts; each harness keeps its native session for context/resume.
//!
//! Flow: `POST /api/chat/sessions/{id}/message` → `ChatHost::send_message`
//! persists the user message and spawns one turn task. The adapter streams
//! normalized parts into the per-turn assistant message; every flush persists
//! the message and broadcasts it as a `chat.message` SSE event.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex};

use crate::error::{anyhow, Result};
use crate::local::harness::ResumeAction;
use crate::local::model::LocalProject;
use crate::local::opencode::AgentHost;
use crate::store::{now_ms, Store, StoredChatMessage, StoredChatSession};

/// Min interval between mid-turn persist+broadcast flushes (streaming parts
/// can update many times a second; the final flush is always unconditional).
const FLUSH_INTERVAL: Duration = Duration::from_millis(75);

/// Max chars of a tool part's `output`/`error` kept on the wire and in the
/// store. Every flush re-broadcasts (and re-persists) the FULL assistant
/// message, so uncapped tool outputs make each 75ms SSE frame O(total tool
/// output) for the whole turn. The UI never shows more than 20k chars of a
/// tool output anyway (ToolRow slices); capping below that keeps the
/// truncation marker visible under the UI's own slice.
const TOOL_TEXT_CAP: usize = 16_000;
const TOOL_TEXT_TRUNCATION_MARKER: &str = "\n… [output truncated]";
const TOOL_TARGET_CAP: usize = 256;
const TOOL_TARGET_INSPECTION_CAP: usize = 1_024;
const TOOL_TARGET_SCAN_BYTES: usize = 256_000;
const CHAT_TARGET_FILE_ENV: &str = "ORX_CHAT_TARGET_FILE";
const CHAT_TARGET_POINTER_ENV: &str = "ORX_CHAT_TARGET_POINTER";

/// Keep the head and tail of `text` within [`TOOL_TEXT_CAP`] chars, marking
/// the omitted middle. Idempotent — an already-capped string is left alone.
fn cap_tool_text(text: &mut String) {
    // Bytes >= chars, so a string within the cap in bytes needs no scan.
    if text.len() <= TOOL_TEXT_CAP {
        return;
    }
    let char_count = text.chars().count();
    if char_count <= TOOL_TEXT_CAP {
        return;
    }
    let retained = TOOL_TEXT_CAP - TOOL_TEXT_TRUNCATION_MARKER.chars().count();
    let head_chars = retained / 2;
    let tail_chars = retained - head_chars;
    let head_end = text
        .char_indices()
        .nth(head_chars)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    let tail_start = text
        .char_indices()
        .nth(char_count - tail_chars)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    let mut capped = String::with_capacity(text.len().min(TOOL_TEXT_CAP));
    capped.push_str(&text[..head_end]);
    capped.push_str(TOOL_TEXT_TRUNCATION_MARKER);
    capped.push_str(&text[tail_start..]);
    *text = capped;
}

fn bounded_tool_scan_windows(text: &str) -> Vec<&str> {
    if text.len() <= TOOL_TARGET_SCAN_BYTES {
        return vec![text];
    }
    let window_bytes = TOOL_TARGET_SCAN_BYTES / 2;
    let mut end = window_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut start = text.len() - window_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    vec![&text[..end], &text[start..]]
}

fn valid_tool_target(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() == 8 && bytes.iter().all(u8::is_ascii_hexdigit))
        || (bytes.len() == 36
            && bytes.iter().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    *byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            }))
}

fn tool_command(input: &serde_json::Map<String, Value>) -> &str {
    let arguments = input.get("arguments").and_then(Value::as_object);
    [
        input.get("command"),
        input.get("cmd"),
        arguments.and_then(|a| a.get("command")),
        arguments.and_then(|a| a.get("cmd")),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .unwrap_or("")
}

fn push_tool_target(targets: &mut Vec<String>, seen: &mut HashSet<String>, value: &str) {
    if targets.len() >= TOOL_TARGET_CAP {
        return;
    }
    let candidate = value.trim_matches(|char: char| !char.is_ascii_hexdigit() && char != '-');
    if valid_tool_target(candidate) {
        let normalized = candidate.to_ascii_lowercase();
        if seen.insert(normalized.clone()) {
            targets.push(normalized);
        }
    }
}

fn marker_tool_targets(
    text: &str,
    resource: &str,
    targets: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    let marker = if resource == "runs" {
        "[orx-run:"
    } else {
        "[orx-experiment:"
    };
    for line in text.lines() {
        if targets.len() >= TOOL_TARGET_CAP {
            break;
        }
        let trimmed = line.trim();
        if let Some(start) = trimmed.find(marker) {
            if let Some(value) = trimmed[start + marker.len()..].split(']').next() {
                push_tool_target(targets, seen, value);
            }
        }
    }
}

fn heuristic_tool_targets(
    text: &str,
    resource: &str,
    targets: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    let endpoint = format!("/{resource}/");
    for line in text.lines() {
        if targets.len() >= TOOL_TARGET_CAP {
            break;
        }
        let trimmed = line.trim();
        if let Some(start) = trimmed.find(&endpoint) {
            if let Some(value) = trimmed[start + endpoint.len()..]
                .split(|char: char| !char.is_ascii_hexdigit() && char != '-')
                .next()
            {
                push_tool_target(targets, seen, value);
            }
        }
        if resource == "runs" {
            let lower = trimmed.to_ascii_lowercase();
            if let Some(value) = lower.strip_prefix("run id:") {
                push_tool_target(targets, seen, value);
            }
        } else if let Some(value) = trimmed.strip_prefix("id:") {
            push_tool_target(targets, seen, value);
        }
    }
}

fn strip_tool_target_markers(text: &mut String) {
    if !text.contains("[orx-") {
        return;
    }
    let filtered = text
        .split_inclusive('\n')
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.starts_with("[orx-run:") || trimmed.starts_with("[orx-experiment:"))
                || !trimmed.ends_with(']')
        })
        .collect::<String>();
    *text = filtered;
}

fn preserve_tool_targets(state: &mut WireToolState) {
    let Some(input) = state.input.as_mut().and_then(Value::as_object_mut) else {
        return;
    };
    let normalized_command = tool_command(input)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let resource = if normalized_command.contains("orx logs") {
        "runs"
    } else if normalized_command.contains("orx exp status")
        || normalized_command.contains("orx exp desc")
    {
        "experiments"
    } else {
        return;
    };
    let key = if resource == "runs" {
        "runTargetIds"
    } else {
        "experimentTargetIds"
    };
    let authority_key = format!("{key}Authoritative");
    let texts = [state.output.as_deref(), state.error.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    let mut marker_targets = Vec::new();
    let mut marker_seen = HashSet::new();
    for text in &texts {
        for window in bounded_tool_scan_windows(text) {
            marker_tool_targets(window, resource, &mut marker_targets, &mut marker_seen);
        }
    }
    let previously_authoritative = input
        .get(&authority_key)
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let authoritative = !marker_targets.is_empty() || previously_authoritative;
    let existing = input
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(TOOL_TARGET_INSPECTION_CAP)
        .collect::<Vec<_>>();
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    if !marker_targets.is_empty() {
        if previously_authoritative {
            for target in existing {
                push_tool_target(&mut targets, &mut seen, target);
            }
        }
        for target in marker_targets {
            push_tool_target(&mut targets, &mut seen, &target);
        }
    } else {
        for target in existing {
            push_tool_target(&mut targets, &mut seen, target);
        }
        if !authoritative {
            for text in &texts {
                for window in bounded_tool_scan_windows(text) {
                    heuristic_tool_targets(window, resource, &mut targets, &mut seen);
                }
            }
        }
    }
    if !targets.is_empty() {
        input.insert(key.into(), json!(targets));
    }
    if authoritative {
        input.insert(authority_key, Value::Bool(true));
    }
    if let Some(legacy) = input.get("targetIds").and_then(Value::as_array) {
        let mut normalized = Vec::new();
        let mut legacy_seen = HashSet::new();
        for target in legacy
            .iter()
            .take(TOOL_TARGET_INSPECTION_CAP)
            .filter_map(Value::as_str)
        {
            push_tool_target(&mut normalized, &mut legacy_seen, target);
        }
        input.insert("targetIds".into(), json!(normalized));
    }
    if let Some(output) = state.output.as_mut() {
        cap_tool_text(output);
    }
    if let Some(error) = state.error.as_mut() {
        cap_tool_text(error);
    }
    if let Some(output) = state.output.as_mut() {
        strip_tool_target_markers(output);
    }
    if let Some(error) = state.error.as_mut() {
        strip_tool_target_markers(error);
    }
}

fn safe_session_name(session_id: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(session_id.len() * 2);
    for byte in session_id.as_bytes() {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn target_event_path(session_id: &str, message_id: &str) -> PathBuf {
    let safe = safe_session_name(session_id);
    let message = safe_session_name(message_id);
    crate::store::data_dir()
        .join("chat-targets")
        .join(format!("{safe}-{message}.events"))
}

fn target_event_pointer(session_id: &str) -> PathBuf {
    crate::store::data_dir()
        .join("chat-targets")
        .join(format!("{}.current", safe_session_name(session_id)))
}

fn shell_hook_dir(session_id: &str) -> PathBuf {
    crate::store::data_dir()
        .join("chat-shell")
        .join(safe_session_name(session_id))
}

fn target_event_start(session_id: &str, message_id: &str) -> (PathBuf, u64) {
    let path = target_event_path(session_id, message_id);
    let _ = std::fs::remove_file(&path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::File::create(&path);
    let _ = std::fs::write(
        target_event_pointer(session_id),
        path.to_string_lossy().as_bytes(),
    );
    (path, 0)
}

pub fn record_chat_target(resource: &str, target: &str) {
    let Some(path) = std::env::var_os(CHAT_TARGET_FILE_ENV).map(PathBuf::from) else {
        return;
    };
    if !matches!(resource, "runs" | "experiments") || !valid_tool_target(target) {
        return;
    }
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    if let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(path)
    {
        let scope = std::env::var("ORX_CHAT_TOOL_SCOPE").unwrap_or_default();
        let command = std::env::var("ORX_CHAT_TOOL_COMMAND").unwrap_or_default();
        let cwd = std::env::current_dir()
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();
        let event = json!({
            "scope": scope.to_string(),
            "command": command,
            "cwd": cwd,
            "resource": resource,
            "target": target,
        });
        if let Ok(mut encoded) = serde_json::to_vec(&event) {
            encoded.push(b'\n');
            let mut lock = fd_lock::RwLock::new(file);
            if let Ok(mut guard) = lock.write() {
                let _ = guard.write_all(&encoded);
            };
        }
    }
}

fn target_command_matches(command: &str, command_hint: &str, resource: &str) -> bool {
    let resource_matches = if resource == "runs" {
        command.contains("orx logs")
    } else {
        command.contains("orx exp status") || command.contains("orx exp desc")
    };
    resource_matches
        && (command_hint.is_empty()
            || command.contains(command_hint)
            || command_hint.contains(command))
}

fn target_candidates(
    parts: &[WirePart],
    command_hint: &str,
    resource: &str,
    candidates: &mut Vec<(String, String, Option<String>)>,
) {
    for part in parts.iter().rev() {
        target_candidates(&part.children, command_hint, resource, candidates);
        let Some(input) = part
            .state
            .as_ref()
            .and_then(|state| state.input.as_ref())
            .and_then(Value::as_object)
        else {
            continue;
        };
        let command = tool_command(input)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        if target_command_matches(&command, command_hint, resource) {
            let cwd = input
                .get("cwd")
                .or_else(|| input.get("workdir"))
                .and_then(Value::as_str)
                .map(str::to_string);
            candidates.push((part.id.clone(), command, cwd));
        }
    }
}

fn attach_target_to_ids(
    parts: &mut [WirePart],
    part_ids: &HashSet<String>,
    resource: &str,
    target: &str,
) {
    for part in parts {
        attach_target_to_ids(&mut part.children, part_ids, resource, target);
        if !part_ids.contains(&part.id) {
            continue;
        }
        let Some(input) = part
            .state
            .as_mut()
            .and_then(|state| state.input.as_mut())
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        let key = if resource == "runs" {
            "runTargetIds"
        } else {
            "experimentTargetIds"
        };
        let mut targets = input
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(TOOL_TARGET_INSPECTION_CAP)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let mut seen = targets
            .iter()
            .map(|value| value.to_ascii_lowercase())
            .collect();
        push_tool_target(&mut targets, &mut seen, target);
        input.insert(key.into(), json!(targets));
        input.insert(format!("{key}Authoritative"), Value::Bool(true));
    }
}

fn attach_target_event(
    parts: &mut [WirePart],
    bound_part_ids: Option<&[String]>,
    claimed_part_ids: &HashSet<String>,
    command_hint: &str,
    cwd_hint: &str,
    resource: &str,
    target: &str,
) -> Vec<String> {
    let ids = if let Some(bound) = bound_part_ids {
        bound.iter().cloned().collect::<HashSet<_>>()
    } else {
        let normalized_hint = command_hint
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        let mut candidates = Vec::new();
        target_candidates(parts, &normalized_hint, resource, &mut candidates);
        if !cwd_hint.is_empty()
            && candidates
                .iter()
                .any(|(_, _, cwd)| cwd.as_deref() == Some(cwd_hint))
        {
            candidates.retain(|(_, _, cwd)| cwd.as_deref() == Some(cwd_hint));
        }
        candidates.retain(|(id, _, _)| !claimed_part_ids.contains(id));
        let Some((_, selected_command, _)) = candidates.first() else {
            return Vec::new();
        };
        let selected_command = selected_command.clone();
        let ids = candidates
            .into_iter()
            .filter(|(_, command, _)| command == &selected_command)
            .map(|(id, _, _)| id)
            .collect::<HashSet<_>>();
        if ids.len() != 1 {
            return Vec::new();
        }
        ids
    };
    attach_target_to_ids(parts, &ids, resource, target);
    ids.into_iter().collect()
}

fn reconcile_target_file(session_id: &str, message_id: &str) -> Option<WireMessage> {
    let path = target_event_path(session_id, message_id);
    let mut contents = String::new();
    if let Ok(file) = std::fs::File::open(&path) {
        let _ = file
            .take(TOOL_TARGET_SCAN_BYTES as u64)
            .read_to_string(&mut contents);
    }
    let Ok(store) = Store::open() else {
        return None;
    };
    let Ok(messages) = store.list_chat_messages(session_id) else {
        return None;
    };
    let stored = messages.iter().find(|message| message.id == message_id)?;
    let mut message = stored_to_wire(stored);
    let mut bindings = HashMap::new();
    let mut claimed = HashSet::new();
    for line in contents.lines().take(TOOL_TARGET_INSPECTION_CAP) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let (Some(scope), Some(command), Some(resource), Some(target)) = (
            event.get("scope").and_then(Value::as_str),
            event.get("command").and_then(Value::as_str),
            event.get("resource").and_then(Value::as_str),
            event.get("target").and_then(Value::as_str),
        ) else {
            continue;
        };
        let cwd = event.get("cwd").and_then(Value::as_str).unwrap_or_default();
        let bound = bindings.get(scope).map(Vec::as_slice);
        let part_ids = attach_target_event(
            &mut message.parts,
            bound,
            &claimed,
            command,
            cwd,
            resource,
            target,
        );
        if part_ids.is_empty() {
            continue;
        }
        bindings
            .entry(scope.to_string())
            .or_insert_with(|| part_ids.clone());
        claimed.extend(part_ids);
    }
    settle_interrupted_tool_parts(&mut message.parts);
    if store
        .upsert_chat_message(&StoredChatMessage {
            id: message.id.clone(),
            session_id: session_id.to_string(),
            role: message.role.clone(),
            parts_json: serde_json::to_string(&message.parts).unwrap_or_default(),
            created_at: message.created_at,
        })
        .is_err()
    {
        return None;
    }
    let _ = std::fs::remove_file(path);
    remove_target_pointer_if_matches(session_id, message_id);
    Some(message)
}

fn settle_interrupted_tool_parts(parts: &mut [WirePart]) {
    for part in parts {
        settle_interrupted_tool_parts(&mut part.children);
        if let Some(state) = part.state.as_mut() {
            if state.status == "running" {
                state.status = "interrupted".into();
            }
        }
    }
}

fn remove_target_pointer_if_matches(session_id: &str, message_id: &str) {
    let pointer = target_event_pointer(session_id);
    let expected = target_event_path(session_id, message_id);
    if std::fs::read_to_string(&pointer)
        .ok()
        .is_some_and(|path| PathBuf::from(path) == expected)
    {
        let _ = std::fs::remove_file(pointer);
    }
}

pub fn cleanup_session_transcript_artifacts(session_id: &str) {
    let directory = crate::store::data_dir().join("chat-targets");
    let prefix = format!("{}-", safe_session_name(session_id));
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with(&prefix) && name.ends_with(".events") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let _ = std::fs::remove_file(target_event_pointer(session_id));
    let _ = std::fs::remove_dir_all(shell_hook_dir(session_id));
}

/// Find a part by id anywhere in the tree (depth-first), returning `&mut` to it.
/// Shared by the harnesses that route sub-agent events into a spawn part's
/// `children`.
pub fn find_part_mut<'a>(parts: &'a mut [WirePart], id: &str) -> Option<&'a mut WirePart> {
    for part in parts.iter_mut() {
        if part.id == id {
            return Some(part);
        }
        if let Some(found) = find_part_mut(&mut part.children, id) {
            return Some(found);
        }
    }
    None
}

/// Upsert by id, carrying forward the existing part's `children`. Used for spawn
/// parts: a fresh build has empty children, but the sub-agent transcript already
/// streamed into the on-transcript part — replacing the whole part would drop it.
/// Non-spawn parts have no children, so this is equivalent to a plain upsert.
pub fn upsert_preserving_children(parts: &mut Vec<WirePart>, mut part: WirePart) {
    match parts.iter_mut().find(|p| p.id == part.id) {
        Some(existing) => {
            if part.children.is_empty() {
                part.children = std::mem::take(&mut existing.children);
            }
            if let (Some(incoming), Some(previous)) = (part.state.as_mut(), existing.state.as_ref())
            {
                if let (Some(incoming_input), Some(previous_input)) =
                    (incoming.input.as_mut(), previous.input.as_ref())
                {
                    for key in [
                        "runTargetIds",
                        "runTargetIdsAuthoritative",
                        "experimentTargetIds",
                        "experimentTargetIdsAuthoritative",
                        "targetIds",
                    ] {
                        if incoming_input.get(key).is_none() {
                            if let Some(value) = previous_input.get(key) {
                                incoming_input[key] = value.clone();
                            }
                        }
                    }
                }
            }
            *existing = part;
        }
        None => parts.push(part),
    }
}

/// Bound every live tool part's `output`/`error` before persistence. The
/// head-and-tail cap keeps accepting new tail output without growing memory.
fn cap_tool_parts(parts: &mut [WirePart]) {
    for part in parts.iter_mut() {
        if let Some(state) = part.state.as_mut() {
            preserve_tool_targets(state);
            if let Some(output) = state.output.as_mut() {
                cap_tool_text(output);
            }
            if let Some(error) = state.error.as_mut() {
                cap_tool_text(error);
            }
        }
        cap_tool_parts(&mut part.children);
    }
}

fn tool_state_signature(parts: &[WirePart]) -> Vec<(String, String)> {
    fn collect(parts: &[WirePart], parent: &str, states: &mut Vec<(String, String)>) {
        for part in parts {
            let path = if parent.is_empty() {
                part.id.clone()
            } else {
                format!("{parent}/{}", part.id)
            };
            if let Some(state) = &part.state {
                states.push((path.clone(), state.status.clone()));
            }
            collect(&part.children, &path, states);
        }
    }

    let mut states = Vec::new();
    collect(parts, "", &mut states);
    states
}

/// How long a bridge approval card may sit unanswered before it's denied and
/// the turn continues. Kept under the `MCP_TOOL_TIMEOUT` the claude child runs
/// with (60 min — see `harness::claude`), so orx answers before the CLI gives
/// up on the tool call.
const BRIDGE_ANSWER_TIMEOUT: Duration = Duration::from_secs(55 * 60);

// --- wire types (what the UI renders) ---------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireToolState {
    pub status: String, // running | completed | error
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// One option in an AskUserQuestion prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireQuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// An interactive request the user must act on before the harness continues.
/// The three kinds (`plan` / `permission` / `question`) originated with Claude
/// Code's ExitPlanMode / permission_denials / AskUserQuestion, but `permission`
/// and `question` are now shared: OpenCode emits them from its serve
/// `permission.asked` / `question.asked` events (see `harness/opencode.rs`),
/// and Codex emits `question` from `item/tool/requestUserInput`. `plan` is
/// Claude + Codex, each via its own mechanism (ExitPlanMode vs the end-turn
/// card synthesized from a collaboration-mode `plan` item — see
/// `harness/codex.rs`).
///
/// How the answer flows back is per-harness (see [`crate::local::harness::ResumeAction`]):
/// Claude ends its turn and resumes with a new message; OpenCode is paused
/// mid-turn and the answer is replied inline over the live serve session — which
/// is what `native_id` is for. The UI renders a card either way.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePrompt {
    /// `plan` | `permission` | `question`.
    pub kind: String,
    /// Whether this prompt has been answered (resolved permission cards
    /// vanish; resolved plan/question cards collapse to a one-line row).
    #[serde(default)]
    pub resolved: bool,
    /// plan: the proposed plan markdown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// plan: true when the harness synthesized this card from the turn's final
    /// text because the model never called ExitPlanMode. The approval flow is
    /// identical; the UI just softens the framing ("ready to proceed?" instead
    /// of "proposed plan").
    #[serde(default)]
    pub synthesized: bool,
    /// permission: the tool the harness was blocked from using, + its input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<Value>,
    /// question: the prompt text + selectable options.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub options: Vec<WireQuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
    /// The harness-native id used to reply over a live protocol (opencode's
    /// permission/question request id, the Claude bridge's held request id).
    /// The backend resume path routes on it; the UI reads only its *presence*
    /// (a held mid-turn card — the turn is blocked on this answer) and echoes
    /// the `WirePart` id when answering. `None` for end-turn cards, which
    /// resume by message, not by reply id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    /// Answer echo, stamped when the user resolves the card so the collapsed
    /// rendering can show the outcome (and it survives a reload):
    /// questions record the chosen labels, plan/permission whether it was
    /// approved, and any freeform note rides along. Absent on cards resolved
    /// without an answer (stale-card cleanup, cancelled bridge requests).
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub answers: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePart {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String, // text | reasoning | tool | prompt
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<WireToolState>,
    /// Present only on `prompt` parts — the interactive request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<WirePrompt>,
    /// Nested parts belonging to a sub-agent this part spawned (Codex
    /// collaboration). A spawn part streams the sub-agent's own transcript here;
    /// arbitrary depth for sub-agents that spawn their own. `default` +
    /// `skip_serializing_if` keeps old `parts_json` rows and childless parts
    /// byte-identical on the wire — no migration.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<WirePart>,
}

impl WirePart {
    pub fn text(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind: "text".into(),
            text: Some(text.into()),
            tool: None,
            state: None,
            prompt: None,
            children: Vec::new(),
        }
    }

    pub fn reasoning(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            kind: "reasoning".into(),
            ..Self::text(id, text)
        }
    }

    /// `text` holds the attachment file name (served via /api/chat/attachments).
    pub fn image(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            kind: "image".into(),
            ..Self::text(id, name)
        }
    }

    /// A synthetic tool part — a status row (`error`, `interrupted`, …) that
    /// isn't a real tool call. The UI renders it through the same tool-row path
    /// as harness tools.
    pub fn tool(
        id: impl Into<String>,
        tool: impl Into<String>,
        status: impl Into<String>,
        error: Option<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind: "tool".into(),
            text: None,
            tool: Some(tool.into()),
            state: Some(WireToolState {
                status: status.into(),
                input: None,
                output: None,
                error,
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        }
    }

    /// An interactive prompt part (plan / permission / question).
    pub fn prompt(id: impl Into<String>, prompt: WirePrompt) -> Self {
        Self {
            id: id.into(),
            kind: "prompt".into(),
            text: None,
            tool: None,
            state: None,
            prompt: Some(prompt),
            children: Vec::new(),
        }
    }
}

// --- image attachments ---------------------------------------------------------

/// A pasted image or uploaded file riding the send-message request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub media_type: String,
    pub data_base64: String,
    /// Original file name (uploads/drops); pasted images carry none.
    #[serde(default)]
    pub name: Option<String>,
}

/// An attachment written to disk, ready to hand the harness by path.
pub struct SavedAttachment {
    /// Server-minted file name, served via /api/chat/attachments.
    pub file_name: String,
    pub path: std::path::PathBuf,
    /// Human-readable name shown in the transcript and told to the agent.
    pub display_name: String,
    pub is_pdf: bool,
}

pub fn attachments_dir() -> Result<std::path::PathBuf> {
    let dir = crate::store::data_dir().join("chat-attachments");
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow!("Could not create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn image_ext(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

pub fn attachment_content_type(name: &str) -> &'static str {
    match name.rsplit('.').next() {
        Some("png") => "image/png",
        Some("jpg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Sanitize an original file name into the `<name>.<ext>` form embedded in the
/// server-minted attachment file name — ASCII alnum / `-` / `_` only (the set
/// the attachment route allows), canonical extension, no dots in the stem so
/// the result can never contain a `..` traversal sequence.
fn safe_attachment_name(original: Option<&str>, ext: &str) -> String {
    let base = original
        .map(|n| n.rsplit(['/', '\\']).next().unwrap_or(n))
        .and_then(|b| b.rsplit_once('.').map(|(stem, _)| stem).or(Some(b)))
        .unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let mut safe = cleaned
        .trim_matches('-')
        .chars()
        .take(60)
        .collect::<String>();
    if safe.is_empty() {
        safe = if ext == "pdf" {
            "document".into()
        } else {
            "image".into()
        };
    }
    format!("{safe}.{ext}")
}

/// Decode pasted/uploaded attachments to the attachments dir. The original file
/// name (when present) is preserved after a `__` marker so the transcript and the
/// agent see a meaningful name; the uuid prefix keeps names collision-free.
fn save_images(images: &[ImageAttachment]) -> Result<Vec<SavedAttachment>> {
    if images.is_empty() {
        return Ok(Vec::new());
    }
    let dir = attachments_dir()?;
    let mut saved = Vec::new();
    for img in images {
        let ext = image_ext(&img.media_type)
            .ok_or_else(|| anyhow!("unsupported attachment type: {}", img.media_type))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(img.data_base64.as_bytes())
            .map_err(|e| anyhow!("bad attachment data: {e}"))?;
        let safe = safe_attachment_name(img.name.as_deref(), ext);
        let file_name = format!("att-{}__{safe}", uuid::Uuid::new_v4());
        let path = dir.join(&file_name);
        std::fs::write(&path, bytes)
            .map_err(|e| anyhow!("Could not write {}: {}", path.display(), e))?;
        // Original basename, minus control chars so it can't break out of the
        // <attached-files> block it's injected into; falls back to the safe name.
        let display_name = img
            .name
            .as_deref()
            .map(|n| n.rsplit(['/', '\\']).next().unwrap_or(n))
            .map(|n| n.chars().filter(|c| !c.is_control()).collect::<String>())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| safe.clone());
        saved.push(SavedAttachment {
            file_name,
            path,
            display_name,
            is_pdf: ext == "pdf",
        });
    }
    Ok(saved)
}

/// How much of the model's context window a session has consumed, measured off
/// the most recent API request the harness reported. Latest report wins (not
/// cumulative), so auto-compaction naturally drops the number.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    /// Tokens occupying the context window after the most recent API request
    /// (input + cache read + cache write + output of that request).
    pub used_tokens: u64,
    /// Total context window of the model, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireMessage {
    pub id: String,
    pub role: String,
    pub parts: Vec<WirePart>,
    pub created_at: i64,
}

pub fn session_json(s: &StoredChatSession, busy: bool) -> Value {
    let context_usage = s
        .context_usage_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<Value>(j).ok());
    json!({
        "id": s.id,
        "projectId": s.project_id,
        "harness": s.harness,
        "title": s.title,
        // The UI animates the reveal of a harness-generated title, so it needs
        // to tell one from a placeholder or a user rename.
        "titleSource": s.title_source,
        "model": s.model,
        "permissionMode": s.permission_mode,
        "reasoningLevel": s.reasoning_level,
        "archived": s.archived,
        "createdAt": s.created_at,
        "updatedAt": s.updated_at,
        "busy": busy,
        "contextUsage": context_usage,
    })
}

fn message_json(m: &WireMessage, session_id: &str) -> Value {
    json!({ "sessionId": session_id, "message": m })
}

fn stored_to_wire(m: &StoredChatMessage) -> WireMessage {
    let mut message = WireMessage {
        id: m.id.clone(),
        role: m.role.clone(),
        parts: serde_json::from_str(&m.parts_json).unwrap_or_default(),
        created_at: m.created_at,
    };
    cap_tool_parts(&mut message.parts);
    message
}

fn is_initial_chat_message(transcript_text: Option<&str>, has_messages: bool) -> bool {
    transcript_text.is_none() && !has_messages
}

fn with_bootstrap_context(
    native_session_id: Option<&str>,
    bootstrap_context: Option<&str>,
    text: String,
) -> String {
    match (native_session_id, bootstrap_context) {
        (None, Some(context)) => {
            format!("{context}\n\n<current-user-message>\n{text}\n</current-user-message>")
        }
        _ => text,
    }
}

#[cfg(test)]
mod initial_message_tests {
    use super::{is_initial_chat_message, with_bootstrap_context};

    #[test]
    fn only_the_first_ordinary_message_starts_a_chat_session() {
        assert!(is_initial_chat_message(None, false));
        assert!(!is_initial_chat_message(None, true));
        assert!(!is_initial_chat_message(Some("resume"), false));
    }

    #[test]
    fn bootstrap_context_is_injected_only_before_a_native_session_exists() {
        let seeded = with_bootstrap_context(None, Some("prior demo"), "continue".into());
        assert!(seeded.contains("prior demo"));
        assert!(seeded.contains("<current-user-message>\ncontinue"));
        assert_eq!(
            with_bootstrap_context(Some("native"), Some("prior demo"), "continue".into()),
            "continue"
        );
        assert_eq!(
            with_bootstrap_context(None, None, "continue".into()),
            "continue"
        );
    }
}

// --- permission bridge ---------------------------------------------------------

/// The decision returned to the `orx mcp-gate` permission bridge for one
/// blocked tool call. Serialized verbatim into Claude Code's
/// permission-prompt-tool contract (the bridge stringifies it into the MCP
/// tool result), so the wire shape is exactly
/// `{"behavior":"allow","updatedInput":{…}}` / `{"behavior":"deny","message":"…"}`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "behavior", rename_all = "lowercase")]
pub enum PermissionDecision {
    Allow {
        /// The (possibly rewritten) tool input. The contract requires it on an
        /// allow; we echo the original input.
        #[serde(rename = "updatedInput", skip_serializing_if = "Option::is_none")]
        updated_input: Option<Value>,
    },
    Deny {
        message: String,
    },
}

impl PermissionDecision {
    fn deny(message: impl Into<String>) -> Self {
        Self::Deny {
            message: message.into(),
        }
    }
}

/// One outstanding bridge request: the oneshot unblocks the long-poll handler
/// in `request_permission` (and thereby the `orx mcp-gate` HTTP call and the
/// claude turn behind it).
struct PendingPermission {
    session_id: String,
    tx: tokio::sync::oneshot::Sender<PermissionDecision>,
}

/// The card-less tier of plan-mode permission policy: `Some(decision)` where
/// the answer is unambiguous, `None` where the user must decide (a card).
///
/// Read-only Bash allows — the PreToolUse hook normally short-circuits these
/// before the permission tool ever fires; this keeps behavior right if the
/// hook wasn't wired. WebFetch/WebSearch are read-only research that plan mode
/// denies natively (verified on claude 2.1.197) — exactly what planning needs,
/// so allow. File edits DENY: with a permission tool configured the CLI
/// *delegates* plan mode's edit block to it (verified: an allow here creates
/// files mid-plan), so this branch IS the plan-mode safety, not dead defense.
fn plan_auto_policy(tool_name: &str, tool_input: &Value) -> Option<PermissionDecision> {
    if tool_name == "Bash" {
        let readonly = tool_input
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(crate::local::harness::command_is_readonly);
        if readonly {
            return Some(PermissionDecision::Allow {
                updated_input: Some(tool_input.clone()),
            });
        }
        // A non-read-only Bash command is the user's call — card.
        return None;
    }
    match tool_name {
        "WebFetch" | "WebSearch" => Some(PermissionDecision::Allow {
            updated_input: Some(tool_input.clone()),
        }),
        "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => Some(PermissionDecision::deny(
            "File edits are blocked in plan mode. Present your plan with the \
             ExitPlanMode tool so the user can approve it before implementation.",
        )),
        _ => None,
    }
}

/// Cleanup for one bridge request, running on *every* exit from
/// `request_permission` — answered, timed out, or the handler future dropped
/// mid-await (the HTTP connection died with the claude child). Removes the
/// pending entry and resolves the card so it can't be answered into the void.
/// Re-resolving an already-answered card is a no-op (`mark_prompt_resolved`
/// skips it) so this late pass can't shadow an echo-stamped broadcast.
struct PendingGuard {
    host: Arc<ChatHost>,
    session_id: String,
    prompt_id: String,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.host
            .pending_permissions
            .lock()
            .unwrap()
            .remove(&self.prompt_id);
        if let Ok(Some(msg)) = mark_prompt_resolved(
            &self.host.msg_write,
            &self.session_id,
            &self.prompt_id,
            None,
        ) {
            self.host
                .emit("chat.message", message_json(&msg, &self.session_id));
        }
    }
}

// --- host --------------------------------------------------------------------

/// Owns turn tasks and the chat event stream. One per `orx up` process.
pub struct ChatHost {
    /// Lazy opencode serve manager (only the opencode adapter spawns it).
    pub opencode: Arc<AgentHost>,
    /// Lazy codex app-server manager (only the codex adapter spawns it).
    pub codex: Arc<crate::local::codex::CodexHost>,
    /// Persistent Claude Code child manager (one resident child per session;
    /// only the claude adapter spawns it).
    pub claude: Arc<crate::local::claude::ClaudeHost>,
    http: reqwest::Client,
    events: broadcast::Sender<(&'static str, Value)>,
    /// Sessions with a turn reserved, running, or settling after interruption.
    /// A key remains present throughout the lifecycle, so a replacement turn
    /// cannot race native shutdown for the preceding one.
    turns: Mutex<HashMap<String, TurnState>>,
    deleting_sessions: Arc<std::sync::Mutex<HashSet<String>>>,
    /// Per-session serialization for `respond`. Answering a prompt reads the
    /// card, delivers the answer (a non-idempotent POST for inline harnesses),
    /// and marks it resolved — steps that must not interleave for one session,
    /// or a double-submit could fire the reply twice. Held only for the brief
    /// `respond` critical section; keyed per session so different sessions don't
    /// contend. (The busy `turns` slot can't gate this: an inline harness is
    /// *deliberately* busy while paused on the prompt.)
    respond_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Guards the read-modify-write of a chat message's `parts_json` blob so two
    /// writers can't lost-update each other. The dangerous pair: a still-running
    /// opencode turn's `flush` (which carries a concurrently-resolved card's flag
    /// forward via `adopt_resolved_prompts`) vs `respond`'s `mark_prompt_resolved`
    /// — both do read→modify→write on the *same* message, and SQLite's WAL
    /// serializes the writes but not the logical transaction. A single process-
    /// wide sync mutex (writes are brief and already WAL-serialized, so this adds
    /// no real contention) makes each RMW atomic. Sync because `flush` is sync;
    /// never held across an `.await`.
    msg_write: std::sync::Mutex<()>,
    /// Outstanding permission-bridge requests, keyed by the prompt part id the
    /// card was surfaced under. Sync mutex, never held across an await.
    pending_permissions: std::sync::Mutex<HashMap<String, PendingPermission>>,
    /// Per-session bridge token, minted once per plan-mode child spawn (the
    /// resident bridge carries it for the child's whole life — re-minting
    /// mid-child would strand it). The rest of the localhost API is
    /// unauthenticated, but this endpoint *grants tool permissions*, so the
    /// bridge must echo the token its child was spawned with.
    gate_tokens: std::sync::Mutex<HashMap<String, String>>,
    /// Sessions whose running turn surfaced a bridge card — checked (and
    /// cleared) by the synthesized-plan-card fallback so it never double-cards
    /// a turn the bridge already carded.
    bridge_prompted: std::sync::Mutex<HashSet<String>>,
    /// The port `orx up` bound, for the bridge env contract.
    up_port: std::sync::OnceLock<u16>,
    /// Messages the user sent while the session's turn was in flight, oldest
    /// first. `drain_queue` runs the front one when a turn finishes naturally;
    /// a user Stop clears the whole queue. In-memory and uncommitted — a queued
    /// message only becomes a transcript bubble once it actually runs.
    queued: std::sync::Mutex<HashMap<String, VecDeque<QueuedMessage>>>,
}

struct ActiveTurn {
    handle: tokio::task::JoinHandle<()>,
    message_id: String,
}

enum TurnState {
    Reserved,
    Active(ActiveTurn),
    Cancelling,
}

/// A user message parked while the session was busy, replayed verbatim through
/// the normal send path once the running turn ends.
#[derive(Clone)]
struct QueuedMessage {
    id: String,
    text: String,
    overrides: TurnOverrides,
    images: Vec<ImageAttachment>,
}

/// Chip label for a parked message: its text, or an attachment count for an
/// image/file-only send (which carries no text to show).
fn queued_label(m: &QueuedMessage) -> String {
    if !m.text.trim().is_empty() || m.images.is_empty() {
        return m.text.clone();
    }
    let n = m.images.len();
    format!("{n} attachment{}", if n == 1 { "" } else { "s" })
}

/// Reserves a session's turn slot for the duration of `send_message`'s setup.
/// `claim` inserts a `None` reservation under the `turns` lock iff the session
/// isn't already busy — closing the check-then-insert race. On drop (early
/// error / panic) it clears the reservation; call `defuse` once the real abort
/// handle has replaced it so the running turn's slot survives.
struct TurnGuard {
    host: Arc<ChatHost>,
    session_id: String,
    armed: bool,
}

pub struct SessionDeletionLease {
    deleting: Arc<std::sync::Mutex<HashSet<String>>>,
    session_id: String,
}

impl Drop for SessionDeletionLease {
    fn drop(&mut self) {
        self.deleting.lock().unwrap().remove(&self.session_id);
    }
}

impl TurnGuard {
    /// `Some` if the slot was free and is now reserved; `None` if already busy.
    async fn claim(host: &Arc<ChatHost>, session_id: &str) -> Option<Self> {
        if host.deleting_sessions.lock().unwrap().contains(session_id) {
            return None;
        }
        let mut turns = host.turns.lock().await;
        if host.deleting_sessions.lock().unwrap().contains(session_id)
            || turns.contains_key(session_id)
        {
            return None;
        }
        turns.insert(session_id.to_string(), TurnState::Reserved);
        Some(Self {
            host: host.clone(),
            session_id: session_id.to_string(),
            armed: true,
        })
    }

    /// Hand ownership of the slot to the spawned turn — stop clearing it on drop.
    fn defuse(mut self) {
        self.armed = false;
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // Setup failed before a turn was spawned: release the reservation. Only
        // remove if it's still the unspawned reservation (None), never a live
        // handle (some other path may have taken over).
        //
        // `try_lock` is safe here rather than a leak risk: an armed guard only
        // drops on an early return from send_message's prologue, which never
        // holds the `turns` lock (claim releases it immediately, and it's only
        // re-acquired at the final upgrade after the guard is defused). So the
        // lock is always free when an armed guard drops — the fallible lock can't
        // actually fail in this path.
        if let Ok(mut turns) = self.host.turns.try_lock() {
            if matches!(turns.get(&self.session_id), Some(TurnState::Reserved)) {
                turns.remove(&self.session_id);
            }
        }
    }
}

impl ChatHost {
    pub fn new(
        opencode: Arc<AgentHost>,
        codex: Arc<crate::local::codex::CodexHost>,
        claude: Arc<crate::local::claude::ClaudeHost>,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            opencode,
            codex,
            claude,
            http: reqwest::Client::new(),
            events,
            turns: Mutex::new(HashMap::new()),
            deleting_sessions: Arc::new(std::sync::Mutex::new(HashSet::new())),
            respond_locks: Mutex::new(HashMap::new()),
            msg_write: std::sync::Mutex::new(()),
            pending_permissions: std::sync::Mutex::new(HashMap::new()),
            gate_tokens: std::sync::Mutex::new(HashMap::new()),
            bridge_prompted: std::sync::Mutex::new(HashSet::new()),
            up_port: std::sync::OnceLock::new(),
            queued: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Record the port `orx up` bound (once, at startup) so plan-mode turns can
    /// hand it to the `orx mcp-gate` bridge.
    pub fn set_up_port(&self, port: u16) {
        let _ = self.up_port.set(port);
    }

    /// The bound `orx up` port, if this host runs under a server (None in
    /// contexts with no HTTP surface — the bridge is skipped there).
    pub fn up_port(&self) -> Option<u16> {
        self.up_port.get().copied()
    }

    /// Mint (and remember) the bridge token for a session's plan-mode child.
    /// One token per *child* now, minted at spawn (not per turn): the resident
    /// claude child — and its bridge — live across turns, so a live plan child
    /// keeps its token until a config-change/interrupt/crash respawn mints a new
    /// one. Overwriting on each mint is still correct (a respawn's old child is
    /// killed first), but the mint site moved to `claude::spawn_client`;
    /// re-minting while a plan child is live would strand its held bridge
    /// requests, since `request_permission` equality-checks the token with no
    /// expiry.
    pub fn mint_gate_token(&self, session_id: &str) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.gate_tokens
            .lock()
            .unwrap()
            .insert(session_id.to_string(), token.clone());
        token
    }

    /// Whether this session's running turn surfaced a bridge card — and clear
    /// the flag. Consulted by the synthesized-plan-card fallback at turn end.
    pub fn take_bridge_prompted(&self, session_id: &str) -> bool {
        self.bridge_prompted.lock().unwrap().remove(session_id)
    }

    /// Bridge entry point (`POST /api/internal/permissions`): decide one
    /// blocked tool call from a plan-mode turn. Auto-decides by policy where
    /// the answer is unambiguous; otherwise surfaces a card and **blocks until
    /// the user answers** (or the timeout denies) — the held HTTP response is
    /// what pauses the claude turn mid-flight.
    pub async fn request_permission(
        self: &Arc<Self>,
        session_id: &str,
        token: &str,
        tool_name: &str,
        tool_input: Value,
    ) -> Result<PermissionDecision> {
        // The endpoint grants tool permissions, so unlike the rest of the
        // localhost API it authenticates: the bridge must echo the token its
        // child was spawned with.
        let token_ok = self
            .gate_tokens
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|t| t == token);
        if !token_ok {
            return Err(anyhow!("unknown or stale gate token"));
        }
        // A bridge child that outlived its turn has nothing left to approve.
        if !self.is_busy(session_id).await {
            return Ok(PermissionDecision::deny(
                "the turn this approval belonged to has already ended",
            ));
        }

        // Tier 1 — policy decides, no card.
        if let Some(decision) = plan_auto_policy(tool_name, &tool_input) {
            return Ok(decision);
        }

        // Tier 2 — the user decides. ExitPlanMode becomes the plan card (the
        // hook routes it here with an "ask" so headless can't self-approve);
        // AskUserQuestion becomes the QUESTION card itself, held mid-turn —
        // gating it behind a permission card would be a pointless double
        // interaction, and *allowing* it is worse: headless the tool returns
        // no answer, so the model guesses and keeps going instead of blocking.
        // Holding the call is the only shape that actually blocks the turn on
        // the user's answer. Everything else — gray-area Bash, MCP tools, … —
        // a permission card.
        let prompt_id = format!("perm_{}", uuid::Uuid::new_v4());
        let prompt = if tool_name == "ExitPlanMode" {
            WirePrompt {
                kind: "plan".into(),
                plan: Some(
                    tool_input
                        .get("plan")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                ),
                native_id: Some(prompt_id.clone()),
                ..Default::default()
            }
        } else if let Some(question) =
            crate::local::harness::question_prompt(tool_name, Some(&tool_input))
                .filter(|q| !q.options.is_empty())
        {
            // Malformed question input — unparseable, or no options at all —
            // falls through to a permission card instead: options are the
            // question card's primary interface, and allow/deny on the raw
            // tool call is a saner fallback than an options-less card.
            WirePrompt {
                native_id: Some(prompt_id.clone()),
                ..question
            }
        } else {
            WirePrompt {
                kind: "permission".into(),
                tool: Some(tool_name.to_string()),
                tool_input: Some(tool_input),
                native_id: Some(prompt_id.clone()),
                ..Default::default()
            }
        };

        let is_question = prompt.kind == "question";
        // The card rides its own assistant message: the running turn owns its
        // in-flight message's parts (a foreign part appended there would be
        // clobbered by the turn's next flush).
        let msg = WireMessage {
            id: format!("msg_{prompt_id}"),
            role: "assistant".into(),
            parts: vec![WirePart::prompt(prompt_id.clone(), prompt)],
            created_at: now_ms(),
        };
        Store::open()?.upsert_chat_message(&StoredChatMessage {
            id: msg.id.clone(),
            session_id: session_id.to_string(),
            role: "assistant".into(),
            parts_json: serde_json::to_string(&msg.parts)?,
            created_at: msg.created_at,
        })?;
        self.emit("chat.message", message_json(&msg, session_id));
        // A question card answered mid-turn is NOT an exit recourse from plan
        // mode, so it must not count as "saw a prompt" — a turn that asks a
        // question and then ends with its plan as plain text still needs the
        // synthesized plan card. Plan/permission cards keep counting.
        if !is_question {
            self.bridge_prompted
                .lock()
                .unwrap()
                .insert(session_id.to_string());
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending_permissions.lock().unwrap().insert(
            prompt_id.clone(),
            PendingPermission {
                session_id: session_id.to_string(),
                tx,
            },
        );
        // Cleanup on every exit path — answered, timed out, or this handler
        // future dropped (HTTP connection died with the claude child): remove
        // the pending entry and resolve the card so it can't be answered into
        // the void.
        let _guard = PendingGuard {
            host: self.clone(),
            session_id: session_id.to_string(),
            prompt_id: prompt_id.clone(),
        };

        let decision = tokio::select! {
            d = rx => d.unwrap_or_else(|_| PermissionDecision::deny("the approval was cancelled")),
            _ = tokio::time::sleep(BRIDGE_ANSWER_TIMEOUT) => PermissionDecision::deny(
                "No one answered this approval within 55 minutes; treat it as denied \
                 and wrap up the turn cleanly.",
            ),
        };
        Ok(decision)
    }

    /// Settle a pending bridge request with the user's decision (the native
    /// resume path). Err if it's no longer pending — a stale card.
    pub fn settle_permission(&self, prompt_id: &str, decision: PermissionDecision) -> Result<()> {
        let pending = self
            .pending_permissions
            .lock()
            .unwrap()
            .remove(prompt_id)
            .ok_or_else(|| anyhow!("this approval is no longer pending"))?;
        // A dropped receiver means the request handler already died; its guard
        // is cleaning the card up, so a lost send is fine.
        let _ = pending.tx.send(decision);
        Ok(())
    }

    /// Whether a bridge approval card of this session is still awaiting the
    /// user. The claude turn watchdog consults this: a child held on the
    /// mcp-gate long-poll is silently blocked *by design* (user think-time is
    /// unbounded), so the no-output timeout must not kill it.
    pub fn has_pending_permission(&self, session_id: &str) -> bool {
        self.pending_permissions
            .lock()
            .unwrap()
            .values()
            .any(|p| p.session_id == session_id)
    }

    /// Deny-and-unblock every pending bridge request of a session. Called when
    /// its turn ends or is interrupted: the bridge child dies with the turn,
    /// and a card left pending would strand its long-poll forever.
    fn cancel_pending_permissions(&self, session_id: &str) {
        let drained: Vec<PendingPermission> = {
            let mut map = self.pending_permissions.lock().unwrap();
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter().filter_map(|id| map.remove(&id)).collect()
        };
        for pending in drained {
            let _ = pending
                .tx
                .send(PermissionDecision::deny("the turn was interrupted"));
        }
    }

    /// The per-session `respond` lock, created on first use. The map only grows
    /// (one small `Arc<Mutex>` per session ever answered) — negligible for a
    /// single `orx up` process's session count.
    async fn respond_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        self.respond_locks
            .lock()
            .await
            .entry(session_id.to_string())
            .or_default()
            .clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<(&'static str, Value)> {
        self.events.subscribe()
    }

    fn emit(&self, name: &'static str, data: Value) {
        let _ = self.events.send((name, data));
    }

    /// Publish an arbitrary named event onto the SSE broadcast that `/api/events`
    /// forwards. Used by non-chat features (e.g. the data-dir move) that want to
    /// stream progress to the UI without standing up a second channel.
    pub fn emit_event(&self, name: &'static str, data: Value) {
        self.emit(name, data);
    }

    /// Shut down both harness hosts' long-lived child processes. They respawn
    /// lazily on the next turn — used after a data-dir move so a child that
    /// captured the old path (Codex hard-pins `$ORX_DATA_DIR` at spawn) comes
    /// back resolving the new one.
    pub async fn shutdown_harnesses(&self) {
        self.opencode.shutdown().await;
        self.codex.shutdown().await;
        self.claude.shutdown().await;
    }

    pub async fn busy_sessions(&self) -> Vec<String> {
        self.turns.lock().await.keys().cloned().collect()
    }

    pub async fn is_busy(&self, session_id: &str) -> bool {
        self.turns.lock().await.contains_key(session_id)
    }

    pub fn begin_session_delete(&self, session_id: &str) -> Option<SessionDeletionLease> {
        let mut deleting = self.deleting_sessions.lock().unwrap();
        if !deleting.insert(session_id.to_string()) {
            return None;
        }
        Some(SessionDeletionLease {
            deleting: self.deleting_sessions.clone(),
            session_id: session_id.to_string(),
        })
    }

    /// The session's parked messages, oldest first — for the reload snapshot.
    pub fn queued_items(&self, session_id: &str) -> Vec<Value> {
        self.queued
            .lock()
            .unwrap()
            .get(session_id)
            .map(|q| {
                q.iter()
                    .map(|m| json!({ "id": m.id, "text": queued_label(m) }))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn queued_json(&self, session_id: &str) -> Value {
        json!({ "sessionId": session_id, "items": self.queued_items(session_id) })
    }

    fn emit_queued(&self, session_id: &str) {
        self.emit("chat.queued", self.queued_json(session_id));
    }

    /// Drop every parked message for a session (user Stop / delete). Emits an
    /// empty `chat.queued` only if there was something to clear.
    pub fn clear_queue(&self, session_id: &str) {
        let had = self
            .queued
            .lock()
            .unwrap()
            .remove(session_id)
            .is_some_and(|q| !q.is_empty());
        if had {
            self.emit_queued(session_id);
        }
    }

    /// Remove one parked message by id (the ✕ on a queued chip).
    pub fn cancel_queued(&self, session_id: &str, item_id: &str) -> bool {
        let removed = {
            let mut map = self.queued.lock().unwrap();
            let Some(q) = map.get_mut(session_id) else {
                return false;
            };
            let before = q.len();
            q.retain(|m| m.id != item_id);
            let removed = q.len() != before;
            if q.is_empty() {
                map.remove(session_id);
            }
            removed
        };
        if removed {
            self.emit_queued(session_id);
        }
        removed
    }

    /// Drain the whole parked queue into a single turn once the current turn
    /// finishes naturally — successive steering messages run together in one
    /// turn, not a full turn each. Boxed return: `drain_queue` →
    /// `send_message_showing` → (spawned) `drain_queue` is an async recursion
    /// cycle the auto-`Send` solver can't close on its own, so we assert the
    /// boxed future is `Send` to break it.
    fn drain_queue<'a>(
        self: &'a Arc<Self>,
        session_id: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            // Scope the guard: a std mutex must never be held across an await.
            let items: Vec<QueuedMessage> = {
                let mut map = self.queued.lock().unwrap();
                match map.remove(session_id) {
                    Some(q) => q.into(),
                    None => return,
                }
            };
            if items.is_empty() {
                return;
            }
            self.emit_queued(session_id);
            // Coalesce every parked message into one turn: join their texts and
            // concatenate their attachments; the most recent composer overrides win.
            let text = items
                .iter()
                .map(|m| m.text.trim())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let images: Vec<ImageAttachment> = items
                .iter()
                .flat_map(|m| m.images.iter().cloned())
                .collect();
            let overrides = items
                .last()
                .map(|m| m.overrides.clone())
                .unwrap_or_default();
            if let Err(err) = self
                .send_message_showing(session_id, text, None, overrides, images, false)
                .await
            {
                // Re-park only for the genuine race: a fresh send claimed the
                // slot in the gap after `finish_turn` freed it (session busy
                // again), so restore the messages up front and let that turn
                // drain them. Any other failure (a real setup error, or a session
                // being deleted) has no turn to retry against — drop them rather
                // than strand chips that re-fail on every future drain.
                if self.is_busy(session_id).await {
                    {
                        let mut map = self.queued.lock().unwrap();
                        let q = map.entry(session_id.to_string()).or_default();
                        for item in items.into_iter().rev() {
                            q.push_front(item);
                        }
                    }
                    self.emit_queued(session_id);
                } else {
                    eprintln!("orx up: dropped queued messages after send failure: {err}");
                }
            }
        })
    }

    /// Persist the user message and run one harness turn in the background.
    pub async fn send_message(
        self: &Arc<Self>,
        session_id: &str,
        text: String,
        overrides: TurnOverrides,
        images: Vec<ImageAttachment>,
    ) -> Result<()> {
        self.send_message_showing(session_id, text, None, overrides, images, true)
            .await
    }

    /// [`Self::send_message`] with the transcript/model split: `transcript_text`
    /// is what the stored transcript (and the UI) shows as the user message,
    /// while `text` is what the harness receives. `None` keeps them identical
    /// (every ordinary send); an empty override records no user message at all.
    /// Same precedent as slash-skills (transcript keeps the `/name` the user
    /// typed, the harness gets the expanded prompt) — used by prompt-card
    /// resumes, whose scaffolding text ("Implement the plan.") the user never
    /// typed.
    async fn send_message_showing(
        self: &Arc<Self>,
        session_id: &str,
        text: String,
        transcript_text: Option<String>,
        overrides: TurnOverrides,
        images: Vec<ImageAttachment>,
        queue_if_busy: bool,
    ) -> Result<()> {
        // Atomically claim the session's turn slot: the busy-check and the
        // reservation happen under one lock so two concurrent sends (or a
        // send racing a /respond resume) can't both spawn a turn against the
        // same session. `_guard` releases the reservation on any early error.
        let _guard = match TurnGuard::claim(self, session_id).await {
            Some(guard) => guard,
            // Busy: park a genuine user send (Claude-desktop steering) so it
            // runs when the turn ends, instead of rejecting it. System/resume
            // sends pass `queue_if_busy = false` and keep the old rejection.
            None if queue_if_busy && !(text.trim().is_empty() && images.is_empty()) => {
                let idle = {
                    let turns = self.turns.lock().await;
                    if matches!(turns.get(session_id), Some(TurnState::Cancelling)) {
                        return Err(anyhow!("session is stopping — send again once it is idle"));
                    }
                    self.queued
                        .lock()
                        .unwrap()
                        .entry(session_id.to_string())
                        .or_default()
                        .push_back(QueuedMessage {
                            id: format!("q_{}", uuid::Uuid::new_v4()),
                            text,
                            overrides,
                            images,
                        });
                    !turns.contains_key(session_id)
                };
                self.emit_queued(session_id);
                if idle {
                    self.drain_queue(session_id).await;
                }
                return Ok(());
            }
            None => return Err(anyhow!("session is busy — interrupt it first")),
        };
        let store = Store::open()?;
        let mut session = store
            .get_chat_session(session_id)?
            .ok_or_else(|| anyhow!("chat session not found"))?;
        let starts_session = is_initial_chat_message(
            transcript_text.as_deref(),
            store.has_chat_messages(session_id)?,
        );
        let project = store
            .get_local_project(&session.project_id)?
            .ok_or_else(|| anyhow!("project not found"))?;

        // Composer selections are sticky: an override that differs from the
        // stored value is persisted so the next turn (and a reload) keep it.
        if let Some(model) = overrides.model.filter(|m| !m.is_empty()) {
            if session.model.as_deref() != Some(model.as_str()) {
                store.set_chat_session_model(&session.id, &model)?;
                session.model = Some(model);
            }
        }
        // Read the session's mode BEFORE the composer override rewrites it: the
        // codex harness needs to know whether the *previous* turn ran under Plan
        // (the thread may be sticky-planned) to decide whether this turn must
        // attach a `default` collaborationMode mask to un-stick it. Captured
        // here because the override below is the last moment the pre-turn value
        // is visible. Persists across restarts (it's the DB row), so a resume
        // after `orx up` bounced still un-sticks.
        let prev_permission_mode = session
            .permission_mode
            .as_deref()
            .and_then(crate::local::harness::PermissionMode::from_id);
        if let Some(mode) = overrides.permission_mode.filter(|m| !m.is_empty()) {
            if session.permission_mode.as_deref() != Some(mode.as_str()) {
                store.set_chat_session_permission_mode(&session.id, &mode)?;
                session.permission_mode = Some(mode);
            }
        }
        if let Some(level) = overrides.reasoning_level.filter(|l| !l.is_empty()) {
            if session.reasoning_level.as_deref() != Some(level.as_str()) {
                store.set_chat_session_reasoning_level(&session.id, &level)?;
                session.reasoning_level = Some(level);
            }
        }
        // Activity unarchives (Claude-desktop behavior): a session being talked
        // to shouldn't stay hidden from the default Recents view.
        if session.archived {
            store.set_chat_session_archived(&session.id, false)?;
            session.archived = false;
        }
        let saved_images = save_images(&images)?;
        let display_text = transcript_text.as_deref().unwrap_or(&text);
        // The input auto-titling runs on — set only on the first message.
        // Owned because `skills::expand` moves `text` below, ending the borrow
        // `display_text` may hold on it; and it carries what the user typed,
        // not the expanded harness prompt.
        let mut title_seed = None;
        if session.title.is_none() {
            // First *non-empty* line: a message that opens with a blank line
            // would otherwise write no placeholder at all, leaving `title` NULL
            // so every later message re-ran the whole first-message path.
            let first_line = display_text
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim();
            // Text only: an image-only message has nothing to name from.
            title_seed = (!first_line.is_empty()).then(|| display_text.to_string());
            let mut title: String = first_line.chars().take(64).collect();
            if first_line.chars().count() > 64 {
                title = title.trim_end().to_string();
                title.push('…');
            }
            if title.is_empty() && !saved_images.is_empty() {
                // Name an attachment-only message after the first PDF (the
                // "upload my paper" flow), falling back to a generic label.
                title = saved_images
                    .iter()
                    .find(|a| a.is_pdf)
                    .map(|a| a.display_name.chars().take(64).collect())
                    .unwrap_or_else(|| "Image".into());
            }
            if !title.is_empty() {
                store.set_chat_session_title(&session.id, &title, "fallback")?;
                session.title = Some(title);
            }
        }

        let mut parts = Vec::new();
        if !display_text.is_empty() {
            parts.push(WirePart::text("p0", display_text.to_string()));
        }
        for (i, att) in saved_images.iter().enumerate() {
            parts.push(WirePart::image(format!("img{i}"), att.file_name.clone()));
        }
        // A resume whose transcript text is empty (e.g. a note-less plan
        // approval) records no user message: the resolved card already tells
        // that part of the story, and an empty bubble would just be noise.
        if !parts.is_empty() {
            let user_msg = WireMessage {
                id: format!("msg_{}", uuid::Uuid::new_v4()),
                role: "user".into(),
                parts,
                created_at: now_ms(),
            };
            store.upsert_chat_message(&StoredChatMessage {
                id: user_msg.id.clone(),
                session_id: session.id.clone(),
                role: "user".into(),
                parts_json: serde_json::to_string(&user_msg.parts)?,
                created_at: user_msg.created_at,
            })?;
            if starts_session {
                crate::telemetry::capture_chat_session_started(&session.harness);
            }
            self.emit("chat.message", message_json(&user_msg, &session.id));
        }
        store.touch_chat_session(&session.id)?;
        let session = store.get_chat_session(&session.id)?.unwrap_or(session);

        self.emit(
            "chat.session",
            json!({ "session": session_json(&session, true) }),
        );
        self.emit(
            "chat.busy",
            json!({ "sessionId": session.id, "busy": true }),
        );

        // Slash-skills: the transcript keeps the `/name` the user typed; the
        // harness gets the expanded prompt.
        let turn_text = crate::local::skills::expand(&text, project.github_enabled())
            .or_else(|| crate::local::user_skills::expand(&text, &project.id))
            .unwrap_or(text);
        let mut turn_text = with_bootstrap_context(
            session.native_session_id.as_deref(),
            session.bootstrap_context.as_deref(),
            turn_text,
        );
        // Harnesses take plain text; attachments ride as on-disk paths every
        // CLI can open with its own file-reading tool (Read handles PDFs and
        // images alike).
        if !saved_images.is_empty() {
            let list: String = saved_images
                .iter()
                .map(|att| format!("- {} — {}\n", att.display_name, att.path.display()))
                .collect();
            turn_text.push_str(&format!(
                "\n\n<attached-files>\nThe user attached {} file(s) to this message, saved on disk at:\n{list}\
                 Open each with your file-reading tool (Read) before responding — it can read PDFs and images.\n</attached-files>",
                saved_images.len()
            ));
        }

        let sid = session.id.clone();
        let assistant_message_id = format!("msg_{}", uuid::Uuid::new_v4());
        let mut ctx = TurnCtx {
            host: self.clone(),
            session_id: session.id.clone(),
            harness: session.harness.clone(),
            native_session_id: session.native_session_id.clone(),
            model: session.model.clone(),
            permission_mode: session
                .permission_mode
                .as_deref()
                .and_then(crate::local::harness::PermissionMode::from_id),
            prev_permission_mode,
            reasoning_level: session.reasoning_level.clone(),
            project,
            text: turn_text,
            assistant: WireMessage {
                id: assistant_message_id,
                role: "assistant".into(),
                parts: Vec::new(),
                created_at: now_ms(),
            },
            // Seed from the persisted value so mid-turn reports (which carry a
            // token count but often no window) inherit last turn's window and
            // the meter keeps its percent while the turn streams.
            context_usage: session
                .context_usage_json
                .as_deref()
                .and_then(|json| serde_json::from_str(json).ok()),
            last_flush: Instant::now() - FLUSH_INTERVAL,
            last_flushed_tool_states: Vec::new(),
            last_attempted_tool_states: Vec::new(),
            target_event_path: None,
            target_event_offset: 0,
            pending_target_events: Vec::new(),
            target_event_bindings: HashMap::new(),
        };
        // Upgrade the reservation to a live handle, atomically re-checking that
        // it's still ours: an `interrupt` racing the prologue above may have
        // removed the reservation, while deletion also closes admission before
        // it interrupts. In either case no harness task may start.
        {
            let mut turns = self.turns.lock().await;
            if self.deleting_sessions.lock().unwrap().contains(&sid)
                || !matches!(turns.get(&sid), Some(TurnState::Reserved))
            {
                _guard.defuse();
                return Ok(());
            }
            let (target_path, target_event_offset) =
                target_event_start(&session.id, &ctx.assistant.id);
            ctx.target_event_path = Some(target_path);
            ctx.target_event_offset = target_event_offset;
            let message_id = ctx.assistant.id.clone();
            let task = tokio::spawn(async move {
                let result = match crate::local::harness::chat_harness(&ctx.harness) {
                    Some(harness) => harness.run_turn(&mut ctx).await,
                    None => Err(anyhow!("unknown harness: {}", ctx.harness)),
                };
                if let Err(err) = result {
                    ctx.push_error(format!("{err}"));
                }
                let _ = ctx.flush();
                if let Some(path) = ctx.target_event_path.as_ref() {
                    let _ = std::fs::remove_file(path);
                }
                remove_target_pointer_if_matches(&ctx.session_id, &ctx.assistant.id);
                if let Some(usage) = &ctx.context_usage {
                    if let (Ok(store), Ok(json)) = (Store::open(), serde_json::to_string(usage)) {
                        let _ = store.set_chat_session_context_usage(&ctx.session_id, &json);
                    }
                }
                ctx.host
                    .finish_turn(&ctx.session_id, Some(&ctx.assistant.id))
                    .await;
                // Natural completion only: a user Stop aborts this task before
                // it reaches here (and clears the queue itself), so an
                // interrupted turn never drains.
                ctx.host.drain_queue(&ctx.session_id).await;
            });
            turns.insert(
                sid,
                TurnState::Active(ActiveTurn {
                    handle: task,
                    message_id,
                }),
            );
            if let Some(seed) = title_seed {
                self.spawn_title_generation(session.id.clone(), session.harness.clone(), seed);
            }
            _guard.defuse();
        }
        Ok(())
    }

    /// Turn cleanup: drop the handle, bump the session, broadcast idle.
    async fn finish_turn(&self, session_id: &str, message_id: Option<&str>) {
        let should_finish = {
            let mut turns = self.turns.lock().await;
            let matches = match (turns.get(session_id), message_id) {
                (Some(TurnState::Active(active)), Some(message_id)) => {
                    active.message_id == message_id
                }
                (Some(TurnState::Cancelling), None) => true,
                _ => false,
            };
            if matches {
                turns.remove(session_id);
                true
            } else {
                false
            }
        };
        if !should_finish {
            return;
        }
        // Any bridge card still pending belongs to the turn that just ended —
        // deny it so the (dying) bridge child's long-poll unblocks.
        self.cancel_pending_permissions(session_id);
        if let Ok(store) = Store::open() {
            let _ = store.touch_chat_session(session_id);
            if let Ok(Some(session)) = store.get_chat_session(session_id) {
                self.emit(
                    "chat.session",
                    json!({ "session": session_json(&session, false) }),
                );
            }
        }
        self.emit(
            "chat.busy",
            json!({ "sessionId": session_id, "busy": false }),
        );
    }

    async fn finish_interruption(self: &Arc<Self>, session_id: &str) {
        self.finish_turn(session_id, None).await;
    }

    /// Abort an in-flight turn. Child processes die via kill_on_drop; the
    /// opencode adapter additionally gets a native abort so the serve process
    /// stops generating. Returns whether a turn (or a reservation) was
    /// actually aborted — `false` means the session was already idle.
    pub async fn interrupt(self: &Arc<Self>, session_id: &str) -> Result<bool> {
        let active = {
            let mut turns = self.turns.lock().await;
            let Some(state) = turns.get_mut(session_id) else {
                return Ok(false);
            };
            match std::mem::replace(state, TurnState::Cancelling) {
                TurnState::Active(active) => Some(active),
                TurnState::Reserved => None,
                TurnState::Cancelling => return Ok(false),
            }
        };
        let host = self.clone();
        let session_id = session_id.to_string();
        let settlement = tokio::spawn(async move {
            host.cancel_pending_permissions(&session_id);
            let native_shutdown = async {
                if let Ok(store) = Store::open() {
                    if let Ok(Some(session)) = store.get_chat_session(&session_id) {
                        if session.harness == "opencode" {
                            if let (Some(nid), Some(port)) = (
                                &session.native_session_id,
                                host.opencode.port_for(&session_id).await,
                            ) {
                                let url = format!("http://127.0.0.1:{port}/session/{nid}/abort");
                                let _ = host.http.post(url).body("{}").send().await;
                            }
                        } else if session.harness == "codex" {
                            host.codex.interrupt_session(&session_id).await;
                        } else if session.harness == "claude-code" {
                            host.claude.kill_session(&session_id).await;
                        }
                    }
                }
            };
            let _ = tokio::time::timeout(Duration::from_secs(10), native_shutdown).await;
            if let Some(active) = active.as_ref() {
                active.handle.abort();
            }
            if let Some(active) = active {
                let _ = active.handle.await;
                if let Some(message) = reconcile_target_file(&session_id, &active.message_id) {
                    host.emit("chat.message", message_json(&message, &session_id));
                }
                let _ = std::fs::remove_file(target_event_path(&session_id, &active.message_id));
                remove_target_pointer_if_matches(&session_id, &active.message_id);
            }
            host.finish_interruption(&session_id).await;
        });
        let _ = settlement.await;
        Ok(true)
    }

    /// User-facing interrupt (the Stop button / Escape): abort like
    /// [`Self::interrupt`], and when a turn was actually in flight persist a
    /// visible "Interrupted" marker in the transcript. An aborted turn that had
    /// streamed nothing would otherwise vanish without a trace — the user's
    /// message sits unanswered and the stop reads as "orx did nothing".
    /// Internal interrupts (plan-approval resume, session/project delete) stay
    /// markerless on purpose: their stories are told elsewhere (the resolved
    /// card, the row disappearing).
    pub async fn interrupt_by_user(self: &Arc<Self>, session_id: &str) -> Result<()> {
        // Stamped before the abort: a fast resend can claim the freed slot and
        // persist its user message before this runs, and a later timestamp
        // would sort the marker after that new bubble. (The live broadcast can
        // still paint them in arrival order for a few ms; a reload converges
        // on the stored order.)
        let created_at = now_ms();
        // Stop means stop everything: drop any messages parked behind this turn
        // so they don't fire the moment it aborts.
        self.clear_queue(session_id);
        if !self.interrupt(session_id).await? {
            return Ok(());
        }
        self.clear_queue(session_id);
        let msg = WireMessage {
            id: format!("msg_{}", uuid::Uuid::new_v4()),
            role: "assistant".into(),
            parts: vec![WirePart::tool(
                "interrupted",
                "interrupted",
                "completed",
                None,
            )],
            created_at,
        };
        // Marker persistence is best-effort: the abort already happened, and an
        // Err here would surface as a failed Stop on a turn that IS stopped.
        if let (Ok(store), Ok(json)) = (Store::open(), serde_json::to_string(&msg.parts)) {
            let _ = store.upsert_chat_message(&StoredChatMessage {
                id: msg.id.clone(),
                session_id: session_id.to_string(),
                role: "assistant".into(),
                parts_json: json,
                created_at: msg.created_at,
            });
        }
        self.emit("chat.message", message_json(&msg, session_id));
        Ok(())
    }

    /// Answer an interactive prompt (plan / permission / question) and resume.
    ///
    /// `ChatHost` owns the harness-agnostic orchestration — locate the
    /// unresolved card, mark it resolved, broadcast — but the *harness* decides
    /// (and, for inline-approval harnesses, performs) how the answer flows back,
    /// via [`Harness::resume_from_prompt`]. That split is deliberate: Claude ends
    /// its turn on a prompt and resumes with a new user message
    /// ([`ResumeAction::SendMessage`]), while OpenCode is still mid-turn, paused
    /// over its serve session, and the reply is POSTed to that live process
    /// ([`ResumeAction::Handled`]) — so a busy session is *expected* there and
    /// must not be rejected.
    pub async fn respond(self: &Arc<Self>, req: PromptAnswer) -> Result<()> {
        // Serialize answers to one session: the load→deliver→resolve sequence
        // below is non-idempotent (an inline reply POSTs to the live harness), so
        // two racing `respond`s (a double-click, two tabs) must not interleave.
        // The loser waits, then finds the card already resolved and no-ops. Held
        // for the whole critical section.
        let gate = self.respond_lock(&req.session_id).await;
        let _gate = gate.lock().await;

        // Load the session and the *unresolved* prompt card (full WirePrompt, so
        // the harness can read its reply target — e.g. opencode's permission id).
        // Nothing is mutated yet, so any error below leaves the card actionable.
        // A card already resolved (the loser of the race above, or a re-submit)
        // is a clean no-op — `unresolved_prompt` returns `None`.
        let session = Store::open()?
            .get_chat_session(&req.session_id)?
            .ok_or_else(|| anyhow!("chat session not found"))?;
        // Already resolved (the loser of a double-submit, or a re-click) is a
        // clean no-op — NOT an error. Returning `Err` here would make the UI's
        // catch clear `busy` on a session whose turn is still streaming; a plain
        // `Ok` leaves the live turn (and its busy state) untouched.
        let Some(prompt) = unresolved_prompt(&req.session_id, &req.prompt_id)? else {
            return Ok(());
        };
        let harness = crate::local::harness::chat_harness(&session.harness)
            .ok_or_else(|| anyhow!("unknown harness: {}", session.harness))?;

        // Ask the harness how the answer resumes. Inline harnesses deliver the
        // reply to their live process here and return `Handled`; end-turn
        // harnesses return the follow-up message to send. Answer validation
        // (e.g. a question with no selection) surfaces as an `Err` here, before
        // we mark anything resolved — so a failed delivery leaves the card
        // actionable and retryable (nothing has been mutated yet).
        let resume_ctx = ResumeCtx {
            host: self.clone(),
            session_id: session.id.clone(),
            native_session_id: session.native_session_id.clone(),
        };
        let action = harness
            .resume_from_prompt(&resume_ctx, &prompt, &req)
            .await?;

        // Each arm delivers the answer FIRST and only then marks the card
        // resolved (`resolve_prompt_card`). The old order (resolve, then
        // deliver) had a stranding failure mode: if `send_message` was
        // rejected — e.g. the session was still busy because a held bridge
        // request kept the turn alive — the card was already read-only but
        // the answer was dropped, leaving no recourse but an interrupt.
        // Resolving after a successful delivery keeps a failed answer
        // retryable: nothing has been mutated, the card is still actionable.
        // (The resolve itself is best-effort — see `resolve_prompt_card`.)
        match action {
            ResumeAction::SendMessage { text, mode } => {
                // A native (mid-turn) card may resume while its turn is still
                // running — plan approval under the permission bridge replaces
                // the paused plan turn with the implementation turn, so
                // interrupt first. End-turn cards keep the old contract: the
                // session should be idle, and `send_message`'s guard rejects if
                // a turn is somehow running (answering a stale card must never
                // kill an unrelated live turn).
                if prompt.native_id.is_some() && self.is_busy(&req.session_id).await {
                    self.interrupt(&req.session_id).await?;
                }
                let overrides = TurnOverrides {
                    model: None,
                    permission_mode: mode.map(|m| m.id().to_string()),
                    reasoning_level: None,
                };
                // Plan/permission resumes are scaffolding the user never typed
                // ("Implement the plan.", "The user approved that action…") —
                // the transcript shows only their own note (usually nothing;
                // the resolved card tells the rest). A question resume's text
                // IS the user's answer, so it stays a normal bubble.
                let transcript = match prompt.kind.as_str() {
                    "plan" | "permission" => Some(req.note.clone().unwrap_or_default()),
                    _ => None,
                };
                self.send_message_showing(
                    &req.session_id,
                    text,
                    transcript,
                    overrides,
                    Vec::new(),
                    false,
                )
                .await?;
                self.resolve_prompt_card(&req);
                Ok(())
            }
            ResumeAction::Handled => {
                // The inline reply unblocked the still-running turn; it keeps
                // streaming and will `finish_turn` itself. Leave `busy` alone.
                self.resolve_prompt_card(&req);
                Ok(())
            }
            ResumeAction::Nothing => {
                // Card closed with no resume (e.g. a denied Claude permission);
                // broadcast idle so `busy` clears in the UI.
                self.resolve_prompt_card(&req);
                if let Ok(Some(session)) = Store::open()?.get_chat_session(&req.session_id) {
                    self.emit(
                        "chat.session",
                        json!({ "session": session_json(&session, false) }),
                    );
                }
                Ok(())
            }
        }
    }

    /// Resolve one card answerless and broadcast — for zombie native cards
    /// whose held turn died without cleanup (process crash/restart, so
    /// [`PendingGuard`] never ran). Collapses the card so it stops rendering
    /// actionable and swallowing every answer. Best-effort by design.
    pub fn resolve_zombie_prompt(&self, session_id: &str, prompt_id: &str) {
        if let Ok(Some(msg)) = mark_prompt_resolved(&self.msg_write, session_id, prompt_id, None) {
            self.emit("chat.message", message_json(&msg, session_id));
        }
    }

    /// Mark an answered card resolved (stamping the answer echo) and broadcast
    /// the updated message so it re-renders collapsed on every client
    /// immediately (send_message only emits the new user message, never the
    /// mutated assistant one). Best-effort: by the time this runs the answer
    /// has already been delivered, so a (store-only) failure is logged rather
    /// than surfaced — an Err from `respond` would make the UI's catch clear
    /// `busy` on a turn that is actually still streaming.
    fn resolve_prompt_card(&self, req: &PromptAnswer) {
        let resolved =
            mark_prompt_resolved(&self.msg_write, &req.session_id, &req.prompt_id, Some(req))
                .and_then(|m| m.ok_or_else(|| anyhow!("prompt not found")));
        match resolved {
            Ok(msg) => self.emit("chat.message", message_json(&msg, &req.session_id)),
            Err(e) => eprintln!("orx up: answered prompt not marked resolved: {e}"),
        }
    }

    /// Broadcast a freshly re-read session row, resolving `busy` live from the
    /// turn map.
    ///
    /// For the mutations that *don't* know `busy` — rename, archive, auto-title
    /// — which is why they have to ask. The turn-transition sites
    /// (`send_message`'s prologue, `finish_turn`, `respond`,
    /// `TurnCtx::set_title`) hard-code the busy value they are establishing and
    /// emit inline instead.
    ///
    /// Callers pass the row they re-read *after* their write: re-reading keeps
    /// the broadcast from clobbering a concurrent title/archive/`updated_at`
    /// change with a stale snapshot. `None` in means the row is genuinely gone
    /// (deleted mid-flight) and nothing is emitted; `None` comes back out, for
    /// the HTTP handlers that answer 404 on it.
    ///
    /// Takes the row rather than a `&Store`: `Store` is `!Sync`, so a `&Store`
    /// held across the await would make the spawned auto-title future
    /// non-`Send`. Callers do the read (propagating store errors).
    async fn emit_session(&self, session: Option<StoredChatSession>) -> Option<StoredChatSession> {
        let session = session?;
        let busy = self.is_busy(&session.id).await;
        self.emit(
            "chat.session",
            json!({ "session": session_json(&session, busy) }),
        );
        Some(session)
    }

    /// Archive/unarchive a session and broadcast the updated row so every open
    /// dashboard's Recents list re-filters. Returns None for an unknown id.
    pub async fn set_archived(
        &self,
        session_id: &str,
        archived: bool,
    ) -> Result<Option<StoredChatSession>> {
        let store = Store::open()?;
        store.set_chat_session_archived(session_id, archived)?;
        Ok(self.emit_session(store.get_chat_session(session_id)?).await)
    }

    /// Fire-and-forget auto-title: run the harness's one-shot title child in
    /// parallel with the first turn, then adopt the result only while the title
    /// is still unset or the first-line placeholder (a user Rename always
    /// wins). Failures are silent — the placeholder is a perfectly good title.
    fn spawn_title_generation(
        self: &Arc<Self>,
        session_id: String,
        harness_id: String,
        first_message: String,
    ) {
        let host = self.clone();
        tokio::spawn(async move {
            let Some(harness) = crate::local::harness::chat_harness(&harness_id) else {
                return;
            };
            let Some(title) = harness.generate_title(&first_message).await else {
                return;
            };
            let Ok(store) = Store::open() else { return };
            if !matches!(
                store.set_chat_session_title_if_placeholder(&session_id, &title),
                Ok(true)
            ) {
                return;
            }
            // `emit_session` resolves busy live rather than assuming the turn is
            // still running: generation can outlive a fast turn, and a stale
            // `busy: true` would strand the UI.
            let session = store.get_chat_session(&session_id).ok().flatten();
            host.emit_session(session).await;
        });
    }

    /// Rename a session and broadcast the updated row. Returns `None` for an
    /// unknown id (e.g. deleted mid-flight).
    pub async fn set_title(
        &self,
        session_id: &str,
        title: &str,
    ) -> Result<Option<StoredChatSession>> {
        let store = Store::open()?;
        store.set_chat_session_title(session_id, title, "user")?;
        Ok(self.emit_session(store.get_chat_session(session_id)?).await)
    }

    pub async fn delete_session(self: &Arc<Self>, session_id: &str) -> Result<()> {
        let _deleting = self
            .begin_session_delete(session_id)
            .ok_or_else(|| anyhow!("session deletion is already in progress"))?;
        self.clear_queue(session_id);
        let _ = self.interrupt(session_id).await;
        // A live opencode serve child would keep running in (and lock) the
        // session's worktree; the resident claude child's cwd is that worktree
        // too, so reap it before `cleanup_session_worktree` below.
        self.opencode.kill_session(session_id).await;
        self.codex.kill_session(session_id).await;
        self.claude.forget_session(session_id).await;
        self.respond_locks.lock().await.remove(session_id);
        let store = Store::open()?;
        let session = store.get_chat_session(session_id)?;
        store.delete_chat_session(session_id)?;
        self.emit("chat.session.deleted", json!({ "sessionId": session_id }));
        if let Some(session) = session {
            cleanup_session_transcript_artifacts(&session.id);
            if let Ok(Some(project)) = store.get_local_project(&session.project_id) {
                cleanup_session_worktree(&project, session_id);
            }
        }
        Ok(())
    }
}

/// Remove a deleted session's worktree in the background — git + rm are
/// blocking and best-effort, and must never hold up the delete response.
pub fn cleanup_session_worktree(project: &LocalProject, session_id: &str) {
    let project = project.clone();
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        crate::local::git::remove_session_worktree(&project, &session_id);
    });
}

/// A user's answer to an interactive prompt.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptAnswer {
    pub session_id: String,
    pub prompt_id: String,
    /// Approve (proceed) vs reject (dismiss). For questions, always true.
    #[serde(default = "default_true")]
    pub approve: bool,
    /// For plan/permission approval: the permission mode to resume under
    /// (a harness-agnostic wire id, e.g. `"auto"`, `"accept-edits"`). None keeps
    /// the session's mode. Only meaningful for end-turn resume (Claude); inline
    /// harnesses reply over their live protocol and ignore it.
    #[serde(default)]
    pub resume_mode: Option<String>,
    /// For questions: the chosen option labels.
    #[serde(default)]
    pub answers: Vec<String>,
    /// Optional freeform note the user added (plan refinement / extra context).
    #[serde(default)]
    pub note: Option<String>,
}

fn default_true() -> bool {
    true
}

/// What a harness needs to resume an answered prompt over its own machinery —
/// handed to [`Harness::resume_from_prompt`]. End-turn harnesses ignore it (they
/// just build a `SendMessage`); inline harnesses reach through `host` to talk to
/// their live process. Kept harness-neutral: it carries the shared `host`, the
/// orx session id, and the native session id, and each harness pulls what it
/// needs (an opencode reply reaches `host.opencode` / `host.http`, exactly as
/// `interrupt` does).
pub struct ResumeCtx {
    pub host: Arc<ChatHost>,
    /// The orx session id (for the `is_busy` liveness check).
    pub session_id: String,
    /// The harness's own session id, if one has been minted (opencode needs it
    /// to address the reply endpoint).
    pub native_session_id: Option<String>,
}

impl ResumeCtx {
    /// Shared HTTP client (mirrors `TurnCtx::http`).
    pub fn http(&self) -> &reqwest::Client {
        &self.host.http
    }

    /// Whether the session still has a turn in flight. An inline harness whose
    /// turn has already ended (errored / been interrupted) has no paused process
    /// left to receive a reply, so it uses this to reject a stale answer instead
    /// of firing a reply into the void.
    pub async fn is_busy(&self) -> bool {
        self.host.is_busy(&self.session_id).await
    }
}

/// The still-*unresolved* prompt card with `prompt_id`, if present — read before
/// any mutation so the harness can inspect it (kind, reply target) and validate
/// the answer first. Returns `None` if there's no such card *or* it's already
/// resolved, so a double-answer is a no-op rather than a second resume.
fn unresolved_prompt(session_id: &str, prompt_id: &str) -> Result<Option<WirePrompt>> {
    let store = Store::open()?;
    for msg in store.list_chat_messages(session_id)?.iter().rev() {
        if msg.role != "assistant" {
            continue;
        }
        let parts: Vec<WirePart> = serde_json::from_str(&msg.parts_json).unwrap_or_default();
        if let Some(prompt) = parts
            .iter()
            .find(|p| p.id == prompt_id)
            .and_then(|p| p.prompt.as_ref())
        {
            return Ok((!prompt.resolved).then(|| prompt.clone()));
        }
    }
    Ok(None)
}

/// Flip a prompt to resolved and stamp the answer echo (see
/// [`WirePrompt::answers`]) so the collapsed card can show the outcome.
/// `None` (stale-card cleanup, cancelled bridge requests) leaves any earlier
/// echo intact — a re-resolve must not erase it.
fn stamp_resolved(prompt: &mut WirePrompt, answer: Option<&PromptAnswer>) {
    prompt.resolved = true;
    if let Some(answer) = answer {
        prompt.answers = answer.answers.clone();
        prompt.approved = Some(answer.approve);
        prompt.note = answer.note.clone().filter(|n| !n.trim().is_empty());
    }
}

/// Resolve the prompt part with `prompt_id` in the session's last assistant
/// message that carries it ([`stamp_resolved`] with `answer`), persist it, and
/// return the mutated message (so the caller can broadcast a `chat.message`
/// and the card re-renders collapsed). `None` if no such prompt part exists,
/// or if it was already resolved and there's no answer to stamp — an
/// answerless re-resolve (stale-card cleanup) has nothing to change, and
/// skipping the write keeps its late broadcast from shadowing an echo-stamped
/// one a client already received.
///
/// The read→modify→write runs under `msg_write` so it's atomic against a
/// still-running turn's `flush` reconcile-and-persist of the same message (see
/// `TurnCtx::flush`) — otherwise the flush could clobber this resolve.
fn mark_prompt_resolved(
    msg_write: &std::sync::Mutex<()>,
    session_id: &str,
    prompt_id: &str,
    answer: Option<&PromptAnswer>,
) -> Result<Option<WireMessage>> {
    let _guard = msg_write.lock().unwrap();
    let store = Store::open()?;
    for msg in store.list_chat_messages(session_id)?.iter().rev() {
        if msg.role != "assistant" {
            continue;
        }
        let mut parts: Vec<WirePart> = serde_json::from_str(&msg.parts_json).unwrap_or_default();
        if let Some(part) = parts
            .iter_mut()
            .find(|p| p.id == prompt_id && p.prompt.is_some())
        {
            if let Some(prompt) = part.prompt.as_mut() {
                if prompt.resolved && answer.is_none() {
                    return Ok(None);
                }
                stamp_resolved(prompt, answer);
            }
            store.upsert_chat_message(&StoredChatMessage {
                id: msg.id.clone(),
                session_id: session_id.to_string(),
                role: msg.role.clone(),
                parts_json: serde_json::to_string(&parts)?,
                created_at: msg.created_at,
            })?;
            return Ok(Some(WireMessage {
                id: msg.id.clone(),
                role: msg.role.clone(),
                parts,
                created_at: msg.created_at,
            }));
        }
    }
    Ok(None)
}

/// Resolve still-unresolved prompt cards of a session, store-side.
///
/// For inline-approval harnesses whose prompts die with their turn (codex: a
/// JSON-RPC request the process has since abandoned), a leftover unresolved
/// card is a zombie — unanswerable, and worse, its reply id can collide with a
/// fresh child's restarting request ids, so a click on the dead card could be
/// delivered to a *different, live* request. Called at codex turn entry
/// (`native_only: false`) to close both.
///
/// End-turn harnesses (Claude) sweep with `native_only: true`: their
/// UN-held cards deliberately outlive turns and resume via a new message, but
/// a *held* (`native_id`) card can never outlive its process — one left
/// unresolved is a crash/restart artifact that would otherwise capture the
/// composer once the fresh turn makes the session busy again.
///
/// Same `msg_write` contract as `mark_prompt_resolved`. Returns the updated
/// messages so the caller can broadcast them.
fn resolve_stale_prompts(
    msg_write: &std::sync::Mutex<()>,
    session_id: &str,
    native_only: bool,
) -> Result<Vec<WireMessage>> {
    let _guard = msg_write.lock().unwrap();
    let store = Store::open()?;
    let mut updated = Vec::new();
    for msg in store.list_chat_messages(session_id)? {
        if msg.role != "assistant" {
            continue;
        }
        let mut parts: Vec<WirePart> = serde_json::from_str(&msg.parts_json).unwrap_or_default();
        let mut changed = false;
        for part in parts.iter_mut() {
            if let Some(prompt) = part.prompt.as_mut() {
                if !prompt.resolved && (!native_only || prompt.native_id.is_some()) {
                    stamp_resolved(prompt, None);
                    changed = true;
                }
            }
        }
        if changed {
            store.upsert_chat_message(&StoredChatMessage {
                id: msg.id.clone(),
                session_id: session_id.to_string(),
                role: msg.role.clone(),
                parts_json: serde_json::to_string(&parts)?,
                created_at: msg.created_at,
            })?;
            updated.push(WireMessage {
                id: msg.id,
                role: msg.role,
                parts,
                created_at: msg.created_at,
            });
        }
    }
    Ok(updated)
}

impl ChatHost {
    /// [`resolve_stale_prompts`] + broadcast, for harness turn-entry use.
    pub async fn resolve_stale_prompts(&self, session_id: &str, native_only: bool) -> Result<()> {
        for msg in resolve_stale_prompts(&self.msg_write, session_id, native_only)? {
            self.emit("chat.message", message_json(&msg, session_id));
        }
        Ok(())
    }
}

// --- per-turn context handed to adapters --------------------------------------

/// Composer selections a single message can override, mirroring the sticky
/// per-session settings. Empty/None fields leave the stored value in place.
#[derive(Debug, Default, Clone)]
pub struct TurnOverrides {
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub reasoning_level: Option<String>,
}

pub struct TurnCtx {
    pub host: Arc<ChatHost>,
    pub session_id: String,
    pub harness: String,
    pub native_session_id: Option<String>,
    pub model: Option<String>,
    /// Effective permission mode for this turn (session value; harness applies
    /// its own default when `None`).
    pub permission_mode: Option<crate::local::harness::PermissionMode>,
    /// The permission mode the session carried *before* this turn's composer
    /// override — read pre-override in `send_message`. The codex harness uses it
    /// to tell "this thread may be sticky-planned" (previous turn was Plan, so a
    /// non-plan turn must attach a `default` collaborationMode mask to un-stick
    /// it) from a thread that never entered Plan (attach nothing — a mask always
    /// injects a template). `None` on the very first turn of a session.
    pub prev_permission_mode: Option<crate::local::harness::PermissionMode>,
    /// Effective reasoning-level wire id for this turn (harness-owned vocabulary;
    /// the harness interprets it, e.g. Claude → `--effort`). Default when `None`.
    pub reasoning_level: Option<String>,
    pub project: LocalProject,
    pub text: String,
    pub assistant: WireMessage,
    /// Latest context-window usage the harness reported this turn. Persisted at
    /// turn end; `report_usage` also streams it live over `chat.usage`.
    pub context_usage: Option<ContextUsage>,
    last_flush: Instant,
    last_flushed_tool_states: Vec<(String, String)>,
    last_attempted_tool_states: Vec<(String, String)>,
    target_event_path: Option<PathBuf>,
    target_event_offset: u64,
    pending_target_events: Vec<(String, String, String, String, String)>,
    target_event_bindings: HashMap<String, Vec<String>>,
}

impl TurnCtx {
    pub fn http(&self) -> &reqwest::Client {
        &self.host.http
    }

    /// Bare in-memory ctx for harness unit tests: parts accumulate on
    /// `assistant`, nothing is flushed or persisted (don't call `flush` /
    /// `set_native_session_id` on it — those touch the store).
    #[cfg(test)]
    pub fn test_stub() -> Self {
        Self {
            host: Arc::new(ChatHost::new(
                Arc::new(AgentHost::new(None)),
                Arc::new(crate::local::codex::CodexHost::new()),
                Arc::new(crate::local::claude::ClaudeHost::new()),
            )),
            session_id: "test-session".into(),
            harness: "test".into(),
            native_session_id: None,
            model: None,
            permission_mode: None,
            prev_permission_mode: None,
            reasoning_level: None,
            project: crate::local::model::LocalProject {
                id: "test-project".into(),
                name: "Test".into(),
                slug: "test".into(),
                github_owner: "owner".into(),
                github_repo: "repo".into(),
                github_sync_enabled: true,
                baseline_branch: "main".into(),
                repo_path: "/tmp/test-repo".into(),
                run_command: None,
                paper_id: None,
                created_at: 0,
                updated_at: 0,
            },
            text: String::new(),
            assistant: WireMessage {
                id: "test-msg".into(),
                role: "assistant".into(),
                parts: Vec::new(),
                created_at: 0,
            },
            context_usage: None,
            last_flush: Instant::now(),
            last_flushed_tool_states: Vec::new(),
            last_attempted_tool_states: Vec::new(),
            target_event_path: None,
            target_event_offset: 0,
            pending_target_events: Vec::new(),
            target_event_bindings: HashMap::new(),
        }
    }

    fn apply_target_events(&mut self) {
        if let Some(path) = self.target_event_path.as_ref() {
            if let Ok(mut file) = std::fs::File::open(path) {
                if let Ok(length) = file.metadata().map(|metadata| metadata.len()) {
                    if length < self.target_event_offset {
                        self.target_event_offset = 0;
                    }
                    if file.seek(SeekFrom::Start(self.target_event_offset)).is_ok() {
                        let mut pending = String::new();
                        if file
                            .take(TOOL_TARGET_SCAN_BYTES as u64)
                            .read_to_string(&mut pending)
                            .is_ok()
                        {
                            if let Some(complete_end) = pending.rfind('\n').map(|index| index + 1) {
                                for line in pending[..complete_end].lines() {
                                    let Ok(event) = serde_json::from_str::<Value>(line) else {
                                        continue;
                                    };
                                    let (Some(scope), Some(command), Some(resource), Some(target)) = (
                                        event.get("scope").and_then(Value::as_str),
                                        event.get("command").and_then(Value::as_str),
                                        event.get("resource").and_then(Value::as_str),
                                        event.get("target").and_then(Value::as_str),
                                    ) else {
                                        continue;
                                    };
                                    let cwd = event
                                        .get("cwd")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default();
                                    if self.pending_target_events.len() < TOOL_TARGET_INSPECTION_CAP
                                    {
                                        self.pending_target_events.push((
                                            scope.to_string(),
                                            command.to_string(),
                                            cwd.to_string(),
                                            resource.to_string(),
                                            target.to_string(),
                                        ));
                                    }
                                }
                                self.target_event_offset += complete_end as u64;
                            }
                        }
                    }
                }
            }
        }
        let mut claimed = self
            .target_event_bindings
            .values()
            .cloned()
            .flatten()
            .collect::<HashSet<_>>();
        let mut remaining = Vec::new();
        for (scope, command, cwd, resource, target) in
            std::mem::take(&mut self.pending_target_events)
        {
            let bound = self.target_event_bindings.get(&scope).map(Vec::as_slice);
            let part_ids = attach_target_event(
                &mut self.assistant.parts,
                bound,
                &claimed,
                &command,
                &cwd,
                &resource,
                &target,
            );
            if part_ids.is_empty() {
                remaining.push((scope, command, cwd, resource, target));
                continue;
            }
            self.target_event_bindings
                .entry(scope)
                .or_insert_with(|| part_ids.clone());
            claimed.extend(part_ids);
        }
        self.pending_target_events = remaining;
    }

    /// Record the harness's own session id (CLIs mint/rotate them per turn).
    pub fn set_native_session_id(&mut self, native_id: &str) {
        if self.native_session_id.as_deref() == Some(native_id) {
            return;
        }
        self.native_session_id = Some(native_id.to_string());
        if let Ok(store) = Store::open() {
            let _ = store.set_chat_session_native_id(&self.session_id, native_id);
        }
    }

    pub fn set_title(&self, title: &str) {
        let title = title.trim();
        if title.is_empty() {
            return;
        }
        if let Ok(store) = Store::open() {
            // A harness-native title replaces the first-line placeholder but
            // never a title the user set via Rename, and never a title already
            // generated (so a later `session.updated` from opencode can't
            // re-title mid-conversation). The check-and-set is a single
            // conditional UPDATE so a concurrent Rename can't slip in between a
            // read and the write.
            match store.set_chat_session_title_if_placeholder(&self.session_id, title) {
                Ok(true) => {}
                _ => return,
            }
            if let Ok(Some(session)) = store.get_chat_session(&self.session_id) {
                self.host.emit(
                    "chat.session",
                    json!({ "session": session_json(&session, true) }),
                );
            }
        }
    }

    /// Record the latest context-window usage a harness reported and stream it
    /// live over `chat.usage`. Merging: a report that omits `context_window`
    /// inherits the previously-known value (an `assistant` event carries the
    /// token count but not the window; the `result` event fills the window).
    pub fn report_usage(&mut self, mut usage: ContextUsage) {
        if let Some(prev) = &self.context_usage {
            if usage.context_window.is_none() {
                usage.context_window = prev.context_window;
            }
        }
        self.context_usage = Some(usage.clone());
        self.host.emit(
            "chat.usage",
            json!({ "sessionId": self.session_id, "usage": usage }),
        );
    }

    /// Insert or replace a part by id, preserving arrival order.
    pub fn upsert_part(&mut self, part: WirePart) {
        upsert_preserving_children(&mut self.assistant.parts, part);
    }

    /// Like `upsert_part`, but carries forward an existing part's `children` when
    /// the incoming part has none — so re-upserting a spawn row (e.g. an
    /// authoritative final-message merge) doesn't drop the sub-agent transcript
    /// that streamed into it.
    pub fn upsert_part_preserving_children(&mut self, part: WirePart) {
        upsert_preserving_children(&mut self.assistant.parts, part);
    }

    pub fn append_part_text(&mut self, part_id: &str, delta: &str) {
        if let Some(part) = self.assistant.parts.iter_mut().find(|p| p.id == part_id) {
            let text = part.text.get_or_insert_with(String::new);
            text.push_str(delta);
        }
    }

    /// Upsert a part into the `children` of the part with `parent_id` (anywhere
    /// in the tree), carrying forward existing children — for a sub-agent's
    /// transcript hung under its spawn row. No-op if the parent isn't found yet.
    /// Shared by every harness that streams sub-agent activity (Codex threadId,
    /// Claude parent_tool_use_id, OpenCode child sessionID).
    pub fn upsert_child(&mut self, parent_id: &str, part: WirePart) {
        if let Some(parent) = find_part_mut(&mut self.assistant.parts, parent_id) {
            upsert_preserving_children(&mut parent.children, part);
        }
    }

    /// Append streamed text to a child part (creating it via `make` on the first
    /// delta) inside `parent_id`'s children. No-op if the parent isn't found.
    pub fn append_child_text(
        &mut self,
        parent_id: &str,
        child_id: &str,
        delta: &str,
        make: impl FnOnce() -> WirePart,
    ) {
        let Some(parent) = find_part_mut(&mut self.assistant.parts, parent_id) else {
            return;
        };
        if !parent.children.iter().any(|p| p.id == child_id) {
            parent.children.push(make());
        }
        if let Some(child) = parent.children.iter_mut().find(|p| p.id == child_id) {
            child.text.get_or_insert_with(String::new).push_str(delta);
        }
    }

    pub fn push_error(&mut self, message: String) {
        let id = format!("err-{}", self.assistant.parts.len());
        self.assistant
            .parts
            .push(WirePart::tool(id, "error", "error", Some(message)));
    }

    /// Persist + broadcast the assistant message, rate-limited mid-turn.
    pub fn maybe_flush(&mut self) {
        let tool_states = tool_state_signature(&self.assistant.parts);
        let unattempted_state = tool_states != self.last_flushed_tool_states
            && tool_states != self.last_attempted_tool_states;
        if unattempted_state || self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.last_attempted_tool_states = tool_states;
            let _ = self.flush();
        }
    }

    pub fn flush(&mut self) -> Result<()> {
        self.last_flush = Instant::now();
        if self.assistant.parts.is_empty() {
            return Ok(());
        }
        self.apply_target_events();
        cap_tool_parts(&mut self.assistant.parts);
        let store = Store::open()?;
        // A prompt card the harness surfaced mid-turn (opencode's inline
        // permission/question) may be answered *while the turn is still running*
        // — `respond` flips its `resolved` flag on the persisted message from a
        // different task. This in-memory copy still has it `false`, so a naive
        // rewrite would revert the card to actionable. Carry forward any
        // already-resolved flag from the store, then persist — under `msg_write`
        // so the read+write is atomic against a concurrent `mark_prompt_resolved`
        // (else that reconcile-then-clobber is a lost update). Only pay the lock
        // when this message actually carries a prompt part.
        let has_prompt = self.assistant.parts.iter().any(|p| p.prompt.is_some());
        let wire_assistant = {
            // Clone the host handle so the guard borrows it, not `self` — the
            // reconcile below needs `&mut self`.
            let host = self.host.clone();
            let _guard = has_prompt.then(|| host.msg_write.lock().unwrap());
            if has_prompt {
                self.adopt_resolved_prompts(&store);
            }
            let mut wire_assistant = self.assistant.clone();
            cap_tool_parts(&mut wire_assistant.parts);
            store.upsert_chat_message(&StoredChatMessage {
                id: wire_assistant.id.clone(),
                session_id: self.session_id.clone(),
                role: wire_assistant.role.clone(),
                parts_json: serde_json::to_string(&wire_assistant.parts)?,
                created_at: wire_assistant.created_at,
            })?;
            wire_assistant
        };
        self.host.emit(
            "chat.message",
            message_json(&wire_assistant, &self.session_id),
        );
        self.last_flushed_tool_states = tool_state_signature(&self.assistant.parts);
        self.last_attempted_tool_states = self.last_flushed_tool_states.clone();
        Ok(())
    }

    /// Merge the persisted resolution state of prompt parts into the in-memory
    /// assistant message, so a concurrent `respond` that resolved a card isn't
    /// clobbered by this turn's next flush. Only ever flips `false`→`true` and
    /// fills an empty echo (`answers`/`approved`/`note`) — never the reverse —
    /// so it's safe regardless of ordering: the in-memory copy normally never
    /// carries an echo of its own, and dropping the stored one here would
    /// erase the stamped outcome on the next flush.
    fn adopt_resolved_prompts(&mut self, store: &Store) {
        let Ok(Some(stored)) = store.get_chat_message(&self.assistant.id) else {
            return;
        };
        let persisted: Vec<WirePart> = serde_json::from_str(&stored.parts_json).unwrap_or_default();
        for part in self.assistant.parts.iter_mut() {
            let Some(prompt) = part.prompt.as_mut() else {
                continue;
            };
            let stored_prompt = persisted
                .iter()
                .find(|p| p.id == part.id)
                .and_then(|p| p.prompt.as_ref());
            let Some(stored_prompt) = stored_prompt.filter(|p| p.resolved) else {
                continue;
            };
            prompt.resolved = true;
            // Adopt the echo even when this copy is already resolved but
            // echo-less (codex's turn loop resolves its in-memory card
            // without one) — else this flush would persist the bare copy
            // over the stamped outcome.
            if prompt.answers.is_empty() && prompt.approved.is_none() && prompt.note.is_none() {
                prompt.answers = stored_prompt.answers.clone();
                prompt.approved = stored_prompt.approved;
                prompt.note = stored_prompt.note.clone();
            }
        }
    }
}

// --- shared adapter helpers ----------------------------------------------------

/// Transcript replay for the UI.
pub fn list_messages(session_id: &str) -> Result<Vec<WireMessage>> {
    let store = Store::open()?;
    Ok(store
        .list_chat_messages(session_id)?
        .iter()
        .map(stored_to_wire)
        .collect())
}

// --- run watcher ----------------------------------------------------------------

fn is_terminal(status: &str) -> bool {
    matches!(status, "done" | "failed" | "cancelled")
}

/// The chat session a completed run should notify: the one that *launched* it
/// (recorded on the run), provided it still exists and has history. Returns
/// `None` for an orphan run (no owning session — CLI-launched or pre-migration)
/// or a launcher since deleted/emptied. Store-only (the busy check and send stay
/// in `watch_runs`), which also keeps the routing decision unit-testable.
fn notify_target(store: &Store, run: &crate::store::StoredRun) -> Option<String> {
    let session_id = run.chat_session_id.clone()?;
    let session = store.get_chat_session(&session_id).ok().flatten()?;
    let has_history = store
        .list_chat_messages(&session.id)
        .map(|m| !m.is_empty())
        .unwrap_or(false);
    has_history.then_some(session.id)
}

/// Poke the chat session that *launched* a run when it completes while no turn
/// is in flight — the local stand-in for the cloud agent staying online inside
/// a blocking `orx exp wait`. Routing is by the run's recorded
/// `chat_session_id` (stamped from the harness child's `ORX_CHAT_SESSION_ID`),
/// never a project-wide guess, so a second idle agent in the same project is
/// never handed another agent's run. The first pass only seeds the cursor, so a
/// server restart doesn't replay old completions. A busy owner is skipped (the
/// agent is awake — likely in its wait loop — and will see the completion
/// itself); a run with no owning session (CLI-launched) pokes nothing.
pub async fn watch_runs(chat: Arc<ChatHost>) {
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut first = true;
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        // Store hiccups (locked db) just skip a tick.
        let Ok(store) = Store::open() else { continue };
        let Ok(runs) = store.list_runs(200) else {
            continue;
        };
        for run in runs {
            let prev = seen.insert(run.id.clone(), run.status.clone());
            let newly_terminal =
                is_terminal(&run.status) && !matches!(prev.as_deref(), Some(s) if is_terminal(s));
            if first || !newly_terminal {
                continue;
            }
            // The launching session (see `notify_target`); `None` skips.
            let Some(session_id) = notify_target(&store, &run) else {
                continue;
            };
            if chat.is_busy(&session_id).await {
                // The owner is awake — likely blocking in its own `orx exp
                // wait` — and will observe the completion itself.
                continue;
            }
            let text = format!(
                "[orx] Run `{}` finished with status **{}**. Reconcile with \
                 `orx runs {}`, analyze the result (`orx logs {}`), and \
                 continue the loop.",
                run.id, run.status, run.project_id, run.id
            );
            if let Err(err) = chat
                .send_message(&session_id, text, TurnOverrides::default(), Vec::new())
                .await
            {
                eprintln!("orx up: run watcher: {err}");
            }
        }
        first = false;
    }
}

/// Env prep shared by the CLI adapters: this orx first on PATH (agents shell
/// out to `orx`) and the dashboard-managed env vars, real env winning.
pub fn prepare_env(cmd: &mut tokio::process::Command) {
    if let Ok(exe) = std::env::current_exe().and_then(|p| p.canonicalize()) {
        if let Some(dir) = exe.parent() {
            let mut path = std::ffi::OsString::from(dir);
            if let Some(existing) = std::env::var_os("PATH").filter(|p| !p.is_empty()) {
                path.push(":");
                path.push(existing);
            }
            cmd.env("PATH", path);
        }
    }
    for (key, value) in crate::config::list_synced_env() {
        if std::env::var_os(&key).is_none() {
            cmd.env(key, value);
        }
    }
}

/// Env var carrying the launching chat session's id into a harness child. The
/// agent shells out `orx exp run`, a fresh `orx` subprocess that inherits this,
/// so run creation can stamp `StoredRun::chat_session_id` (see
/// `launching_chat_session`) and the run watcher can route the completion
/// notification back to exactly the session that started it.
pub const CHAT_SESSION_ENV: &str = "ORX_CHAT_SESSION_ID";

/// Marks a process as a child of a local `orx up` harness. Separate from
/// [`CHAT_SESSION_ENV`], which the cloud box's opencode plugin also exports for
/// attribution — presence of a session id alone no longer implies local.
pub const LOCAL_SESSION_ENV: &str = "ORX_LOCAL_SESSION";

fn shell_single_quote(path: &std::path::Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

fn zsh_startup_wrapper(name: &str) -> String {
    format!(
        "_ORX_CHAT_SHIM_ZDOTDIR=$ZDOTDIR\n\
         ZDOTDIR=$_ORX_CHAT_USER_ZDOTDIR\n\
         [[ -r \"$ZDOTDIR/{name}\" ]] && source \"$ZDOTDIR/{name}\"\n\
         _ORX_CHAT_USER_ZDOTDIR=$ZDOTDIR\n\
         ZDOTDIR=$_ORX_CHAT_SHIM_ZDOTDIR\n"
    )
}

fn child_env_value(key: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(key).or_else(|| {
        crate::config::list_synced_env()
            .into_iter()
            .find_map(|(candidate, value)| (candidate == key).then(|| value.into()))
    })
}

/// Stamp the launching session id onto a harness child's env. Call *after*
/// `prepare_env` so a dashboard-synced value can't shadow it. Harness children
/// are one-per-session, so this is unambiguous.
pub fn set_chat_session_env(cmd: &mut tokio::process::Command, session_id: &str) {
    cmd.env(CHAT_SESSION_ENV, session_id);
    cmd.env(LOCAL_SESSION_ENV, "1");

    let shell_dir = shell_hook_dir(session_id);
    if std::fs::create_dir_all(&shell_dir).is_err() {
        return;
    }
    let original_zdotdir = child_env_value("ZDOTDIR")
        .map(PathBuf::from)
        .or_else(|| child_env_value("HOME").map(PathBuf::from));
    let Some(original_zdotdir) = original_zdotdir else {
        return;
    };
    let pointer = target_event_pointer(session_id);
    let zshenv = format!(
        "_ORX_CHAT_SHIM_ZDOTDIR=$ZDOTDIR\n\
         _ORX_CHAT_USER_ZDOTDIR={}\n\
         ZDOTDIR=$_ORX_CHAT_USER_ZDOTDIR\n\
         [[ -r \"$ZDOTDIR/.zshenv\" ]] && source \"$ZDOTDIR/.zshenv\"\n\
         _ORX_CHAT_USER_ZDOTDIR=$ZDOTDIR\n\
         ZDOTDIR=$_ORX_CHAT_SHIM_ZDOTDIR\n\
         export ORX_CHAT_TOOL_SCOPE=\"zsh-$$\"\n\
         export ORX_CHAT_TOOL_COMMAND=\"$ZSH_EXECUTION_STRING\"\n\
         if [[ -z \"${{ORX_CHAT_TARGET_FILE-}}\" && -r \"$ORX_CHAT_TARGET_POINTER\" ]]; then\n\
           export ORX_CHAT_TARGET_FILE=$(<\"$ORX_CHAT_TARGET_POINTER\")\n\
         elif [[ -z \"${{ORX_CHAT_TARGET_FILE-}}\" ]]; then\n\
           unset ORX_CHAT_TARGET_FILE\n\
         fi\n",
        shell_single_quote(&original_zdotdir)
    );
    let mut hooks = vec![(".zshenv", zshenv)];
    hooks.extend(
        [".zprofile", ".zshrc", ".zlogin", ".zlogout"]
            .into_iter()
            .map(|name| (name, zsh_startup_wrapper(name))),
    );
    if hooks
        .iter()
        .any(|(name, contents)| std::fs::write(shell_dir.join(name), contents).is_err())
    {
        return;
    }

    let bash_env = shell_dir.join("bash_env");
    let original_bash_env = child_env_value("BASH_ENV")
        .map(|value| value.to_string_lossy().into_owned())
        .map(|value| {
            format!(
                "_ORX_CHAT_USER_BASH_ENV={}\n\
                 eval \"_ORX_CHAT_USER_BASH_ENV=\\\"$_ORX_CHAT_USER_BASH_ENV\\\"\"\n\
                 [[ -r \"$_ORX_CHAT_USER_BASH_ENV\" ]] && source \"$_ORX_CHAT_USER_BASH_ENV\"\n",
                shell_single_quote(std::path::Path::new(&value))
            )
        })
        .unwrap_or_default();
    let bash_hook = format!(
        "{original_bash_env}\
         export ORX_CHAT_TOOL_SCOPE=\"bash-$$\"\n\
         export ORX_CHAT_TOOL_COMMAND=\"$BASH_EXECUTION_STRING\"\n\
         if [[ -z \"${{ORX_CHAT_TARGET_FILE-}}\" && -r \"$ORX_CHAT_TARGET_POINTER\" ]]; then\n\
           export ORX_CHAT_TARGET_FILE=$(<\"$ORX_CHAT_TARGET_POINTER\")\n\
         elif [[ -z \"${{ORX_CHAT_TARGET_FILE-}}\" ]]; then\n\
           unset ORX_CHAT_TARGET_FILE\n\
         fi\n"
    );
    if std::fs::write(&bash_env, bash_hook).is_err() {
        return;
    }

    cmd.env(CHAT_TARGET_POINTER_ENV, pointer);
    cmd.env("ZDOTDIR", shell_dir);
    cmd.env("BASH_ENV", bash_env);
}

/// The chat session that launched this run, read from the env the harness child
/// exported (see [`set_chat_session_env`]). `None` for CLI-launched or server
/// runs — those intentionally poke no chat session on completion.
pub fn launching_chat_session() -> Option<String> {
    std::env::var(CHAT_SESSION_ENV)
        .ok()
        .filter(|s| !s.is_empty())
}

/// Whether this process is running inside a local `orx up` session.
/// [`LOCAL_SESSION_ENV`] is exported only by [`set_chat_session_env`] onto
/// `orx up` harness children, so its presence means this process is one (or a
/// subprocess of one). Commands that take a project or run id should prefer
/// `…is_local()` on the resolved entity; this is for the ones that take
/// neither (e.g. `orx skill <name>`).
pub fn in_local_session() -> bool {
    std::env::var(LOCAL_SESSION_ENV).is_ok_and(|v| !v.is_empty())
}

/// Append-only stderr sink for a harness child (startup/debug diagnostics).
pub fn harness_log(name: &str) -> Result<std::fs::File> {
    let path = crate::store::data_dir().join(format!("agent-{name}.log"));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| anyhow!("Could not create {}: {}", parent.display(), e))?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| anyhow!("Could not open {}: {}", path.display(), e))
}

#[cfg(test)]
mod session_env_tests {
    use super::{in_local_session, CHAT_SESSION_ENV, LOCAL_SESSION_ENV};
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        _lock: MutexGuard<'static, ()>,
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn new(vars: &[&'static str]) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let saved = vars
                .iter()
                .map(|k| (*k, std::env::var(k).ok()))
                .collect::<Vec<_>>();
            for k in vars {
                std::env::remove_var(k);
            }
            EnvGuard { _lock: lock, saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (k, v) in &self.saved {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        }
    }

    /// The cloud box's opencode plugin exports CHAT_SESSION_ENV for experiment
    /// attribution. That must not read as a local `orx up` session, or
    /// `orx skill` serves the Local skill bodies on every cloud box.
    #[test]
    fn chat_session_alone_is_not_a_local_session() {
        let _guard = EnvGuard::new(&[CHAT_SESSION_ENV, LOCAL_SESSION_ENV]);

        std::env::set_var(CHAT_SESSION_ENV, "ses_cloud_box");
        assert!(!in_local_session());

        std::env::set_var(LOCAL_SESSION_ENV, "1");
        assert!(in_local_session());
    }

    #[test]
    fn empty_local_marker_is_not_a_local_session() {
        let _guard = EnvGuard::new(&[CHAT_SESSION_ENV, LOCAL_SESSION_ENV]);
        std::env::set_var(LOCAL_SESSION_ENV, "");
        assert!(!in_local_session());
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;

    #[test]
    fn session_path_names_are_injective_for_punctuation() {
        assert_ne!(safe_session_name("a/b"), safe_session_name("ab"));
        assert!(!safe_session_name("...").is_empty());
    }

    #[test]
    fn cap_tool_text_truncates_and_is_idempotent() {
        let mut short = "hello".to_string();
        cap_tool_text(&mut short);
        assert_eq!(short, "hello");

        let mut long = "x".repeat(TOOL_TEXT_CAP + 1);
        cap_tool_text(&mut long);
        assert_eq!(long.chars().count(), TOOL_TEXT_CAP);
        assert!(long.contains(TOOL_TEXT_TRUNCATION_MARKER));
        assert!(long.starts_with('x'));
        assert!(long.ends_with('x'));

        // Re-capping a capped string must not shave it further.
        let capped = long.clone();
        cap_tool_text(&mut long);
        assert_eq!(long, capped);

        long.push_str("terminal error");
        cap_tool_text(&mut long);
        assert_eq!(long.chars().count(), TOOL_TEXT_CAP);
        assert!(long.ends_with("terminal error"));

        // Multi-byte chars: truncation lands on a char boundary.
        let mut wide = "é".repeat(TOOL_TEXT_CAP * 2);
        cap_tool_text(&mut wide);
        assert_eq!(wide.chars().count(), TOOL_TEXT_CAP);
        assert!(wide.contains(TOOL_TEXT_TRUNCATION_MARKER));
        assert!(wide.ends_with('é'));
    }

    /// The per-flush pass caps `output` and `error` on tool parts and leaves
    /// text parts alone. Nested sub-agent parts (`children`) are capped too.
    #[test]
    fn cap_tool_parts_caps_output_and_error() {
        let bloated_tool = |id: &str| WirePart {
            id: id.into(),
            kind: "tool".into(),
            text: None,
            tool: Some("Bash".into()),
            state: Some(WireToolState {
                status: "completed".into(),
                input: None,
                output: Some("y".repeat(1_000_000)),
                error: Some("e".repeat(1_000_000)),
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        };
        // A spawn part whose sub-agent transcript (a child) has huge output.
        let mut spawn = bloated_tool("spawn");
        spawn.tool = Some("subagent".into());
        spawn.children = vec![bloated_tool("sub-t1")];
        let mut parts = vec![
            WirePart::text("t0", "z".repeat(TOOL_TEXT_CAP * 2)),
            bloated_tool("t1"),
            spawn,
        ];
        cap_tool_parts(&mut parts);
        // Assistant prose is never capped — only tool payloads.
        assert_eq!(parts[0].text.as_ref().unwrap().len(), TOOL_TEXT_CAP * 2);
        let state = parts[1].state.as_ref().unwrap();
        assert_eq!(
            state.output.as_ref().unwrap().chars().count(),
            TOOL_TEXT_CAP
        );
        assert_eq!(state.error.as_ref().unwrap().chars().count(), TOOL_TEXT_CAP);
        // The nested sub-agent part's output is bounded by the recursion.
        let child_state = parts[2].children[0].state.as_ref().unwrap();
        assert_eq!(
            child_state.output.as_ref().unwrap().chars().count(),
            TOOL_TEXT_CAP
        );
    }

    #[test]
    fn cap_tool_parts_preserves_semantic_targets() {
        let first = "11111111-1111-1111-1111-111111111111";
        let middle = "22222222-2222-2222-2222-222222222222";
        let last = "33333333-3333-3333-3333-333333333333";
        let output = format!(
            "[orx-run:{first}]\n{}\n[orx-run:{middle}]\n{}\n[orx-run:{last}]",
            "x".repeat(20_000),
            "y".repeat(20_000)
        );
        let mut parts = vec![WirePart {
            id: "logs".into(),
            kind: "tool".into(),
            text: None,
            tool: Some("bash".into()),
            state: Some(WireToolState {
                status: "completed".into(),
                input: Some(json!({ "command": "orx logs $id" })),
                output: Some(output),
                error: None,
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        }];

        cap_tool_parts(&mut parts);

        let state = parts[0].state.as_ref().unwrap();
        let output = state.output.as_ref().unwrap();
        assert!(output.chars().count() <= TOOL_TEXT_CAP);
        assert!(output.contains(TOOL_TEXT_TRUNCATION_MARKER));
        assert_eq!(
            state.input.as_ref().unwrap()["runTargetIds"],
            json!([first, middle, last])
        );
    }

    #[test]
    fn semantic_targets_are_resource_specific_and_bounded() {
        let parent = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let latest_run = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        let mut output = format!(
            "id: 11111111-1111-1111-1111-111111111111\nparent: {parent}\nlast run: {latest_run}\n"
        );
        for index in 0..300 {
            output.push_str(&format!(
                "[orx-experiment:{index:08x}-1111-1111-1111-111111111111]\n"
            ));
        }
        let mut state = WireToolState {
            status: "completed".into(),
            input: Some(json!({ "arguments": { "cmd": "orx exp status $id" } })),
            output: Some(output),
            error: None,
            title: None,
        };

        preserve_tool_targets(&mut state);

        let targets = state.input.as_ref().unwrap()["experimentTargetIds"]
            .as_array()
            .unwrap();
        assert_eq!(targets.len(), TOOL_TARGET_CAP);
        assert!(!targets.iter().any(|value| value == parent));
        assert!(!targets.iter().any(|value| value == latest_run));
    }

    #[test]
    fn semantic_markers_are_authoritative_and_preserve_newlines() {
        let target = "11111111-1111-1111-1111-111111111111";
        let mentioned = "22222222-2222-2222-2222-222222222222";
        let mut state = WireToolState {
            status: "error".into(),
            input: Some(json!({ "command": "orx logs $id" })),
            output: Some(format!(
                "[orx-run:{target}]\nfirst line\n/runs/{mentioned}\n"
            )),
            error: None,
            title: None,
        };

        preserve_tool_targets(&mut state);

        assert_eq!(
            state.input.as_ref().unwrap()["runTargetIds"],
            json!([target])
        );
        let expected = format!("first line\n/runs/{mentioned}\n");
        assert_eq!(state.output.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn semantic_markers_beyond_legacy_scan_limit_are_preserved() {
        let target = "11111111-1111-1111-1111-111111111111";
        let mut state = WireToolState {
            status: "completed".into(),
            input: Some(json!({ "command": "orx logs $id" })),
            output: Some(format!(
                "{}\n[orx-run:{target}]\n",
                "x".repeat(TOOL_TARGET_SCAN_BYTES + 1)
            )),
            error: None,
            title: None,
        };

        preserve_tool_targets(&mut state);

        assert_eq!(
            state.input.as_ref().unwrap()["runTargetIds"],
            json!([target])
        );
        assert!(!state.output.as_ref().unwrap().contains("[orx-run:"));
    }

    #[test]
    fn out_of_band_target_attaches_to_latest_matching_tool() {
        let target = "11111111-1111-1111-1111-111111111111";
        let mut parts = vec![WirePart {
            id: "logs".into(),
            kind: "tool".into(),
            text: None,
            tool: Some("bash".into()),
            state: Some(WireToolState {
                status: "completed".into(),
                input: Some(json!({ "command": "id=$(lookup); orx logs \"$id\"" })),
                output: Some("ordinary log content".into()),
                error: None,
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        }];

        assert!(!attach_target_event(
            &mut parts,
            None,
            &HashSet::new(),
            "id=$(lookup); orx logs \"$id\"",
            "",
            "runs",
            target,
        )
        .is_empty());
        let input = parts[0].state.as_ref().unwrap().input.as_ref().unwrap();
        assert_eq!(input["runTargetIds"], json!([target]));
        assert_eq!(input["runTargetIdsAuthoritative"], true);
    }

    #[test]
    fn identical_parallel_commands_are_left_unattributed() {
        let target = "11111111-1111-1111-1111-111111111111";
        let make_part = |id: &str| WirePart {
            id: id.into(),
            kind: "tool".into(),
            text: None,
            tool: Some("bash".into()),
            state: Some(WireToolState {
                status: "completed".into(),
                input: Some(json!({ "command": "orx logs \"$id\"" })),
                output: None,
                error: None,
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        };
        let mut parts = vec![make_part("one"), make_part("two")];
        let claimed = HashSet::new();
        let ids = attach_target_event(
            &mut parts,
            None,
            &claimed,
            "orx logs \"$id\"",
            "",
            "runs",
            target,
        );
        assert!(ids.is_empty());

        for part in parts {
            let input = part.state.unwrap().input.unwrap();
            assert!(input["runTargetIds"].is_null());
        }
    }

    #[test]
    fn target_cwd_disambiguates_parallel_commands() {
        let target = "11111111-1111-1111-1111-111111111111";
        let make_part = |id: &str, cwd: &str| WirePart {
            id: id.into(),
            kind: "tool".into(),
            text: None,
            tool: Some("bash".into()),
            state: Some(WireToolState {
                status: "completed".into(),
                input: Some(json!({ "command": "orx logs \"$id\"", "cwd": cwd })),
                output: None,
                error: None,
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        };
        let mut parts = vec![make_part("one", "/one"), make_part("two", "/two")];
        let mut ids = attach_target_event(
            &mut parts,
            None,
            &HashSet::new(),
            "orx logs \"$id\"",
            "/one",
            "runs",
            target,
        );

        ids.sort();
        assert_eq!(ids, vec!["one"]);
        assert_eq!(
            parts[0].state.as_ref().unwrap().input.as_ref().unwrap()["runTargetIds"],
            json!([target])
        );
        assert!(parts[1].state.as_ref().unwrap().input.as_ref().unwrap()["runTargetIds"].is_null());
    }

    #[test]
    fn interrupted_reconciliation_settles_running_tools() {
        let mut parts = vec![WirePart {
            id: "running".into(),
            kind: "tool".into(),
            text: None,
            tool: Some("bash".into()),
            state: Some(WireToolState {
                status: "running".into(),
                input: None,
                output: None,
                error: None,
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        }];

        settle_interrupted_tool_parts(&mut parts);

        assert_eq!(parts[0].state.as_ref().unwrap().status, "interrupted");
    }

    #[test]
    fn tool_upsert_preserves_out_of_band_targets() {
        let target = "11111111-1111-1111-1111-111111111111";
        let mut parts = vec![WirePart {
            id: "logs".into(),
            kind: "tool".into(),
            text: None,
            tool: Some("bash".into()),
            state: Some(WireToolState {
                status: "running".into(),
                input: Some(json!({
                    "command": "orx logs $id",
                    "runTargetIds": [target],
                    "runTargetIdsAuthoritative": true
                })),
                output: None,
                error: None,
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        }];
        let replacement = WirePart {
            id: "logs".into(),
            kind: "tool".into(),
            text: None,
            tool: Some("bash".into()),
            state: Some(WireToolState {
                status: "completed".into(),
                input: Some(json!({ "command": "orx logs $id" })),
                output: Some("done".into()),
                error: None,
                title: None,
            }),
            prompt: None,
            children: Vec::new(),
        };

        upsert_preserving_children(&mut parts, replacement);

        let input = parts[0].state.as_ref().unwrap().input.as_ref().unwrap();
        assert_eq!(input["runTargetIds"], json!([target]));
        assert_eq!(input["runTargetIdsAuthoritative"], true);
    }

    #[test]
    fn later_marker_replaces_heuristic_targets() {
        let target = "11111111-1111-1111-1111-111111111111";
        let mentioned = "22222222-2222-2222-2222-222222222222";
        let mut state = WireToolState {
            status: "running".into(),
            input: Some(json!({ "command": "orx logs $id" })),
            output: Some(format!("/runs/{mentioned}\n")),
            error: None,
            title: None,
        };

        preserve_tool_targets(&mut state);
        assert_eq!(
            state.input.as_ref().unwrap()["runTargetIds"],
            json!([mentioned])
        );

        state
            .output
            .as_mut()
            .unwrap()
            .push_str(&format!("[orx-run:{target}]\n"));
        preserve_tool_targets(&mut state);

        assert_eq!(
            state.input.as_ref().unwrap()["runTargetIds"],
            json!([target])
        );
        assert_eq!(
            state.input.as_ref().unwrap()["runTargetIdsAuthoritative"],
            true
        );
    }
}

#[cfg(test)]
mod bridge_tests {
    use super::*;

    /// The decision wire shapes are Claude Code's permission-prompt-tool
    /// contract verbatim — the bridge stringifies them unchanged, so a drift
    /// here breaks every approval.
    #[test]
    fn permission_decision_serializes_to_the_cli_contract() {
        let allow = PermissionDecision::Allow {
            updated_input: Some(json!({"command": "orx runs"})),
        };
        assert_eq!(
            serde_json::to_value(&allow).unwrap(),
            json!({"behavior": "allow", "updatedInput": {"command": "orx runs"}})
        );
        let allow_bare = PermissionDecision::Allow {
            updated_input: None,
        };
        assert_eq!(
            serde_json::to_value(&allow_bare).unwrap(),
            json!({"behavior": "allow"})
        );
        let deny = PermissionDecision::deny("no");
        assert_eq!(
            serde_json::to_value(&deny).unwrap(),
            json!({"behavior": "deny", "message": "no"})
        );
    }

    #[test]
    fn plan_auto_policy_decides_the_unambiguous_tiers() {
        let allow =
            |d: Option<PermissionDecision>| matches!(d, Some(PermissionDecision::Allow { .. }));
        let deny =
            |d: Option<PermissionDecision>| matches!(d, Some(PermissionDecision::Deny { .. }));

        // Read-only Bash: allowed without a card.
        assert!(allow(plan_auto_policy(
            "Bash",
            &json!({"command": "orx runs 2>&1 | head -50"})
        )));
        assert!(allow(plan_auto_policy(
            "Bash",
            &json!({"command": "git show origin/b:f.py | head -100"})
        )));
        // Gray-area Bash: the user's call — card.
        assert!(plan_auto_policy("Bash", &json!({"command": "cargo metadata"})).is_none());
        assert!(plan_auto_policy("Bash", &json!({"command": "rm -rf /"})).is_none());
        // Read-only research tools: allowed (plan mode denies them natively).
        assert!(allow(plan_auto_policy(
            "WebFetch",
            &json!({"url": "https://example.com"})
        )));
        assert!(allow(plan_auto_policy("WebSearch", &json!({"query": "x"}))));
        // AskUserQuestion: tier 2, but its card is the QUESTION itself, held
        // mid-turn (see `request_permission`) — auto-allowing would run the
        // tool headless, which returns no answer, so the model would guess
        // instead of blocking on the user.
        assert!(plan_auto_policy(
            "AskUserQuestion",
            &json!({"questions": [{"question": "Which?", "options": []}]})
        )
        .is_none());
        // File edits: denied — this branch IS plan mode's edit block once a
        // permission tool is configured.
        for tool in ["Write", "Edit", "MultiEdit", "NotebookEdit"] {
            assert!(
                deny(plan_auto_policy(tool, &json!({"file_path": "/x"}))),
                "{tool}"
            );
        }
        // ExitPlanMode and unknown tools: the user's call — card.
        assert!(plan_auto_policy("ExitPlanMode", &json!({"plan": "x"})).is_none());
        assert!(plan_auto_policy("mcp__foo__bar", &json!({})).is_none());
    }

    fn answer(answers: &[&str], approve: bool, note: Option<&str>) -> PromptAnswer {
        PromptAnswer {
            session_id: "s".into(),
            prompt_id: "p".into(),
            approve,
            resume_mode: None,
            answers: answers.iter().map(|s| s.to_string()).collect(),
            note: note.map(str::to_string),
        }
    }

    #[test]
    fn stamp_resolved_records_the_answer_echo() {
        let mut prompt = WirePrompt {
            kind: "question".into(),
            ..Default::default()
        };
        stamp_resolved(
            &mut prompt,
            Some(&answer(&["Core patching science"], true, Some("go deep"))),
        );
        assert!(prompt.resolved);
        assert_eq!(prompt.answers, vec!["Core patching science"]);
        assert_eq!(prompt.approved, Some(true));
        assert_eq!(prompt.note.as_deref(), Some("go deep"));

        // A whitespace-only note is dropped, a denial echoes approved=false.
        let mut prompt = WirePrompt {
            kind: "permission".into(),
            ..Default::default()
        };
        stamp_resolved(&mut prompt, Some(&answer(&[], false, Some("   "))));
        assert!(prompt.resolved);
        assert_eq!(prompt.approved, Some(false));
        assert_eq!(prompt.note, None);
    }

    #[test]
    fn stamp_resolved_without_answer_preserves_an_earlier_echo() {
        // A stale-card cleanup (PendingGuard drop, resolve_stale_prompts) runs
        // with no answer; re-resolving must not erase what the user chose.
        let mut prompt = WirePrompt {
            kind: "question".into(),
            ..Default::default()
        };
        stamp_resolved(&mut prompt, Some(&answer(&["A"], true, None)));
        stamp_resolved(&mut prompt, None);
        assert!(prompt.resolved);
        assert_eq!(prompt.answers, vec!["A"]);
        assert_eq!(prompt.approved, Some(true));
    }

    fn bare_session() -> StoredChatSession {
        StoredChatSession {
            id: "chat_1".into(),
            project_id: "proj_1".into(),
            harness: "claude-code".into(),
            native_session_id: None,
            title: None,
            title_source: None,
            model: Some("claude-haiku-4-5".into()),
            permission_mode: None,
            reasoning_level: None,
            archived: false,
            context_usage_json: None,
            bootstrap_context: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn session_json_includes_context_usage_when_set_null_otherwise() {
        // No usage stored → the field is JSON null.
        let session = bare_session();
        assert!(session_json(&session, false)["contextUsage"].is_null());

        // Stored usage is inlined as a parsed object, not a string.
        let mut with_usage = bare_session();
        with_usage.context_usage_json =
            Some(r#"{"usedTokens":27564,"contextWindow":200000}"#.into());
        let value = session_json(&with_usage, false);
        assert_eq!(value["contextUsage"]["usedTokens"], 27564);
        assert_eq!(value["contextUsage"]["contextWindow"], 200000);
    }

    #[test]
    fn session_json_carries_title_source() {
        // The UI keys its title-reveal animation off this field, so it has to
        // survive to the wire — null on a legacy row, verbatim otherwise.
        assert!(session_json(&bare_session(), false)["titleSource"].is_null());

        let mut generated = bare_session();
        generated.title_source = Some("generated".into());
        assert_eq!(session_json(&generated, false)["titleSource"], "generated");
    }

    #[test]
    fn context_usage_serde_camel_cases_and_skips_none() {
        let usage = ContextUsage {
            used_tokens: 100,
            context_window: None,
        };
        // Only usedTokens survives; the None window is skipped.
        assert_eq!(
            serde_json::to_value(&usage).unwrap(),
            json!({ "usedTokens": 100 })
        );
    }
}

#[cfg(test)]
mod notify_target_tests {
    use super::*;
    use crate::store::{Store, StoredChatMessage, StoredChatSession, StoredRun};

    fn session(store: &Store, id: &str, project: &str, updated_at: i64, msgs: usize) {
        store
            .create_chat_session(&StoredChatSession {
                id: id.into(),
                project_id: project.into(),
                harness: "codex".into(),
                native_session_id: None,
                title: None,
                title_source: None,
                model: None,
                permission_mode: None,
                reasoning_level: None,
                archived: false,
                context_usage_json: None,
                bootstrap_context: None,
                created_at: 1,
                updated_at,
            })
            .unwrap();
        for i in 0..msgs {
            store
                .upsert_chat_message(&StoredChatMessage {
                    id: format!("{id}-m{i}"),
                    session_id: id.into(),
                    role: "user".into(),
                    parts_json: "[]".into(),
                    created_at: 1,
                })
                .unwrap();
        }
    }

    fn run(project: &str, owner: Option<&str>) -> StoredRun {
        StoredRun {
            id: "run_x".into(),
            experiment_id: "exp_1".into(),
            project_id: project.into(),
            status: "failed".into(),
            backend_json: "{}".into(),
            command: "echo hi".into(),
            created_at: 1,
            updated_at: 1,
            ended_at: None,
            exit_code: None,
            commit_sha: None,
            result_markdown: None,
            cancel_requested: false,
            chat_session_id: owner.map(str::to_string),
        }
    }

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("orx-notify-{tag}-{}", uuid::Uuid::new_v4()));
        (Store::open_at(dir.clone()).unwrap(), dir)
    }

    /// The reported bug: an idle bystander is the *most recently updated*
    /// session in the project, while an older session actually launched the
    /// run. Routing must follow ownership, not recency.
    #[test]
    fn routes_to_launcher_not_the_newest_bystander() {
        let (store, dir) = temp_store("owner");
        let proj = "p1";
        // Owner is older; bystander is the newest — what the old project-wide
        // heuristic would have wrongly picked.
        session(&store, "owner", proj, 100, 3);
        session(&store, "bystander", proj, 999, 3);

        let target = notify_target(&store, &run(proj, Some("owner")));
        assert_eq!(target.as_deref(), Some("owner"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A run with no recorded owner (CLI-launched / pre-migration) pokes no one
    /// — never a project-wide guess.
    #[test]
    fn orphan_run_notifies_no_one() {
        let (store, dir) = temp_store("orphan");
        session(&store, "bystander", "p1", 999, 3);
        assert_eq!(notify_target(&store, &run("p1", None)), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The owner must still exist and have history; an empty (or vanished)
    /// launcher is skipped rather than poked.
    #[test]
    fn empty_or_missing_owner_is_skipped() {
        let (store, dir) = temp_store("empty");
        session(&store, "empty_owner", "p1", 100, 0);
        assert_eq!(notify_target(&store, &run("p1", Some("empty_owner"))), None);
        assert_eq!(notify_target(&store, &run("p1", Some("ghost"))), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
