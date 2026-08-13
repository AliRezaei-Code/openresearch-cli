import type { SkillInfo } from "./api";

export const PLAN_COMMAND: SkillInfo = {
  name: "plan",
  description: "Enter Plan mode for this chat",
  argHint: "[prompt]",
  source: "command",
};

export function commandsForHarness(
  skills: SkillInfo[],
  planActivation: "permission" | "command" | null | undefined,
): SkillInfo[] {
  return planActivation === "command" ? [PLAN_COMMAND, ...skills] : skills;
}

export function parsePlanCommand(
  text: string,
  planActivation: "permission" | "command" | null | undefined,
): { prompt: string } | null {
  if (planActivation !== "command") return null;
  const match = text.match(/^\/plan(?:\s+([\s\S]*))?$/i);
  return match ? { prompt: (match[1] ?? "").trim() } : null;
}

export function effectiveCommandPlanMode(
  planActivation: "permission" | "command" | null | undefined,
  commandRequested: boolean,
  pendingMode: boolean | null,
): boolean | undefined {
  if (planActivation !== "command") return undefined;
  if (commandRequested) return true;
  return pendingMode ?? undefined;
}
