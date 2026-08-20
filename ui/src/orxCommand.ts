export type LitSource = "alphaxiv" | "openalex" | "biorxiv";

export type OrxLitCall =
  | { kind: "lit"; source: LitSource; query?: string }
  | { kind: "paper"; source: LitSource; id?: string }
  | {
      kind: "discover";
      source: "alphaxiv";
      strategy: "keyword" | "embedding";
      query?: string;
    };

function asSource(value: string | undefined): LitSource | undefined {
  return value === "alphaxiv" || value === "openalex" || value === "biorxiv"
    ? value
    : undefined;
}

function detectPaperSource(id: string): LitSource {
  const value = id.trim();
  const lower = value.toLowerCase();
  if (lower.includes("biorxiv.org")) return "biorxiv";
  if (lower.includes("openalex.org")) return "openalex";
  const doi = value.match(/10\.\d+\/\S+/);
  if (doi) return doi[0].startsWith("10.1101/") ? "biorxiv" : "openalex";
  const last = value.split("/").pop() ?? "";
  if (/^W\d+$/i.test(last)) return "openalex";
  return "alphaxiv";
}

/** Shell-style tokens up to the first operator, including Codex's quoted argv display. */
export function shellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let hasWord = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const push = () => {
    if (hasWord) words.push(word);
    word = "";
    hasWord = false;
  };

  for (const char of input) {
    if (escaped) {
      word += char;
      hasWord = true;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      hasWord = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasWord = true;
      continue;
    }
    if (char === "|" || char === ";" || char === ">" || char === "&") break;
    if (/\s/.test(char)) push();
    else {
      word += char;
      hasWord = true;
    }
  }
  push();
  return words;
}

/** Remove quotes only when they make the entire body one shell word. */
export function unwrapShellBody(input: string): string {
  const first = input[0];
  if ((first === '"' || first === "'") && input.at(-1) === first && shellWords(input).length === 1) {
    return input.slice(1, -1);
  }
  return input;
}

/** The argv after an `orx` executable in shell command position. */
export function orxArgv(command: string): string[] | null {
  const tokens = shellWords(command);
  let index = 0;
  while (["do", "then", "else", "if", "while", "until"].includes(tokens[index])) index++;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
  if (tokens[index] === "env") {
    index++;
    while (tokens[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) {
      index++;
    }
  }
  if (tokens[index] === "command") {
    index++;
    if (["-v", "-V"].includes(tokens[index])) return null;
    while (tokens[index]?.startsWith("-")) index++;
  }
  if (tokens[index]?.split("/").pop() !== "orx") return null;
  return tokens.slice(index + 1);
}

/** Match an `orx` argv prefix regardless of whether Codex quoted every token. */
export function orxArgsMatch(command: string, args: string): boolean {
  const argv = orxArgv(command);
  if (argv === null) return false;
  const patterns = args.split("\\s+");
  return patterns.every(
    (pattern, index) => argv[index] !== undefined && new RegExp(`^(?:${pattern})$`, "i").test(argv[index]),
  );
}

/** Parse the first literature command from a shell segment. */
export function parseOrxLit(command: string): OrxLitCall | null {
  const argv = orxArgv(command);
  if (!argv) return null;
  const kind = argv[0];
  if (kind !== "lit" && kind !== "paper" && kind !== "discover") return null;

  let source: LitSource | undefined;
  const positionals: string[] = [];
  const valueFlags = new Set([
    "--limit",
    "--published-after",
    "--published-before",
    "--prioritize",
  ]);
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--source") {
      source = asSource(argv[++index]);
      continue;
    }
    if (token.startsWith("--source=")) {
      source = asSource(token.slice("--source=".length));
      continue;
    }
    if (valueFlags.has(token)) {
      if (!argv[index + 1]?.startsWith("--")) index++;
      continue;
    }
    if (token.startsWith("--")) continue;
    positionals.push(token);
  }

  if (kind === "lit") {
    return { kind, source: source ?? "alphaxiv", query: positionals[0] };
  }
  if (kind === "paper") {
    const id = positionals[0];
    return {
      kind,
      source: source ?? (id ? detectPaperSource(id) : "alphaxiv"),
      id,
    };
  }

  const strategy = positionals[0];
  if (strategy !== "keyword" && strategy !== "embedding") return null;
  return { kind, source: "alphaxiv", strategy, query: positionals[1] };
}
