//! Native modular agent skills for `orx`.
//!
//! The monolithic `orx skill` overview (repo-root `SKILL.md`) is factored into a
//! handful of focused modules that live as **literal, complete skill files** in
//! the repo `agent-skills/` directory (`agent-skills/<name>/SKILL.md`,
//! frontmatter included — readable as-is on GitHub) and are embedded in the
//! binary at compile time and installed verbatim. Two consumers use them:
//!
//! * **Local `orx up` sessions** get the [`SkillSet::Local`] modules written as
//!   native `SKILL.md` skill dirs *into the session worktree* — fresh on every
//!   turn, right beside the playbook (see [`ensure_session_skills`]). The harness
//!   picks the skills subdir (`.claude/skills`, `.opencode/skills`,
//!   `.agents/skills`), so the session's own agent auto-discovers them and never
//!   sees drift.
//! * **`orx skill <name>`** resolves a bundled module (with or without the
//!   `orx-` prefix) and prints it; the no-arg overview lists the same set.
//!   `orx install-skills --full` writes the Full set into an agent's global
//!   skills dir.
//!
//! Every module has one canonical `SKILL.md`. The Local set omits onboarding
//! because a session already has a project; the Full set includes it. The
//! `orx-` prefix on every dir name makes modules unmistakable in a skill list.

use std::path::Path;

use crate::error::{anyhow, Result};

/// One embedded skill module: its public name (== skill dir name == the `name:`
/// frontmatter field), a one-line description (mirrored in the file's
/// frontmatter — a test enforces they agree), and the complete `SKILL.md`
/// contents, installed and printed verbatim.
pub struct AgentSkill {
    pub name: &'static str,
    pub description: &'static str,
    pub content: &'static str,
}

/// Which module set to serve. Both sets use the same canonical module bodies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkillSet {
    /// Skills installed into an active `orx up` project session.
    Local,
    /// The complete set, including local project onboarding guidance.
    Full,
}

// --- Module files (embedded verbatim from the repo `agent-skills/` dir) ------

const COMPUTE: &str = include_str!("../../agent-skills/orx-compute/SKILL.md");
const COMPUTE_K8S: &str = include_str!("../../agent-skills/orx-compute-k8s/SKILL.md");
const EXPERIMENT_TREE: &str = include_str!("../../agent-skills/orx-experiment-tree/SKILL.md");
const GIT: &str = include_str!("../../agent-skills/orx-git/SKILL.md");
const LIT: &str = include_str!("../../agent-skills/orx-lit/SKILL.md");
const CREATE: &str = include_str!("../../agent-skills/orx-create/SKILL.md");
const REPORTS: &str = include_str!("../../agent-skills/orx-reports/SKILL.md");
const EVIDENCE: &str = include_str!("../../agent-skills/orx-evidence/SKILL.md");

// Descriptions are the *trigger surface*: what the module covers plus explicit,
// liberal "Use when …" cues (false positives beat false negatives — an agent
// that loads a module needlessly wastes a little context; one that misses it
// works blind). Keep each ≤400 chars — Codex's ambient budget is ~8k across
// the whole set.

const D_COMPUTE: &str = "Launch experiment runs with `orx exp run`: backends (hf, modal, k8s, ssh, slurm, ray, openresearch, local), flavors, timeouts, images, sizing, and choosing `orx exp wait` vs `orx exp wake`. Use before launching or re-launching any run, when choosing or switching a backend or GPU flavor, when a job OOMs, stalls, or times out, or when deciding GPU vs CPU.";
const D_EXPERIMENT_TREE: &str = "The experiment-tree model and the auto-research loop: shape the tree (stacked bushes), branch/launch/wait/promote, and `orx exp desc` notes. Use before creating, planning, or reorganizing experiments, when deciding what to try next, when a round of runs finishes, or whenever you're unsure how work maps onto the tree.";

const S_COMPUTE: AgentSkill = AgentSkill {
    name: "orx-compute",
    description: D_COMPUTE,
    content: COMPUTE,
};
const S_COMPUTE_K8S: AgentSkill = AgentSkill {
    name: "orx-compute-k8s",
    description: "Run an experiment on your own Kubernetes cluster (`orx exp run --backend k8s`): the single-pod committed-manifest contract orx enforces at submit. Use when the user names k8s, kubernetes, or a cluster, before writing or editing `.orx/k8s.yaml`, or when a k8s submit is rejected.",
    content: COMPUTE_K8S,
};
const S_EXPERIMENT_TREE: AgentSkill = AgentSkill {
    name: "orx-experiment-tree",
    description: D_EXPERIMENT_TREE,
    content: EXPERIMENT_TREE,
};
const S_GIT: AgentSkill = AgentSkill {
    name: "orx-git",
    description: "Read, edit, commit, and diff experiment code with local Git. Use whenever you touch an experiment branch, compare nodes, prepare a run, or diagnose stale code.",
    content: GIT,
};
const S_LIT: AgentSkill = AgentSkill {
    name: "orx-lit",
    description: "Search and read research papers. The main agent calls alphaXiv, OpenAlex, and bioRxiv discovery primitives, ranks the combined candidates, and chooses sources for focused follow-ups. Use for literature reviews, related work, prior art, papers, authors, methods, benchmarks, or research claims; never delegate the retrieval loop to a sub-agent.",
    content: LIT,
};
const S_CREATE: AgentSkill = AgentSkill {
    name: "orx-create",
    description: "Initialize a local project with `orx up` and add local experiment nodes with `orx create-experiment`. Use when starting a project or experiment, when the local tree is empty, or when choosing a baseline, parent, or run command.",
    content: CREATE,
};
const S_REPORTS: AgentSkill = AgentSkill {
    name: "orx-reports",
    description: "Write durable research outputs into the local project's artifacts directory. Use when a line of work concludes, when the user asks for a write-up, summary, comparison, figures, or exported data, or before ending a long task — findings not written down are lost.",
    content: REPORTS,
};
const S_EVIDENCE: AgentSkill = AgentSkill {
    name: "orx-evidence",
    description: "Analyze run results through `orx logs`. Use after any run reaches a terminal state, before declaring a run a success or failure, when metrics are missing from output, or when designing what a run command should print.",
    content: EVIDENCE,
};

