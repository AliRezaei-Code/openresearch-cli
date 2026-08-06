// Brand marks + command parsing for the literature sources, used to render
// `orx lit` / `orx paper` tool calls in chat as a real search ("Searching
// OpenAlex for …") instead of a raw shell line. The official SVGs are inlined
// at build time via `?raw` (no external asset — the UI is rust-embedded and
// CSP-locked) and shown in a small white tile so the black marks (OpenAlex,
// bioRxiv) stay visible in dark mode and every source reads uniformly.

import alphaxivSvg from "../assets/lit-sources/alphaxiv.svg?raw";
import biorxivSvg from "../assets/lit-sources/biorxiv.svg?raw";
import openalexSvg from "../assets/lit-sources/openalex.svg?raw";

export type LitSource = "alphaxiv" | "openalex" | "biorxiv";

export const LIT_SOURCE_NAME: Record<LitSource, string> = {
  alphaxiv: "alphaXiv",
  openalex: "OpenAlex",
  biorxiv: "bioRxiv",
};

const LIT_SOURCE_SVG: Record<LitSource, string> = {
  alphaxiv: alphaxivSvg,
  openalex: openalexSvg,
  biorxiv: biorxivSvg,
};

export function LitSourceLogo({ source, size = 16 }: { source: LitSource; size?: number }) {
  return (
    <span
      className="lit-logo"
      style={{ width: size, height: size }}
      // Decorative — the source name is always in the adjacent text.
      aria-hidden="true"
      // Static, build-inlined brand SVGs — not user input.
      dangerouslySetInnerHTML={{ __html: LIT_SOURCE_SVG[source] }}
    />
  );
}

export type OrxLitCall =
  | { kind: "lit"; source: LitSource; query?: string }
  | { kind: "paper"; source: LitSource; id?: string };

function asSource(v: string | undefined): LitSource | undefined {
  return v === "alphaxiv" || v === "openalex" || v === "biorxiv" ? v : undefined;
}

/** Mirror of the Rust `detect_source` used by `orx paper` when no `--source`
 * is given: host hints first, then a `10.1101/…` DOI → biorxiv, any other
 * `10.…/…` DOI or a bare `W…` id → openalex, else alphaXiv. */
function detectPaperSource(id: string): LitSource {
  const s = id.trim();
  const lower = s.toLowerCase();
  if (lower.includes("biorxiv.org")) return "biorxiv";
  if (lower.includes("openalex.org")) return "openalex";
  // A real DOI is `10.<registrant>/<suffix>` — the slash distinguishes it from
  // an arXiv id like `2410.12345` (October) that also contains "10.".
  const doi = s.match(/10\.\d+\/\S+/);
  if (doi) return doi[0].startsWith("10.1101/") ? "biorxiv" : "openalex";
  const last = s.split("/").pop() ?? "";
  if (/^W\d+$/i.test(last)) return "openalex";
  return "alphaxiv";
}

/** Tokenize the args after `orx lit`/`orx paper`, respecting quotes and
 * stopping at a shell operator (`|`, `;`, `>`, `&`). */
function tokenizeArgs(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      has = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    if (c === "|" || c === ";" || c === ">" || c === "&") break;
    cur += c;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
}

/** Recognize an `orx lit` / `orx paper` invocation inside a shell command and
 * pull out the source + query/id. Returns null for anything else. */
export function parseOrxLit(command: string): OrxLitCall | null {
  const m = command.match(/(?:^|[\s;&|(])orx\s+(lit|paper)\b/);
  if (!m) return null;
  const kind = m[1] as "lit" | "paper";
  const rest = command.slice((m.index ?? 0) + m[0].length);
  const tokens = tokenizeArgs(rest);

  let source: LitSource | undefined;
  let positional: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--source") {
      source = asSource(tokens[++i]);
      continue;
    }
    if (t.startsWith("--source=")) {
      source = asSource(t.slice("--source=".length));
      continue;
    }
    // `--limit` takes a value; skip it so the value isn't read as the query.
    if (t === "--limit") {
      i++;
      continue;
    }
    if (t.startsWith("--")) continue; // --json / --full / --limit=N
    if (positional === undefined && t) positional = t;
  }

  if (kind === "lit") {
    return { kind, source: source ?? "alphaxiv", query: positional };
  }
  return {
    kind,
    source: source ?? (positional ? detectPaperSource(positional) : "alphaxiv"),
    id: positional,
  };
}
