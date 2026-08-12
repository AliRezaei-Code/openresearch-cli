import {
  ArrowUpRight,
  Blocks,
  BookOpen,
  ChartSpline,
  Check,
  ChevronRight,
  Clock,
  CornerDownLeft,
  FileText,
  FlaskConical,
  FolderOpen,
  GitBranch,
  Globe,
  HelpCircle,
  MoreHorizontal,
  PanelLeft,
  Paperclip,
  Package,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  ToggleRight,
  Users,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { BrandMark } from "./Wordmark";
import {
  cancelQueuedMessage,
  chatAttachmentUrl,
  createChatSession,
  deleteChatSession,
  DEMO_FIGURE_SESSION_ID,
  DEMO_LITERATURE_SESSION_ID,
  DEMO_MAIN_SESSION_ID,
  DEMO_PROJECT_ID,
  getChatMessages,
  getSkills,
  interruptChat,
  listChatSessions,
  reasoningFor,
  reconcileReasoning,
  renameChatSession,
  respondChat,
  sendChatMessage,
  setChatSessionArchived,
  type ChatImageAttachment,
  type ChatMessage,
  type ChatPart,
  type ChatPrompt,
  type ChatSession,
  type Harness,
  type PromptAnswer,
  type QueuedMessage,
  type SkillInfo,
} from "../api";
import { onChatEvent } from "../events";
import { LitSourceLogo, parseOrxLit, paperUrl } from "./LitSourceLogo";
import { LitSourcesList } from "./LitSourcesPicker";
import { Md } from "./Md";
import { PlanStrip } from "./PlanStrip";
import { SETTINGS_NAV, type SettingsTab } from "./SettingsPage";
import { SkillMenu } from "./SkillMenu";
import {
  defaultSelection,
  HARNESS_LABELS,
  ModelPicker,
  OptionPicker,
  usePopover,
  type ModelSelection,
} from "./ModelPicker";
import { ContextMeter } from "./ContextMeter";
import { renderNote } from "./agentNote";
import { loadReadDemoSessions, markDemoSessionRead } from "../demoSessionState";
import { ICON_BUTTON_BASE_CLASS_NAME, ICON_BUTTON_CLASS_NAME, MODEL_ITEM_CLASS_NAME, PAPER_TITLE_CLASS_NAME, SPINNER_CLASS_NAME } from "../styleClasses";

const TOOL_LINE_CLASS_NAME = [
  "tool-line flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap",
  "text-lg",
].join(" ");

const PROMPT_COLLAPSED_CLASS_NAME = [
  "prompt-collapsed text-muted text-lg font-[375] my-3.5 mx-0 [&_summary]:flex",
  "[&_summary]:items-center [&_summary]:gap-2 [&_summary]:cursor-pointer",
  "[&_summary]:list-none [&_summary]:select-none [&_summary::-webkit-details-marker]:hidden",
  "[&_summary::after]:content-['›'] [&_summary::after]:text-muted",
  "[&_summary::after]:transition-transform [&_summary::after]:duration-80 [&_summary::after]:ease-standard [&[open]_summary::after]:rotate-90",
].join(" ");

const PROMPT_COLLAPSED_BODY_CLASS_NAME = [
  "prompt-collapsed-body mt-1.5 pl-3 border-l-2 border-l-border",
  "text-md text-subtext",
].join(" ");

const PLAN_RESOLVED_CLASS_NAME = [
  "prompt-collapsed plan-resolved text-subtext my-3.5 mx-0",
  "[&_summary]:flex [&_summary]:items-center [&_summary]:gap-2 [&_summary]:w-fit [&_summary]:max-w-full",
  "[&_summary]:py-[3px] [&_summary]:px-1 [&_summary]:cursor-pointer [&_summary]:rounded-sm",
  "[&_summary]:list-none [&_summary]:select-none [&_summary:hover]:bg-surface",
  "[&_summary::-webkit-details-marker]:hidden",
  "[&_summary_.plan-chevron]:transition-transform [&_summary_.plan-chevron]:duration-120",
  "[&_summary_.plan-chevron]:ease-standard [&[open]_summary_.plan-chevron]:rotate-90",
].join(" ");

const PROMPT_HEAD_CLASS_NAME = [
  "prompt-head text-xs font-semibold text-text",
  "[&_code]:font-mono [&_code]:text-sm [&_code]:text-text",
].join(" ");

const PROMPT_ACTIONS_CLASS_NAME = [
  "prompt-actions flex flex-wrap gap-2 [&_.btn-primary]:inline-flex",
  "[&_.btn-primary]:items-center [&_.btn-primary]:gap-1.5 [&_.btn-primary]:py-1.5 [&_.btn-primary]:px-[13px]",
  "[&_.btn-primary]:font-[inherit] [&_.btn-primary]:text-sm",
  "[&_.btn-primary]:font-semibold [&_.btn-primary]:border [&_.btn-primary]:border-transparent",
  "[&_.btn-primary]:rounded-sm [&_.btn-primary]:cursor-pointer",
  "[&_.btn-primary]:transition-[background,border-color] [&_.btn-primary]:duration-80 [&_.btn-primary]:ease-standard [&_.btn-ghost]:inline-flex",
  "[&_.btn-ghost]:items-center [&_.btn-ghost]:gap-1.5 [&_.btn-ghost]:py-1.5 [&_.btn-ghost]:px-[13px]",
  "[&_.btn-ghost]:font-[inherit] [&_.btn-ghost]:text-sm",
  "[&_.btn-ghost]:font-semibold [&_.btn-ghost]:border [&_.btn-ghost]:border-transparent",
  "[&_.btn-ghost]:rounded-sm [&_.btn-ghost]:cursor-pointer",
  "[&_.btn-ghost]:transition-[background,border-color] [&_.btn-ghost]:duration-80 [&_.btn-ghost]:ease-standard",
  "[&_.btn-primary]:bg-primary [&_.btn-primary]:text-background",
  "[&_.btn-primary:hover:not(:disabled)]:opacity-90 [&_.btn-ghost]:bg-transparent",
  "[&_.btn-ghost]:border-border [&_.btn-ghost]:text-subtext",
  "[&_.btn-ghost:hover:not(:disabled)]:border-border-strong",
  "[&_.btn-ghost:hover:not(:disabled)]:text-text",
  "[&_.btn-ghost:hover:not(:disabled)]:bg-surface [&_button:disabled]:opacity-50",
  "[&_button:disabled]:cursor-default",
].join(" ");

// --- chat state --------------------------------------------------------------

interface ChatState {
  messagesBySession: Record<string, ChatMessage[]>;
  busySessions: Set<string>;
  // Messages parked behind a running turn, per session, oldest first.
  queuedBySession: Record<string, QueuedMessage[]>;
}

type Action =
  | { type: "reset" }
  | {
      type: "seed";
      sessionId: string;
      messages: ChatMessage[];
      queued?: QueuedMessage[];
      onlyIfAbsent?: boolean;
    }
  | { type: "upsertMessage"; sessionId: string; message: ChatMessage }
  | {
      type: "optimisticUser";
      sessionId: string;
      text: string;
      attachments: { url: string; mediaType: string; name?: string }[];
    }
  | { type: "busy"; sessionId: string; busy: boolean }
  // `known` scopes the reseed: flags for sessions outside it (other projects —
  // busy events aren't project-filtered) are carried forward, not wiped.
  | { type: "seedBusy"; sessions: string[]; known: string[] }
  | { type: "setQueued"; sessionId: string; items: QueuedMessage[] }
  | { type: "forget"; sessionId: string };

const LOCAL_PREFIX = "local-";

function upsertMessage(list: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const i = list.findIndex((m) => m.id === message.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = message;
    return next;
  }
  // The server's copy of the user message replaces the optimistic local one.
  const cleaned =
    message.role === "user" ? list.filter((m) => !m.id.startsWith(LOCAL_PREFIX)) : list;
  return [...cleaned, message];
}

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case "reset":
      return { messagesBySession: {}, busySessions: new Set(), queuedBySession: {} };
    case "seed":
      // onlyIfAbsent: recover a failed fetch without clobbering messages that
      // streamed in via SSE during it (a `message` event already created the key).
      if (action.onlyIfAbsent && action.sessionId in state.messagesBySession) return state;
      return {
        ...state,
        messagesBySession: { ...state.messagesBySession, [action.sessionId]: action.messages },
        // A seed is the authoritative snapshot, so it also (re)sets the parked
        // queue — recovering it after a reload or an SSE gap.
        queuedBySession: {
          ...state.queuedBySession,
          [action.sessionId]: action.queued ?? [],
        },
      };
    case "upsertMessage": {
      const list = state.messagesBySession[action.sessionId] ?? [];
      return {
        ...state,
        messagesBySession: {
          ...state.messagesBySession,
          [action.sessionId]: upsertMessage(list, action.message),
        },
      };
    }
    case "optimisticUser": {
      const list = state.messagesBySession[action.sessionId] ?? [];
      const parts: ChatPart[] = action.text
        ? [{ id: "p0", type: "text", text: action.text }]
        : [];
      // Data URLs stand in until the server's copy arrives with file names.
      action.attachments.forEach((a, i) =>
        parts.push({ id: `img${i}`, type: "image", text: a.url, name: a.name }),
      );
      const msg: ChatMessage = {
        id: `${LOCAL_PREFIX}${Date.now()}`,
        role: "user",
        parts,
        createdAt: Date.now(),
      };
      return {
        ...state,
        messagesBySession: { ...state.messagesBySession, [action.sessionId]: [...list, msg] },
      };
    }
    case "busy": {
      const busySessions = new Set(state.busySessions);
      if (action.busy) busySessions.add(action.sessionId);
      else busySessions.delete(action.sessionId);
      return { ...state, busySessions };
    }
    case "seedBusy": {
      const busySessions = new Set(action.sessions);
      const known = new Set(action.known);
      for (const id of state.busySessions) if (!known.has(id)) busySessions.add(id);
      return { ...state, busySessions };
    }
    case "setQueued": {
      return {
        ...state,
        queuedBySession: { ...state.queuedBySession, [action.sessionId]: action.items },
      };
    }
    case "forget": {
      // Deleted session: drop its transcript and busy flag so a same-id event
      // arriving late can't render stale state.
      const messagesBySession = { ...state.messagesBySession };
      delete messagesBySession[action.sessionId];
      const busySessions = new Set(state.busySessions);
      busySessions.delete(action.sessionId);
      const queuedBySession = { ...state.queuedBySession };
      delete queuedBySession[action.sessionId];
      return { messagesBySession, busySessions, queuedBySession };
    }
  }
}

// --- rendering ---------------------------------------------------------------

function relTime(ts: number | undefined): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The last path segment, for compact display ("src/a/b.rs" → "b.rs"). */
function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

type ToolActivityKind = "read" | "search" | "edit" | "web" | "agent" | "project" | "command";

interface ToolActivity {
  kind: ToolActivityKind;
  label: string;
  filePath?: string;
  labelPrefix?: string;
  labelTarget?: string;
  litCall?: NonNullable<ReturnType<typeof parseOrxLit>>;
  runIds?: string[];
  experimentIds?: string[];
}

function inputString(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function editChange(input: Record<string, unknown>): { path: string; type: string | null } | null {
  const changes = input.changes;
  if (!Array.isArray(changes)) return null;
  for (const change of changes) {
    if (!change || typeof change !== "object" || !("path" in change) || typeof change.path !== "string") {
      continue;
    }
    const kind = "kind" in change ? change.kind : null;
    const type = kind && typeof kind === "object" && "type" in kind && typeof kind.type === "string"
      ? kind.type
      : null;
    return { path: change.path, type };
  }
  return null;
}

/** Codex reports shell commands as `/bin/zsh -lc <script>`. That wrapper is
 * execution plumbing, not useful transcript content. */
function meaningfulCommand(command: string): string {
  const trimmed = command.trim();
  const wrapped = trimmed.match(/^\/bin\/(?:ba|z)?sh\s+-lc\s+([\s\S]+)$/);
  let body = (wrapped?.[1] ?? trimmed).trim();
  const first = body[0];
  if ((first === "\"" || first === "'") && body[body.length - 1] === first) {
    body = body.slice(1, -1);
  }
  return stripHeredocBodies(body).replace(/[\t\r ]+/g, " ").trim();
}

function heredocMarker(line: string): { delimiter: string; stripTabs: boolean } | null {
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length - 1; index++) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char !== "<" || line[index + 1] !== "<") continue;
    index += 2;
    const stripTabs = line[index] === "-";
    if (stripTabs) index++;
    while (/\s/.test(line[index] ?? "")) index++;
    const delimiterQuote = line[index] === "\"" || line[index] === "'" ? line[index++] : null;
    let delimiter = "";
    while (index < line.length) {
      const current = line[index];
      if (delimiterQuote ? current === delimiterQuote : /\s|[;|&]/.test(current)) break;
      delimiter += current;
      index++;
    }
    if (delimiter) return { delimiter, stripTabs };
  }
  return null;
}

function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let marker: { delimiter: string; stripTabs: boolean } | null = null;
  for (const line of lines) {
    if (marker) {
      const candidate = marker.stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate.trimEnd() === marker.delimiter) marker = null;
      continue;
    }
    kept.push(line);
    marker = heredocMarker(line);
  }
  return kept.join("\n");
}

function shellCommandSegment(command: string, start: number): string {
  let segment = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let i = start; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      segment += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      segment += char;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      segment += char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "<" || char === ">") {
      return segment.replace(/\s+\d+$/, "").trim();
    }
    segment += char;
  }
  return segment.trim();
}

function shellWords(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  const push = () => {
    if (word) words.push(word);
    word = "";
  };

  for (const char of input) {
    if (escaped) {
      word += char;
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
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) push();
    else word += char;
  }
  push();
  return words;
}

function validReadTarget(value: string | undefined): string | null {
  if (!value || value === "-" || /^\d+$/.test(value) || /[$`]/.test(value)) return null;
  return value;
}

function commandReadTarget(command: string): string | null {
  const reader = /(?:^|[^\w-])(sed|cat|head|tail)\b/.exec(command);
  if (!reader || reader.index === undefined) return null;
  const args = shellWords(shellCommandSegment(command, reader.index + reader[0].length));
  const name = reader[1];

  if (name === "sed") {
    let index = 0;
    let scriptProvidedByOption = false;
    while (index < args.length && args[index].startsWith("-")) {
      const option = args[index++];
      if (option === "-e" || option === "--expression" || option === "-f" || option === "--file") {
        scriptProvidedByOption = true;
        index++;
      }
    }
    if (!scriptProvidedByOption) index++;
    return validReadTarget(args.slice(index).find((arg) => !arg.startsWith("-")));
  }

  const files: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {
      files.push(...args.slice(index + 1));
      break;
    }
    if (name !== "cat" && ["-n", "--lines", "-c", "--bytes", "--pid"].includes(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    files.push(arg);
  }
  return validReadTarget(files[0]);
}

function commandSearchPattern(command: string): string | null {
  const search = command.match(/\b(?:rg|grep)\b(?:\s+-[^\s]+)*\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return search?.[1] ?? search?.[2] ?? search?.[3] ?? null;
}

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RUN_TARGET_PATTERN = `(?:${UUID_PATTERN}|[0-9a-f]{8})`;

interface ShellCommandSegment {
  raw: string;
  code: string;
}

function shellCommandSegments(command: string): ShellCommandSegment[] {
  const segments: ShellCommandSegment[] = [];
  let raw = "";
  let code = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  const push = () => {
    if (raw.trim() || code.trim()) segments.push({ raw: raw.trim(), code: code.trim() });
    raw = "";
    code = "";
  };
  const scanSubstitution = (start: number): number => {
    let depth = 1;
    let nestedQuote: "\"" | "'" | null = null;
    let nestedEscaped = false;
    for (let index = start; index < command.length; index++) {
      const char = command[index];
      if (nestedEscaped) {
        nestedEscaped = false;
        continue;
      }
      if (char === "\\" && nestedQuote !== "'") {
        nestedEscaped = true;
        continue;
      }
      if (nestedQuote) {
        if (char === nestedQuote) nestedQuote = null;
        continue;
      }
      if (char === "\"" || char === "'") {
        nestedQuote = char;
        continue;
      }
      if (char === "(") depth++;
      if (char === ")" && --depth === 0) return index;
    }
    return command.length - 1;
  };
  const scanBackticks = (start: number): number => {
    let nestedEscaped = false;
    for (let index = start; index < command.length; index++) {
      const char = command[index];
      if (nestedEscaped) {
        nestedEscaped = false;
        continue;
      }
      if (char === "\\") {
        nestedEscaped = true;
        continue;
      }
      if (char === "`") return index;
    }
    return command.length - 1;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      raw += char;
      if (!quote) code += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      raw += char;
      escaped = true;
      continue;
    }
    if (quote) {
      if (quote === "\"" && char === "$" && command[index + 1] === "(") {
        const end = scanSubstitution(index + 2);
        segments.push(...shellCommandSegments(command.slice(index + 2, end)));
        raw += command.slice(index, end + 1);
        index = end;
        continue;
      }
      if (quote === "\"" && char === "`") {
        const end = scanBackticks(index + 1);
        segments.push(...shellCommandSegments(command.slice(index + 1, end)));
        raw += command.slice(index, end + 1);
        index = end;
        continue;
      }
      raw += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      raw += char;
      quote = char;
      continue;
    }
    if (char === "`") {
      const end = scanBackticks(index + 1);
      segments.push(...shellCommandSegments(command.slice(index + 1, end)));
      raw += command.slice(index, end + 1);
      index = end;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")" || char === "\n") {
      push();
      continue;
    }
    raw += char;
    code += char;
  }
  push();
  return segments;
}

function orxCommandSegments(command: string, args: string): ShellCommandSegment[] {
  const invocation = new RegExp(`(?:^|\\b(?:do|then|else|if|while|until)\\s+)(?:[A-Za-z_][A-Za-z0-9_]*=[^\\s]+\\s+)*orx\\s+${args}\\b`, "i");
  return shellCommandSegments(command).filter((segment) => invocation.test(segment.code));
}

function commandInvokesOrx(command: string, args: string): boolean {
  return orxCommandSegments(command, args).length > 0;
}

