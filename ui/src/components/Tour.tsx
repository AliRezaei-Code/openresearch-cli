import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  BUTTON_CLASS_NAME,
  ICON_BUTTON_CLASS_NAME,
  PRIMARY_BUTTON_CLASS_NAME,
} from "../styleClasses";
import { BrandMark } from "./Wordmark";

export function DemoWelcomeModal({
  onClose,
  onCreateProject,
}: {
  onClose: () => Promise<void>;
  onCreateProject: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    (action: () => Promise<void>) => {
      if (saving) return;
      setSaving(true);
      setError(null);
      void action()
        .catch(() => setError("Couldn't save your progress. Try again."))
        .finally(() => setSaving(false));
    },
    [saving],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      run(onClose);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, run]);

  return createPortal(
    <div className="fixed inset-0 z-200 flex items-center justify-center bg-[rgba(29,_27,_26,_0.42)] p-5">
      <div
        className="relative w-110 max-w-full rounded-xl border border-border bg-background p-6 shadow-[0_24px_60px_rgba(0,_0,_0,_0.22)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="demo-welcome-title"
      >
        <button
          className={`${ICON_BUTTON_CLASS_NAME} !absolute top-3.5 right-3.5`}
          aria-label="Close"
          onClick={() => run(onClose)}
          disabled={saving}
        >
          <X size={16} />
        </button>
        <div className="mb-5 flex items-center gap-3 pr-8">
          <span className="block h-9 w-9 shrink-0 [&_svg]:block [&_svg]:h-full [&_svg]:w-full">
            <BrandMark />
          </span>
          <div>
            <div className="mb-0.5 text-xs font-semibold tracking-[0.08em] text-primary uppercase">
              Demo project
            </div>
            <h2
              id="demo-welcome-title"
              className="m-0 text-3xl leading-tight tracking-[-0.02em]"
            >
              Welcome to OpenResearch
            </h2>
          </div>
        </div>
        <div className="text-base leading-relaxed text-text [&_p]:m-0 [&_p_+_p]:mt-3">
          <p>
            This is a demo project showing how OpenResearch works. This demo uses Andrej
            Karpathy&apos;s{" "}
            <a
              href="https://github.com/karpathy/nanochat"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-primary underline decoration-border-strong underline-offset-3 hover:decoration-primary"
            >
              nanochat
            </a>, a repo for training a mini-GPT from scratch.
          </p>
          <p>
            Look through the agent conversations, experiments, runs, and artifacts to see how a
            project on OpenResearch comes together.
          </p>
        </div>
        {error && <p className="mt-3 mb-0 text-sm text-accent-red">{error}</p>}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2.5">
          <button
            className={BUTTON_CLASS_NAME}
            onClick={() => run(onCreateProject)}
            disabled={saving}
          >
            Create a new project
          </button>
          <button
            className={PRIMARY_BUTTON_CLASS_NAME}
            onClick={() => run(onClose)}
            disabled={saving}
          >
            {saving ? "Saving…" : "Explore the demo"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
