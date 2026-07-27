//! Cross-harness turn options — the permission mode and reasoning level a chat
//! session runs under. These are the vocabulary the UI toggles speak; each
//! harness advertises which values it supports (`options()`) and maps the
//! chosen value onto its own CLI (in its `run_turn`).
//!
//! The two axes are modeled differently on purpose:
//!
//! * Permission mode is a *shared* enum — the concept (ask / accept-edits /
//!   plan / auto / bypass) is common enough to name once. Its wire ids are
//!   harness-agnostic (`ask` / `accept-edits` / `plan` / `auto` / `bypass`);
//!   each harness maps the enum onto its own control surface in `run_turn`
//!   (Claude → `--permission-mode`, Codex → `--sandbox` policy). The ids were
//!   neutralized off Claude's `--permission-mode` spelling once Codex landed and
//!   its sandbox policies didn't map onto Claude's strings — see the store data
//!   migration in `store.rs` that rewrites the old spellings.
//! * Reasoning level is deliberately NOT shared, and is now per *model* as well
//!   as per harness (issue #123). Claude's `--effort` tiers, Codex's
//!   `model_reasoning_effort` and OpenCode's `variant` genuinely differ, and
//!   within a harness they differ by model too: Codex's `ultra` is Sol/Terra
//!   only, OpenCode's variants are declared per model in its catalog, and
//!   Claude's `ultracode` depends on the installed CLI version. So the real
//!   choices ride on [`ModelInfo::reasoning_levels`](super::ModelInfo), and the
//!   list here is only the harness-wide fallback for a model with none.
//!
//! Every reasoning list leads with [`REASONING_DEFAULT_ID`] and defaults to it,
//! so the composer sends no override unless the user picks one — selecting a
//! model must never silently replace the CLI's own configured effort.
//!
//! A harness that doesn't support an axis lists nothing for it, and the composer
//! hides that control.

use serde::{Deserialize, Serialize};

/// How much the harness should defer to the user before acting. The wire ids
/// are harness-agnostic (`ask`, `accept-edits`, `plan`, `auto`, `bypass`); each
/// harness maps the enum onto its own control surface in `run_turn` (Claude →
/// `--permission-mode`, Codex → `--sandbox`). `auto` is distinct from
/// `accept-edits` (it's Claude's balanced default mode).
///
/// Not every harness supports every mode — a harness advertises its supported
/// subset via `options()` and the composer only offers those. `plan`, for
/// instance, is Claude + OpenCode + Codex (each with its own machinery): Claude's
/// plan mode pairs with a `PreToolUse` hook so read-only `orx` inspection still
/// runs (see `plan_gate`); OpenCode has a native read-only `plan` agent; Codex
/// attaches a native `collaborationMode` mask over the app-server (its own
/// plan.md template — restriction is prompt-level, not sandbox-level).
/// `ask`/`accept-edits` are the modes not every harness carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    /// Prompt for every action. (`ask`)
    Ask,
    /// Auto-accept file edits; still prompt for other tools. (`accept-edits`)
    AcceptEdits,
    /// Read/plan only — propose without executing. (`plan`)
    Plan,
    /// Claude Code's default balanced auto mode. (`auto`)
    Auto,
    /// No prompts at all. (`bypass`)
    Bypass,
}

impl PermissionMode {
    /// The stable, harness-agnostic wire id (what the UI stores and sends). Each
    /// harness maps this to its own CLI/API in `run_turn`.
    pub fn id(self) -> &'static str {
        match self {
            PermissionMode::Ask => "ask",
            PermissionMode::AcceptEdits => "accept-edits",
            PermissionMode::Plan => "plan",
            PermissionMode::Auto => "auto",
            PermissionMode::Bypass => "bypass",
        }
    }

    /// Menu label shown in the composer's permission-mode toggle.
    pub fn label(self) -> &'static str {
        match self {
            PermissionMode::Ask => "Ask permissions",
            PermissionMode::AcceptEdits => "Accept edits",
            PermissionMode::Plan => "Plan mode",
            PermissionMode::Auto => "Auto mode",
            PermissionMode::Bypass => "Bypass permissions",
        }
    }

    /// Parse a wire id back to a mode. Unknown ids fall back to `None` so the
    /// caller can apply its own default.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "ask" => Some(PermissionMode::Ask),
            "accept-edits" => Some(PermissionMode::AcceptEdits),
            "plan" => Some(PermissionMode::Plan),
            "auto" => Some(PermissionMode::Auto),
            "bypass" => Some(PermissionMode::Bypass),
            _ => None,
        }
    }
}

