import { ArrowLeft, ArrowRight, Check, Copy, RefreshCw, X } from "lucide-react";
import { Wordmark } from "./Wordmark";
import { useEffect, useRef, useState } from "react";
import {
  getGitSettings,
  getHarnesses,
  getProfile,
  harnessModelLabel,
  completeOnboarding,
  reasoningFor,
  searchPapers,
  type GitSettings,
  type Harness,
  type HarnessId,
  type LinkedPaper,
  type PaperHit,
  type Project,
} from "../api";
import { GitTokenForm } from "./GitTokenForm";
import { renderNote } from "./agentNote";
import { onHarnessAuth } from "../events";
import { saveAgentSelection, type AgentSelection } from "../agentSelection";

const RETRY_COPY = "Couldn't reach orx. Check it's still running, then re-check.";

/** First-run walkthrough: the detected coding agents, then GitHub access, then a
 * short research-background prompt, then install and open the demo project.
 * Step 1 gates — orx can't chat without a signed-in agent. Steps 2 and 3 don't:
 * cloning/pushing work over SSH keys, and the background (a blurb + linked
 * papers) is optional, saved best-effort so it never blocks installation. The
 * data-dir choice lives in Settings → Storage (which can also *move* existing
 * data); usage analytics is opt-out via the CLI (`orx telemetry off`). */
export function Onboarding({ onDone }: { onDone: (project: Project) => void }) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [git, setGit] = useState<GitSettings | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [preferredHarness, setPreferredHarness] = useState<HarnessId | null>(null);
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
  const harnessSelectionInvalidated = useRef(false);
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
  useEffect(() => {
    if (harnesses === null) return;
    const ready = harnesses.filter((h) => h.agentReady);
    setPreferredHarness((current) => {
      if (current && !ready.some((h) => h.id === current)) {
        harnessSelectionInvalidated.current = true;
        return null;
      }
      if (current) return current;
      return ready.length === 1 && !harnessSelectionInvalidated.current ? ready[0].id : null;
    });
  }, [harnesses]);
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

  const finishOnboarding = async () => {
    const harness = harnesses?.find((item) => item.id === preferredHarness && item.agentReady);
    if (!harness || finishing) return;
    const selection = selectionFor(harness);
    setFinishing(true);
    setFinishError(null);
    try {
      const completion = await completeOnboarding(selection, {
        background: background.trim() || null,
        papers,
      });
      saveAgentSelection(completion.selection);
      onDone(completion.project);
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
              <Wordmark /> · Step 1 of 3
            </div>
            <h2 className="onb-title">Choose your coding agent</h2>
            <p className="onb-sub">
              Choose your preferred coding agent. You can change coding agents at any time.
            </p>
            <div className="onb-cards">
              {harnesses !== null ? (
                harnesses.map((h) => (
                  <AgentCard
                    key={h.id}
                    h={h}
                    selected={preferredHarness === h.id}
                    onSelect={() => {
                      harnessSelectionInvalidated.current = false;
                      setPreferredHarness(h.id);
                    }}
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
            {harnesses !== null && !anyAgentReady && (
              <p className="onb-gate-hint">Sign in to at least one agent to continue.</p>
            )}
            {harnesses !== null && anyAgentReady && preferredHarness === null && (
              <p className="onb-gate-hint">Choose a coding agent to continue.</p>
            )}
            <div className="onb-actions">
              <button className="btn ghost" onClick={() => load(true, true)} disabled={checking}>
                <RefreshCw size={12} className={checking ? "spin" : ""} /> Re-check
              </button>
              <div style={{ flex: 1 }} />
              <button
                className="btn primary"
                onClick={() => setStep(1)}
                disabled={!anyAgentReady || preferredHarness === null}
                title={
                  !anyAgentReady
                    ? "Sign in to at least one coding agent to continue"
                    : preferredHarness === null
                      ? "Choose your preferred coding agent"
                      : undefined
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
              A sentence or two about what you work on helps orx tailor its research. All optional;
              you can skip and add this later.
            </p>
            <div className="onb-cards">
              <div className="onb-card">
                <textarea
                  className="onb-textarea"
                  value={background}
                  onChange={(e) => setBackground(e.target.value)}
                  disabled={finishing}
                  rows={4}
                  placeholder="e.g. I work on sample-efficient RL for LLM post-training, focused on reward-model-free methods."
                />
                <div className="onb-paper-search">
                  <input
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
            {/* The data dir moved to Settings → Storage; still disclose where
                things land so the location isn't a surprise. */}
            <p className="onb-aside-text" style={{ marginTop: 12 }}>
              Your background stays on this machine, alongside your database, run logs, and
              artifacts — change where they live any time in Settings → Storage.
            </p>
            <div className="onb-actions">
              <button className="btn ghost" onClick={() => setStep(1)} disabled={finishing}>
                <ArrowLeft size={12} /> Back
              </button>
              <div style={{ flex: 1 }} />
              <button
                className="btn primary"
                onClick={() => void finishOnboarding()}
                disabled={finishing || preferredHarness === null}
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
  if (harness === "claude-code") {
    return (
      <svg className="onb-agent-logo claude" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
      </svg>
    );
  }
  if (harness === "opencode") {
    return (
      <svg className="onb-agent-logo" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M22 24H2V0h20zM17 4.8H7v14.4h10z" />
      </svg>
    );
  }
  return (
    <svg className="onb-agent-logo" viewBox="146 227 268 265" aria-hidden="true">
      <path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z" />
    </svg>
  );
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
  const version = h.version?.replace(/\s*\(.*\)$/, "");
  return (
    <button
      type="button"
      className={`onb-card onb-agent-choice${selected ? " selected" : ""}`}
      disabled={!h.agentReady}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <div className="onb-card-head">
        <span className="onb-card-identity">
          <AgentLogo harness={h.id} />
          <span className="onb-card-name">{h.name}</span>
        </span>
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
    </button>
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
