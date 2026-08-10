import { ArrowLeft, ArrowRight, Check, RefreshCw, X } from "lucide-react";
import { Wordmark } from "./Wordmark";
import { useEffect, useRef, useState } from "react";
import {
  getHarnesses,
  getProfile,
  getProjectPathStatus,
  harnessModelLabel,
  completeOnboarding,
  reasoningFor,
  searchPapers,
  type AgentSelection,
  type Harness,
  type HarnessId,
  type LinkedPaper,
  type PaperHit,
  type Project,
} from "../api";
import { renderNote } from "./agentNote";
import { HarnessLogo } from "./HarnessLogo";
import { onHarnessAuth } from "../events";

const RETRY_COPY = "Couldn't reach orx. Check it's still running, then re-check.";
const RESEARCH_AREAS = ["AI/ML", "Biology", "Physics", "Other"];

/** First-run walkthrough: choose a local coding agent, verify Git, add a
 * research profile, then install and open the demo project. The local tool
 * checks gate setup; the profile is saved best-effort so it never blocks
 * installation. The data-dir choice lives in
 * Settings → Storage (which can also *move* existing data); usage analytics is
 * opt-out via the CLI (`orx telemetry off`). */
export function Onboarding({
  onDone,
  preferredAgent,
}: {
  onDone: (project: Project, selection: AgentSelection) => void;
  preferredAgent: AgentSelection | null;
}) {
  const [step, setStep] = useState<0 | 1>(0);
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [gitVersion, setGitVersion] = useState<string | null>();
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [preferredHarness, setPreferredHarness] = useState<HarnessId | null>(null);
  const [checking, setChecking] = useState(false);
  const [researchAreas, setResearchAreas] = useState<string[]>([]);
  const [otherArea, setOtherArea] = useState("");
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

  // Step 1 requires one genuinely usable harness and local Git. Failed or
  // inconclusive detection never bypasses either gate.
  const anyAgentReady = harnesses?.some((h) => h.agentReady) ?? false;
  const gitReady = gitVersion != null;

  // Drops a slow probe whose answer a newer load has already superseded.
  const loadSeq = useRef(0);
  const load = (refresh: boolean, retryRejected = false) => {
    const seq = ++loadSeq.current;
    setChecking(true);
    setHarnessError(false);
    setGitError(false);
    setGitVersion(undefined);
    const fresh = () => seq === loadSeq.current;
    void Promise.allSettled([
      getHarnesses(refresh, retryRejected).then((h) => fresh() && setHarnesses(h)),
      getProjectPathStatus().then((status) => fresh() && setGitVersion(status.gitVersion)),
    ])
      .then(([harness, gitStatus]) => {
        if (!fresh()) return;
        // Clear the stale answer too, so "errored", "loading" and "loaded"
        // stay mutually exclusive — otherwise a failed re-check leaves old
        // cards on screen saying "not signed in" while the gate un-gates.
        if (harness.status === "rejected") {
          setHarnessError(true);
          setHarnesses(null);
        }
        if (gitStatus.status === "rejected") {
          setGitError(true);
          setGitVersion(undefined);
        }
      })
      .finally(() => fresh() && setChecking(false));
  };
  useEffect(() => load(false), []);
  useEffect(() => {
    if (harnesses === null) return;
    const ready = harnesses.filter((h) => h.agentReady);
    setPreferredHarness((current) => {
      if (current && ready.some((h) => h.id === current)) return current;
      const saved = preferredAgent && ready.find((h) => h.id === preferredAgent.harness);
      return saved?.id ?? ready[0]?.id ?? null;
    });
  }, [harnesses, preferredAgent]);
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
        setResearchAreas(p.researchAreas);
        setOtherArea(p.otherArea ?? "");
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
  const toggleResearchArea = (area: string) => {
    setResearchAreas((current) =>
      current.includes(area) ? current.filter((item) => item !== area) : [...current, area],
    );
  };

  const researchProfileValid =
    researchAreas.length > 0 && (!researchAreas.includes("Other") || otherArea.trim().length > 0);

  const finishOnboarding = async () => {
    const harness = harnesses?.find((item) => item.id === preferredHarness && item.agentReady);
    if (!harness || finishing) return;
    const selection = selectionFor(harness);
    setFinishing(true);
    setFinishError(null);
    try {
      const completion = await completeOnboarding(selection, {
        researchAreas,
        otherArea: researchAreas.includes("Other") ? otherArea : null,
        background: background || null,
        papers,
      });
      onDone(completion.project, completion.selection);
    } catch (error) {
      setFinishError(error instanceof Error ? error.message : String(error));
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="home onboarding">
      <div className="home-inner">
        {step === 0 ? (
          <>
            <div className="onb-eyebrow">
              <Wordmark /> · Step 1 of 2
            </div>
            <h2 className="onb-title">Choose a coding agent</h2>
            <p className="onb-sub">OpenResearch uses an agent already signed in on this machine.</p>
            {harnesses !== null && !anyAgentReady && (
              <p className="onb-gate-hint onb-agent-hint">
                Sign in to at least one agent to continue.
              </p>
            )}
            {harnesses !== null && anyAgentReady && preferredHarness === null && (
              <p className="onb-gate-hint onb-agent-hint">
                Choose a coding agent to continue.
              </p>
            )}
            <div className="onb-cards">
              {harnesses !== null ? (
                harnesses.map((h) => (
                  <AgentCard
                    key={h.id}
                    h={h}
                    selected={preferredHarness === h.id}
                    onSelect={() => setPreferredHarness(h.id)}
                  />
                ))
              ) : harnessError ? (
                // Never a spinner next to an error — detection isn't running.
                <div className="onb-card-meta">{RETRY_COPY}</div>
              ) : (
                <div className="onb-loading">
                  <span className="spinner" /> Detecting Claude Code, Codex, OpenCode…
                </div>
              )}
            </div>
            {(gitVersion === null || gitError) && (
              <div className="onb-git-check" role="status" aria-live="polite">
                <LocalGitCard gitVersion={gitVersion} error={gitError} />
                {gitError ? (
                  <p className="onb-gate-hint onb-git-hint">{RETRY_COPY}</p>
                ) : (
                  <p className="onb-gate-hint onb-git-hint">
                    Git is required for local experiments. Install Git, then re-check.
                  </p>
                )}
              </div>
            )}
            <div className="onb-actions">
              {(harnessError ||
                gitError ||
                gitVersion === null ||
                (harnesses !== null && !anyAgentReady)) && (
                <button className="btn ghost" onClick={() => load(true, true)} disabled={checking}>
                  <RefreshCw size={12} className={checking ? "spin" : ""} /> Re-check
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button
                className="btn primary"
                onClick={() => setStep(1)}
                disabled={checking || !anyAgentReady || preferredHarness === null || !gitReady}
                title={
                  checking
                    ? "Waiting for the local tool checks"
                    : !anyAgentReady
                      ? "Sign in to at least one coding agent to continue"
                      : preferredHarness === null
                        ? "Choose your preferred coding agent"
                        : gitError
                          ? "Re-check Git before continuing"
                          : gitVersion === undefined
                            ? "Waiting for the Git check"
                            : gitVersion === null
                              ? "Install Git to continue"
                              : undefined
                }
              >
                Continue <ArrowRight size={13} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="onb-eyebrow">
              <Wordmark /> · Step 2 of 2
            </div>
            <h2 className="onb-title onb-profile-title">Tell us about your research</h2>
            <div className="onb-cards">
              <div className="onb-card">
                <fieldset className="onb-fieldset">
                  <legend>What areas are you interested in?</legend>
                  <p className="onb-field-hint">Choose one or more.</p>
                  <div className="onb-area-options">
                    {RESEARCH_AREAS.map((area) => (
                      <label key={area} className="onb-area-option">
                        <input
                          type="checkbox"
                          checked={researchAreas.includes(area)}
                          onChange={() => toggleResearchArea(area)}
                          disabled={finishing}
                        />
                        <span>{area}</span>
                      </label>
                    ))}
                  </div>
                  {researchAreas.includes("Other") && (
                    <input
                      className="onb-other-area"
                      value={otherArea}
                      onChange={(event) => setOtherArea(event.target.value)}
                      disabled={finishing}
                      placeholder="Tell us your other research area"
                      aria-label="Other research area"
                    />
                  )}
                </fieldset>
                <label className="onb-field-label" htmlFor="onb-background">
                  Research background
                </label>
                <textarea
                  id="onb-background"
                  className="onb-textarea"
                  value={background}
                  onChange={(e) => setBackground(e.target.value)}
                  disabled={finishing}
                  rows={4}
                  placeholder="e.g. I work on sample-efficient RL for LLM post-training, focused on reward-model-free methods."
                />
                <label className="onb-field-label" htmlFor="onb-paper-search">
                  Representative papers
                </label>
                <p className="onb-field-hint">
                  Add papers that represent your research interests, including papers by other
                  authors.
                </p>
                <div className="onb-paper-search">
                  <input
                    id="onb-paper-search"
                    value={paperQuery}
                    onChange={(e) => setPaperQuery(e.target.value)}
                    disabled={finishing}
                    placeholder="Search alphaXiv by title to link a paper…"
                  />
                  {searchingPapers ? (
                    <div className="onb-card-meta">Searching alphaXiv…</div>
                  ) : paperHits.length > 0 ? (
                    <div className="onb-paper-results">
                      {paperHits.map((h) => (
                        <button
                          key={h.paperId}
                          type="button"
                          onClick={() => addPaper(h)}
                          disabled={finishing}
                        >
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
                          disabled={finishing}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {!researchProfileValid && (
              <p className="onb-profile-hint">
                {researchAreas.length === 0
                  ? "Choose at least one research area to continue."
                  : "Describe your research area to continue."}
              </p>
            )}
            <div className="onb-actions">
              <button className="btn ghost" onClick={() => setStep(0)} disabled={finishing}>
                <ArrowLeft size={12} /> Back
              </button>
              <div style={{ flex: 1 }} />
              <button
                className="btn primary"
                onClick={() => void finishOnboarding()}
                disabled={finishing || preferredHarness === null || !researchProfileValid}
              >
                {finishing ? (
                  <>
                    <span className="spinner" /> Setting things up…
                  </>
                ) : (
                  <>
                    Get started <ArrowRight size={13} />
                  </>
                )}
              </button>
            </div>
            {preferredHarness === null && (
              <p className="onb-gate-hint">
                Your selected agent is no longer ready. Go back to Step 1 and choose another.
              </p>
            )}
            {finishError && <p className="onb-gate-hint">{finishError}</p>}
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

function selectionFor(harness: Harness): AgentSelection {
  const model = harness.models[0]?.id ?? null;
  return {
    harness: harness.id,
    model,
    permissionMode: harness.options?.defaultPermissionMode ?? null,
    reasoningLevel: reasoningFor(harness, model).defaultId,
  };
}

function AgentLogo({ harness }: { harness: HarnessId }) {
  return <HarnessLogo harness={harness} size={18} />;
}

function AgentCard({
  h,
  selected,
  onSelect,
}: {
  h: Harness;
  selected: boolean;
  onSelect: () => void;
}) {
  const badge = agentBadge(h);
  const visibleBadge = selected ? { cls: "st-done", label: "Selected" } : badge;
  const version = h.version?.replace(/\s*\(.*\)$/, "");
  const head = (
    <div className="onb-card-head">
      <span className="onb-card-identity">
        <AgentLogo harness={h.id} />
        <span className="onb-card-name">{h.name}</span>
      </span>
      <span className={`status-badge ${visibleBadge.cls}`}>
        {h.agentReady ? <Check size={12} strokeWidth={3} /> : <span className="dot" />}
        {visibleBadge.label}
      </span>
    </div>
  );
  // An unready agent can't be selected — render it as a plain container, not a
  // disabled button, so the copy button on its `agentNote` command stays live.
  if (!h.agentReady) {
    return (
      <div className="onb-card onb-agent-choice">
        {head}
        <div className="onb-card-meta">{renderNote(h.agentNote)}</div>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`onb-card onb-agent-choice${selected ? " selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {head}
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
    </button>
  );
}

function LocalGitCard({
  gitVersion,
  error,
}: {
  gitVersion: string | null | undefined;
  error: boolean;
}) {
  return (
    <div className="onb-card">
      <div className="onb-card-head">
        <span className="onb-card-name">Local Git</span>
        <span
          className={`status-badge ${gitVersion ? "st-done" : error || gitVersion === null ? "st-failed" : "st-starting"}`}
        >
          {gitVersion ? <Check size={12} strokeWidth={3} /> : <span className="dot" />}
          {gitVersion ? "Ready" : error ? "Check failed" : gitVersion === null ? "Not found" : "Checking"}
        </span>
      </div>
      {(gitVersion || (!error && gitVersion === undefined)) && (
        <div className="onb-card-meta">{gitVersion ?? "Checking Git…"}</div>
      )}
    </div>
  );
}
