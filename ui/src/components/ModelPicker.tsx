import { Check, ChevronDown, Lock } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getHarnesses,
  harnessModelLabel,
  modelLabel,
  reasoningFor,
  reconcileReasoning,
  REASONING_DEFAULT_ID,
  type Harness,
  type HarnessId,
  type OptionChoice,
} from "../api";
import { renderNote } from "./agentNote";
import { onHarnessAuth } from "../events";
import type { AgentSelection } from "../agentSelection";

export type ModelSelection = AgentSelection;

export const HARNESS_LABELS: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

/** First harness that can actually run — the fallback when nothing is picked.
 * Seeds mode/reasoning from that harness's advertised defaults. */
export function defaultSelection(harnesses: Harness[]): ModelSelection | null {
  const ready = harnesses.find((h) => h.agentReady);
  if (!ready) return null;
  // Seed the catalog's first model — the catalogs are CLI-discovered now, so
  // it's a real, current id. Custom providers advertise no models; they seed
  // null (= send no `--model`, the CLI uses whatever it is configured with).
  const model = ready.models[0]?.id ?? null;
  return {
    harness: ready.id,
    model,
    permissionMode: ready.options?.defaultPermissionMode ?? null,
    reasoningLevel: reasoningFor(ready, model).defaultId,
  };
}

/** Close-on-outside-click + open state shared by the composer dropdowns (and
 * the session-rail menus). */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the picker and must NOT bubble to other document-level
      // Escape handlers (e.g. ChatPanel's stop-streaming listener) — closing an
      // open picker shouldn't also interrupt an in-flight turn. Capture phase +
      // stopPropagation makes this order-independent: relying on registration
      // order and defaultPrevented among bubble-phase document listeners is
      // fragile, since whichever registered first runs first.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** Composer selector: pick the harness + model new sessions (and same-harness
 * turns) run on. Groups mirror the Harnesses settings tab. */