/// The modules for a given set, in a stable order. Full adds `create`; every
/// shared module uses the same canonical `SKILL.md`.
pub fn skills(set: SkillSet) -> Vec<&'static AgentSkill> {
    match set {
        SkillSet::Local => vec![
            &S_EXPERIMENT_TREE,
            &S_GIT,
            &S_COMPUTE,
            &S_COMPUTE_K8S,
            &S_EVIDENCE,
            &S_REPORTS,
            &S_LIT,
        ],
        SkillSet::Full => vec![
            &S_CREATE,
            &S_EXPERIMENT_TREE,
            &S_GIT,
            &S_COMPUTE,
            &S_COMPUTE_K8S,
            &S_EVIDENCE,
            &S_REPORTS,
            &S_LIT,
        ],
    }
}

/// Resolve a bundled skill by name within `set`, accepting both the public name
/// (`orx-compute`) and the bare form (`compute`). Returns `None` for an unknown
/// bundled name.
pub fn find(name: &str, set: SkillSet) -> Option<&'static AgentSkill> {
    let want = name.trim();
    skills(set)
        .into_iter()
        .find(|s| s.name == want || s.name.strip_prefix("orx-") == Some(want))
}

/// Write the [`SkillSet::Local`] modules as `<worktree>/<skills_dir_rel>/<name>/SKILL.md`,
/// overwriting every file on every call (same freshness semantics as the
/// playbook — zero drift). Returns `Err` on the first write failure; the caller
/// treats it like a playbook-write error.
pub fn ensure_session_skills(worktree: &Path, skills_dir_rel: &str) -> Result<()> {
    let base = worktree.join(skills_dir_rel);
    for skill in skills(SkillSet::Local) {
        let dir = base.join(skill.name);
        std::fs::create_dir_all(&dir)
            .map_err(|e| anyhow!("Could not create {}: {}", dir.display(), e))?;
        let path = dir.join("SKILL.md");
        std::fs::write(&path, skill.content)
            .map_err(|e| anyhow!("Could not write {}: {}", path.display(), e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn is_valid_name(name: &str) -> bool {
        // ^[a-z0-9]+(-[a-z0-9]+)*$
        !name.is_empty()
            && name.split('-').all(|seg| {
                !seg.is_empty()
                    && seg
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            })
    }

    #[test]
    fn names_are_valid_unique_and_prefixed() {
        for set in [SkillSet::Local, SkillSet::Full] {
            let mut seen = HashSet::new();
            for s in skills(set) {
                assert!(
                    is_valid_name(s.name),
                    "{:?}: invalid name {:?}",
                    set,
                    s.name
                );
                assert!(
                    s.name.starts_with("orx-"),
                    "{:?}: name {:?} not orx- prefixed",
                    set,
                    s.name
                );
                assert!(
                    seen.insert(s.name),
                    "{:?}: duplicate name {:?}",
                    set,
                    s.name
                );
            }
        }
    }

    #[test]
    fn descriptions_are_within_bounds() {
        for set in [SkillSet::Local, SkillSet::Full] {
            for s in skills(set) {
                let len = s.description.chars().count();
                assert!(
                    (1..=400).contains(&len),
                    "{:?}: {} description is {} chars (want 1..=400)",
                    set,
                    s.name,
                    len
                );
            }
        }
    }

    #[test]
    fn file_frontmatter_matches_code_and_is_valid_yaml() {
        // The skill files under `agent-skills/` are the literal installed
        // artifacts (embedded verbatim), so their frontmatter must agree with
        // the code's name/description — this is the drift guard between the
        // GitHub-readable files and the indexes generated from the consts.
        for set in [SkillSet::Local, SkillSet::Full] {
            for s in skills(set) {
                let mut lines = s.content.lines();
                assert_eq!(lines.next(), Some("---"), "{} missing opening ---", s.name);
                let name_line = lines.next().unwrap_or_default();
                let desc_line = lines.next().unwrap_or_default();
                assert_eq!(
                    name_line,
                    format!("name: {}", s.name),
                    "{} name frontmatter",
                    s.name
                );

                // The description value must be YAML-safe. The files carry it
                // as a JSON-quoted scalar; strip `description: ` and JSON-decode
                // — the round-trip proves the quoting is well-formed and that
                // the file agrees with the code's description. A bare
                // (unquoted) value containing `: ` — the bug this guards —
                // would not JSON-decode.
                let value = desc_line
                    .strip_prefix("description: ")
                    .unwrap_or_else(|| panic!("{} description frontmatter shape", s.name));
                let decoded: String = serde_json::from_str(value).unwrap_or_else(|e| {
                    panic!("{} description is not a quoted scalar: {e}", s.name)
                });
                assert_eq!(decoded, s.description, "{} description round-trip", s.name);
                // A quoted scalar is a single physical line — no embedded newline.
                assert!(
                    !s.description.contains('\n'),
                    "{} description has a newline",
                    s.name
                );

                assert_eq!(lines.next(), Some("---"), "{} missing closing ---", s.name);
                // A non-empty body follows the closing frontmatter fence
                // (`\n---\n\n` separates the frontmatter block from the body).
                let body = s
                    .content
                    .split_once("\n---\n\n")
                    .map(|(_, body)| body)
                    .unwrap_or("");
                assert!(!body.trim().is_empty(), "{} has an empty body", s.name);
            }
        }
    }

    #[test]
    fn find_resolves_prefixed_and_bare() {
        for set in [SkillSet::Local, SkillSet::Full] {
            assert_eq!(
                find("orx-compute", set).map(|s| s.name),
                Some("orx-compute")
            );
            assert_eq!(find("compute", set).map(|s| s.name), Some("orx-compute"));
            assert!(find("does-not-exist", set).is_none());
            assert!(find("project-query", set).is_none());
        }
        // `orx-create` is Full-only — a local session has no create surface.
        assert_eq!(
            find("orx-create", SkillSet::Full).map(|s| s.name),
            Some("orx-create")
        );
        assert_eq!(
            find("create", SkillSet::Full).map(|s| s.name),
            Some("orx-create")
        );
        assert!(find("orx-create", SkillSet::Local).is_none());
    }

    #[test]
    fn shared_skills_use_one_canonical_body() {
        for name in ["experiment-tree", "git", "compute", "evidence", "reports"] {
            let local = find(name, SkillSet::Local).expect("local skill");
            let full = find(name, SkillSet::Full).expect("full skill");
            assert_eq!(local.content, full.content, "{name} body");
        }
    }

    #[test]
    fn reports_skill_links_written_artifacts() {
        assert!(REPORTS.contains("cite every relevant output as raw"));
        assert!(REPORTS.contains("<file path=\"artifacts/<relative-path>\" />"));
        assert!(REPORTS.contains("never as a bare or backticked path"));
    }

    #[test]
    fn ensure_session_skills_writes_local_set_idempotently() {
        let tmp = std::env::temp_dir().join(format!(
            "orx-agent-skills-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let rel = ".claude/skills";
        ensure_session_skills(&tmp, rel).unwrap();

        let base = tmp.join(rel);
        let expected: HashSet<&str> = skills(SkillSet::Local).iter().map(|s| s.name).collect();
        let got: HashSet<String> = std::fs::read_dir(&base)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        let got_refs: HashSet<&str> = got.iter().map(String::as_str).collect();
        assert_eq!(got_refs, expected, "wrote exactly the Local-set dirs");

        for s in skills(SkillSet::Local) {
            let path = base.join(s.name).join("SKILL.md");
            let content = std::fs::read_to_string(&path).unwrap();
            assert_eq!(content, s.content, "{} SKILL.md content", s.name);
        }

        // Idempotent: a second call overwrites in place and changes nothing.
        ensure_session_skills(&tmp, rel).unwrap();
        let got2: HashSet<String> = std::fs::read_dir(&base)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(got2, got, "second call is idempotent");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unified_git_and_compute_skills_are_written_to_sessions() {
        let tmp =
            std::env::temp_dir().join(format!("orx-unified-skills-test-{}", uuid::Uuid::new_v4()));
        let rel = ".agents/skills";
        ensure_session_skills(&tmp, rel).unwrap();
        let git = std::fs::read_to_string(tmp.join(rel).join("orx-git/SKILL.md")).unwrap();
        assert!(git.contains("never part of compute transport"));
        assert!(git.contains("do not push merely to launch compute"));
        let compute = std::fs::read_to_string(tmp.join(rel).join("orx-compute/SKILL.md")).unwrap();
        assert!(compute.contains("immutable source snapshot"));
        assert!(compute.contains("Hugging Face Jobs"));
        assert!(tmp.join(rel).join("orx-compute-k8s").exists());
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn bundled_skills_avoid_openresearch_ui_navigation() {
        for set in [SkillSet::Local, SkillSet::Full] {
            for skill in skills(set) {
                crate::local::assert_agent_guidance_is_ui_agnostic(skill.name, skill.content);
                crate::local::assert_agent_guidance_is_ui_agnostic(skill.name, skill.description);
            }
        }
    }
}
