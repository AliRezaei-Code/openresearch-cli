// Literature-source toggles shown inline in the composer chat-settings panel:
// which sources `orx lit` / `orx paper` may use. State lives in settings.json
// (same `/api/settings/lit-sources` endpoint the CLI enforces).

import { useEffect, useState } from "react";

import { getLitSources, setLitSources, type LitSourcesSettings } from "../api";
import { LitSourceLogo, LIT_SOURCE_NAME, type LitSource } from "./LitSourceLogo";
import { MODEL_ITEM_CLASS_NAME } from "../styleClasses";

const LIT_SOURCES: LitSource[] = ["alphaxiv", "openalex", "biorxiv"];

const SETTINGS_SWITCH_CLASS_NAME = [
  "settings-switch relative flex-none w-9.5 h-5.5 border border-border rounded-full",
  "bg-surface transition-[background,border-color] duration-120 ease-standard",
  "[&_span]:absolute [&_span]:top-[3px] [&_span]:left-[3px] [&_span]:w-3.5 [&_span]:h-3.5",
  "[&_span]:rounded-full [&_span]:bg-muted [&_span]:transition-[translate,background]",
  "[&_span]:duration-120 [&_span]:ease-standard [&.on]:border-primary [&.on]:bg-primary",
  "[&.on_span]:bg-background [&.on_span]:translate-x-4 [&:disabled]:opacity-45",
  "[&:disabled]:cursor-default [&:focus-visible]:outline-2 [&:focus-visible]:outline-solid",
  "[&:focus-visible]:outline-text [&:focus-visible]:outline-offset-2",
].join(" ");

// Remembered across mounts so reopening the panel shows the last values
// immediately instead of flashing "Loading…" while it revalidates.
let cachedSettings: LitSourcesSettings | null = null;

export function LitSourcesList() {
  const [settings, setSettings] = useState<LitSourcesSettings | null>(cachedSettings);
  const [saving, setSaving] = useState(false);

  const remember = (s: LitSourcesSettings) => {
    cachedSettings = s;
    setSettings(s);
  };

  useEffect(() => {
    void getLitSources()
      .then(remember)
      .catch(() => {});
  }, []);

  const toggle = (key: LitSource) => {
    if (!settings || saving) return;
    setSaving(true);
    void setLitSources({ ...settings, [key]: !settings[key] })
      .then(remember)
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  if (!settings) return <div className="py-1.5 px-2 text-muted text-sm">Loading…</div>;

  return (
    <div className="flex flex-col">
      {LIT_SOURCES.map((key) => {
        const on = settings[key];
        return (
          <button
            key={key}
            type="button"
            role="switch"
            aria-checked={on}
            className={MODEL_ITEM_CLASS_NAME}
            disabled={saving}
            onClick={() => toggle(key)}
          >
            <span className="inline-flex items-center gap-[9px]">
              <LitSourceLogo source={key} size={16} decorative />
              {LIT_SOURCE_NAME[key]}
            </span>
            <span className={`${SETTINGS_SWITCH_CLASS_NAME} ${on ? "on" : ""}`} aria-hidden="true">
              <span />
            </span>
          </button>
        );
      })}
    </div>
  );
}
