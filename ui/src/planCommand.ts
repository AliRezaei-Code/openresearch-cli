import type { SkillInfo } from "./api";

export const PLAN_COMMAND: SkillInfo = {
  name: "plan",
  description: "Toggle Plan mode for this chat",
  argHint: "",
  source: "command",
};

export interface SlashCommandContext {
  query: string;
  start: number;
  end: number;
}

export function slashCommandContext(
  text: string,
  cursor: number,
): SlashCommandContext | null {
  if (cursor < 0 || cursor > text.length) return null;
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  if (text[start] !== "/") return null;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  const query = text.slice(start + 1, end);
  if (query.includes("/")) return null;
  return { query: query.toLowerCase(), start, end };
}

/** Whether the `/name` opens the draft or one of its lines, which is the point
 * at which it is unambiguously a command rather than part of a sentence. */
export function isAnchoredSlashCommand(
  text: string,
  context: SlashCommandContext,
): boolean {
  const before = text.slice(0, context.start);
  return !before.slice(before.lastIndexOf("\n") + 1).trim();
}

export function removeSlashCommand(
  text: string,
  context: SlashCommandContext,
): { text: string; cursor: number } {
  let before = text.slice(0, context.start);
  let after = text.slice(context.end);
  if (!before) {
    after = after.replace(/^\s/, "");
  } else if (!after) {
    before = before.replace(/\s$/, "");
  } else if (/\s$/.test(before) && /^\s/.test(after)) {
    after = after.slice(1);
  }
  return { text: before + after, cursor: before.length };
}

export function commandsForHarness(
  skills: SkillInfo[],
  planActivation: "permission" | "command" | null | undefined,
): SkillInfo[] {
  const availableSkills = skills.filter(
    (skill) => skill.name.toLowerCase() !== PLAN_COMMAND.name,
  );
  return planActivation
    ? [PLAN_COMMAND, ...availableSkills]
    : availableSkills;
}

export function parsePlanCommand(
  text: string,
  planActivation: "permission" | "command" | null | undefined,
): { prompt: string } | null {
  if (!planActivation) return null;
  const token = /(^|\s)\/plan(?=\s|$)/gi;
  if (!token.test(text)) return null;
  return { prompt: text.replace(token, "").trim() };
}

export function effectiveCommandPlanMode(
  planActivation: "permission" | "command" | null | undefined,
  toggledMode: boolean | undefined,
  pendingMode: boolean | null,
): boolean | undefined {
  if (planActivation !== "command") return undefined;
  if (toggledMode !== undefined) return toggledMode;
  return pendingMode ?? undefined;
}
