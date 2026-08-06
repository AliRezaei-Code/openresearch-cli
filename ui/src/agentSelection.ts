import type { HarnessId } from "./api";

export interface AgentSelection {
  harness: HarnessId;
  model: string | null;
  permissionMode: string | null;
  reasoningLevel: string | null;
}

const STORAGE_KEY = "orx:agent-selection";

function isHarnessId(value: unknown): value is HarnessId {
  return value === "claude-code" || value === "codex" || value === "opencode";
}

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isAgentSelection(value: unknown): value is AgentSelection {
  if (typeof value !== "object" || value === null) return false;
  const record = Object.fromEntries(Object.entries(value));
  return (
    isHarnessId(record.harness) &&
    optionalString(record.model) &&
    optionalString(record.permissionMode) &&
    optionalString(record.reasoningLevel)
  );
}

export function loadAgentSelection(): AgentSelection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isAgentSelection(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveAgentSelection(selection: AgentSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Storage can be unavailable in private mode; the current session still works.
  }
}