export function ModelPicker({
  value,
  onSelect,
  onHarnesses,
  lockHarness = false,
}: {
  value: ModelSelection | null;
  onSelect: (value: ModelSelection) => void;
  onHarnesses?: (harnesses: Harness[]) => void;
  /** When set (a session is open), only the current harness is offered — its
   * harness is fixed for its lifetime, so you can still switch models within it
   * but not switch to a different harness. */
  lockHarness?: boolean;
}) {
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const { open, setOpen, ref: rootRef } = usePopover();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let mounted = true;
    const load = (refresh = false) =>
      getHarnesses(refresh)
        .then((list) => {
          if (!mounted) return;
          setHarnesses(list);
          onHarnesses?.(list);
        })
        .catch(() => {});
    void load();
    const unsubscribe = onHarnessAuth(() => void load(true));
    return () => {
      mounted = false;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // Locked to the open session's harness: only offer that one.
    const shown =
      lockHarness && value ? harnesses.filter((h) => h.id === value.harness) : harnesses;
    return shown.map((h) => {
      let models = h.models;
      if (q) models = models.filter((m) => m.id.toLowerCase().includes(q));
      // opencode's long tail (openrouter etc.) stays behind the filter box.
      else if (h.id === "opencode") models = models.slice(0, 6);
      return { harness: h, models, hidden: q ? 0 : h.models.length - models.length };
    });
  }, [harnesses, filter, lockHarness, value]);

  /** Switch harness → reseed mode defaults for that harness.
   *
   * Reasoning is reconciled against the *newly selected model* in both cases:
   * choices are per-model now, so an effort the previous model allowed may not
   * exist on this one (`ultra` on Sol → 5.5). Keeping it would send a value the
   * model rejects, so it falls back to that model's default. */
  const pick = (harness: Harness, model: string | null) => {
    const sameHarness = value?.harness === harness.id;
    onSelect({
      harness: harness.id,
      model,
      permissionMode: sameHarness
        ? value!.permissionMode
        : harness.options?.defaultPermissionMode ?? null,
      reasoningLevel: reconcileReasoning(
        harness,
        model,
        sameHarness ? value!.reasoningLevel : null,
      ),
    });
    setOpen(false);
    setFilter("");
  };

  // Pill label: prefer the catalog's own name for the selected model (the
  // Claude aliases like `opus[1m]` are meaningless prettified).
  const selected =
    value?.model != null
      ? harnesses
          .find((h) => h.id === value.harness)
          ?.models.find((m) => m.id === value.model)
      : undefined;
  const label = value
    ? value.model
      ? selected
        ? harnessModelLabel(selected)
        : modelLabel(value.model)
      : "Default model"
    : "Model";

  return (
    <div className="model-picker" data-onboarding="model-picker" ref={rootRef}>
      <button
        type="button"
        className="composer-pill"
        title="Harness + model for this chat"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="model-menu align-right">
          <input
            autoFocus
            type="text"
            placeholder="Search models…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="model-menu-list">
            {groups.map(({ harness, models, hidden }) => (
              <div key={harness.id}>
                <div className="model-group">
                  <span>{harness.name}</span>
                  {!harness.agentReady && (
                    <span className="model-group-status">
                      <Lock size={10} /> Unavailable
                    </span>
                  )}
                </div>
                {!harness.agentReady ? (
                  <div className="model-more model-unavailable">
                    {harness.agentNote ? renderNote(harness.agentNote) : "Not available"}
                  </div>
                ) : (
                  <>
                    {/* "Default model" (= send no --model, the CLI decides)
                        only where the CLI advertises no catalog — a custom
                        provider whose real models live behind its gateway.
                        With a discovered catalog the row is redundant noise:
                        the catalog's own default leads the list. */}
                    {harness.models.length === 0 && (
                      <button className="model-item" onClick={() => pick(harness, null)}>
                        <span>
                          Default model
                          <span className="model-id">CLI configuration</span>
                        </span>
                        {value?.harness === harness.id && value?.model === null && (
                          <Check size={13} />
                        )}
                      </button>
                    )}
                    {models.map((m) => (
                      <button
                        key={m.id}
                        className="model-item"
                        title={m.id}
                        onClick={() => pick(harness, m.id)}
                      >
                        <span>
                          {harnessModelLabel(m)}
                          {/* The catalog blurb carries what the alias doesn't —
                              for Claude, the resolved version ("Opus 4.8 with
                              1M context · …"). Fall back to the raw id. */}
                          <span className="model-id">{m.description ?? m.id}</span>
                        </span>
                        {value?.harness === harness.id && value?.model === m.id && (
                          <Check size={13} />
                        )}
                      </button>
                    ))}
                    {hidden > 0 && (
                      <div className="model-more">{hidden} more — search to find</div>
                    )}
                    {/* Free-form escape hatch: the catalogs are curated menus,
                        not the set of ids the CLIs accept — `--model
                        claude-opus-5` works on a CLI whose menu doesn't list
                        it. Typing an id not in the list offers it directly. */}
                    {filter.trim().length > 0 &&
                      !harness.models.some((m) => m.id === filter.trim()) && (
                        <button
                          className="model-item"
                          onClick={() => pick(harness, filter.trim())}
                        >
                          <span>
                            Use “{filter.trim()}”
                            <span className="model-id">pass as the model id</span>
                          </span>
                        </button>
                      )}
                  </>
                )}
              </div>
            ))}
            {harnesses.length === 0 && <div className="model-more">Detecting harnesses…</div>}
          </div>
          {lockHarness && value && harnesses.length > 1 && (
            <div className="model-locked-note">
              <Lock size={11} />
              Sessions keep their harness — new chat to switch
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A compact single-axis dropdown (permission mode or reasoning level). Renders
 * nothing when the harness advertises no choices for this axis. Mirrors the
 * Claude Code composer menu: a header, the current-default row pinned at top
 * with a "· Default" note, then the full numbered list. */
export function OptionPicker({
  choices,
  value,
  defaultId,
  header,
  align = "left",
  variant = "pill",
  title,
  numbered = false,
  onSelect,
}: {
  choices: OptionChoice[];
  value: string | null;
  /** The harness's default id — pinned at top of the menu and used when
   * `value` is null. */
  defaultId?: string | null;
  /** Group header (e.g. "Mode"). */
  header?: string;
  align?: "left" | "right";
  /** `pill` = boxed (permission mode); `bare` = text-only (reasoning). */
  variant?: "pill" | "bare";
  title?: string;
  /** Show 1-based number hints on the right (like the mode menu). */
  numbered?: boolean;
  onSelect: (id: string) => void;
}) {
  const { open, setOpen, ref } = usePopover();
  if (choices.length === 0) return null;

  const effectiveId = value ?? defaultId ?? choices[0]?.id ?? null;
  const current = choices.find((c) => c.id === effectiveId);
  const defaultChoice = choices.find((c) => c.id === defaultId);
  // Only the `default` sentinel gets pinned above a separator — it isn't a
  // point on the tier ramp, it's a different kind of choice (Claude's Adaptive,
  // opencode's "let the model decide"). A *concrete* default (codex's resolved
  // tier, a permission mode) stays inline in its natural position with just
  // the "· Default" marker, so the ramp reads in order.
  const pinned =
    defaultChoice && defaultChoice.id === REASONING_DEFAULT_ID ? defaultChoice : undefined;
  const rest = pinned ? choices.filter((c) => c.id !== pinned.id) : choices;
  const label = current?.label ?? choices[0]?.label ?? "";

  const choose = (id: string) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    <div className="option-picker" ref={ref}>
      <button
        type="button"
        className={variant === "pill" ? "composer-pill" : "composer-bare"}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className={`option-menu ${align === "right" ? "align-right" : ""}`}>
          {header && <div className="model-group">{header}</div>}
          {pinned && (
            <>
              <button className="model-item" onClick={() => choose(pinned.id)}>
                <span>
                  {pinned.label}
                  {/* An unnamed sentinel's label already IS "Default", so the
                      usual marker would read "Default · Default" — say where
                      the behavior comes from instead. A named one ("Adaptive")
                      gets the standard marker. */}
                  <span className="option-default">
                    {pinned.label === "Default" ? " · CLI configuration" : " · Default"}
                  </span>
                </span>
                {effectiveId === pinned.id && <Check size={13} />}
              </button>
              <div className="option-sep" />
            </>
          )}
          {rest.map((c, i) => (
            <button key={c.id} className="model-item" onClick={() => choose(c.id)}>
              <span>
                {c.label}
                {/* A concrete default renders inline, in ramp order, with just
                    the marker — it's one of the tiers, not a separate kind of
                    choice like the pinned sentinel above. */}
                {!pinned && c.id === defaultId && (
                  <span className="option-default"> · Default</span>
                )}
              </span>
              {effectiveId === c.id ? (
                <Check size={13} />
              ) : (
                numbered && <span className="option-num">{i + 1}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
