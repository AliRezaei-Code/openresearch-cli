import assert from "node:assert/strict";
import test from "node:test";
import {
  commandsForHarness,
  effectiveCommandPlanMode,
  isAnchoredSlashCommand,
  parsePlanCommand,
  removeSlashCommand,
  slashCommandContext,
} from "../src/planCommand.ts";

test("Plan is the first command for every plan-capable harness", () => {
  const skills = [{ name: "review", description: "Review", argHint: "", source: "user" }];
  assert.deepEqual(commandsForHarness(skills, "command").map((item) => item.name), [
    "plan",
    "review",
  ]);
  assert.deepEqual(commandsForHarness(skills, "permission").map((item) => item.name), [
    "plan",
    "review",
  ]);
});

test("built-in Plan replaces legacy user-skill collisions", () => {
  const skills = [
    { name: "PLAN", description: "Legacy collision", argHint: "", source: "user" },
    { name: "review", description: "Review", argHint: "", source: "user" },
  ];
  const commands = commandsForHarness(skills, "command");
  assert.deepEqual(commands.map((item) => item.name), ["plan", "review"]);
  assert.equal(commands[0].source, "command");
  assert.deepEqual(
    commandsForHarness(skills, "permission").map((item) => item.name),
    ["plan", "review"],
  );
});

test("Plan is recognized and removed anywhere in the message", () => {
  assert.deepEqual(parsePlanCommand("/plan", "command"), { prompt: "" });
  assert.deepEqual(parsePlanCommand("investigate /PLAN this", "command"), {
    prompt: "investigate this",
  });
  assert.deepEqual(parsePlanCommand("first\n/plan\nsecond /plan", "permission"), {
    prompt: "first\nsecond",
  });
  assert.equal(parsePlanCommand("/planner", "command"), null);
  assert.equal(parsePlanCommand("https://example.com/plan", "command"), null);
});

test("slash context follows the caret anywhere in the message", () => {
  assert.deepEqual(slashCommandContext("/pl", 3), { query: "pl", start: 0, end: 3 });
  assert.deepEqual(slashCommandContext("investigate /pl now", 15), {
    query: "pl",
    start: 12,
    end: 15,
  });
  assert.equal(slashCommandContext("investigate/path", 16), null);
  // Where onChange looks once the space that finished a command lands.
  assert.deepEqual(slashCommandContext("investigate /plan now", 17), {
    query: "plan",
    start: 12,
    end: 17,
  });
});

test("a command is anchored when it opens the draft or one of its lines", () => {
  assert.equal(isAnchoredSlashCommand("/plan", { query: "plan", start: 0, end: 5 }), true);
  assert.equal(isAnchoredSlashCommand("  /plan", { query: "plan", start: 2, end: 7 }), true);
  assert.equal(
    isAnchoredSlashCommand("ask this\n/plan", { query: "plan", start: 9, end: 14 }),
    true,
  );
  assert.equal(
    isAnchoredSlashCommand("copy it into /data", { query: "data", start: 13, end: 18 }),
    false,
  );
  assert.equal(
    isAnchoredSlashCommand("ask this\nnow /plan", { query: "plan", start: 13, end: 18 }),
    false,
  );
});

test("removing a slash command preserves the surrounding message", () => {
  assert.deepEqual(
    removeSlashCommand("/plan investigate", { query: "plan", start: 0, end: 5 }),
    { text: "investigate", cursor: 0 },
  );
  assert.deepEqual(
    removeSlashCommand("investigate /plan this", { query: "plan", start: 12, end: 17 }),
    { text: "investigate this", cursor: 12 },
  );
  assert.deepEqual(removeSlashCommand("investigate /plan", { query: "plan", start: 12, end: 17 }), {
    text: "investigate",
    cursor: 11,
  });
});

test("a requested toggle overrides pending Plan state for an immediate send", () => {
  assert.equal(effectiveCommandPlanMode("command", undefined, false), false);
  assert.equal(effectiveCommandPlanMode("command", undefined, true), true);
  assert.equal(effectiveCommandPlanMode("command", true, false), true);
  assert.equal(effectiveCommandPlanMode("command", false, true), false);
  assert.equal(effectiveCommandPlanMode("permission", true, true), undefined);
  assert.equal(effectiveCommandPlanMode("command", undefined, null), undefined);
});
