import { ArrowLeft, ArrowRight, Check, Copy, RefreshCw, X } from "lucide-react";
import { Wordmark } from "./Wordmark";
import { useEffect, useRef, useState } from "react";
import {
  getGitSettings,
  getHarnesses,
  getProfile,
  harnessModelLabel,
  searchPapers,
  setProfile,
  type GitSettings,
  type Harness,
  type LinkedPaper,
  type PaperHit,
} from "../api";
import { GitTokenForm } from "./GitTokenForm";
import { renderNote } from "./agentNote";
import { onHarnessAuth } from "../events";

const RETRY_COPY = "Couldn't reach orx. Check it's still running, then re-check.";

/** First-run walkthrough: the detected coding agents, then GitHub access, then a
 * short research-background prompt, then hand off to the (empty) projects page.
 * Step 1 gates — orx can't chat without a signed-in agent. Steps 2 and 3 don't:
 * cloning/pushing work over SSH keys, and the background (a blurb + linked
 * papers) is optional, saved best-effort so it never blocks finishing. The
 * data-dir choice lives in Settings → Storage (which can also *move* existing
 * data); usage analytics is opt-out via the CLI (`orx telemetry off`). */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [git, setGit] = useState<GitSettings | null>(null);
  const [checking, setChecking] = useState(false);
  // Step 3 (optional): a free-text background plus any alphaXiv papers linked
  // via title search. Prefilled from any saved profile so a replayed
  // walkthrough doesn't look empty.
  const [background, setBackground] = useState("");
  const [papers, setPapers] = useState<LinkedPaper[]>([]);
  const [paperQuery, setPaperQuery] = useState("");
  const [paperHits, setPaperHits] = useState<PaperHit[]>([]);
  const [searchingPapers, setSearchingPapers] = useState(false);
  const paperSeq = useRef(0);
  // Per-probe, not one shared flag: a git failure must not put a connectivity
  // error on the harness gate it has nothing to do with — or worse, hide the
  // actionable "sign in" hint behind it.
  const [harnessError, setHarnessError] = useState(false);
  const [gitError, setGitError] = useState(false);

  // Step 1 requires one genuinely usable harness. A failed or inconclusive
  // detection never bypasses the gate; the user can re-check without being
  // tricked into a chat configuration that cannot run.
  const anyAgentReady = harnesses?.some((h) => h.agentReady) ?? false;

  // Drives the nudge on step 2 only — that step doesn't gate, so an unknown
  // answer costs nothing.
  const githubConnected = git?.githubTokenSource != null;

  // Drops a slow probe whose answer a newer load — or a token save — has
  // already superseded, so a Save landing mid-refresh isn't overwritten by the
  // pre-save snapshot.
  const loadSeq = useRef(0);
  const load = (refresh: boolean, retryRejected = false) => {
    const seq = ++loadSeq.current;
    setChecking(true);
    setHarnessError(false);
    setGitError(false);
    const fresh = () => seq === loadSeq.current;
    void Promise.allSettled([
      getHarnesses(refresh, retryRejected).then((h) => fresh() && setHarnesses(h)),
      getGitSettings().then((g) => fresh() && setGit(g)),
    ])
      .then(([harness, git]) => {
        if (!fresh()) return;
        // Clear the stale answer too, so "errored", "loading" and "loaded"
        // stay mutually exclusive — otherwise a failed re-check leaves old
        // cards on screen saying "not signed in" while the gate un-gates.
        if (harness.status === "rejected") {
          setHarnessError(true);
          setHarnesses(null);
        }
        if (git.status === "rejected") {
          setGitError(true);
          setGit(null);
        }
      })
      // Not sequence-guarded: this is "a load is running", not data a stale
      // response could corrupt. Guarding it meant a token save (which bumps
      // loadSeq to supersede the probe) left `checking` true forever, with
      // both Re-check buttons dead for the rest of the session.
      .finally(() => setChecking(false));
  };
  useEffect(() => load(false), []);
  useEffect(
    () =>
      onHarnessAuth(() => {
        void getHarnesses(true)
          .then((next) => {
            setHarnesses(next);
            setHarnessError(false);
          })
          .catch(() => setHarnessError(true));
      }),
    [],
  );
  // Prefill from any saved profile — best-effort, never gates the step.
  useEffect(() => {
    void getProfile()
      .then((p) => {
        setBackground(p.background ?? "");
        setPapers(p.papers);
      })
      .catch(() => {});
  }, []);

  // Debounced title search; `paperSeq` drops superseded responses.
  useEffect(() => {
    const q = paperQuery.trim();
    if (q.length < 3) {
      setPaperHits([]);
      setSearchingPapers(false);
      return;
    }
    const seq = ++paperSeq.current;
    setSearchingPapers(true);
    const t = setTimeout(() => {
      searchPapers(q)
        .then((res) => seq === paperSeq.current && setPaperHits(res))
        .catch(() => seq === paperSeq.current && setPaperHits([]))
        .finally(() => seq === paperSeq.current && setSearchingPapers(false));
    }, 350);
    return () => clearTimeout(t);
  }, [paperQuery]);

  const addPaper = (h: PaperHit) => {
    setPapers((cur) =>
      cur.some((p) => p.paperId === h.paperId)
        ? cur
        : [...cur, { paperId: h.paperId, title: cleanPaperTitle(h.title) }],
    );
    setPaperQuery("");
    setPaperHits([]);
  };
  const removePaper = (id: string) => setPapers((cur) => cur.filter((p) => p.paperId !== id));

  // Persist the profile, then finish. Best-effort — an empty or failed save
  // must never trap the user on the last step.
  const finish = () => {
    void setProfile({ background: background.trim() || null, papers }).catch(() => {});
    onDone();
  };

  return (
    <div className="home onboarding">
      <div className="home-inner">
        {step === 0 ? (
          <>
            <div className="onb-eyebrow">
              <Wordmark /> · Step 1 of 3
            </div>
            <h2 className="onb-title">Your coding agents</h2>
            <p className="onb-sub">
              orx found the agent CLIs on this machine and drives them directly — chat and
              autoresearch run on your own logins, no extra API keys.
            </p>
            <div className="onb-cards">
              {harnesses !== null ? (
                harnesses.map((h) => <AgentCard key={h.id} h={h} />)
              ) : harnessError ? (
                // Never a spinner next to an error — detection isn't running.
                <div className="onb-card-meta">{RETRY_COPY}</div>
              ) : (
                <div className="onb-loading">
                  <span className="spinner" /> Detecting Claude Code, Codex, OpenCode…
                </div>
              )}
            </div>
            {harnesses !== null && !anyAgentReady && (
              <p className="onb-gate-hint">Sign in to at least one agent to continue.</p>
            )}
            <div className="onb-actions">
              <button className="btn ghost" onClick={() => load(true, true)} disabled={checking}>
                <RefreshCw size={12} className={checking ? "spin" : ""} /> Re-check
              </button>
              <div style={{ flex: 1 }} />
              <button
                className="btn primary"
                onClick={() => setStep(1)}
                disabled={!anyAgentReady}
                title={
                  anyAgentReady ? undefined : "Sign in to at least one coding agent to continue"
                }
              >
                Continue <ArrowRight size={13} />
              </button>
            </div>
          </>
        ) : step === 1 ? (
          <>
            <div className="onb-eyebrow">
              <Wordmark /> · Step 2 of 3
            </div>
            <h2 className="onb-title">Connect GitHub</h2>
            <p className="onb-sub">
              orx clones your GitHub repos and pushes each experiment as a branch.
            </p>
            <div className="onb-cards">
              {gitError ? (
                <div className="onb-card-meta">{RETRY_COPY}</div>
              ) : (
                <GitCard
                  git={git}
                  onUpdate={(g) => {
                    // A save is newer than any probe still in flight.
                    loadSeq.current++;
                    setGit(g);
                    setGitError(false);
                  }}
                />
              )}
            </div>
            {/* Soft, and honestly so: cloning and pushing work over SSH keys
                (ensure_clone tries ssh first), so a token is a convenience,
                not a requirement. State what's missing; never block on it. A
                disabled Continue beside an enabled Skip just reads as a bug. */}
            {git !== null && !githubConnected && (
              <p className="onb-gate-hint">
                Without GitHub access, orx can&apos;t create repos for you — cloning and pushing
                still work if you have SSH keys.
              </p>
            )}
            <div className="onb-actions">
              <button className="btn ghost" onClick={() => setStep(0)}>
                <ArrowLeft size={12} /> Back
              </button>
              <button className="btn ghost" onClick={() => load(false)} disabled={checking}>
                <RefreshCw size={12} className={checking ? "spin" : ""} /> Re-check
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn primary" onClick={() => setStep(2)}>
                Continue <ArrowRight size={13} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="onb-eyebrow">
              <Wordmark /> · Step 3 of 3
            </div>
            <h2 className="onb-title">Tell us about your research</h2>
            <p className="onb-sub">
              A sentence or two about what you work on helps orx tailor its research — and link any
              alphaXiv papers it should know. All optional; you can skip and add this later.
            </p>
            <div className="onb-cards">
              <div className="onb-card">
                <textarea
                  className="onb-textarea"
                  value={background}
                  onChange={(e) => setBackground(e.target.value)}
                  rows={4}
                  placeholder="e.g. I work on sample-efficient RL for LLM post-training, focused on reward-model-free methods."
                />
                <div className="onb-paper-search">
                  <input
                    value={paperQuery}
                    onChange={(e) => setPaperQuery(e.target.value)}
                    placeholder="Search alphaXiv by title to link a paper…"
                  />
                  {searchingPapers ? (
                    <div className="onb-card-meta">Searching alphaXiv…</div>
                  ) : paperHits.length > 0 ? (
                    <div className="onb-paper-results">
                      {paperHits.map((h) => (
                        <button key={h.paperId} type="button" onClick={() => addPaper(h)}>
                          <span className="title">{cleanPaperTitle(h.title)}</span>
                          <span className="id">{h.paperId}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {papers.length > 0 && (
                  <div className="onb-paper-chips">
                    {papers.map((p) => (
                      <span key={p.paperId} className="onb-paper-chip">
                        <span className="title">{p.title || p.paperId}</span>
                        <span className="id">{p.paperId}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${p.paperId}`}
                          onClick={() => removePaper(p.paperId)}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* The data dir moved to Settings → Storage; still disclose where
                things land so the location isn't a surprise. */}
            <p className="onb-aside-text" style={{ marginTop: 12 }}>
              Your background stays on this machine, alongside your database, run logs, and
              artifacts — change where they live any time in Settings → Storage.
            </p>
            <div className="onb-actions">
              <button className="btn ghost" onClick={() => setStep(1)}>
                <ArrowLeft size={12} /> Back
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn primary" onClick={finish}>
                Create your first project <ArrowRight size={13} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Fast-search titles carry scrape cruft: "[1706.03762] Title - arXiv".
 * Kept in sync with NewProjectForm's cleanTitle. */
function cleanPaperTitle(title: string): string {
  return title.replace(/^\[[^\]]*\]\s*/, "").replace(/\s*[-–|]\s*arXiv\s*$/i, "");
}

/** A shell command plus its own copy button, sharing one border so the button
 * reads as part of the command. Each chip owns its "Copied" state. */
function CmdChip({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <span className="onb-cmd-chip">
      <code>{cmd}</code>
      <button
        className="onb-cmd-copy"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy command"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check size={13} strokeWidth={3} /> : <Copy size={13} />}
      </button>
    </span>
  );
}

/** Agent notes carry the command to run in backticks (`claude auth login`) —
 * render those spans as code so they read as something to type, not prose. */
function agentBadge(h: Harness): { cls: string; label: string } {
  if (h.agentReady) return { cls: "st-done", label: "Signed in" };
  if (!h.installed) return { cls: "st-idle", label: "Not detected" };
  if (h.authState === "unknown") return { cls: "st-starting", label: "Unable to verify" };
  if (h.authState === "unsupported") return { cls: "st-starting", label: "Update required" };
  if (h.installed) return { cls: "st-starting", label: "Not signed in" };
  return { cls: "st-idle", label: "Not detected" };
}

function AgentCard({ h }: { h: Harness }) {
  const badge = agentBadge(h);
  const version = h.version?.replace(/\s*\(.*\)$/, "");
  return (
    <div className="onb-card">
      <div className="onb-card-head">
        <span className="onb-card-name">{h.name}</span>
        <span className={`status-badge ${badge.cls}`}>
          {h.agentReady ? <Check size={12} strokeWidth={3} /> : <span className="dot" />}
          {badge.label}
        </span>
      </div>
      {h.agentReady ? (
        <>
          <div className="onb-card-detail mono">
            {h.account ?? "API key"}
            {h.plan ? ` · ${h.plan}` : ""}
          </div>
          <div className="onb-card-meta">
            {[
              version,
              h.models.length > 0 &&
                `${h.models.length} model${h.models.length === 1 ? "" : "s"} — ${h.models
                  .slice(0, 3)
                  .map((m) => harnessModelLabel(m))
                  .join(", ")}${h.models.length > 3 ? ", …" : ""}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </>
      ) : (
        <div className="onb-card-meta">{renderNote(h.agentNote)}</div>
      )}
    </div>
  );
}

function GitCard({
  git,
  onUpdate,
}: {
  git: GitSettings | null;
  onUpdate: (g: GitSettings) => void;
}) {
  // The PAT form is the fallback, not a peer of `gh auth login` — keep it
  // behind a disclosure so the card offers one obvious action per row.
  const [tokenOpen, setTokenOpen] = useState(false);
  if (git === null) {
    return (
      <div className="onb-loading">
        <span className="spinner" /> Checking git…
      </div>
    );
  }
  if (!git.gitVersion) {
    return (
      <div className="onb-card">
        <div className="onb-card-head">
          <span className="onb-card-name">git</span>
          <span className="status-badge st-failed">
            <span className="dot" /> Not found
          </span>
        </div>
        <div className="onb-card-meta">Install git to clone projects, then re-open orx.</div>
      </div>
    );
  }
  const identity = [git.userName, git.userEmail && `<${git.userEmail}>`]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="onb-card">
      <div className="onb-card-row">
        <span className="onb-card-name">GitHub</span>
        <span className="onb-card-detail mono">
          {git.githubTokenSource === "env"
            ? "Token from GITHUB_TOKEN"
            : git.githubTokenSource === "stored"
              ? "Token saved in orx"
              : git.githubTokenSource === "gh"
                ? "Signed in via gh CLI"
                : ""}
        </span>
        <span className={`status-badge ${git.githubTokenSource ? "st-done" : "st-starting"}`}>
          {git.githubTokenSource ? <Check size={12} strokeWidth={3} /> : <span className="dot" />}
          {git.githubTokenSource ? "Connected" : "Not connected"}
        </span>
      </div>
      {!git.githubTokenSource && (
        <>
          <div className="onb-fix">
            <span className="onb-fix-label">
              {tokenOpen
                ? "Paste a personal access token:"
                : git.ghInstalled
                  ? "Run this in your terminal to sign in:"
                  : "Install the GitHub CLI, then run this to sign in:"}
            </span>
            <button className="onb-fix-alt" onClick={() => setTokenOpen((v) => !v)}>
              {tokenOpen ? "Use gh instead" : "Paste a token instead"}
            </button>
          </div>
          {tokenOpen ? <GitTokenForm onSaved={onUpdate} /> : <CmdChip cmd="gh auth login" />}
        </>
      )}
      {!identity && (
        <div className="onb-aside">
          <div className="onb-aside-text">
            Optional — so the agent&apos;s commits are attributed to you:
          </div>
          <CmdChip cmd={`git config --global user.name "Your Name" && git config --global user.email "you@example.com"`} />
        </div>
      )}
    </div>
  );
}