function idsFromToolOutput(output: string | undefined, resource: "runs" | "experiments"): string[] {
  if (!output) return [];
  const ids = new Set<string>();
  const patterns = resource === "runs"
    ? [
        new RegExp(`/runs/(${UUID_PATTERN})`, "gi"),
        new RegExp(`\\brun(?:_|\\s+)id:\\s*(${UUID_PATTERN})`, "gi"),
        new RegExp(`={3,}\\s*(${UUID_PATTERN})\\s*={3,}`, "gi"),
      ]
    : [
        new RegExp(`/experiments/(${UUID_PATTERN})`, "gi"),
        new RegExp(`^\\s*id:\\s*(${UUID_PATTERN})`, "gim"),
        new RegExp(`={3,}\\s*(${UUID_PATTERN})\\s*={3,}`, "gi"),
      ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) ids.add(match[1]);
  }
  if (ids.size === 0) {
    const bareId = new RegExp(`(?:^|\\s)(${UUID_PATTERN})(?=\\s|$)`, "gim");
    for (const match of output.matchAll(bareId)) ids.add(match[1]);
  }
  return [...ids];
}

function commandRunIds(command: string, output?: string): string[] {
  const invocations = orxCommandSegments(command, "logs");
  if (invocations.length === 0) return [];
  const ids = new Set<string>();
  for (const invocation of invocations) {
    const logs = /\borx\s+logs\b/i.exec(invocation.raw);
    if (!logs) continue;
    const words = shellWords(invocation.raw.slice(logs.index + logs[0].length));
    let target: string | null = null;
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      if (word === "--head") continue;
      if (word === "--bytes" || word === "--range") {
        index++;
        continue;
      }
      if (word.startsWith("--bytes=") || word.startsWith("--range=")) continue;
      target = word;
      break;
    }
    if (!target) continue;
    if (new RegExp(`^${RUN_TARGET_PATTERN}$`, "i").test(target)) {
      ids.add(target);
      continue;
    }
    const variableMatch = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(target);
    if (!variableMatch) continue;
    const variable = variableMatch[1];
    const assignment = command.match(
      new RegExp(`(?:^|[\\s;])(?:export\\s+)?${variable}\\s*=\\s*["']?(${RUN_TARGET_PATTERN})`, "i"),
    );
    if (assignment) ids.add(assignment[1]);
    const loop = command.match(new RegExp(`\\bfor\\s+${variable}\\s+in\\s+([\\s\\S]*?)(?:;|\\n)\\s*do\\b`, "i"));
    if (!loop) continue;
    for (const id of loop[1].matchAll(new RegExp(RUN_TARGET_PATTERN, "gi"))) ids.add(id[0]);
  }
  if (ids.size === 0) idsFromToolOutput(output, "runs").forEach((id) => ids.add(id));
  return [...ids];
}

function commandExperimentIds(command: string, output?: string): string[] {
  const invocations = orxCommandSegments(command, "exp\\s+(?:status|desc)");
  if (invocations.length === 0) return [];
  const ids = new Set<string>();
  for (const invocation of invocations) {
    for (const match of invocation.raw.matchAll(new RegExp(`\\borx\\s+exp\\s+(?:status|desc)\\s+["']?(${UUID_PATTERN})`, "gi"))) {
      ids.add(match[1]);
    }
  }
  for (const invocation of invocations) {
    const match = /\borx\s+exp\s+(?:status|desc)\s+["']?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/.exec(invocation.raw);
    if (!match) continue;
    const variable = match[1];
    const loop = command.match(new RegExp(`\\bfor\\s+${variable}\\s+in\\s+([\\s\\S]*?)(?:;|\\n)\\s*do\\b`, "i"));
    if (!loop) continue;
    for (const id of loop[1].matchAll(new RegExp(UUID_PATTERN, "gi"))) ids.add(id[0]);
  }
  if (ids.size === 0) idsFromToolOutput(output, "experiments").forEach((id) => ids.add(id));
  return [...ids];
}

/** User-facing activity inferred from the structured tool input. Shell calls
 * get a small set of realistic recognizers; unknown commands keep their actual
 * command after the shell wrapper is removed. */
function toolActivity(part: ChatPart): ToolActivity {
  const tool = part.tool ?? "tool";
  const input = part.state?.input ?? {};
  const rawCommand = inputString(input, "command");
  const toolOutput = part.state?.output || part.state?.error;
  const filePath = inputString(input, "filePath", "file_path");
  const description = inputString(input, "description");
  switch (tool.toLowerCase()) {
    case "bash": {
      if (!rawCommand) return { kind: "command", label: "Ran a command" };
      const litCall = parseOrxLit(rawCommand);
      if (litCall) {
        const label = litCall.kind === "lit"
          ? litCall.query ? `Searched for “${litCall.query}”` : "Searched the literature"
          : litCall.id ? `Read ${litCall.id}` : "Read a paper";
        return { kind: litCall.kind === "lit" ? "search" : "read", label, litCall };
      }

      const command = meaningfulCommand(rawCommand);
      const readsExperimentStatus = commandInvokesOrx(command, "exp\\s+status");
      const readsExperimentNotes = commandInvokesOrx(command, "exp\\s+desc");
      if (commandInvokesOrx(command, "logs")) {
        const runIds = commandRunIds(command, toolOutput);
        const label = runIds.length === 1 ? "Reviewed run log" : "Reviewed run logs";
        return { kind: "project", label, runIds };
      }
      if (commandInvokesOrx(command, "exp\\s+run")) {
        return { kind: "project", label: "Started an experiment run" };
      }
      if (commandInvokesOrx(command, "exp\\s+wait")) {
        return { kind: "project", label: "Waited for an experiment run" };
      }
      if (commandInvokesOrx(command, "exp\\s+cancel")) {
        return { kind: "project", label: "Cancelled an experiment run" };
      }
      const readsProject = commandInvokesOrx(command, "project\\s+view");
      if (readsProject && readsExperimentStatus && readsExperimentNotes) {
        return {
          kind: "project",
          label: "Reviewed experiment status and notes",
          experimentIds: commandExperimentIds(command, toolOutput),
        };
      }
      if (readsProject && readsExperimentNotes) {
        return {
          kind: "project",
          label: "Read experiment notes",
          experimentIds: commandExperimentIds(command, toolOutput),
        };
      }
      if (readsProject && readsExperimentStatus) {
        return {
          kind: "project",
          label: "Checked experiment status",
          experimentIds: commandExperimentIds(command, toolOutput),
        };
      }
      if (readsProject) {
        return { kind: "project", label: "Read project details" };
      }
      if (readsExperimentStatus && readsExperimentNotes) {
        return {
          kind: "project",
          label: "Reviewed experiment status and notes",
          experimentIds: commandExperimentIds(command, toolOutput),
        };
      }
      if (readsExperimentStatus) {
        return {
          kind: "project",
          label: "Checked experiment status",
          experimentIds: commandExperimentIds(command, toolOutput),
        };
      }
      if (readsExperimentNotes) {
        return {
          kind: "project",
          label: "Read experiment notes",
          experimentIds: commandExperimentIds(command, toolOutput),
        };
      }
      if (commandInvokesOrx(command, "runs?")) {
        return { kind: "project", label: "Listed project runs" };
      }

      const readTarget = commandReadTarget(command);
      if (readTarget) {
        return {
          kind: "read",
          label: `Read ${baseName(readTarget)}`,
          filePath: readTarget,
          labelPrefix: "Read ",
          labelTarget: baseName(readTarget),
        };
      }
      if (/\brg\s+--files\b/.test(command) || /\bfind\s+/.test(command) || /^ls(?:\s|$)/.test(command)) {
        return { kind: "search", label: "Listed files" };
      }
      if (/\b(?:rg|grep)\b/.test(command)) {
        const pattern = commandSearchPattern(command);
        return { kind: "search", label: pattern ? `Searched code for “${pattern}”` : "Searched code" };
      }
      if (/\bgit\s+status\b/.test(command)) return { kind: "command", label: "Checked Git status" };
      if (/\bgit\s+diff\b/.test(command)) return { kind: "command", label: "Reviewed code changes" };
      if (/\bgit\s+log\b/.test(command)) return { kind: "command", label: "Read Git history" };
      if (/\b(?:cargo|pnpm|npm|yarn)\s+(?:run\s+)?test\b/.test(command)) return { kind: "command", label: "Ran tests" };
      if (/\b(?:typecheck|tsc\b)/.test(command)) return { kind: "command", label: "Checked types" };
      if (/\blint\b/.test(command)) return { kind: "command", label: "Checked code style" };
      if (/\b(?:cargo|pnpm|npm|yarn)\s+(?:run\s+)?build\b/.test(command)) return { kind: "command", label: "Built the project" };
      return { kind: "command", label: `Ran ${command}` };
    }
    case "read": {
      const target = filePath ? baseName(filePath) : null;
      return target
        ? { kind: "read", label: `Read ${target}`, filePath: filePath ?? undefined, labelPrefix: "Read ", labelTarget: target }
        : { kind: "read", label: "Read a file" };
    }
    case "edit":
    case "write":
    case "notebookedit": {
      const change = editChange(input);
      const resolvedPath = filePath ?? change?.path ?? null;
      const target = resolvedPath ? baseName(resolvedPath) : null;
      const verb = change?.type === "add" ? "Created" : change?.type === "delete" ? "Deleted" : "Edited";
      return target
        ? { kind: "edit", label: `${verb} ${target}`, filePath: resolvedPath ?? undefined, labelPrefix: `${verb} `, labelTarget: target }
        : { kind: "edit", label: "Edited a file" };
    }
    case "grep": {
      const pattern = inputString(input, "pattern");
      return { kind: "search", label: pattern ? `Searched code for “${pattern}”` : "Searched code" };
    }
    case "glob": {
      const pattern = inputString(input, "pattern");
      return { kind: "search", label: pattern ? `Listed files matching ${pattern}` : "Listed files" };
    }
    case "websearch": {
      const query = inputString(input, "query");
      const url = inputString(input, "url");
      const pattern = inputString(input, "pattern");
      if (query) return { kind: "web", label: `Searched the web for “${query}”` };
      if (pattern && url) return { kind: "web", label: `Searched “${pattern}” on a page` };
      if (url) return { kind: "web", label: `Opened ${url}` };
      return { kind: "web", label: description ?? "Browsed the web" };
    }
    case "webfetch": {
      const url = inputString(input, "url");
      return { kind: "web", label: url ? `Read ${url}` : description ?? "Read a web page" };
    }
    case "task":
      return { kind: "agent", label: description ?? "Ran a subagent" };
    case "subagent":
      return { kind: "agent", label: subagentLine(input) };
    case "error":
      return { kind: "command", label: "Tool failed" };
    case "interrupted":
      return { kind: "command", label: "Tool was interrupted" };
    default: {
      const detail = description ?? filePath ?? rawCommand ?? part.state?.title ?? "";
      return { kind: "command", label: detail ? `${tool}: ${detail}` : tool };
    }
  }
}

/** Readable one-liner for a Codex sub-agent spawn/activity row, from the
 * collab item fields the backend put in `state.input`. */
function subagentLine(input: Record<string, unknown>): string {
  const trim = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);
  const prompt = typeof input.prompt === "string" && input.prompt ? ` — “${trim(input.prompt)}”` : "";
  // collabAgentToolCall carries `tool`; subAgentActivity carries `kind`.
  switch (typeof input.tool === "string" ? input.tool : "") {
    case "spawnAgent":
      return `Spawned agent${prompt}`;
    case "sendInput":
      return `Sent input to agent${prompt}`;
    case "resumeAgent":
      return "Resumed agent";
    case "wait":
      return "Waiting on agent";
    case "closeAgent":
      return "Closed agent";
  }
  switch (typeof input.kind === "string" ? input.kind : "") {
    case "started":
      return "Sub-agent started";
    case "interacted":
      return "Sub-agent activity";
    case "interrupted":
      return "Sub-agent interrupted";
  }
  return "Sub-agent";
}

function ToolActivityIcon({ activity, className = "" }: { activity: ToolActivity; className?: string }) {
  if (activity.litCall) return <LitSourceLogo source={activity.litCall.source} size={16} />;
  const props = { size: 16, strokeWidth: 1.75, className: `tool-kind-icon shrink-0 ${className}` };
  switch (activity.kind) {
    case "read":
    case "project":
      return <BookOpen {...props} />;
    case "search":
      return <Search {...props} />;
    case "edit":
      return <Pencil {...props} />;
    case "web":
      return <Globe {...props} />;
    case "agent":
      return <Users {...props} />;
    case "command":
      return <SquareTerminal {...props} />;
  }
}

function ToolTargetOverflow({
  items,
  onOpen,
}: {
  items: Array<{ id: string; label: string }>;
  onOpen?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const revealRef = useRef<HTMLSpanElement>(null);
  const focusReveal = useRef(false);

  useEffect(() => {
    if (!open || !focusReveal.current) return;
    focusReveal.current = false;
    revealRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  return (
    <span className="tool-target-overflow inline">
      {open && (
        <span className="tool-target-reveal" ref={revealRef}>
          {items.map((item, index) => (
            <span key={item.id}>
              {index > 0 && ", "}
              {onOpen ? (
                <button
                  className="tool-target"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpen(item.id);
                  }}
                >
                  {item.label}
                </button>
              ) : (
                <span>{item.label}</span>
              )}
            </span>
          ))}
        </span>
      )}
      {open && ", "}
      <button
        className="tool-target-more"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          focusReveal.current = !open && event.detail === 0;
          setOpen((value) => !value);
        }}
      >
        {open ? "show less" : `+ ${items.length} more`}
      </button>
    </span>
  );
}

