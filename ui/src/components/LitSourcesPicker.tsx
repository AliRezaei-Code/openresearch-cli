// Composer-footer control: a switch icon that opens a small popover to toggle
// which literature sources `orx lit` / `orx paper` may use. The state lives in
// settings.json (same `/api/settings/lit-sources` endpoint the CLI enforces).

import { useEffect, useState } from "react";

import { ToggleRight } from "lucide-react";

import { getLitSources, setLitSources, type LitSourcesSettings } from "../api";
import { LitSourceLogo, LIT_SOURCE_NAME, type LitSource } from "./LitSourceLogo";
import { usePopover } from "./ModelPicker";

const LIT_SOURCES: LitSource[] = ["alphaxiv", "openalex", "biorxiv"];

export function LitSourcesPicker() {
  const { open, setOpen, ref } = usePopover();
  const [settings, setSettings] = useState<LitSourcesSettings | null>(null);
  const [saving, setSaving] = useState(false);

  // Load lazily the first time the menu opens.
  useEffect(() => {
    if (!open || settings) return;
    void getLitSources()
      .then(setSettings)
      .catch(() => {});
  }, [open, settings]);

  const toggle = (key: LitSource) => {
    if (!settings || saving) return;
    setSaving(true);
    void setLitSources({ ...settings, [key]: !settings[key] })
      .then(setSettings)
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  return (
    <div className="option-picker" ref={ref}>
      <button
        type="button"
        className="composer-bare"
        title="Literature sources for orx lit / orx paper"
        aria-label="Literature sources"
        onClick={() => setOpen((v) => !v)}
      >
        <ToggleRight size={16} />
      </button>
      {open && (
        <div className="option-menu lit-sources-menu">
          <div className="model-group">Literature sources</div>
          {!settings ? (
            <div className="lit-sources-loading">Loading…</div>
          ) : (
            LIT_SOURCES.map((key) => {
              const on = settings[key];
              return (
                <button
                  key={key}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  className="model-item"
                  disabled={saving}
                  onClick={() => toggle(key)}
                >
                  <span className="lit-source-item-label">
                    <LitSourceLogo source={key} size={16} decorative />
                    {LIT_SOURCE_NAME[key]}
                  </span>
                  <span className={`settings-switch ${on ? "on" : ""}`} aria-hidden="true">
                    <span />
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
