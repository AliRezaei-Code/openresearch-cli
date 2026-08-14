// Inline source editor: a transparent <textarea> layered over the same
// refractor-highlighted <pre> + gutter that CodeView renders read-only, so
// syntax colors stay live while typing. It IS the view for editable files —
// there's no separate mode, you just click and type. The textarea owns input,
// caret and selection; the highlighted pre and gutter are scroll-synced to it.
// Token colors apply under a `.file-view` ancestor (see CodeView).
import { useLayoutEffect, useMemo, useRef } from "react";
import { detectSyntaxLanguageFromFilePath } from "../syntaxLanguage";
import { highlight } from "../syntaxHighlight";

export function CodeEditor({
  value,
  onChange,
  onSave,
  onBlur,
  path,
  highlightLine,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Cmd/Ctrl+S while focused — the viewer maps this to save. */
  onSave: () => void;
  /** Focus left the editor — the viewer saves any pending edit. */
  onBlur?: () => void;
  path: string;
  /** 1-based line to scroll to and place the caret on (from a `file:line` chip). */
  highlightLine?: number;
}) {
  const rendered = useMemo(
    () => highlight(value, detectSyntaxLanguageFromFilePath(path)),
    [value, path],
  );
  // A trailing newline opens a new (empty) line the caret can sit on, so unlike
  // the read-only view every "\n" counts toward the gutter.
  const lineCount = value ? value.split("\n").length : 1;

  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);

  // Keep the highlighted layer and the gutter pinned to the textarea's scroll.
  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };
  // Re-sync after content changes relayout (e.g. a newline shifts scrollHeight).
  useLayoutEffect(syncScroll, [value]);

  // On open via a `file:line` chip, park the caret on that line and center it.
  // Runs once per file (keyed by path); `value` is the freshly loaded content.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta || !highlightLine) return;
    const cs = getComputedStyle(ta);
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const lineH = Number.parseFloat(cs.lineHeight) || 0;
    const target = Math.min(Math.max(Math.trunc(highlightLine), 1), lineCount);
    const lines = value.split("\n");
    let caret = 0;
    for (let i = 0; i < target - 1; i++) caret += lines[i].length + 1;
    ta.setSelectionRange(caret, caret);
    if (lineH) ta.scrollTop = Math.max(0, padTop + (target - 1) * lineH - ta.clientHeight / 2);
    syncScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart, selectionEnd } = ta;
      const next = value.slice(0, selectionStart) + "\t" + value.slice(selectionEnd);
      onChange(next);
      // Restore the caret just past the inserted tab once React re-renders.
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = selectionStart + 1;
      });
    }
  };

  return (
    <div className="file-view-editwrap flex items-stretch h-full min-h-0 relative">
      <pre
        ref={gutterRef}
        className="file-view-gutter m-0 pt-3.5 pb-3.5 font-mono text-sm leading-[1.55] pl-3.5 pr-2.5 text-right text-muted select-none bg-background border-r border-r-border-variant shrink-0 overflow-hidden"
        aria-hidden="true"
      >
        {Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}
      </pre>
      <div className="relative flex-1 min-w-0">
        <pre
          ref={preRef}
          className="file-view-code absolute inset-0 m-0 pt-3.5 pb-3.5 font-mono text-sm leading-[1.55] pl-4 pr-4 [tab-size:4] whitespace-pre overflow-hidden pointer-events-none"
          aria-hidden="true"
        >
          <code>{rendered}</code>
        </pre>
        <textarea
          ref={taRef}
          className="file-view-editarea absolute inset-0 m-0 pt-3.5 pb-3.5 font-mono text-sm leading-[1.55] pl-4 pr-4 [tab-size:4] whitespace-pre overflow-auto resize-none border-0 bg-transparent text-transparent caret-[var(--text)] outline-none"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          wrap="off"
        />
      </div>
    </div>
  );
}