function ToolActivityLabel({
  activity,
  onOpenFile,
  onOpenRun,
  runExperimentName,
  onOpenExperiment,
  experimentName,
}: {
  activity: ToolActivity;
  onOpenFile?: (path: string) => void;
  onOpenRun?: (runId: string) => void;
  runExperimentName?: (runId: string) => string;
  onOpenExperiment?: (experimentId: string) => void;
  experimentName?: (experimentId: string) => string;
}) {
  if (activity.litCall?.kind === "paper" && activity.litCall.id) {
    return (
      <a
        className="tool-target"
        href={paperUrl(activity.litCall.source, activity.litCall.id)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {activity.label}
        <ArrowUpRight className="inline ml-1 opacity-50" size={13} aria-hidden="true" />
      </a>
    );
  }
  if (activity.filePath && activity.labelTarget && onOpenFile) {
    const filePath = activity.filePath;
    return (
      <>
        {activity.labelPrefix}
        <button
          className="tool-target"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenFile(filePath);
          }}
        >
          {activity.labelTarget}
        </button>
      </>
    );
  }
  if (activity.runIds?.length) {
    const runIds = runExperimentName
      ? activity.runIds.filter((runId) => Boolean(runExperimentName(runId)))
      : activity.runIds;
    if (runIds.length === 0) return activity.label;
    const multiple = runIds.length > 1;
    const visibleRunIds = runIds.slice(0, 3);
    const hiddenRuns = runIds.slice(visibleRunIds.length).map((runId) => ({
      id: runId,
      label: runExperimentName?.(runId) || "Experiment",
    }));
    return (
      <>
        {multiple ? "Reviewed run logs for " : "Reviewed run log "}
        {visibleRunIds.map((runId, index) => (
          <span key={runId}>
            {index > 0 && ", "}
            {onOpenRun ? (
              <button
                className="tool-target"
                title={`Open logs for run ${runId}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenRun(runId);
                }}
              >
                {runExperimentName?.(runId) || "Experiment"}
              </button>
            ) : (
              <span>{runExperimentName?.(runId) || "Experiment"}</span>
            )}
          </span>
        ))}
        {hiddenRuns.length > 0 && (
          <>
            {", "}
            <ToolTargetOverflow items={hiddenRuns} onOpen={onOpenRun} />
          </>
        )}
      </>
    );
  }
  if (activity.experimentIds?.length) {
    const experimentIds = experimentName
      ? activity.experimentIds.filter((experimentId) => Boolean(experimentName(experimentId)))
      : activity.experimentIds;
    if (experimentIds.length === 0) return activity.label;
    const visibleExperimentIds = experimentIds.slice(0, 3);
    const hiddenExperiments = experimentIds.slice(visibleExperimentIds.length).map((experimentId) => ({
      id: experimentId,
      label: experimentName?.(experimentId) || "Experiment",
    }));
    return (
      <>
        {activity.label} for {visibleExperimentIds.map((experimentId, index) => (
          <span key={experimentId}>
            {index > 0 && ", "}
            {onOpenExperiment ? (
              <button
                className="tool-target"
                title={`Open experiment ${experimentName?.(experimentId) || ""}`.trim()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenExperiment(experimentId);
                }}
              >
                {experimentName?.(experimentId) || "Experiment"}
              </button>
            ) : (
              <span>{experimentName?.(experimentId) || "Experiment"}</span>
            )}
          </span>
        ))}
        {hiddenExperiments.length > 0 && (
          <>
            {", "}
            <ToolTargetOverflow items={hiddenExperiments} onOpen={onOpenExperiment} />
          </>
        )}
      </>
    );
  }
  return activity.label;
}

function summarizeToolGroup(activities: ToolActivity[]): string {
  const count = (kind: ToolActivityKind) => activities.filter((activity) => activity.kind === kind).length;
  const clauses: string[] = [];
  const reads = count("read");
  const searches = count("search");
  const edits = count("edit");
  const projects = count("project");
  const web = count("web");
  const commands = count("command");
  const agents = count("agent");

  if (reads) clauses.push(reads === 1 ? "Read a file" : "Read files");
  if (searches) clauses.push("searched code");
  if (edits) clauses.push(edits === 1 ? "edited a file" : "edited files");
  if (projects) clauses.push("reviewed project data");
  if (web) clauses.push("browsed the web");
  if (commands) clauses.push(commands === 1 ? "ran a command" : "ran commands");
  if (agents) clauses.push(agents === 1 ? "worked with a subagent" : "worked with subagents");
  const summary = clauses.join(", ");
  return summary ? `${summary[0].toUpperCase()}${summary.slice(1)}` : "Used tools";
}

function activityInProgress(activity: ToolActivity): ToolActivity {
  const replacements: Array<[RegExp, string]> = [
    [/^Reviewed run logs?/, activity.label.startsWith("Reviewed run logs") ? "Reading run logs" : "Reading run log"],
    [/^Reviewed /, "Reviewing "],
    [/^Read /, "Reading "],
    [/^Searched /, "Searching "],
    [/^Listed /, "Listing "],
    [/^Edited /, "Editing "],
    [/^Created /, "Creating "],
    [/^Deleted /, "Deleting "],
    [/^Ran /, "Running "],
    [/^Started /, "Starting "],
    [/^Waited /, "Waiting "],
    [/^Checked /, "Checking "],
    [/^Built /, "Building "],
    [/^Cancelled /, "Cancelling "],
  ];
  let label = activity.label;
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(label)) continue;
    label = label.replace(pattern, replacement);
    break;
  }
  return { ...activity, label };
}

function resolvedActivityLabel(
  activity: ToolActivity,
  runExperimentName?: (runId: string) => string,
  experimentName?: (experimentId: string) => string,
): string {
  const summarizedNames = (names: string[]) => {
    const visible = names.slice(0, 3);
    const remaining = names.length - visible.length;
    return `${visible.join(", ")}${remaining > 0 ? `, + ${remaining} more` : ""}`;
  };
  if (activity.runIds?.length) {
    const names = activity.runIds.map((runId) => runExperimentName?.(runId) || "").filter(Boolean);
    if (names.length === 0) return activity.label;
    return `${activity.label}${names.length > 1 ? " for " : " "}${summarizedNames(names)}`;
  }
  if (activity.experimentIds?.length) {
    const names = activity.experimentIds.map((experimentId) => experimentName?.(experimentId) || "").filter(Boolean);
    if (names.length === 0) return activity.label;
    return `${activity.label} for ${summarizedNames(names)}`;
  }
  return activity.label;
}

function latestRunningActivity(parts: ChatPart[]): ToolActivity | null {
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index].state?.status === "running") return activityInProgress(toolActivity(parts[index]));
  }
  return null;
}

function groupIconActivity(activities: ToolActivity[]): ToolActivity {
  const priority: ToolActivityKind[] = ["read", "search", "edit", "project", "web", "command", "agent"];
  for (const kind of priority) {
    const activity = activities.find((candidate) => candidate.kind === kind);
    if (activity) return activity;
  }
  return activities[0] ?? { kind: "command", label: "Used tools" };
}

interface SquashedToolPart {
  part: ChatPart;
  count: number;
}

function squashableToolPartKey(part: ChatPart): string | null {
  if (part.state?.status !== "completed") return null;
  const activity = toolActivity(part);
  return JSON.stringify([
    activity.kind,
    activity.label,
    activity.filePath ?? null,
    activity.litCall?.kind === "paper" ? activity.litCall.id ?? null : null,
    activity.runIds ?? null,
    activity.experimentIds ?? null,
  ]);
}

function squashToolParts(parts: ChatPart[]): SquashedToolPart[] {
  const squashed: SquashedToolPart[] = [];
  for (const part of parts) {
    const key = squashableToolPartKey(part);
    const previous = squashed[squashed.length - 1];
    if (key && previous && squashableToolPartKey(previous.part) === key) {
      previous.count++;
    } else {
      squashed.push({ part, count: 1 });
    }
  }
  return squashed;
}

/** Routine successful calls are static activity rows. Only failures disclose
 * raw command/output, because that detail is useful for diagnosis. */
function ToolRow({
  part,
  repeatCount = 1,
  onOpenFile,
  onOpenRun,
  runExperimentName,
  onOpenExperiment,
  experimentName,
}: {
  part: ChatPart;
  repeatCount?: number;
  onOpenFile?: (path: string) => void;
  onOpenRun?: (runId: string) => void;
  runExperimentName?: (runId: string) => string;
  onOpenExperiment?: (experimentId: string) => void;
  experimentName?: (experimentId: string) => string;
}) {
  const state = part.state;
  const activity = toolActivity(part);
  const failed = state?.status === "error";
  const errorMessage = (state?.error || state?.output || "").replace(/^Exit code \d+\s*/i, "").trim();
  const hasDetail = failed && Boolean(errorMessage);
  const line = (
    <>
      <ToolActivityIcon
        activity={activity}
        className={`${failed ? "text-accent-red" : "text-muted"} self-start mt-[5px]`}
      />
      <span className={`tool-line flex-1 min-w-0 whitespace-normal break-words text-lg ${failed ? "text-accent-red" : "text-subtext"}`}>
        <ToolActivityLabel
          activity={activity}
          onOpenFile={onOpenFile}
          onOpenRun={onOpenRun}
          runExperimentName={runExperimentName}
          onOpenExperiment={onOpenExperiment}
          experimentName={experimentName}
        />
        {repeatCount > 1 && (
          <span className="tool-repeat-count ml-1 text-muted font-normal" title={`${repeatCount} consecutive identical calls`}>
            ×{repeatCount}
          </span>
        )}
      </span>
    </>
  );

  if (!hasDetail) {
    return <div className="tool-row flex items-center gap-2 min-w-0 py-[3px] px-1">{line}</div>;
  }

  return (
    <details className="tool-row tool-row-error group flex flex-col [&_summary]:flex [&_summary]:items-center [&_summary]:gap-2 [&_summary]:w-fit [&_summary]:max-w-full [&_summary]:py-[3px] [&_summary]:px-1 [&_summary]:cursor-pointer [&_summary]:list-none [&_summary]:select-none [&_summary]:min-w-0 [&_summary]:rounded-sm [&_summary:hover]:bg-surface [&_summary::-webkit-details-marker]:hidden">
      <summary>
        {line}
        <ChevronRight size={12} className="tool-row-chevron shrink-0 text-accent-red transition-transform duration-120 ease-standard group-open:rotate-90" />
      </summary>
      <div className="tool-detail mt-1 mr-0 mb-1 ml-6">
        <div className="tool-output py-1.5 px-2.5 font-mono text-xs text-subtext whitespace-pre-wrap wrap-anywhere max-h-65 overflow-y-auto bg-background border border-border-variant rounded-sm">
          {errorMessage.slice(0, 20000)}
        </div>
      </div>
    </details>
  );
}

/** Consecutive calls render as one Codex-style activity group: a readable
 * aggregate description and a collapsible list of semantic rows. */
function ToolGroup({
  parts,
  onOpenFile,
  onOpenRun,
  runExperimentName,
  onOpenExperiment,
  experimentName,
}: {
  parts: ChatPart[];
  onOpenFile?: (path: string) => void;
  onOpenRun?: (runId: string) => void;
  runExperimentName?: (runId: string) => string;
  onOpenExperiment?: (experimentId: string) => void;
  experimentName?: (experimentId: string) => string;
}) {
  const running = parts.some((p) => p.state?.status === "running");
  const [open, setOpen] = useState(running);
  const wasRunning = useRef(running);
  const hasRun = useRef(running);
  const displayParts = squashToolParts(parts);
  const activities = displayParts.map(({ part }) => toolActivity(part));
  const runningActivity = latestRunningActivity(parts);
  const summary = summarizeToolGroup(activities);
  const iconActivity = runningActivity ?? groupIconActivity(activities);
  const summaryLabel = runningActivity
    ? resolvedActivityLabel(runningActivity, runExperimentName, experimentName)
    : summary;
  const liveMessage = running ? summaryLabel : hasRun.current ? "Tool activity completed" : "";

  useEffect(() => {
    if (running) hasRun.current = true;
  }, [running]);

  useEffect(() => {
    if (running === wasRunning.current) return;
    wasRunning.current = running;
    setOpen(running);
  }, [running]);

  if (parts.length === 1) {
    if (runningActivity) {
      return (
        <div className="tool-group my-3.5 mx-0">
          <div className="tool-row flex items-start gap-2 min-w-0 py-[3px] px-1 text-lg text-subtext">
            <ToolActivityIcon activity={runningActivity} className="tool-running-shimmer-icon self-start mt-[5px]" />
            <span className="tool-running-shimmer min-w-0 whitespace-normal break-words">
              {resolvedActivityLabel(runningActivity, runExperimentName, experimentName)}
            </span>
          </div>
          <span className="sr-only" role="status" aria-live="polite">{liveMessage}</span>
        </div>
      );
    }
    return (
      <div className="tool-group my-3.5 mx-0">
        <ToolRow
          part={parts[0]}
          onOpenFile={onOpenFile}
          onOpenRun={onOpenRun}
          runExperimentName={runExperimentName}
          onOpenExperiment={onOpenExperiment}
          experimentName={experimentName}
        />
        <span className="sr-only" role="status" aria-live="polite">{liveMessage}</span>
      </div>
    );
  }

  const expanded = open;
  return (
    <div className="tool-group my-3.5 mx-0">
      <button
        className="tool-group-summary flex items-start gap-2 w-fit max-w-full py-[3px] px-1 cursor-pointer text-lg text-subtext text-left rounded-sm [&:hover]:bg-surface"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expanded}
      >
        <ToolActivityIcon activity={iconActivity} className={`${running ? "tool-running-shimmer-icon" : "text-muted"} mt-[5px]`} />
        <span className={`tool-group-label min-w-0 whitespace-normal break-words ${running ? "tool-running-shimmer" : ""}`}>
          {summaryLabel}
        </span>
        <ChevronRight size={13} className={`tool-chevron shrink-0 mt-[6px] text-muted transition-transform duration-120 ease-standard [&.open]:rotate-90 ${expanded ? "open" : ""}`} />
      </button>
      <span className="sr-only" role="status" aria-live="polite">{liveMessage}</span>
      {expanded && (
        <div className="tool-group-rows flex flex-col gap-px mt-0.5 mr-0 mb-1 ml-6">
          {displayParts.map(({ part, count }) => (
            <ToolRow
              key={part.id}
              part={part}
              repeatCount={count}
              onOpenFile={onOpenFile}
              onOpenRun={onOpenRun}
              runExperimentName={runExperimentName}
              onOpenExperiment={onOpenExperiment}
              experimentName={experimentName}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Interactive card for a plan / permission / question prompt. Approving (or
 * answering) resumes the session. Once resolved, cards mirror Claude Code:
 * a permission leaves no trace, a plan collapses to an expandable
 * "Proposed plan" row, a question collapses to a compact record of the
 * chosen answer — all inline at the card's chronological position. */
function PromptCard({
  part,
  onRespond,
  onOpenFile,
  onOpenPlan,
}: {
  part: ChatPart;
  onRespond?: (answer: PromptAnswer) => void;
  onOpenFile?: (path: string, line?: number, exp?: string) => void;
  onOpenPlan?: (plan: string, promptId: string) => void;
}) {
  const p = part.prompt as ChatPrompt;
  const [picked, setPicked] = useState<string[]>([]);
  // Read-only host (no onRespond): actions disabled or hidden, card visible.
  const done = !onRespond;

  const respond = (answer: Omit<PromptAnswer, "promptId">) =>
    onRespond?.({ promptId: part.id, ...answer });

  // Resolved rendering, keyed off `resolved` alone (`done` also covers
  // read-only hosts, where an *unresolved* card must stay visible).
  if (p.resolved) {
    if (p.kind === "permission") return null;
    if (p.kind === "plan") {
      const outcome = p.approved === true
        ? { label: "Plan approved", icon: Check, iconClass: "text-accent-green" }
        : p.approved === false && p.note
          ? { label: "Plan revision requested", icon: Pencil, iconClass: "text-accent-amber" }
          : p.approved === false
            ? { label: "Plan rejected", icon: X, iconClass: "text-accent-red" }
            : { label: "Plan resolved", icon: FileText, iconClass: "text-muted" };
      const OutcomeIcon = outcome.icon;
      return (
        <details className={PLAN_RESOLVED_CLASS_NAME}>
          <summary>
            <span className="plan-resolved-label text-lg font-[375] wrap-anywhere">
              {p.synthesized ? "Plan" : "Proposed plan"}
            </span>
            <OutcomeIcon size={17} strokeWidth={1.8} className={`shrink-0 ${outcome.iconClass}`} />
            <span className="plan-resolved-label prompt-outcome text-lg font-[375] wrap-anywhere">{outcome.label}</span>
            <ChevronRight size={12} className="plan-chevron shrink-0 text-muted" />
          </summary>
          <div className={`${PROMPT_COLLAPSED_BODY_CLASS_NAME} ml-6`}>
            <Md text={p.plan ?? ""} onOpenFile={onOpenFile} />
            {p.note && <div className="prompt-collapsed-note mt-1.5 italic">{p.note}</div>}
          </div>
        </details>
      );
    }
    // question — one line: header/question + what was chosen (or the typed
    // custom answer). No echo at all (stale-resolved): neutral "Resolved",
    // matching the plan row.
    const chosen = (p.answers ?? []).join(", ") || p.note || "";
    return (
      <details className={PROMPT_COLLAPSED_CLASS_NAME}>
        <summary>
          <span className="prompt-collapsed-title font-[375] wrap-anywhere">{p.header || p.question || "Question"}</span>
          <span className={`prompt-outcome font-[375] text-subtext wrap-anywhere [&.approved]:text-accent-green [&.chosen]:text-accent-green [&.approved::before]:content-['✓_'] [&.chosen::before]:content-['✓_'] [&.revised]:text-accent-amber [&.rejected]:text-accent-amber ${chosen ? "chosen" : ""}`}>{chosen || "Resolved"}</span>
        </summary>
        <div className={PROMPT_COLLAPSED_BODY_CLASS_NAME}>
          {/* The summary title already shows the question when there's no header. */}
          {p.header && p.question && <div className="prompt-q text-base font-semibold leading-normal text-text">{p.question}</div>}
          {(p.options ?? []).length > 0 && (
            <ul className="prompt-collapsed-options mt-1.5 mx-0 mb-0 pl-4.5 [&_.sel]:text-text [&_.sel]:font-semibold">
              {(p.options ?? []).map((o) => (
                <li key={o.label} className={p.answers?.includes(o.label) ? "sel" : ""}>
                  {o.label}
                </li>
              ))}
            </ul>
          )}
          {/* A note-only answer is already the summary outcome — don't echo it twice. */}
          {p.note && p.note !== chosen && <div className="prompt-collapsed-note mt-1.5 italic">{p.note}</div>}
        </div>
      </details>
    );
  }

  if (p.kind === "plan") {
    // With a plan-strip host (onOpenPlan), the docked strip owns the approval
    // actions and the full plan lives in the right pane — the inline card is a
    // compact, clamped in-transcript record. Without one, it keeps its own
    // buttons (approving leaves plan mode; resumeMode values are
    // harness-agnostic permission-mode wire ids).
    const docked = !!onOpenPlan;
    return (
      <div className={`prompt-card my-2 mx-0 py-3 px-3.5 border border-border border-l-[3px] border-l-border rounded-sm bg-surface flex flex-col gap-[9px] [&.plan]:border-l-accent-blue [&.permission]:border-l-accent-amber [&.question]:border-l-accent-purple [&.readonly]:opacity-60 plan ${done ? "readonly" : ""}`}>
        <div className={PROMPT_HEAD_CLASS_NAME}>
          {p.synthesized ? "Plan mode — ready to proceed?" : "Proposed plan"}
        </div>
        <div className={`prompt-plan text-base leading-[1.6] text-text max-h-85 overflow-y-auto [&.clamped]:max-h-[9.5em] [&.clamped]:overflow-hidden [&.clamped]:relative [&.clamped::after]:content-[''] [&.clamped::after]:absolute [&.clamped::after]:inset-x-0 [&.clamped::after]:bottom-0 [&.clamped::after]:top-auto [&.clamped::after]:h-8.5 [&.clamped::after]:bg-[linear-gradient(to_bottom,_transparent,_var(--surface))] [&.clamped::after]:pointer-events-none ${docked ? "clamped" : ""}`}>
          <Md text={p.plan ?? ""} onOpenFile={onOpenFile} />
        </div>
        {docked && (
          <button className="prompt-plan-open self-start border-0 bg-transparent text-accent-blue text-sm p-0 cursor-pointer [&:hover]:underline" onClick={() => onOpenPlan(p.plan ?? "", part.id)}>
            View full plan
          </button>
        )}
        {/* Strip-less fallback (unreachable in the main app — App always
            provides onOpenPlan): same action semantics as the strip. */}
        {!done && !docked && (
          <div className={PROMPT_ACTIONS_CLASS_NAME}>
            <button className="btn-primary" onClick={() => respond({ approve: true, resumeMode: "auto" })}>
              Accept and auto mode
            </button>
            <button className="btn-ghost" onClick={() => respond({ approve: true, resumeMode: "bypass" })}>
              Accept and bypass all
            </button>
            <button className="btn-ghost" onClick={() => respond({ approve: false })}>
              Reject
            </button>
          </div>
        )}
      </div>
    );
  }

  if (p.kind === "permission") {
    const summary =
      (typeof p.toolInput?.command === "string" && p.toolInput.command) ||
      (typeof p.toolInput?.filePath === "string" && p.toolInput.filePath) ||
      "";
    // Codex approval cards ship a human-readable reason (and fileChange cards
    // carry nothing else) — show it so the user knows what they're granting.
    const reason =
      (typeof p.toolInput?.reason === "string" && p.toolInput.reason) || "";
    return (
      <div className={`prompt-card my-2 mx-0 py-3 px-3.5 border border-border border-l-[3px] border-l-border rounded-sm bg-surface flex flex-col gap-[9px] [&.plan]:border-l-accent-blue [&.permission]:border-l-accent-amber [&.question]:border-l-accent-purple [&.readonly]:opacity-60 permission ${done ? "readonly" : ""}`}>
        <div className={PROMPT_HEAD_CLASS_NAME}>
          Permission needed: <code>{p.tool}</code>
        </div>
        {summary && <div className="prompt-sub text-sm text-subtext wrap-anywhere">{summary}</div>}
        {reason && <div className="prompt-sub text-sm text-subtext wrap-anywhere">{reason}</div>}
        {!done && (
          // No resumeMode: the harness picks the right one for an approval.
          // Claude resumes under `bypass` (the only mode that actually grants a
          // blocked tool — acceptEdits would re-deny Bash); inline harnesses
          // (opencode) reply once/reject keyed off `approve`. Deny denies either way.
          <div className={PROMPT_ACTIONS_CLASS_NAME}>
            <button className="btn-primary" onClick={() => respond({ approve: true })}>
              Allow
            </button>
            <button className="btn-ghost" onClick={() => respond({ approve: false })}>
              Deny
            </button>
          </div>
        )}
      </div>
    );
  }

  // question
  const toggle = (label: string) =>
    setPicked((cur) =>
      p.multiSelect
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label],
    );
  return (
    <div className={`prompt-card my-2 mx-0 py-3 px-3.5 border border-border border-l-[3px] border-l-border rounded-sm bg-surface flex flex-col gap-[9px] [&.plan]:border-l-accent-blue [&.permission]:border-l-accent-amber [&.question]:border-l-accent-purple [&.readonly]:opacity-60 question ${done ? "readonly" : ""}`}>
      {p.header && <div className={PROMPT_HEAD_CLASS_NAME}>{p.header}</div>}
      {p.question && <div className="prompt-q text-base font-semibold leading-normal text-text">{p.question}</div>}
      <div className="prompt-options flex flex-col gap-1.5">
        {(p.options ?? []).map((o) => {
          const sel = picked.includes(o.label);
          return (
            <button
              key={o.label}
              className={`prompt-option flex flex-col items-start gap-0.5 w-full py-2 px-[11px] text-left border border-border rounded-sm bg-background text-text cursor-pointer transition-[border-color,background] duration-80 ease-standard [&:hover:not(:disabled)]:border-border-strong [&:hover:not(:disabled)]:bg-surface [&.sel]:border-primary [&.sel]:bg-primary-subtle [&:disabled]:cursor-default ${sel ? "sel" : ""}`}
              disabled={done}
              onClick={() => (done ? undefined : p.multiSelect ? toggle(o.label) : respond({ answers: [o.label] }))}
            >
              <span className="prompt-option-label block text-md font-semibold">{o.label}</span>
              {o.description && <span className="prompt-option-desc block text-sm font-normal leading-[1.45] text-subtext">{o.description}</span>}
            </button>
          );
        })}
      </div>
      {p.multiSelect && !done && (
        <div className={PROMPT_ACTIONS_CLASS_NAME}>
          <button
            className="btn-primary"
            disabled={picked.length === 0}
            onClick={() => respond({ answers: picked })}
          >
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

/** Whether a part paints anything in the transcript. The single source of
 * truth for "invisible": empty text/reasoning (encrypted-thinking models
 * stored these before the harness-side skip existed) and resolved permission
 * cards (which leave no trace). Shared by `messageHasVisibleContent` and
 * `renderParts` so the two can't drift. */
function partIsVisible(part: ChatPart): boolean {
  if (part.type === "prompt")
    return !!part.prompt && !(part.prompt.resolved && part.prompt.kind === "permission");
  if (part.type === "text" || part.type === "reasoning") return !!part.text;
  return true; // tool, image, …
}

/** Whether a message renders anything once resolved-permission cards vanish —
 * a bridge permission card rides its own message, so resolving it leaves the
 * message empty and it must drop out of the transcript entirely. */
function messageHasVisibleContent(m: ChatMessage): boolean {
  if (m.role === "user") return true;
  return m.parts.some(partIsVisible);
}

/** Memoized: streaming re-broadcasts the whole updated message up to ~13x/sec, and
 * `upsertMessage` preserves object identity for every untouched message — so
 * only the message actually being streamed re-renders (and re-parses its
 * markdown/KaTeX), not the entire transcript. Callback props must stay
 * referentially stable for this to hold (see the useCallback/useMemo wiring
 * in ChatPanel). `Transcript` below adds a second boundary for the other hot
 * path — composer keystrokes re-render ChatPanel itself, and the transcript
 * memo stops those from touching the rows at all. */
/** Resolve an `image` (attachment) part into what the transcript renders: a
 * source URL, whether it's a PDF (file chip vs inline image), and a name. */
function attachmentPartView(p: ChatPart): { src: string; isPdf: boolean; name: string } {
  const raw = p.text ?? "";
  const src = raw.startsWith("data:") ? raw : chatAttachmentUrl(raw);
  // Server file names embed the original after a `__` marker; optimistic parts
  // carry the real name on the part instead (no server file yet).
  const derived = raw.startsWith("data:")
    ? ""
    : raw.includes("__")
      ? raw.slice(raw.indexOf("__") + 2)
      : raw;
  const name = p.name || derived || "attachment";
  const isPdf =
    raw.startsWith("data:application/pdf") || /\.pdf$/i.test(name) || /\.pdf$/i.test(raw);
  return { src, isPdf, name };
}

const Message = memo(function Message({
  message,
  onOpenFile,
  onOpenRun,
  runExperimentName,
  onOpenExperiment,
  experimentName,
  onRespond,
  onOpenPlan,
  onOpenSubagent,
  skills,
}: {
  message: ChatMessage;
  onOpenFile?: (path: string, line?: number, exp?: string) => void;
  onOpenRun?: (runId: string) => void;
  runExperimentName?: (runId: string) => string;
  onOpenExperiment?: (experimentId: string) => void;
  experimentName?: (experimentId: string) => string;
  onRespond?: (answer: PromptAnswer) => void;
  /** Open a plan's full markdown in the right pane (plan cards/strip). */
  onOpenPlan?: (plan: string, promptId: string) => void;
  /** Open a sub-agent's transcript in the right pane (spawn-row "view"). */
  onOpenSubagent?: (spawnPartId: string) => void;
  /** Known slash-skills, for rendering a leading `/name` as a command chip. */
  skills?: SkillInfo[];
}) {
  if (message.role === "user") {
    const text = message.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
    // A leading known `/command` renders as the same chip the composer shows.
    // Unknown commands (or skills removed since) fall back to plain text.
    const slash = text.match(/^\/(\S+)([\s\S]*)$/);
    const command = slash ? skills?.find((s) => s.name === slash[1]) : undefined;
    // Optimistic parts carry a data URL; server parts carry a file name.
    const attachments = message.parts
      .filter((p) => p.type === "image" && p.text)
      .map(attachmentPartView);
    const images = attachments.filter((a) => !a.isPdf);
    const files = attachments.filter((a) => a.isPdf);
    return (
      <div className="msg-user self-end max-w-[88%] bg-surface rounded-[16px] py-2.5 px-[15px] text-base whitespace-pre-wrap wrap-anywhere [&_.skill-chip]:mr-0.5 [&_.skill-chip]:align-baseline">
        {command ? (
          <>
            <span className="skill-chip inline-flex items-center py-px px-[7px] font-mono text-md font-medium text-primary bg-primary-subtle border border-border-variant rounded-sm">/{command.name}</span>
            {slash![2]}
          </>
        ) : (
          text
        )}
        {images.length > 0 && (
          <div className="msg-images flex flex-wrap gap-1.5 mt-2 [&_img]:max-w-55 [&_img]:max-h-40 [&_img]:border [&_img]:border-border-variant [&_img]:rounded-xs [&_img]:block">
            {images.map((a, i) => (
              <a key={i} href={a.src} target="_blank" rel="noreferrer">
                <img src={a.src} alt="attachment" />
              </a>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="msg-files flex flex-wrap gap-1.5 mt-2">
            {files.map((a, i) => (
              <a key={i} className="msg-file inline-flex items-center gap-1.5 max-w-60 py-1.5 px-2.5 border border-border-variant rounded-sm text-text no-underline [&:hover]:border-text [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap" href={a.src} target="_blank" rel="noreferrer">
                <FileText size={15} />
                <span>{a.name}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="msg-assistant text-lg leading-[1.62] text-text min-w-0">
      {renderParts(message.parts, {
        onOpenFile,
        onOpenRun,
        runExperimentName,
        onOpenExperiment,
        experimentName,
        onRespond,
        onOpenPlan,
        onOpenSubagent,
      })}
    </div>
  );
});

/** Shared assistant-parts renderer, reused for a message body and (recursively)
 * for a sub-agent's nested transcript. Coalesces consecutive tool parts into one
 * collapsed group (Claude-desktop style); text / reasoning / prompt parts break
 * a run and render inline. A sub-agent spawn part (tool `subagent`) also breaks
 * the run and renders as its own nested block. */
function renderParts(
  parts: ChatPart[],
  opts: {
    onOpenFile?: (path: string, line?: number, exp?: string) => void;
    onOpenRun?: (runId: string) => void;
    runExperimentName?: (runId: string) => string;
    onOpenExperiment?: (experimentId: string) => void;
    experimentName?: (experimentId: string) => string;
    onRespond?: (answer: PromptAnswer) => void;
    onOpenPlan?: (plan: string, promptId: string) => void;
    onOpenSubagent?: (spawnPartId: string) => void;
  },
): React.ReactNode[] {
  const {
    onOpenFile,
    onOpenRun,
    runExperimentName,
    onOpenExperiment,
    experimentName,
    onRespond,
    onOpenPlan,
    onOpenSubagent,
  } = opts;
  const rendered: React.ReactNode[] = [];
  let toolRun: ChatPart[] = [];
  const flushTools = () => {
    if (toolRun.length === 0) return;
    rendered.push(
      <ToolGroup
        key={`tg-${toolRun[0].id}`}
        parts={toolRun}
        onOpenFile={onOpenFile}
        onOpenRun={onOpenRun}
        runExperimentName={runExperimentName}
        onOpenExperiment={onOpenExperiment}
        experimentName={experimentName}
      />,
    );
    toolRun = [];
  };
  for (const part of parts) {
    // A part that renders nothing must not break a tool run either — e.g. the
    // empty reasoning parts encrypted-thinking models produced (stored
    // transcripts predating the ingest-side skip still carry them), or a
    // resolved permission card. Without this, each invisible part splits
    // consecutive tools into single-row groups.
    if (!partIsVisible(part)) continue;
    // A sub-agent spawn part streams its own transcript in `children` — render
    // it as a standalone nested block, not folded into a tool run. The signal is
    // harness-agnostic: Codex tags the row `subagent`, while Claude's `Task` /
    // OpenCode's `task` rows are spawns whenever they carry children.
    if (part.type === "tool" && (part.tool === "subagent" || (part.children?.length ?? 0) > 0)) {
      flushTools();
      rendered.push(
        <SubagentBlock key={part.id} part={part} onOpenSubagent={onOpenSubagent} />,
      );
      continue;
    }
    if (part.type === "tool") {
      toolRun.push(part);
      continue;
    }
    flushTools();
    // The visibility skip above guarantees text/reasoning parts here are
    // non-empty.
    if (part.type === "text")
      rendered.push(
        <Md key={part.id} text={part.text!} onOpenFile={onOpenFile} onOpenRun={onOpenRun} />,
      );
    else if (part.type === "reasoning")
      rendered.push(
        <details key={part.id} className="reasoning text-muted text-md my-0.5 mx-0 [&_summary]:cursor-pointer [&_summary]:list-none [&_summary]:select-none [&_summary]:font-semibold [&[open]]:whitespace-pre-wrap">
          <summary>thinking…</summary>
          {part.text}
        </details>,
      );
    else if (part.type === "prompt" && part.prompt)
      rendered.push(
        <PromptCard
          key={part.id}
          part={part}
          onRespond={onRespond}
          onOpenFile={onOpenFile}
          onOpenPlan={onOpenPlan}
        />,
      );
  }
  flushTools();
  return rendered;
}

/** Find a part by id anywhere in a parts tree (depth-first). Used by the
 * right-pane sub-agent tab to locate a spawn part across a session's messages. */
export function findPartById(parts: ChatPart[], id: string): ChatPart | null {
  for (const part of parts) {
    if (part.id === id) return part;
    const nested = part.children && findPartById(part.children, id);
    if (nested) return nested;
  }
  return null;
}

/** The sub-agent's transcript, rendered standalone in the right-pane tab (the
 * only place the transcript is shown — the inline row just opens this). Reuses
 * `renderParts`, so nested sub-agents are themselves click-to-open rows. */
export function SubagentTranscript({
  spawn,
  onOpenFile,
  onOpenRun,
  runExperimentName,
  onOpenExperiment,
  experimentName,
  onOpenSubagent,
}: {
  spawn: ChatPart;
  onOpenFile?: (path: string, line?: number, exp?: string) => void;
  onOpenRun?: (runId: string) => void;
  runExperimentName?: (runId: string) => string;
  onOpenExperiment?: (experimentId: string) => void;
  experimentName?: (experimentId: string) => string;
  onOpenSubagent?: (spawnPartId: string) => void;
}) {
  const parts = spawn.children ?? [];
  const running = spawn.state?.status === "running";
  const errored = spawn.state?.status === "error";
  const errorMessage = (spawn.state?.error || spawn.state?.output || "").replace(/^Exit code \d+\s*/i, "").trim();
  const hasRun = useRef(running);
  useEffect(() => {
    if (running) hasRun.current = true;
  }, [running]);
  // Gate the empty state on what actually renders, not the raw part count — a
  // stored transcript of nothing but invisible parts must still read as empty.
  const rendered = renderParts(parts, {
    onOpenFile,
    onOpenRun,
    runExperimentName,
    onOpenExperiment,
    experimentName,
    onOpenSubagent,
  });
  const spawnActivity = running ? activityInProgress(toolActivity(spawn)) : toolActivity(spawn);
  return (
    <div className="msg-assistant text-lg leading-[1.62] text-text min-w-0">
      <div className="subagent-tab-header flex items-center gap-2 pb-2 mb-2 border-b border-b-border-variant">
        <ToolActivityIcon activity={spawnActivity} className={running ? "tool-running-shimmer-icon" : errored ? "text-accent-red" : "text-muted"} />
        <span className={`${TOOL_LINE_CLASS_NAME} ${running ? "tool-running-shimmer" : errored ? "text-accent-red" : ""}`}>{spawnActivity.label}</span>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {running ? spawnActivity.label : hasRun.current ? "Sub-agent activity completed" : ""}
      </span>
      {errorMessage ? (
        <div className="tool-output py-1.5 px-2.5 font-mono text-xs text-subtext whitespace-pre-wrap wrap-anywhere max-h-65 overflow-y-auto bg-background border border-border-variant rounded-sm">
          {errorMessage.slice(0, 20000)}
        </div>
      ) : rendered.length === 0 ? (
        <div className="subagent-empty py-[3px] px-1 text-md text-muted">{running ? "Working…" : "No activity"}</div>
      ) : (
        rendered
      )}
    </div>
  );
}

/** A Codex/Claude/OpenCode sub-agent spawn row. A single clickable line — a
 * status dot + label — that opens the sub-agent's full transcript in the
 * right-side panel (like the Claude/Codex desktop apps). The transcript is
 * never expanded inline; the row stays a one-liner whether the sub-agent is
 * running (pulsing dot) or done. */
function SubagentBlock({
  part,
  onOpenSubagent,
}: {
  part: ChatPart;
  onOpenSubagent?: (spawnPartId: string) => void;
}) {
  const errored = part.state?.status === "error";
  const errorMessage = (part.state?.error || part.state?.output || "").replace(/^Exit code \d+\s*/i, "").trim();
  const running = part.state?.status === "running";
  const hasRun = useRef(running);
  useEffect(() => {
    if (running) hasRun.current = true;
  }, [running]);
  const activity = running ? activityInProgress(toolActivity(part)) : toolActivity(part);
  return (
    <>
      <button
        className="subagent-row flex items-center gap-2 w-full my-3.5 mx-0 py-[3px] px-1 cursor-pointer text-text text-lg text-left rounded-sm [&:hover:not(:disabled)]:bg-surface [&:disabled]:cursor-default [&_.tool-line]:text-lg"
        title={errored && errorMessage ? errorMessage : "Open sub-agent transcript"}
        onClick={() => onOpenSubagent?.(part.id)}
        disabled={!onOpenSubagent}
      >
        <ToolActivityIcon activity={activity} className={`subagent-icon shrink-0 ${running ? "tool-running-shimmer-icon" : errored ? "text-accent-red" : "text-muted"}`} />
        <span className={`${TOOL_LINE_CLASS_NAME} ${running ? "tool-running-shimmer" : errored ? "text-accent-red" : "text-text"}`}>{activity.label}</span>
        <ChevronRight size={12} className="subagent-row-chevron shrink-0 text-muted" />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {running ? activity.label : hasRun.current ? "Sub-agent activity completed" : ""}
      </span>
    </>
  );
}

/** Memoized transcript: composer keystrokes re-render ChatPanel (draft state
 * lives there), and this boundary keeps them from re-allocating N Message
 * elements and running N memo comparisons. Every prop passed here must stay
 * referentially stable across keystrokes (memoized/useCallback, never inline)
 * or the boundary silently breaks — with that held, typing costs one shallow
 * compare instead of O(messages) work. */
const Transcript = memo(function Transcript({
  messages,
  onOpenFile,
  onOpenRun,
  runExperimentName,
  onOpenExperiment,
  experimentName,
  onRespond,
  onOpenPlan,
  onOpenSubagent,
  skills,
}: {
  messages: ChatMessage[];
  onOpenFile?: (path: string, line?: number, exp?: string) => void;
  onOpenRun?: (runId: string) => void;
  runExperimentName?: (runId: string) => string;
  onOpenExperiment?: (experimentId: string) => void;
  experimentName?: (experimentId: string) => string;
  onRespond?: (answer: PromptAnswer) => void;
  onOpenPlan?: (plan: string, promptId: string) => void;
  onOpenSubagent?: (spawnPartId: string) => void;
  skills?: SkillInfo[];
}) {
  return (
    <>
      {messages.filter(messageHasVisibleContent).map((m) => (
        <Message
          key={m.id}
          message={m}
          onOpenFile={onOpenFile}
          onOpenRun={onOpenRun}
          runExperimentName={runExperimentName}
          onOpenExperiment={onOpenExperiment}
          experimentName={experimentName}
          onRespond={onRespond}
          onOpenPlan={onOpenPlan}
          onOpenSubagent={onOpenSubagent}
          skills={skills}
        />
      ))}
    </>
  );
});

// --- session rail ------------------------------------------------------------

type SessionFilter = "active" | "archived" | "all";

/** Whether the rail's current filter shows a session in this archived state. */
const matchesFilter = (filter: SessionFilter, archived: boolean) =>
  filter === "all" ? true : filter === "archived" ? archived : !archived;

/** Menu label + rail section heading per filter — "Recents" for the default view. */
const SESSION_FILTERS: { id: SessionFilter; label: string; railLabel: string }[] = [
  { id: "active", label: "Active", railLabel: "Recents" },
  { id: "archived", label: "Archived", railLabel: "Archived" },
  { id: "all", label: "All", railLabel: "All sessions" },
];

/** Filter control beside the "Recents" label: Active (default) / Archived / All. */
function SessionFilterMenu({
  value,
  onChange,
}: {
  value: SessionFilter;
  onChange: (next: SessionFilter) => void;
}) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="rail-filter relative inline-flex" ref={ref}>
      <button
        className={`${ICON_BUTTON_BASE_CLASS_NAME} rail-filter-btn w-6 h-6 rounded-sm ${value !== "active" ? "active" : ""}`}
        title="Filter sessions"
        aria-label="Filter sessions"
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontal size={13} />
      </button>
      {open && (
        <div className="option-menu absolute bottom-[calc(100%_+_8px)] left-0 max-h-95 flex flex-col bg-background border border-border rounded-lg shadow-[0_12px_32px_rgba(0,_0,_0,_0.18)] z-50 overflow-hidden min-w-47.5 p-1.5 [&.align-right]:left-auto [&.align-right]:right-0 [&.drop-down]:bottom-auto [&.drop-down]:top-[calc(100%_+_4px)] [&.session-menu]:left-auto [&.session-menu]:right-1.5 [&.session-menu]:top-[calc(100%_-_2px)] [&.session-menu]:min-w-35 drop-down align-right">
          {SESSION_FILTERS.map((f) => (
            <button
              key={f.id}
              className={MODEL_ITEM_CLASS_NAME}
              onClick={() => {
                onChange(f.id);
                setOpen(false);
              }}
            >
              <span>{f.label}</span>
              {value === f.id && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Per-character stagger, and the ceiling on the whole run — a long title
 * shouldn't take a second and a half to finish arriving. */
const TITLE_CHAR_STAGGER_MS = 14;
const TITLE_STAGGER_CAP_MS = 500;
/** How long the reveal flag stays set: the capped stagger plus one character's
 * 240ms animation, plus slack. After this the title renders as plain text. */
const TITLE_REVEAL_CLEAR_MS = 1200;

/** A session title that materializes character by character when a
 * harness-generated one replaces the first-line placeholder. `animate` is false
 * everywhere else (initial load, renames, re-renders), and then this renders the
 * bare string — the animated form is deliberately the exception.
 *
 * The characters are `aria-hidden` and the whole title rides an `aria-label`:
 * a screen reader must hear one title, not forty single-letter spans. */
function TitleReveal({ title, animate }: { title: string; animate: boolean }) {
  if (!animate) return <>{title}</>;
  return (
    <span className="title-reveal" aria-label={title}>
      {Array.from(title).map((ch, i) =>
        // Spaces stay plain inline boxes: the animated characters must be
        // inline-block (transform doesn't apply to inline boxes), but an
        // inline-block space collapses to zero width and eats the word gap.
        ch === " " ? (
          <span key={i} aria-hidden>
            {ch}
          </span>
        ) : (
          <span
            key={i}
            aria-hidden
            className="title-reveal-char inline-block animate-[title-char-in_240ms_ease-out_both] [@media((prefers-reduced-motion:_reduce))]:animate-none"
            style={{
              animationDelay: `${Math.min(i * TITLE_CHAR_STAGGER_MS, TITLE_STAGGER_CAP_MS)}ms`,
            }}
          >
            {ch}
          </span>
        ),
      )}
    </span>
  );
}

/** One Recents row. Hover swaps the timestamp for a three-dot menu with
 * Rename, Archive/Unarchive, and Delete (Claude-desktop style). Rename turns
 * the title into an inline input. */
function SessionRow({
  session,
  active,
  unread,
  busy,
  waiting,
  revealTitle,
  onOpen,
  onRename,
  onSetArchived,
  onDelete,
}: {
  session: ChatSession;
  active: boolean;
  unread: boolean;
  busy: boolean;
  /** Turn held on an unanswered card: steady dot, not the working pulse. */
  waiting: boolean;
  /** Nonce set while this row's freshly auto-generated title should play its
   * reveal; it doubles as the remount key so a second retitle replays it.
   * Undefined the rest of the time (static title). */
  revealTitle: number | undefined;
  onOpen: () => void;
  onRename: (title: string) => void;
  onSetArchived: (archived: boolean) => void;
  onDelete: () => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const title = session.title?.trim() || "Untitled";
  const [editing, setEditing] = useState(false);
  // Seeded by startEditing() before the input mounts; "" is just a placeholder.
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function startEditing() {
    setDraft(session.title?.trim() || "");
    setEditing(true);
  }
  function commit() {
    const next = draft.trim();
    setEditing(false);
    // Only persist a real change; an empty title would be rejected server-side.
    if (next && next !== (session.title?.trim() || "")) onRename(next);
  }

  // Focus + select the input once the row enters edit mode.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Not a <button>: the kebab is a real button and can't nest inside one.
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      className={`session-row relative flex items-center gap-2 w-full text-left py-[7px] px-2.5 rounded-md text-md text-text cursor-pointer select-none [&:hover]:bg-surface [&.active]:bg-surface [&.active]:font-medium [&_.session-dot]:w-3.5 [&_.session-dot]:inline-flex [&_.session-dot]:items-center [&_.session-dot]:justify-center [&_.session-dot]:shrink-0 [&_.session-title]:flex-1 [&_.session-title]:min-w-0 [&_.session-title]:overflow-hidden [&_.session-title]:text-ellipsis [&_.session-title]:whitespace-nowrap [&.unread_.session-title]:font-semibold [&_.session-time]:text-2xs [&_.session-time]:text-muted [&_.session-time]:shrink-0 [&_.session-menu-btn]:hidden [&_.session-menu-btn]:items-center [&_.session-menu-btn]:justify-center [&_.session-menu-btn]:w-4 [&_.session-menu-btn]:h-4 [&_.session-menu-btn]:-my-0.5 [&_.session-menu-btn]:mx-0 [&_.session-menu-btn]:rounded-sm [&_.session-menu-btn]:text-muted [&_.session-menu-btn]:shrink-0 [&_.session-menu-btn:hover]:text-text [&_.session-menu-btn:hover]:bg-panel [&:hover_.session-menu-btn]:inline-flex [&:focus-within_.session-menu-btn]:inline-flex [&.menu-open_.session-menu-btn]:inline-flex [&:hover_.session-time]:hidden [&:focus-within_.session-time]:hidden [&.menu-open_.session-time]:hidden [&_.busy-dot]:w-[7px] [&_.busy-dot]:h-[7px] [&_.busy-dot]:rounded-full [&_.busy-dot]:bg-primary [&_.busy-dot]:animate-[or-pulse_1.2s_infinite] [&_.busy-dot]:shrink-0 [&_.unread-dot]:w-[7px] [&_.unread-dot]:h-[7px] [&_.unread-dot]:rounded-full [&_.unread-dot]:bg-primary [&_.unread-dot]:shrink-0 [&_.busy-dot.waiting]:animate-none [&_.session-title-input]:flex-1 [&_.session-title-input]:min-w-0 [&_.session-title-input]:py-px [&_.session-title-input]:px-[5px] [&_.session-title-input]:-my-0.5 [&_.session-title-input]:mx-0 [&_.session-title-input]:[font:inherit] [&_.session-title-input]:text-text [&_.session-title-input]:bg-background [&_.session-title-input]:border [&_.session-title-input]:border-primary [&_.session-title-input]:rounded-sm [&_.session-title-input]:outline-none [&.editing]:bg-surface [&.editing]:cursor-default [&.editing_.session-menu-btn]:hidden [&.editing_.session-time]:hidden ${active ? "active" : ""}  ${unread ? "unread" : ""}  ${open ? "menu-open" : ""}  ${
        editing ? "editing" : ""
      }`}
      title={`${HARNESS_LABELS[session.harness]}${session.model ? ` · ${session.model}` : ""}`}
      onClick={() => {
        // While editing, a body click is a no-op; blur/Enter/Esc drive it.
        if (editing) return;
        // With the menu open, a body click just dismisses it — switching
        // sessions underneath an open menu would leave it orphaned.
        if (open) setOpen(false);
        else onOpen();
      }}
      onKeyDown={(e) => {
        // Only keys aimed at the row itself: the kebab, menu items, and the
        // rename input are descendants, and preventDefault here would cancel
        // their activation.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          // Mirror the click branch: dismiss an open menu instead of
          // navigating underneath it.
          if (open) setOpen(false);
          else onOpen();
        }
      }}
    >
      <span className="session-dot">
        {busy ? (
          <span className={`busy-dot ${waiting ? "waiting" : ""}`} />
        ) : (
          unread && <span className="unread-dot" />
        )}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className="session-title-input"
          aria-label="Session title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="session-title">
          <TitleReveal
            key={revealTitle ?? "static"}
            title={title}
            animate={revealTitle !== undefined}
          />
        </span>
      )}
      <span className="session-time">{relTime(session.updatedAt)}</span>
      <button
        className="session-menu-btn"
        title="Session options"
        aria-label="Session options"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="option-menu absolute bottom-[calc(100%_+_8px)] left-0 max-h-95 flex flex-col bg-background border border-border rounded-lg shadow-[0_12px_32px_rgba(0,_0,_0,_0.18)] z-50 overflow-hidden min-w-47.5 p-1.5 [&.align-right]:left-auto [&.align-right]:right-0 [&.drop-down]:bottom-auto [&.drop-down]:top-[calc(100%_+_4px)] [&.session-menu]:left-auto [&.session-menu]:right-1.5 [&.session-menu]:top-[calc(100%_-_2px)] [&.session-menu]:min-w-35 drop-down session-menu">
          <button
            className={MODEL_ITEM_CLASS_NAME}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              startEditing();
            }}
          >
            <span>Rename</span>
          </button>
          <button
            className={MODEL_ITEM_CLASS_NAME}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onSetArchived(!session.archived);
            }}
          >
            <span>{session.archived ? "Unarchive" : "Archive"}</span>
          </button>
          <button
            className={`${MODEL_ITEM_CLASS_NAME} danger`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
          >
            <span>Delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

// --- panel -------------------------------------------------------------------

export function ChatPanel({
  projectId,
  projectName,
  paperId,
  railHeader,
  railOpen,
  onShowRail,
  mainView,
  onSelectMainView,
  experimentsActive,
  filesActive,
  artifactsActive,
  onOpenExperiments,
  onOpenArtifacts,
  onOpenFile,
  onOpenRun,
  runExperimentName,
  onOpenExperiment,
  experimentName,
  onOpenPlan,
  onOpenSubagent,
  onOpenWorktree,
  onStartTour,
  onActiveSessionChange,
  preferredAgent,
  onPreferredAgentChange,
  children,
}: {
  projectId: string;
  projectName: string;
  /** arXiv id the project starts from — surfaces a /reproduce-paper shortcut. */
  paperId?: string | null;
  /** Back-to-projects + project name block rendered at the top of the rail. */
  railHeader?: React.ReactNode;
  /** Whether the agents rail is showing (collapsed via its own header icon). */
  railOpen: boolean;
  /** Reopen the rail (from the chat header's sidebar icon). */
  onShowRail: () => void;
  /** Settings sections replace chat; Artifacts remains a right-panel tool. */
  mainView: "chat" | "skills" | SettingsTab;
  onSelectMainView: (view: "chat" | "skills" | SettingsTab) => void;
  experimentsActive: boolean;
  filesActive: boolean;
  artifactsActive: boolean;
  onOpenExperiments: () => void;
  onOpenArtifacts: () => void;
  /** Open a project file in the right pane (chat tool rows are clickable).
   * `sessionId` is the chat session the click came from, so relative paths
   * can resolve against that session's worktree. */
  onOpenFile?: (path: string, sessionId?: string, line?: number, exp?: string) => void;
  /** Open a run's logs in the right pane (agent-emitted `<run>` evidence chips).
   * Run ids are globally unique, so no session context is needed. */
  onOpenRun?: (runId: string) => void;
  /** Resolve a run to the experiment name shown on tool activity links. */
  runExperimentName?: (runId: string) => string;
  /** Open an experiment overview, where its notes are displayed. */
  onOpenExperiment?: (experimentId: string) => void;
  /** Resolve an experiment id to the name shown on tool activity links. */
  experimentName?: (experimentId: string) => string;
  /** Open a plan's markdown as a right-pane tab (plan strip / plan cards). */
  onOpenPlan?: (plan: string, sessionId: string, promptId: string) => void;
  /** Open a sub-agent's transcript as a right-pane tab (spawn-row "view").
   * `sessionId` is the chat session; `spawnPartId` locates the spawn part. */
  onOpenSubagent?: (sessionId: string, spawnPartId: string) => void;
  /** Open the pinned Files home for the active session. */
  onOpenWorktree: () => void;
  /** Replay the onboarding tour (chat header help button). */
  onStartTour?: () => void;
  /** The open chat session, surfaced so the shell can scope panes to it. */
  onActiveSessionChange?: (sessionId: string | null) => void;
  /** Database-backed selection used to seed new chat sessions. */
  preferredAgent: ModelSelection | null;
  onPreferredAgentChange: (selection: ModelSelection) => Promise<void>;
  /** Middle-pane content when a settings section is active. */
  children?: React.ReactNode;
}) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<ReadonlySet<string>>(new Set());
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("active");
  const [draft, setDraft] = useState("");
  // Pasted/dropped/uploaded attachments waiting in the composer, as data URLs.
  const [attachments, setAttachments] = useState<
    { dataUrl: string; mediaType: string; name?: string; size: number }[]
  >([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, dispatch] = useReducer(reducer, {
    messagesBySession: {},
    busySessions: new Set<string>(),
    queuedBySession: {},
  });
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [selection, setSelection] = useState<ModelSelection | null>(preferredAgent);
  useEffect(() => setSelection(preferredAgent), [preferredAgent]);
  // Unsent composer tweaks (model/mode/reasoning) for the *open* session — the
  // session's harness is fixed, so these override only its mutable settings and
  // are applied (and persisted server-side) on the next send. Cleared when the
  // active session changes. Distinct from `selection`, which is the sticky
  // global preference that seeds *new* sessions.
  const [sessionOverride, setSessionOverride] = useState<Partial<ModelSelection>>({});
  // Sessions whose title was just replaced by a harness-generated one, mapped
  // to a nonce that bumps per reveal so a second retitle remounts the spans and
  // replays the animation instead of sitting on a finished one.
  const [titleReveals, setTitleReveals] = useState<Map<string, number>>(new Map());
  // Last title seen per session id. The SSE subscription is keyed on projectId
  // alone, so its closure can't read `sessions`; this ref is what tells an
  // incoming title from the one already on screen.
  const seenTitles = useRef(new Map<string, string | null>());
  const loadedSessions = useRef(new Set<string>());
  // Tombstones: a turn finishing in the same instant as a delete can emit its
  // final chat.session upsert *after* chat.session.deleted; ignoring upserts
  // for known-deleted ids keeps the ghost row from coming back.
  const deletedIds = useRef(new Set<string>());
  // Bumped on every chat.message dispatch — the reconnect repair uses it to
  // detect a live flush racing its transcript refetch.
  const msgGen = useRef(0);
  // Render-fresh mirror of `sessions` for callbacks memoized on projectId
  // alone (syncSessionList snapshots it before fetching).
  const sessionsRef = useRef<ChatSession[]>([]);
  const threadRef = useRef<HTMLDivElement>(null);
  const threadInnerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Consolidated chat-settings popover (permissions/reasoning/sources), opened
  // by the switch icon in the composer footer.
  const chatSettings = usePopover();

  // Slash-skills: menu state is derived from the draft — open while the first
  // token is an unfinished `/command` (no whitespace yet) with matches.
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillIdx, setSkillIdx] = useState(0);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  // A picked skill renders as a chip on the textarea's first line
  // (Claude-desktop style); the textarea then holds only the args. send()
  // reassembles `/name args`, so the wire and transcript keep the plain-text
  // form. The chip overlays the textarea and the first line is indented past
  // it (text-indent), so long args wrap full-width beneath the chip instead
  // of being squeezed into a narrower column.
  const [pickedSkill, setPickedSkill] = useState<SkillInfo | null>(null);
  const chipRef = useRef<HTMLSpanElement>(null);
  const [chipIndent, setChipIndent] = useState(0);
  useLayoutEffect(() => {
    setChipIndent(pickedSkill && chipRef.current ? chipRef.current.offsetWidth + 8 : 0);
    syncChipScroll();
  }, [pickedSkill]);

  /** The chip belongs to the first line of *content*, so when the textarea
   * scrolls it must ride along (and clip at the wrapper) instead of sitting
   * fixed over whatever line scrolled to the top. */
  function syncChipScroll() {
    if (chipRef.current)
      chipRef.current.style.transform = `translateY(${-(composerRef.current?.scrollTop ?? 0)}px)`;
  }
  // IME guard: mid-composition text can transiently look like a full command.
  const composingRef = useRef(false);
  // Refetch when navigating (esp. back to chat after a Skills-tab upload) so
  // freshly uploaded skills appear in the `/` menu without a reload.
  useEffect(() => {
    getSkills(projectId).then(setSkills).catch(() => {});
  }, [projectId, mainView]);
  const slashToken =
    !pickedSkill && draft.startsWith("/") && !/\s/.test(draft) ? draft.slice(1) : null;
  const skillMatches =
    slashToken !== null && !skillMenuDismissed
      ? skills.filter((s) => s.name.startsWith(slashToken.toLowerCase()))
      : [];
  const skillMenuOpen = skillMatches.length > 0;
  const activeSkillIdx = Math.min(skillIdx, Math.max(0, skillMatches.length - 1));
  useEffect(() => setSkillIdx(0), [slashToken]);

  function pickSkill(skill: SkillInfo) {
    setPickedSkill(skill);
    setDraft("");
    composerRef.current?.focus();
  }

  /** Backspace at the start deletes the command outright (Claude-desktop
   * behavior) — the args stay put; re-type `/` to pick another skill. */
  function removeSkillChip() {
    setPickedSkill(null);
    composerRef.current?.focus();
  }

  /** Queue files (upload button, clipboard paste, or drag-drop) as composer
   * attachments — images and PDFs, which the harness reads off disk by path. */
  function addFiles(files: File[]) {
    // Per-file and total caps keep the base64-inflated (~33%) request body
    // under the backend's 64 MB limit — a single 30 MB file or a batch summing
    // to 40 MB both stay clear once encoded.
    const MAX_BYTES = 30 * 1024 * 1024;
    const TOTAL_BYTES = 40 * 1024 * 1024;
    setAttachError(null);
    let total = attachments.reduce((n, a) => n + a.size, 0);
    for (const file of files) {
      if (!/^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(file.type)) continue;
      if (file.size > MAX_BYTES) {
        setAttachError(`${file.name} is too large — each attachment must be under 30 MB.`);
        continue;
      }
      if (total + file.size > TOTAL_BYTES) {
        setAttachError("Attachments exceed the 40 MB total limit — remove one and try again.");
        continue;
      }
      total += file.size;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setAttachments((cur) => [
          ...cur,
          { dataUrl, mediaType: file.type, name: file.name, size: file.size },
        ]);
      };
      reader.readAsDataURL(file);
    }
  }

  function onComposerPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.items)
      .filter(
        (item) =>
          item.kind === "file" &&
          (item.type.startsWith("image/") || item.type === "application/pdf"),
      )
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }

  // The open session, if any (its harness is locked; its model/mode/reasoning
  // are what the composer should reflect and edit).
  const openSession = sessions.find((s) => s.id === activeId);

  // The selection the composer displays and edits:
  //  * with a session open — that session's stored settings, with any unsent
  //    picker tweaks layered on. The harness is the session's, not the global.
  //  * with no session — the sticky global preference (seeds a new session).
  const rawSelection: ModelSelection | null = openSession
    ? {
        harness: openSession.harness,
        model: sessionOverride.model ?? openSession.model,
        permissionMode: sessionOverride.permissionMode ?? openSession.permissionMode,
        reasoningLevel: sessionOverride.reasoningLevel ?? openSession.reasoningLevel,
      }
    : (selection ?? defaultSelection(harnesses));
  const activeHarness = rawSelection
    ? harnesses.find((h) => h.id === rawSelection.harness)
    : undefined;
  const opts = activeHarness?.options;
  // Reconcile the reasoning level against the *currently selected model* here
  // rather than only in the picker's `pick`. Two paths reach the composer with
  // a level nobody chose for this model: a session row stored by an older build
  // (which always wrote an explicit effort), and a stale saved preference.
  // Reconciling at the point the composer derives its state covers both, so the
  // displayed value and the value `send` transmits can never be one the model
  // rejects.
  const composerSelection: ModelSelection | null = rawSelection && {
    ...rawSelection,
    reasoningLevel: reconcileReasoning(
      activeHarness,
      rawSelection.model,
      rawSelection.reasoningLevel,
    ),
  };
  // Reasoning choices follow the *selected model*, not just the harness — an
  // OpenCode model with no `variants` hides the picker entirely, and Codex's
  // top tiers appear only on the models that accept them.
  const reasoning = reasoningFor(activeHarness, composerSelection?.model);

  // Editing the pickers: every change updates the sticky global preference —
  // the config a "New session" composer opens with is whatever the user chose
  // LAST, whether they chose it on an empty composer or inside a session. With
  // a session open the change additionally lands as that session's unsent
  // tweak (applied on the next send).
  //
  // The session override is *merged*, never replaced. It has to be: the pickers
  // build their `next` by spreading `composerSelection`, whose reasoning level
  // is a reconciled value rather than the session's stored one. Replacing would
  // let a change on one axis pin a reconciled value on another — picking a
  // permission mode would write a reasoning level the user never chose, and the
  // next send would persist it over their real setting.
  const selectModel = (next: Partial<ModelSelection>) => {
    if (!composerSelection) return;
    const merged = { ...composerSelection, ...next };
    setSelection(merged);
    void onPreferredAgentChange(merged).catch(() => {});
    if (openSession) setSessionOverride((cur) => ({ ...cur, ...next }));
  };
  const setPermissionMode = (id: string) => selectModel({ permissionMode: id });
  const setReasoningLevel = (id: string) => selectModel({ reasoningLevel: id });

  sessionsRef.current = sessions;

  /** Fetch the authoritative session list and adopt it wholesale: the rows
   * (honoring delete tombstones and keeping locally-newer contextUsage — same
   * merge as the chat.session handler), the seenTitles baseline (so the next
   * live event compares against what's on screen rather than animating a title
   * the user already had), and the busy set. A session we showed that the
   * authoritative list no longer has was deleted while SSE was down (its
   * chat.session.deleted frame is lost for good) — run the full forget
   * cleanup, or its cached transcript, busy flag, and active selection linger
   * as a ghost. Shared by the project-change load and the SSE-reconnect
   * repair. Resolves to the adopted list, null on fetch failure. */
  const syncSessionList = useCallback(async (): Promise<ChatSession[] | null> => {
    // Snapshot BEFORE the fetch: a session created while the request is in
    // flight is absent from the response but also absent here, so it can
    // never be mistaken for deleted (forgetSession tombstones — a false
    // positive would kill a live session for good).
    const before = sessionsRef.current.map((s) => s.id);
    try {
      const list = (await listChatSessions(projectId)).filter(
        (s) => !deletedIds.current.has(s.id),
      );
      const ids = new Set(list.map((s) => s.id));
      // Forget BEFORE seeding busy: forget drops the ghost's busy flag, so
      // the known-scoped seed below can't carry it forward as if the session
      // belonged to another project.
      for (const id of before) if (!ids.has(id)) forgetSession(id);
      // Same contextUsage-preservation rule as the chat.session handler (the
      // scope differs: this replaces the whole array, that merges one row).
      setSessions((cur) => {
        const prevUsage = new Map(cur.map((c) => [c.id, c.contextUsage]));
        return list.map((s) => ({
          ...s,
          contextUsage: s.contextUsage ?? prevUsage.get(s.id),
        }));
      });
      seenTitles.current = new Map(list.map((s) => [s.id, s.title]));
      dispatch({
        type: "seedBusy",
        sessions: list.filter((s) => s.busy).map((s) => s.id),
        known: list.map((s) => s.id),
      });
      return list;
    } catch {
      return null;
    }
  }, [projectId]);

  // Reset everything when the project changes.
  useEffect(() => {
    setSessions([]);
    // Clear the mirror NOW, not at the next render: syncSessionList below
    // snapshots it, and the old project's rows would all read as "deleted"
    // against the new project's list — tombstoning the entire old project.
    sessionsRef.current = [];
    setActiveId(null);
    const readDemoSessions = loadReadDemoSessions();
    setUnreadSessionIds(
      projectId === DEMO_PROJECT_ID
        ? new Set(
            [DEMO_FIGURE_SESSION_ID, DEMO_LITERATURE_SESSION_ID].filter(
              (sessionId) => !readDemoSessions.has(sessionId),
            ),
          )
        : new Set(),
    );
    setDraft("");
    setPickedSkill(null);
    setAttachments([]);
    dispatch({ type: "reset" });
    loadedSessions.current = new Set();
    setTitleReveals(new Map());
    seenTitles.current = new Map();
    void syncSessionList().then((list) => {
      // Prefer the newest non-archived session; archived ones stay hidden.
      if (list)
        setActiveId(
          (cur) =>
            cur ??
            (projectId === DEMO_PROJECT_ID
              ? list.find((session) => session.id === DEMO_MAIN_SESSION_ID)?.id
              : undefined) ??
            list.find((session) => !session.archived)?.id ??
            null,
        );
    });
  }, [projectId, syncSessionList]);

  // Load message history when a session becomes active.
  useEffect(() => {
    if (!activeId || loadedSessions.current.has(activeId)) return;
    loadedSessions.current.add(activeId);
    getChatMessages(activeId)
      .then(({ messages, queued }) =>
        dispatch({ type: "seed", sessionId: activeId, messages, queued }),
      )
      .catch(() => {
        // Recover from a failed fetch to a usable state rather than a stuck
        // "Loading conversation…" spinner: seed an empty transcript (clears
        // historyLoading, falls through to the empty state) unless messages
        // already streamed in, and drop the loadedSessions guard so switching
        // back to this session refetches.
        dispatch({ type: "seed", sessionId: activeId, messages: [], onlyIfAbsent: true });
        loadedSessions.current.delete(activeId);
      });
  }, [activeId]);

  // Chat events from the shared /api/events stream.
  useEffect(() => {
    return onChatEvent((ev) => {
      switch (ev.type) {
        case "session": {
          if (ev.session.projectId !== projectId) return;
          if (deletedIds.current.has(ev.session.id)) return;
          // A generated title landing on a session already on screen is the
          // auto-title arriving — reveal it. A session we've never seen is
          // skipped on purpose: a list load or a newly created row must not
          // animate a title that was simply always there.
          const known = seenTitles.current.has(ev.session.id);
          const changed = seenTitles.current.get(ev.session.id) !== ev.session.title;
          seenTitles.current.set(ev.session.id, ev.session.title);
          if (known && changed && ev.session.titleSource === "generated") {
            setTitleReveals((cur) => {
              const next = new Map(cur);
              next.set(ev.session.id, (cur.get(ev.session.id) ?? 0) + 1);
              return next;
            });
            // Drop the flag once the run is over (longest stagger + one char
            // duration, plus slack) so later re-renders show a static title.
            window.setTimeout(() => {
              setTitleReveals((cur) => {
                if (!cur.has(ev.session.id)) return cur;
                const next = new Map(cur);
                next.delete(ev.session.id);
                return next;
              });
            }, TITLE_REVEAL_CLEAR_MS);
          }
          setSessions((cur) => {
            const i = cur.findIndex((s) => s.id === ev.session.id);
            if (i < 0) return [ev.session, ...cur];
            const next = cur.slice();
            // An interrupted turn aborts before the persist block, so its
            // follow-up chat.session can lack usage the client already showed
            // live. Usage is never legitimately cleared, so keep the local
            // value whenever the incoming session omits one.
            next[i] = { ...ev.session, contextUsage: ev.session.contextUsage ?? cur[i].contextUsage };
            return next;
          });
          break;
        }
        case "sessionDeleted":
          forgetSession(ev.sessionId);
          break;
        case "message":
          msgGen.current++;
          dispatch({ type: "upsertMessage", sessionId: ev.sessionId, message: ev.message });
          break;
        case "busy":
          dispatch({ type: "busy", sessionId: ev.sessionId, busy: ev.busy });
          break;
        case "queued":
          dispatch({ type: "setQueued", sessionId: ev.sessionId, items: ev.items });
          break;
        case "usage":
          setSessions((cur) =>
            cur.map((s) => (s.id === ev.sessionId ? { ...s, contextUsage: ev.usage } : s)),
          );
          break;
      }
    });
  }, [projectId]);

  // Repair after an SSE gap. Chat frames are edge-only — a dropped EventSource
  // mid-turn loses chat.message / chat.busy events for good, which strands the
  // UI (a spinner that never clears, or a reply that never appears until a
  // reload). On reconnect, refetch the authoritative state: the session list
  // (busy flags ride it) and the active transcript. The seed replaces the
  // transcript wholesale, so a live flush racing the fetch would be clobbered
  // — and if it was the turn's FINAL flush, never repaired; the msgGen check
  // refetches once when that race is detected. Separate subscription so it can
  // depend on activeId without re-running the main handler's effect.
  useEffect(() => {
    return onChatEvent((ev) => {
      if (ev.type !== "reconnected") return;
      void syncSessionList();
      if (!activeId || !loadedSessions.current.has(activeId)) return;
      // One retry is sufficient: flush persists to the store BEFORE it emits,
      // so a refetch issued after observing a raced event already reads that
      // event's content.
      const reseed = (allowRetry: boolean) => {
        const gen = msgGen.current;
        getChatMessages(activeId)
          .then(({ messages, queued }) => {
            dispatch({ type: "seed", sessionId: activeId, messages, queued });
            if (allowRetry && msgGen.current !== gen) reseed(false);
          })
          .catch(() => {});
      };
      reseed(true);
    });
  }, [activeId, syncSessionList]);

  const messages = activeId ? (state.messagesBySession[activeId] ?? []) : [];
  const busy = activeId ? state.busySessions.has(activeId) : false;
  // Messages the user parked behind the running turn (oldest first). Populated
  // by chat.queued events and the seed snapshot; each runs when its turn ends.
  const queued = activeId ? (state.queuedBySession[activeId] ?? []) : [];
  // A session whose transcript hasn't been seeded yet: its key is absent from
  // messagesBySession (vs. present-but-empty for a genuinely empty session).
  // Switching to an existing session leaves this true for the getChatMessages
  // fetch, so we show a spinner instead of flashing the empty state. A brand-new
  // session created via the composer never lands here — its optimisticUser seed
  // populates the key synchronously in the same handler.
  const historyLoading = !!activeId && !(activeId in state.messagesBySession);
  // A busy turn blocked on an unanswered HELD card (nativeId — a bridge or
  // inline mid-turn request) is waiting on the user, not the model. Drives
  // the status line and the rail dot (the composer button is keyed on
  // `pendingQuestion` instead — what send() can actually service). End-turn
  // cards (no nativeId) never coexist with a busy turn of their own, so
  // keying on nativeId avoids false positives from stale cards. (Sessions
  // whose transcripts aren't loaded fall back to plain busy.) Memoized so the
  // messages × parts scan stays off the per-keystroke render path.
  const waitingSessions = useMemo(() => {
    const waiting = new Set<string>();
    for (const id of state.busySessions) {
      if (
        (state.messagesBySession[id] ?? []).some((m) =>
          m.parts.some(
            (p) => p.type === "prompt" && p.prompt && !p.prompt.resolved && p.prompt.nativeId,
          ),
        )
      )
        waiting.add(id);
    }
    return waiting;
  }, [state.busySessions, state.messagesBySession]);
  const awaitingInput = activeId ? waitingSessions.has(activeId) : false;
  const activeSession = openSession;
  // Nonce while the open session's title is mid-reveal; undefined = static.
  const activeTitleReveal = activeSession ? titleReveals.get(activeSession.id) : undefined;

  // The newest unresolved plan prompt, if any — it drives the docked strip
  // above the composer. Resolution re-emits the message over SSE, so this
  // recomputes to null and the strip disappears on its own.
  const pendingPlan = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const part of messages[i].parts) {
        if (part.type === "prompt" && part.prompt?.kind === "plan" && !part.prompt.resolved) {
          return {
            promptId: part.id,
            plan: part.prompt.plan ?? "",
            synthesized: !!part.prompt.synthesized,
          };
        }
      }
    }
    return null;
  }, [messages]);

  // The newest ANSWERABLE unresolved question card's part id: typed composer
  // text answers IT as a custom answer, instead of racing the held turn with
  // a new message (which the busy guard would reject/drop). Plan cards have
  // their own inline revise textarea (PlanStrip) and don't route through
  // here. Claude + Codex sessions: both accept a note-only reply (codex's
  // user_input_reply takes the note as the surfaced question's freeform
  // answer). Opencode is excluded — it rejects note-only replies (see
  // reply_inline), so its options stay the interface. A held (nativeId) card
  // is answerable only while its turn is alive — a zombie left by a process
  // restart must not capture the composer (its own buttons error and the
  // backend collapses it on the first attempt).
  const pendingQuestion = useMemo(() => {
    const harness = activeSession?.harness;
    if (!activeId || (harness !== "claude-code" && harness !== "codex")) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      for (const part of messages[i].parts) {
        if (part.type !== "prompt" || !part.prompt || part.prompt.resolved) continue;
        if (part.prompt.kind !== "question") continue;
        if (part.prompt.nativeId && !state.busySessions.has(activeId)) return null;
        return part.id;
      }
    }
    return null;
  }, [messages, activeSession?.harness, activeId, state.busySessions]);

  // A submitted plan revision, until its replacement card arrives: hides the
  // outgoing card's strip so it never sits there looking actionable while
  // the model rewrites the plan (the transcript's Working… spinner is the
  // feedback). Cleared when the session's turn ends or a DIFFERENT plan card
  // shows up in the same session — pendingPlan derives from the ACTIVE
  // session, so the replaced check must not fire on a session switch.
  const [revising, setRevising] = useState<{ sessionId: string; promptId: string } | null>(null);
  const revisingPlan = revising && revising.sessionId === activeId ? revising : null;
  useEffect(() => {
    if (!revising) return;
    const stillBusy = state.busySessions.has(revising.sessionId);
    const replaced =
      revising.sessionId === activeId && pendingPlan && pendingPlan.promptId !== revising.promptId;
    if (!stillBusy || replaced) setRevising(null);
  }, [revising, pendingPlan, state.busySessions, activeId]);

  // Plan opens are stamped with the session like file opens are. Memoized
  // (along with openFileInSession and respond below) so the memoized Message
  // rows don't all re-render on every streaming tick.
  const openPlan = useMemo(
    () =>
      onOpenPlan && activeId
        ? (plan: string, promptId: string) => onOpenPlan(plan, activeId, promptId)
        : undefined,
    [onOpenPlan, activeId],
  );

  const openSubagent = useMemo(
    () =>
      onOpenSubagent && activeId
        ? (spawnPartId: string) => onOpenSubagent(activeId, spawnPartId)
        : undefined,
    [onOpenSubagent, activeId],
  );

  // File opens resolve against the active session's worktree — the agent runs
  // there, so that's where its paths point.
  const openFileInSession = useMemo(
    () =>
      onOpenFile &&
      ((path: string, line?: number, exp?: string) =>
        onOpenFile(path, activeId ?? undefined, line, exp)),
    [onOpenFile, activeId],
  );

  // Drop any unsent composer tweak when switching sessions, so it never bleeds
  // from one session's pickers onto another's.
  useEffect(() => setSessionOverride({}), [activeId]);

  // Surface the open session to the shell (Agent-scoped panes key off it).
  useEffect(() => {
    onActiveSessionChange?.(activeId);
  }, [activeId, onActiveSessionChange]);

  // Opening a session or returning from settings starts pinned at the latest messages.
  const threadMounted = mainView === "chat" && (messages.length > 0 || busy);
  useLayoutEffect(() => {
    stickToBottom.current = true;
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, threadMounted]);

  // Autoscroll while pinned. Layout effect, so history seeds and streamed
  // messages land already scrolled (no flash of the top of the thread).
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // Re-pin when the thread resizes without a message change — images loading,
  // tool rows expanding, the pane resizing.
  useEffect(() => {
    const el = threadRef.current;
    const inner = threadInnerRef.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [threadMounted]);

  async function send() {
    const args = draft.trim();
    // Reassemble the picked skill chip into the plain `/name args` wire form —
    // the backend's slash expansion and the transcript both see only text.
    const text = pickedSkill ? `/${pickedSkill.name}${args ? ` ${args}` : ""}` : args;
    const pending = attachments;
    if (!text && pending.length === 0) return;
    // A pending question card owns plain typed text as a custom answer
    // (Claude-desktop behavior). This also works while the turn is HELD on
    // the card — where a new message would be rejected as busy and silently
    // dropped. A failed answer restores the draft so the text isn't lost.
    // (Auto-convert is off while a card is pending; a chip picked from the
    // menu or left over just serializes into the note text, same as typing it.)
    if (text && pendingQuestion && pending.length === 0) {
      setDraft("");
      setPickedSkill(null);
      void respond({ promptId: pendingQuestion, answers: [], note: text }).then((ok) => {
        if (!ok) setDraft((cur) => cur || text);
      });
      return;
    }
    if (busy) {
      // A turn is already running: park this message (Claude-desktop steering)
      // so it runs when the turn ends, instead of dropping it. The server
      // enqueues it and echoes chat.queued to render the chip — no optimistic
      // transcript bubble, since it hasn't run yet.
      if (!activeId || !activeHarness?.agentReady) return;
      const sid = activeId;
      setDraft("");
      setPickedSkill(null);
      setAttachments([]);
      setAttachError(null);
      const turnOpts = composerSelection
        ? {
            model: composerSelection.model,
            permissionMode: composerSelection.permissionMode,
            reasoningLevel: composerSelection.reasoningLevel,
          }
        : {};
      setSessionOverride({});
      const images: ChatImageAttachment[] = pending.map((a) => ({
        mediaType: a.mediaType,
        dataBase64: a.dataUrl.slice(a.dataUrl.indexOf(",") + 1),
        name: a.name,
      }));
      try {
        await sendChatMessage(sid, text, turnOpts, images.length ? images : undefined);
      } catch {
        // Never reached the queue — restore the composer so a retry is one keypress.
        setDraft((cur) => cur || text);
        setAttachments((cur) => (cur.length ? cur : pending));
      }
      return;
    }
    if (!activeHarness?.agentReady) return;
    // `composerSelection` already resolves to the open session's settings (+ any
    // unsent tweak) or, for a new session, the global preference.
    const effective = composerSelection;
    if (!effective && !activeId) return; // no harness available at all
    setDraft("");
    setPickedSkill(null);
    setAttachments([]);
    setAttachError(null);
    let sid = activeId;
    try {
      if (!sid) {
        const session = await createChatSession(projectId, effective!.harness, {
          model: effective!.model,
          permissionMode: effective!.permissionMode,
          reasoningLevel: effective!.reasoningLevel,
        });
        loadedSessions.current.add(session.id);
        setSessions((cur) => [session, ...cur]);
        setActiveId(session.id);
        sid = session.id;
      }
      dispatch({
        type: "optimisticUser",
        sessionId: sid,
        text,
        attachments: pending.map((a) => ({ url: a.dataUrl, mediaType: a.mediaType, name: a.name })),
      });
      dispatch({ type: "busy", sessionId: sid, busy: true });
      stickToBottom.current = true;
      // The session being sent to is never archived after this turn (new ones
      // start active; existing ones are unarchived server-side by activity) —
      // leave the Archived-only view so its row stays visible.
      if (sessionFilter === "archived") setSessionFilter("active");
      // `effective.harness` is always the target session's harness (locked once
      // it exists), so these overrides are always valid — the backend persists
      // them as the session's sticky settings. Clear the unsent tweak now.
      const turnOpts = effective
        ? {
            model: effective.model,
            permissionMode: effective.permissionMode,
            reasoningLevel: effective.reasoningLevel,
          }
        : {};
      setSessionOverride({});
      const images: ChatImageAttachment[] = pending.map((a) => ({
        mediaType: a.mediaType,
        dataBase64: a.dataUrl.slice(a.dataUrl.indexOf(",") + 1),
        name: a.name,
      }));
      await sendChatMessage(sid, text, turnOpts, images.length ? images : undefined);
    } catch (err) {
      // The message never reached a turn — put it back in the composer so a
      // retry is one keypress, whichever branch below applies.
      setDraft((cur) => cur || text);
      setAttachments((cur) => (cur.length ? cur : pending));
      if (!sid) return; // session creation failed; no transcript to annotate
      const msg = err instanceof Error ? err.message : String(err);
      // A *network* failure does not prove no turn started — the backend
      // claims the turn (and emits busy) before its response, so a lost
      // response can reject on a live, streaming turn; ask the server before
      // declaring failure. An explicit busy rejection is different: the slot
      // belongs to someone else's turn (run watcher, second tab) and ours was
      // never accepted — always surface that.
      if (!/session is busy/i.test(msg)) {
        const busyNow = await listChatSessions(projectId)
          .then((list) => !!list.find((s) => s.id === sid)?.busy)
          .catch(() => false);
        if (busyNow) {
          // The turn is real and streaming — undo the restore, nothing failed.
          setDraft((cur) => (cur === text ? "" : cur));
          setAttachments((cur) => (cur === pending ? [] : cur));
          return;
        }
      }
      dispatch({ type: "busy", sessionId: sid, busy: false });
      // Surface the failure instead of swallowing it: a silently dropped send
      // leaves the optimistic bubble unanswered and reads as "orx did nothing".
      // Local-only — swept by upsertMessage's LOCAL_PREFIX filter when the next
      // server user message lands (or by the reconnect reseed), and gone on
      // reload.
      dispatch({
        type: "upsertMessage",
        sessionId: sid,
        message: {
          id: `${LOCAL_PREFIX}senderr-${Date.now()}`,
          role: "assistant",
          parts: [
            {
              id: "p0",
              type: "tool",
              tool: "error",
              state: {
                status: "error",
                error: `Message not sent: ${msg}`,
              },
            },
          ],
          createdAt: Date.now(),
        },
      });
    }
  }

  function stop() {
    if (activeId) void interruptChat(activeId);
  }

  // Optimistic: drop locally now; the server's chat.queued echo reconciles. A
  // message that already started running server-side simply isn't found.
  function cancelQueued(itemId: string) {
    if (!activeId) return;
    const sid = activeId;
    dispatch({
      type: "setQueued",
      sessionId: sid,
      items: queued.filter((q) => q.id !== itemId),
    });
    void cancelQueuedMessage(sid, itemId).catch(() => {});
  }

  // Escape stops the streaming turn and drops focus back into the composer,
  // mirroring the Claude Code desktop app. Harness-agnostic — `stop()` →
  // `interruptChat` interrupts whichever harness (Claude, Codex, OpenCode, …)
  // is running the active session. Only armed while chat is visible.
  //
  // An overlay that should swallow Escape (rather than let it stop the turn)
  // must own the key ahead of this document-level bubble listener, by one of
  // two means already in use — a new overlay has to pick one or it will
  // interrupt the turn on Escape:
  //   - the slash menu preventDefaults in the composer's onKeyDown (bubble),
  //     so the `defaultPrevented` guard below defers to it;
  //   - the composer pickers (usePopover) stopPropagation in the capture phase,
  //     so their Escape never reaches this listener at all.
  useEffect(() => {
    if (!busy || mainView !== "chat") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      stop();
      composerRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, activeId, mainView]);

  /** Drop every trace of a session — the local row, the open-thread selection,
   * and the cached transcript. Used on delete (ours or another dashboard's). */
  function forgetSession(sessionId: string) {
    deletedIds.current.add(sessionId);
    setSessions((cur) => cur.filter((s) => s.id !== sessionId));
    setActiveId((cur) => (cur === sessionId ? null : cur));
    setUnreadSessionIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    loadedSessions.current.delete(sessionId);
    seenTitles.current.delete(sessionId);
    dispatch({ type: "forget", sessionId });
  }

  function setArchived(session: ChatSession, archived: boolean) {
    // Optimistic; the server also broadcasts the row over chat.session. On
    // failure restore the pre-request snapshot (not the request's negation,
    // which could undo a concurrent authoritative update).
    const prev = session.archived;
    setSessions((cur) => cur.map((s) => (s.id === session.id ? { ...s, archived } : s)));
    // Deselect only when the row leaves the rail's current filter — keeping it
    // selected would leave the thread (and Agent-scoped panes) keyed to an
    // invisible session. Kept even if the request fails; it's a no-op then.
    if (!matchesFilter(sessionFilter, archived))
      setActiveId((cur) => (cur === session.id ? null : cur));
    void setChatSessionArchived(session.id, archived).catch(() => {
      setSessions((cur) =>
        cur.map((s) => (s.id === session.id ? { ...s, archived: prev } : s)),
      );
    });
  }

  function rename(session: ChatSession, title: string) {
    // Optimistic; the server trims and re-broadcasts the row over chat.session.
    // On failure restore the pre-request title (not the draft) so a concurrent
    // authoritative update isn't undone.
    const prev = session.title;
    setSessions((cur) => cur.map((s) => (s.id === session.id ? { ...s, title } : s)));
    void renameChatSession(session.id, title).catch(() => {
      setSessions((cur) => cur.map((s) => (s.id === session.id ? { ...s, title: prev } : s)));
    });
  }

  async function removeSession(session: ChatSession) {
    const title = session.title?.trim() || "Untitled";
    if (!window.confirm(`Delete "${title}"?\n\nIts transcript is permanently removed.`)) return;
    try {
      await deleteChatSession(session.id);
    } catch (err) {
      window.alert(
        `Failed to delete "${title}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    forgetSession(session.id);
  }

  /** Deliver a card answer; resolves `false` when delivery failed (so a
   * caller can e.g. restore a consumed draft). Stable per session so the
   * memoized Message rows don't re-render on unrelated state changes. */
  const respond = useCallback(
    (answer: PromptAnswer): Promise<boolean> => {
      if (!activeId) return Promise.resolve(false);
      const sid = activeId;
      // The resumed turn streams over SSE; optimistically mark busy.
      dispatch({ type: "busy", sessionId: sid, busy: true });
      return respondChat(sid, answer)
        .then(() => true)
        .catch(() => false)
        .finally(() => {
          // Reconcile with the store: if this tab's copy of the card was stale
          // (e.g. the held turn timed out and resolved it while our SSE was
          // dropped), the answer no-ops server-side and nothing re-broadcasts —
          // without this the card stays actionable forever and every answer
          // silently dead-ends. Busy is reconciled from the server for THIS
          // session only (a whole-set replace could stomp another session's
          // just-started optimistic flag), so the optimistic dispatch above
          // can't wedge true after a no-op or failure.
          getChatMessages(sid)
            .then(({ messages, queued }) => dispatch({ type: "seed", sessionId: sid, messages, queued }))
            .catch(() => {});
          listChatSessions(projectId)
            .then((list) =>
              dispatch({
                type: "busy",
                sessionId: sid,
                busy: !!list.find((s) => s.id === sid)?.busy,
              }),
            )
            // On a failed fetch keep the optimistic flag: clearing busy while a
            // Handled resume is still streaming would hide Working…/Stop for
            // the rest of the turn (nothing re-asserts busy mid-stream).
            .catch(() => {});
        });
    },
    [activeId, projectId],
  );

  const visibleSessions = sessions.filter((s) => matchesFilter(sessionFilter, s.archived));
  const newTaskShortcut = /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘ ⇧ Enter"
    : "Ctrl + Shift + Enter";
  const startNewTask = useCallback(() => {
    setSessionFilter("active");
    setActiveId(null);
    onSelectMainView("chat");
  }, [onSelectMainView]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.key !== "Enter" ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey ||
        !event.shiftKey
      )
        return;
      event.preventDefault();
      startNewTask();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [startNewTask]);

  const rail = (
    <aside className="session-rail w-68 shrink-0 flex flex-col mt-2.5 mr-3.5 mb-2.5 ml-0 bg-background min-h-0 [&_.rail-body]:flex-1 [&_.rail-body]:min-h-0 [&_.rail-body]:overflow-y-auto [&_.rail-body]:py-1 [&_.rail-body]:px-2 floating-panel border border-border rounded-lg shadow-[0_6px_24px_color-mix(in_oklab,_var(--text)_5%,_transparent),_0_1px_4px_color-mix(in_oklab,_var(--text)_4%,_transparent)] overflow-hidden">
      {railHeader}
      {/* Workspace tools open beside chat; settings sections replace the middle pane. */}
      <nav className="rail-nav flex flex-col gap-0.5 p-2 shrink-0">
        <button
          className={`rail-nav-item flex items-center gap-2.5 py-[7px] px-2.5 text-base text-text rounded-md text-left [&:hover]:bg-surface [&.active]:bg-panel [&.active]:font-semibold ${experimentsActive ? "active" : ""}`}
          onClick={onOpenExperiments}
        >
          <FlaskConical size={15} />
          Experiments
        </button>
        <button
          className={`rail-nav-item flex items-center gap-2.5 py-[7px] px-2.5 text-base text-text rounded-md text-left [&:hover]:bg-surface [&.active]:bg-panel [&.active]:font-semibold ${filesActive ? "active" : ""}`}
          onClick={onOpenWorktree}
        >
          <FolderOpen size={15} />
          Files
        </button>
        <button
          className={`rail-nav-item flex items-center gap-2.5 py-[7px] px-2.5 text-base text-text rounded-md text-left [&:hover]:bg-surface [&.active]:bg-panel [&.active]:font-semibold ${artifactsActive ? "active" : ""}`}
          data-onboarding="nav-artifacts"
          onClick={onOpenArtifacts}
        >
          <Package size={15} />
          Artifacts
        </button>
        <button
          className={`rail-nav-item flex items-center gap-2.5 py-[7px] px-2.5 text-base text-text rounded-md text-left [&:hover]:bg-surface [&.active]:bg-panel [&.active]:font-semibold ${mainView === "skills" ? "active" : ""}`}
          onClick={() => onSelectMainView("skills")}
        >
          <Blocks size={15} />
          Skills
        </button>
        {SETTINGS_NAV.map((item) => (
          <button
            key={item.id}
            className={`rail-nav-item flex items-center gap-2.5 py-[7px] px-2.5 text-base text-text rounded-md text-left [&:hover]:bg-surface [&.active]:bg-panel [&.active]:font-semibold ${mainView !== "chat" && mainView !== "skills" && item.activeTabs.includes(mainView) ? "active" : ""}`}
            data-onboarding={item.id === "compute" ? "nav-compute" : undefined}
            onClick={() => onSelectMainView(item.id)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>
      <div className="rail-section-head flex items-center justify-between shrink-0 pt-3.5 pr-2.5 pb-1.5 pl-4.5">
        <div className="rail-section-label p-0 text-md font-medium text-subtext">
          {SESSION_FILTERS.find((f) => f.id === sessionFilter)?.railLabel ?? "Recents"}
        </div>
        <div className="rail-section-actions flex items-center gap-0.5">
          <button
            className="rail-section-new inline-flex items-center gap-1 py-[3px] px-1.5 rounded-sm text-subtext text-xs font-medium [&:hover]:text-text [&:hover]:bg-surface tip-up [&[data-tip]::after]:top-auto [&[data-tip]::after]:bottom-[calc(100%_+_6px)]"
            data-onboarding="new-session"
            data-tip={newTaskShortcut}
            aria-keyshortcuts="Meta+Shift+Enter Control+Shift+Enter"
            onClick={startNewTask}
          >
            <Plus size={13} />
            Task
          </button>
          <SessionFilterMenu value={sessionFilter} onChange={setSessionFilter} />
        </div>
      </div>
      <div className="rail-body">
        {visibleSessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            active={s.id === activeId && mainView === "chat"}
            unread={unreadSessionIds.has(s.id)}
            busy={state.busySessions.has(s.id)}
            waiting={waitingSessions.has(s.id)}
            revealTitle={titleReveals.get(s.id)}
            onOpen={() => {
              setActiveId(s.id);
              if (projectId === DEMO_PROJECT_ID) markDemoSessionRead(s.id);
              setUnreadSessionIds((current) => {
                if (!current.has(s.id)) return current;
                const next = new Set(current);
                next.delete(s.id);
                return next;
              });
              onSelectMainView("chat");
            }}
            onRename={(title) => rename(s, title)}
            onSetArchived={(archived) => setArchived(s, archived)}
            onDelete={() => void removeSession(s)}
          />
        ))}
        {visibleSessions.length === 0 && (
          <div className="rail-empty py-1.5 px-2.5 text-md text-muted">
            {sessionFilter === "archived"
              ? "No archived sessions"
              : sessions.length > 0
                ? "No active sessions"
                : "No sessions yet"}
          </div>
        )}
      </div>
    </aside>
  );

  // With the rail hidden, the header stretches to the full pane width
  // (Claude-desktop style): the reopen toggle sits in the window's top-left
  // corner with the title beside it, instead of riding the centered readable
  // column.
  const headerClass = `chat-header flex items-center gap-2 py-0 px-4 bg-background shrink-0 h-12 relative z-4 w-full max-w-readable my-0 mx-auto [&.rail-hidden]:max-w-none [&.rail-hidden]:py-0 [&.rail-hidden]:px-0.5 [&::after]:content-[''] [&::after]:absolute [&::after]:top-full [&::after]:left-0 [&::after]:right-0 [&::after]:h-6 [&::after]:bg-[linear-gradient(to_bottom,_var(--base),_transparent)] [&::after]:pointer-events-none${railOpen ? "" : " rail-hidden"}`;
  const railReopen = !railOpen && (
    <button
      className={ICON_BUTTON_CLASS_NAME}
      title="Show sidebar"
      aria-label="Show sidebar"
      onClick={onShowRail}
    >
      <PanelLeft size={15} />
    </button>
  );

  if (mainView !== "chat") {
    return (
      <>
        {railOpen && rail}
        <section className="chat-pane flex-1 min-w-0 flex flex-col bg-background min-h-0">
          {!railOpen && <div className={headerClass}>{railReopen}</div>}
          <div className="settings-view-scroll flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable_both-edges]">{children}</div>
        </section>
      </>
    );
  }

  return (
    <>
      {railOpen && rail}
      <section className="chat-pane flex-1 min-w-0 flex flex-col bg-background min-h-0">
      {/* Header — session title on the left, right-pane view switchers on the
          right, fading into the chat below (sessions live in the rail). */}
      <div className={headerClass}>
        {railReopen}
        <div
          className={PAPER_TITLE_CLASS_NAME}
          title={activeSession ? activeSession.title?.trim() || "Untitled" : "New session"}
        >
          {activeSession ? (
            <TitleReveal
              key={activeTitleReveal ?? "static"}
              title={activeSession.title?.trim() || "Untitled"}
              animate={activeTitleReveal !== undefined}
            />
          ) : (
            "New session"
          )}
        </div>
        {onStartTour && (
          <button
            className={ICON_BUTTON_CLASS_NAME}
            data-tip="Replay tour"
            aria-label="Replay tour"
            onClick={onStartTour}
          >
            <HelpCircle size={15} />
          </button>
        )}
      </div>

      {historyLoading ? (
        <div className="chat-loading flex-1 flex items-center justify-center gap-3 text-subtext text-xl p-5 [&_.spinner]:w-5.5 [&_.spinner]:h-5.5 [&_.spinner]:border-[3px]" aria-live="polite" aria-busy="true">
          <span className={SPINNER_CLASS_NAME} />
          <span>Loading conversation…</span>
        </div>
      ) : !threadMounted ? (
        <div className="chat-empty flex-1 flex flex-col items-center justify-center @container text-text p-8 text-center [&_h2]:m-0 [&_h2]:text-5xl [&_h2]:font-medium [&_h2]:tracking-[-0.015em] [&_h2]:text-text">
          <div className="chat-empty-mark w-10.5 h-10.5 mb-5.5 [&_svg]:block [&_svg]:w-full [&_svg]:h-full">
            <BrandMark />
          </div>
          <h2>What should we research?</h2>
          <div className="chat-empty-project inline-flex items-center gap-[7px] mt-3 py-1.5 px-3 border border-border rounded-full text-subtext bg-surface text-lg font-semibold">
            <FolderOpen size={19} />
            <span>{projectName}</span>
          </div>
          <div className="chat-empty-starters grid grid-cols-[repeat(2,_minmax(0,_1fr))] gap-2.5 w-[min(100%,_620px)] mt-19 [@container((min-width:_500px))]:grid-cols-[repeat(4,_minmax(0,_1fr))] [@container((min-width:_500px))]:w-[min(100%,_720px)]">
            <button
              type="button"
              className="chat-empty-starter min-h-28 flex flex-col items-start justify-between gap-5 p-4 border border-border rounded-lg text-text bg-background shadow-[0_1px_3px_color-mix(in_oklab,_var(--text)_5%,_transparent)] text-left text-md font-medium leading-[1.35] transition-[border-color,background,translate] duration-120 ease-standard [&:hover]:border-muted [&:hover]:bg-surface [&:hover]:-translate-y-px [&.blue_svg]:text-accent-blue [&.purple_svg]:text-accent-purple [&.green_svg]:text-accent-green [&.orange_svg]:text-accent-orange blue"
              onClick={() => {
                setPickedSkill(null);
                setDraft("Explore this codebase and explain its architecture, key components, and open research questions.");
                composerRef.current?.focus();
              }}
            >
              <BookOpen size={16} />
              <span>Explore this codebase</span>
            </button>
            <button
              type="button"
              className="chat-empty-starter min-h-28 flex flex-col items-start justify-between gap-5 p-4 border border-border rounded-lg text-text bg-background shadow-[0_1px_3px_color-mix(in_oklab,_var(--text)_5%,_transparent)] text-left text-md font-medium leading-[1.35] transition-[border-color,background,translate] duration-120 ease-standard [&:hover]:border-muted [&:hover]:bg-surface [&:hover]:-translate-y-px [&.blue_svg]:text-accent-blue [&.purple_svg]:text-accent-purple [&.green_svg]:text-accent-green [&.orange_svg]:text-accent-orange purple"
              onClick={() => {
                const skill = skills.find((s) => s.name === "reproduce-paper");
                if (paperId && skill) {
                  setPickedSkill(skill);
                  setDraft(`${paperId} on `);
                } else {
                  setPickedSkill(null);
                  setDraft(
                    paperId
                      ? `/reproduce-paper ${paperId} on `
                      : "Find and summarize the research most relevant to this project.",
                  );
                }
                composerRef.current?.focus();
              }}
            >
              <GitBranch size={16} />
              <span>{paperId ? "Reproduce the linked paper" : "Review relevant literature"}</span>
            </button>
            <button
              type="button"
              className="chat-empty-starter min-h-28 flex flex-col items-start justify-between gap-5 p-4 border border-border rounded-lg text-text bg-background shadow-[0_1px_3px_color-mix(in_oklab,_var(--text)_5%,_transparent)] text-left text-md font-medium leading-[1.35] transition-[border-color,background,translate] duration-120 ease-standard [&:hover]:border-muted [&:hover]:bg-surface [&:hover]:-translate-y-px [&.blue_svg]:text-accent-blue [&.purple_svg]:text-accent-purple [&.green_svg]:text-accent-green [&.orange_svg]:text-accent-orange green"
              onClick={() => {
                setPickedSkill(null);
                setDraft("Set up and run an experiment for this project, including a baseline and meaningful variants.");
                composerRef.current?.focus();
              }}
            >
              <FlaskConical size={16} />
              <span>Run an experiment</span>
            </button>
            <button
              type="button"
              className="chat-empty-starter min-h-28 flex flex-col items-start justify-between gap-5 p-4 border border-border rounded-lg text-text bg-background shadow-[0_1px_3px_color-mix(in_oklab,_var(--text)_5%,_transparent)] text-left text-md font-medium leading-[1.35] transition-[border-color,background,translate] duration-120 ease-standard [&:hover]:border-muted [&:hover]:bg-surface [&:hover]:-translate-y-px [&.blue_svg]:text-accent-blue [&.purple_svg]:text-accent-purple [&.green_svg]:text-accent-green [&.orange_svg]:text-accent-orange orange"
              onClick={() => {
                setPickedSkill(null);
                setDraft("Analyze the latest experiment results and recommend the most useful next iteration.");
                composerRef.current?.focus();
              }}
            >
              <ChartSpline size={16} />
              <span>Analyze results</span>
            </button>
          </div>
        </div>
      ) : (
        <div
          className="chat-thread flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
          ref={threadRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          <div className="chat-thread-inner max-w-readable my-0 mx-auto pt-4 px-4 pb-8 flex flex-col gap-4" ref={threadInnerRef}>
            <Transcript
              messages={messages}
              onOpenFile={openFileInSession}
              onOpenRun={onOpenRun}
              runExperimentName={runExperimentName}
              onOpenExperiment={onOpenExperiment}
              experimentName={experimentName}
              onRespond={respond}
              onOpenPlan={openPlan}
              onOpenSubagent={openSubagent}
              skills={skills}
            />
            {busy &&
              (awaitingInput ? (
                <div className="working flex items-center gap-2 text-subtext text-md pt-0.5 px-0 pb-2 [&.awaiting]:italic awaiting">Waiting for your input…</div>
              ) : (
                <div className="working flex items-center gap-2 text-subtext text-md pt-0.5 px-0 pb-2 [&.awaiting]:italic">
                  <span className={SPINNER_CLASS_NAME} /> Working…
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Docked while a plan awaits a decision, so the approval controls never
          scroll away. Actions mirror the (now compact) inline card's wire. */}
      <div className="composer pt-0 px-3 pb-3 shrink-0 relative z-4 bg-background w-full max-w-readable my-0 mx-auto [&::before]:content-[''] [&::before]:absolute [&::before]:bottom-full [&::before]:left-0 [&::before]:right-0 [&::before]:h-6 [&::before]:bg-[linear-gradient(to_top,_var(--base),_transparent)] [&::before]:pointer-events-none [&_textarea]:border-0 [&_textarea]:bg-none [&_textarea]:bg-transparent [&_textarea]:resize-none [&_textarea]:pt-2.5 [&_textarea]:px-3 [&_textarea]:pb-1 [&_textarea]:text-base [&_textarea]:field-sizing-content [&_textarea]:min-h-18 [&_textarea]:max-h-45">
        {/* Inside the composer so the composer's popovers (mode/model pickers,
            z 50 within this stacking context) layer above the strip — as a
            sibling, the composer's own z-index: 4 capped them below it. */}
        {/* Hidden while a submitted revision is in flight so the outgoing
            card never sits there looking actionable; the revised card swaps
            in when it arrives (effect above). The transcript status covers
            the interim ("Waiting for your input…" for a beat until the old
            card's resolve broadcast lands, then Working…). */}
        {pendingPlan && !(revisingPlan && pendingPlan.promptId === revisingPlan.promptId) && (
          <PlanStrip
            synthesized={pendingPlan.synthesized}
            agentLabel={
              activeSession ? HARNESS_LABELS[activeSession.harness] : "The agent"
            }
            onView={() => openPlan?.(pendingPlan.plan, pendingPlan.promptId)}
            onApprove={(resumeMode) =>
              respond({ promptId: pendingPlan.promptId, approve: true, resumeMode })
            }
            // Plain rejection — no note; the model stops and waits.
            onReject={() => respond({ promptId: pendingPlan.promptId, approve: false })}
            // The strip owns its own revise textarea (Claude-desktop style);
            // the note comes back on submit, always non-empty (note presence
            // is what distinguishes revise from reject on the wire).
            onRevise={(note) => {
              if (activeId) setRevising({ sessionId: activeId, promptId: pendingPlan.promptId });
              respond({ promptId: pendingPlan.promptId, approve: false, note });
            }}
          />
        )}
        {queued.length > 0 && (
          <div className="composer-queued flex flex-col gap-1 mb-1.5">
            {queued.map((q) => (
              <div
                key={q.id}
                className="queued-chip flex items-center gap-2 py-1.5 px-2.5 text-sm text-subtext bg-surface border border-border rounded-sm"
                title={q.text}
              >
                <Clock size={13} className="shrink-0 text-muted" />
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {q.text}
                </span>
                <span className="shrink-0 text-xs text-muted uppercase tracking-wide">Queued</span>
                <button
                  title="Cancel queued message"
                  aria-label="Cancel queued message"
                  onClick={() => cancelQueued(q.id)}
                  className="shrink-0 inline-flex items-center justify-center w-4 h-4 p-0 border-0 rounded-full text-muted cursor-pointer [&:hover]:bg-text [&:hover]:text-background"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-box relative flex flex-col border border-border rounded-md bg-background" data-onboarding="composer">
          {activeHarness && !activeHarness.agentReady && (
            <div className="composer-harness-warning py-2 px-3 text-subtext text-xs leading-normal border-b border-b-border-variant [&_strong]:text-accent-amber [&_strong]:font-medium [&_code]:font-mono [&_code]:text-text">
              <strong>{activeHarness.name} is unavailable.</strong>{" "}
              {activeHarness.agentNote ? renderNote(activeHarness.agentNote) : "Re-check its setup."}
            </div>
          )}
          {skillMenuOpen && (
            <SkillMenu
              skills={skillMatches}
              activeIndex={activeSkillIdx}
              onPick={pickSkill}
              onHover={setSkillIdx}
            />
          )}
          {attachments.length > 0 && (
            <div className="composer-attachments flex flex-wrap gap-1.5 pt-2 px-3 pb-0">
              {attachments.map((a, i) => {
                const remove = () =>
                  setAttachments((cur) => cur.filter((_, j) => j !== i));
                return a.mediaType === "application/pdf" ? (
                  <div key={i} className="attachment-file [&_button]:absolute [&_button]:-top-[5px] [&_button]:-right-[5px] [&_button]:inline-flex [&_button]:items-center [&_button]:justify-center [&_button]:w-4 [&_button]:h-4 [&_button]:p-0 [&_button]:border [&_button]:border-border [&_button]:rounded-full [&_button]:bg-surface [&_button]:text-text [&_button]:cursor-pointer [&_button:hover]:bg-text [&_button:hover]:text-background relative inline-flex items-center gap-2 max-w-55 py-2 px-2.5 border border-border rounded-sm text-text bg-surface [&_svg]:shrink-0 [&_svg]:text-muted" title={a.name}>
                    <FileText size={22} />
                    <span className="attachment-file-name overflow-hidden text-ellipsis whitespace-nowrap text-sm">{a.name ?? "document.pdf"}</span>
                    <button title="Remove file" aria-label="Remove file" onClick={remove}>
                      <X size={11} />
                    </button>
                  </div>
                ) : (
                  <div key={i} className="attachment-thumb relative [&_img]:w-13 [&_img]:h-13 [&_img]:object-cover [&_img]:border [&_img]:border-border [&_img]:rounded-sm [&_img]:block [&_button]:absolute [&_button]:-top-[5px] [&_button]:-right-[5px] [&_button]:inline-flex [&_button]:items-center [&_button]:justify-center [&_button]:w-4 [&_button]:h-4 [&_button]:p-0 [&_button]:border [&_button]:border-border [&_button]:rounded-full [&_button]:bg-surface [&_button]:text-text [&_button]:cursor-pointer [&_button:hover]:bg-text [&_button:hover]:text-background">
                    <img src={a.dataUrl} alt="pasted" />
                    <button title="Remove image" aria-label="Remove image" onClick={remove}>
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {attachError && (
            <div className="composer-attach-error pt-1.5 px-3 pb-0 text-sm text-accent-red" role="alert">
              {attachError}
            </div>
          )}
          <div className="composer-input relative flex overflow-hidden [&_textarea]:flex-1">
            {pickedSkill && (
              // Inert like inline text: clicks fall through to the textarea
              // (pointer-events: none); Backspace at the start removes it.
              <span ref={chipRef} className="skill-chip inline-flex items-center py-px px-[7px] font-mono text-md font-medium text-primary bg-primary-subtle border border-border-variant rounded-sm composer-chip absolute top-[9px] left-3 z-1 pointer-events-none">
                /{pickedSkill.name}
              </span>
            )}
            <textarea
              ref={composerRef}
              value={draft}
              style={pickedSkill ? { textIndent: chipIndent } : undefined}
              onScroll={syncChipScroll}
              placeholder={
                // A pending question card owns typed text (see send()); say so.
                // With a chip active, the skill's arg hint says what to type —
                // and when the project already has a paper attached, the paper
                // part of the paper-reproduction skills defaults to it, so mark
                // just that part optional (compute is still expected).
                // Otherwise follow `composerSelection` so the name tracks the
                // picker for a new session and the open session once one exists.
                pendingQuestion
                  ? "Type a custom answer…"
                  : pickedSkill
                    ? ["reproduce-paper", "paper-to-marimo"].includes(pickedSkill.name) &&
                      paperId
                      ? `[paper — optional, defaults to ${paperId}] on [compute]`
                      : pickedSkill.argHint
                    : composerSelection
                      ? activeHarness?.agentReady
                        ? `Message ${HARNESS_LABELS[composerSelection.harness]}… ( / for skills)`
                        : `${HARNESS_LABELS[composerSelection.harness]} is unavailable — open the model picker`
                      : "Ask the research agent… ( / for skills)"
              }
              rows={2}
              onPaste={onComposerPaste}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes("Files")) e.preventDefault();
              }}
              onDrop={(e) => {
                if (e.dataTransfer.files.length === 0) return;
                e.preventDefault();
                addFiles(Array.from(e.dataTransfer.files));
              }}
              onChange={(e) => {
                const v = e.target.value;
                // Auto-convert a typed/pasted full `/name ` into the chip the
                // moment the space lands. Known names only — unknown `/foo`
                // stays plain text (server-side pass-through contract). Not
                // while a question card is pending (its answer is a note, never
                // skill-expanded) and not mid-IME-composition.
                if (!pickedSkill && !pendingQuestion && !composingRef.current) {
                  const m = v.match(/^\/(\S+)\s([\s\S]*)$/);
                  const hit = m && skills.find((s) => s.name === m[1].toLowerCase());
                  if (hit) {
                    setPickedSkill(hit);
                    setDraft(m[2]);
                    setSkillMenuDismissed(false);
                    return;
                  }
                }
                setDraft(v);
                setSkillMenuDismissed(false);
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onKeyDown={(e) => {
                if (skillMenuOpen) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const delta = e.key === "ArrowDown" ? 1 : -1;
                    setSkillIdx(
                      (activeSkillIdx + delta + skillMatches.length) % skillMatches.length,
                    );
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    pickSkill(skillMatches[activeSkillIdx]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSkillMenuDismissed(true);
                    return;
                  }
                }
                // Backspace at the very start deletes the command chip.
                // (Escape deliberately doesn't touch the chip — it's the
                // stop-the-turn gesture, see the document listener above.)
                if (
                  pickedSkill &&
                  e.key === "Backspace" &&
                  e.currentTarget.selectionStart === 0 &&
                  e.currentTarget.selectionEnd === 0
                ) {
                  e.preventDefault();
                  removeSkillChip();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
          </div>
          <div className="composer-actions flex justify-end items-center gap-2 pt-1.5 px-2 pb-2">
            {/* Chat settings (permissions, reasoning, sources) live behind the
                switch icon. */}
            <div className="option-picker relative inline-flex" ref={chatSettings.ref}>
              <button
                type="button"
                className="composer-bare inline-flex items-center gap-[3px] text-md text-text py-[5px] px-1 rounded-sm transition-[background] duration-150 ease-standard [&:hover]:bg-surface"
                title="Chat settings"
                aria-label="Chat settings"
                aria-haspopup="dialog"
                aria-expanded={chatSettings.open}
                onClick={() => chatSettings.setOpen((v) => !v)}
              >
                <ToggleRight size={16} />
              </button>
              {chatSettings.open && (
                <div className="composer-settings-menu absolute bottom-[calc(100%_+_8px)] left-0 flex flex-col gap-0.5 min-w-55 bg-background border border-border rounded-lg shadow-[0_12px_32px_rgba(0,_0,_0,_0.18)] z-50 p-1.5 [&_.composer-pill]:px-1.5 [&_.composer-bare]:px-1.5 [&_.option-menu]:bottom-0 [&_.option-menu]:top-auto [&_.option-menu]:left-[calc(100%_+_8px)] [&_.option-menu]:right-auto">
                  <div className="flex items-center justify-between gap-3 pl-2">
                    <span className="text-md text-muted">Permissions</span>
                    <OptionPicker
                      choices={activeHarness?.agentReady ? (opts?.permissionModes ?? []) : []}
                      value={composerSelection?.permissionMode ?? null}
                      defaultId={opts?.defaultPermissionMode ?? null}
                      header="Permissions"
                      align="left"
                      variant="pill"
                      numbered
                      title="Permission mode for this chat"
                      onSelect={setPermissionMode}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 pl-2">
                    <span className="text-md text-muted">Reasoning</span>
                    <OptionPicker
                      choices={activeHarness?.agentReady ? reasoning.choices : []}
                      value={composerSelection?.reasoningLevel ?? null}
                      defaultId={reasoning.defaultId}
                      header="Reasoning"
                      align="left"
                      variant="bare"
                      title="Reasoning level for this chat — Default sends no override, so the harness CLI's own configured effort applies"
                      onSelect={setReasoningLevel}
                    />
                  </div>
                  <div className="flex flex-col gap-0.5 mt-1 pt-2 border-t border-border">
                    <span className="text-md text-muted pl-2">Sources</span>
                    <LitSourcesList />
                  </div>
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/gif,image/webp"
              multiple
              hidden
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = ""; // let the same file be re-picked
              }}
            />
            <button
              type="button"
              className="composer-attach inline-flex items-center justify-center w-7.5 h-7.5 rounded-sm text-text cursor-pointer transition-[background] duration-150 ease-standard [&:hover]:bg-surface"
              title="Attach a PDF or image"
              aria-label="Attach a PDF or image"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} />
            </button>
            <div style={{ flex: 1 }} />
            {/* The model picker reflects the open session (harness locked once it
                exists); the global default only applies before the first
                message. */}
            <ModelPicker
              value={composerSelection}
              onSelect={selectModel}
              onHarnesses={setHarnesses}
              lockHarness={!!openSession}
            />
            <ContextMeter usage={openSession?.contextUsage} />
            {busy && !pendingQuestion ? (
              // Stop whenever the turn is busy and typed text has nowhere to
              // go — actively streaming, or held on a plan/permission card
              // (their cards are the affordance; send() can't service them).
              // Send stays only when it actually works: idle, or a held
              // QUESTION card that owns typed text.
              <button className="send-btn inline-flex items-center justify-center w-8 h-8 rounded-md bg-primary text-background transition-[background,opacity] duration-100 ease-standard [&:hover:not(:disabled)]:bg-[color-mix(in_oklab,_var(--primary)_88%,_var(--text))] [&:disabled]:opacity-40 [&:disabled]:cursor-default [&.stop]:bg-surface [&.stop]:text-text [&.stop:hover:not(:disabled)]:bg-[color-mix(in_oklab,_var(--surface)_88%,_var(--text))] stop" title="Stop" aria-label="Stop" onClick={stop}>
                <X size={16} />
              </button>
            ) : (
              <button
                className="send-btn inline-flex items-center justify-center w-8 h-8 rounded-md bg-primary text-background transition-[background,opacity] duration-100 ease-standard [&:hover:not(:disabled)]:bg-[color-mix(in_oklab,_var(--primary)_88%,_var(--text))] [&:disabled]:opacity-40 [&:disabled]:cursor-default [&.stop]:bg-surface [&.stop]:text-text [&.stop:hover:not(:disabled)]:bg-[color-mix(in_oklab,_var(--surface)_88%,_var(--text))]"
                title="Send"
                aria-label="Send"
                onClick={() => void send()}
                disabled={
                  !activeHarness?.agentReady ||
                  (!pickedSkill && !draft.trim() && attachments.length === 0)
                }
              >
                <CornerDownLeft size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      </section>
    </>
  );
}
