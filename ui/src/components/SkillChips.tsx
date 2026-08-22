import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import { splitCommandTokens } from "../planCommand";

/** Metrics the composer mirror copies off the textarea so its text lands on the
 * real text glyph for glyph. */
const MIRRORED_PROPERTIES = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "tab-size",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
];

function chipSegments(
  text: string,
  isCommand: (name: string) => boolean,
  chipClassName: string,
): ReactNode[] {
  return splitCommandTokens(text, isCommand).map((segment, i) =>
    segment.command ? (
      <span key={i} className={chipClassName}>
        {segment.text}
      </span>
    ) : (
      <Fragment key={i}>{segment.text}</Fragment>
    ),
  );
}

/** A sent message's text with every known `/command` rendered as a chip. */
export function MessageWithChips({
  text,
  isCommand,
}: {
  text: string;
  isCommand: (name: string) => boolean;
}) {
  return (
    <>
      {chipSegments(
        text,
        isCommand,
        "skill-chip inline-flex items-center py-px px-[7px] font-mono text-md font-medium text-primary bg-primary-subtle border border-border-variant rounded-sm",
      )}
    </>
  );
}

/** Chips for the composer, painted behind the textarea's own text by a mirror
 * that reproduces its wrapping exactly — a textarea cannot style one range of
 * its value. Requires the positioned parent's only in-flow child to be a
 * textarea that renders BEFORE this (its ref must be attached when the mirror
 * measures it) and paints its own text over the mirror. */
export function ComposerSkillChips({
  text,
  hint,
  isCommand,
  textareaRef,
}: {
  /** The textarea's exact current value — chips land by character offset. */
  text: string;
  hint: string | null;
  isCommand: (name: string) => boolean;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);

  // Out of flow, so writing the mirror's styles here cannot resize the textarea
  // the observer watches.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    const sync = () => {
      const computed = getComputedStyle(textarea);
      for (const property of MIRRORED_PROPERTIES)
        mirror.style.setProperty(property, computed.getPropertyValue(property));
      // clientWidth excludes the scrollbar, so the mirror wraps where the textarea does.
      mirror.style.width = `${
        textarea.clientWidth +
        parseFloat(computed.borderLeftWidth) +
        parseFloat(computed.borderRightWidth)
      }px`;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [textareaRef]);

  // The chips ride the textarea's own scrolling — caret-driven (no scroll event
  // on the frame the text changes) as well as user-driven.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const sync = () => {
      if (mirrorRef.current) mirrorRef.current.scrollTop = textarea.scrollTop;
    };
    sync();
    textarea.addEventListener("scroll", sync);
    return () => textarea.removeEventListener("scroll", sync);
  }, [textareaRef, text]);

  return (
    <div
      ref={mirrorRef}
      aria-hidden
      className="composer-chips absolute inset-y-0 left-0 box-border overflow-hidden whitespace-pre-wrap break-words border-solid border-transparent text-transparent select-none pointer-events-none"
    >
      {/* Pill bleed is box-shadow spread, never padding or a border: anything
        * that adds layout width pushes every glyph after it off the real text. */}
      {chipSegments(
        text,
        isCommand,
        "composer-chip bg-primary-subtle rounded-sm shadow-[0_0_0_3px_var(--primary-subtle)]",
      )}
      {hint && <span className="text-muted">{text.endsWith(" ") ? hint : ` ${hint}`}</span>}
      {/* A trailing newline drops its line box here but not in the textarea,
        * which would clamp the mirror's scrollTop a line short. */}
      {"\u200b"}
    </div>
  );
}