/// One selectable value in a composer toggle (id + human label). Ids are owned
/// because the reasoning axis is now *model*-derived: OpenCode's choices come
/// from `opencode models --verbose` at detect time, so they can't be
/// `&'static str`. Permission modes still pass their static ids in, via
/// [`OptionChoice::new`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionChoice {
    pub id: String,
    pub label: String,
}

impl OptionChoice {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
        }
    }
}

/// The wire id meaning "send no explicit effort/variant — let the harness CLI
/// and its own config decide". This is a *sentinel*, never passed to a CLI: the
/// per-harness mappers (`claude_effort`, `codex_reasoning`, `opencode_variant`)
/// all resolve it to `None`.
///
/// It exists because "no override" and "the harness's suggested level" are
/// genuinely different states. Before this, the WebUI always sent an explicit
/// per-turn effort, which silently overrode a user's configured
/// `model_reasoning_effort = "max"` in `~/.codex/config.toml` (issue #123).
pub const REASONING_DEFAULT_ID: &str = "default";

/// Human label for a raw effort/variant id. Native ids are lowercase words
/// (`low`, `xhigh`, `ultracode`), so title-casing covers all of them bar
/// `xhigh`, whose display casing is `XHigh`.
fn reasoning_label(id: &str) -> String {
    match id {
        "xhigh" => "XHigh".to_string(),
        // Unknown native ids still render — an id the CLI genuinely accepts is
        // better shown title-cased than dropped.
        other => super::detect::title_case(other),
    }
}

/// Native ids → labeled choices, no sentinel. For models whose *actual*
/// default tier is known (codex reports `defaultReasoningEffort`), the picker
/// preselects that concrete tier instead of offering a "no override" row —
/// sending the tier the CLI would resolve anyway is equivalent, and the user
/// sees a real value.
pub fn reasoning_tiers(ids: &[&str]) -> Vec<OptionChoice> {
    ids.iter()
        // Skip a native id that collides with the sentinel: it would render
        // as a second row that selects "no override" instead of the tier.
        // The ids come from the CLIs' catalogs verbatim, so this is the
        // catalog's call, not ours.
        .filter(|id| **id != REASONING_DEFAULT_ID)
        .map(|id| OptionChoice::new(*id, reasoning_label(id)))
        .collect()
}

/// Build a reasoning list from native ids, led by the `Default` choice — which
/// sends no override at all. For harnesses where "no override" is genuinely
/// different from every listed tier: Claude's unset effort means *adaptive*
/// (not any fixed level), and opencode reports no per-model default to
/// preselect.
pub fn reasoning_choices(ids: &[&str]) -> Vec<OptionChoice> {
    std::iter::once(OptionChoice::new(REASONING_DEFAULT_ID, "Default"))
        .chain(reasoning_tiers(ids))
        .collect()
}

/// A stored reasoning id → the value to actually send, or `None` for "no
/// override". Shared by all three harnesses so the sentinel rule lives in one
/// place; each passes the `allowed` set it computes for the selected model.
///
/// `None` covers three cases that must all leave the CLI's own configured
/// effort alone: the `default` sentinel, a stale stored level the selected
/// model doesn't accept, and junk.
pub fn resolve_reasoning<'a>(level: Option<&'a str>, allowed: &[&str]) -> Option<&'a str> {
    let level = level?;
    (level != REASONING_DEFAULT_ID && allowed.contains(&level)).then_some(level)
}

/// The toggle vocabulary a harness supports, sent to the UI so it can render
/// only valid choices and pre-select the harness's defaults. An empty list for
/// an axis means "this harness has no such control" and the UI hides it.
///
/// The reasoning axis here is the harness-wide *fallback*: the choices shown
/// when the selected model has no per-model list of its own. Model-specific
/// choices ride on [`ModelInfo::reasoning_levels`](super::ModelInfo) and take
/// precedence in the composer — see `reasoningFor` in `ui/src/api.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessOptions {
    pub permission_modes: Vec<OptionChoice>,
    pub default_permission_mode: Option<&'static str>,
    pub reasoning_levels: Vec<OptionChoice>,
    pub default_reasoning_level: Option<String>,
}

impl HarnessOptions {
    /// A harness with neither control (the trait default).
    pub fn none() -> Self {
        Self {
            permission_modes: Vec::new(),
            default_permission_mode: None,
            reasoning_levels: Vec::new(),
            default_reasoning_level: None,
        }
    }

    pub fn with_permission_modes(
        mut self,
        modes: &[PermissionMode],
        default: PermissionMode,
    ) -> Self {
        self.permission_modes = modes
            .iter()
            .map(|m| OptionChoice::new(m.id(), m.label()))
            .collect();
        self.default_permission_mode = Some(default.id());
        self
    }

    /// Set the harness-wide fallback reasoning list from native ids. Unlike
    /// permission modes, reasoning vocabulary isn't shared — Claude's `--effort`
    /// tiers, Codex's `model_reasoning_effort` and OpenCode's `variant` genuinely
    /// differ — so each harness passes its own ids and interprets the chosen one
    /// in its `run_turn`.
    ///
    /// The list is always led by the `Default` choice, and `Default` is always
    /// the default selection: the composer must not send an explicit override
    /// unless the user picks one (issue #123).
    pub fn with_reasoning_levels(mut self, ids: &[&str]) -> Self {
        self.reasoning_levels = reasoning_choices(ids);
        self.default_reasoning_level = Some(REASONING_DEFAULT_ID.to_string());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire ids are the store/UI contract — pin them so a rename is a
    /// deliberate, test-breaking change (and a reminder to add a data migration).
    #[test]
    fn wire_ids_are_the_neutralized_spelling() {
        assert_eq!(PermissionMode::Ask.id(), "ask");
        assert_eq!(PermissionMode::AcceptEdits.id(), "accept-edits");
        assert_eq!(PermissionMode::Plan.id(), "plan");
        assert_eq!(PermissionMode::Auto.id(), "auto");
        assert_eq!(PermissionMode::Bypass.id(), "bypass");
    }

    #[test]
    fn from_id_round_trips_every_mode() {
        for mode in [
            PermissionMode::Ask,
            PermissionMode::AcceptEdits,
            PermissionMode::Plan,
            PermissionMode::Auto,
            PermissionMode::Bypass,
        ] {
            assert_eq!(PermissionMode::from_id(mode.id()), Some(mode));
        }
    }

    #[test]
    fn from_id_rejects_the_old_claude_spellings_and_junk() {
        // The pre-migration spellings must NOT parse — a stale row is normalized
        // by the store migration, not silently reinterpreted here.
        for old in [
            "default",
            "acceptEdits",
            "bypassPermissions",
            "",
            "nonsense",
        ] {
            assert_eq!(PermissionMode::from_id(old), None, "{old} should not parse");
        }
    }

    #[test]
    fn permission_mode_serde_uses_kebab_ids() {
        // The enum is serialized directly in some payloads; its serde form must
        // match the wire ids (kebab-case), not the Rust variant names.
        let json = serde_json::to_string(&PermissionMode::AcceptEdits).unwrap();
        assert_eq!(json, "\"accept-edits\"");
        let back: PermissionMode = serde_json::from_str("\"bypass\"").unwrap();
        assert_eq!(back, PermissionMode::Bypass);
    }
}
