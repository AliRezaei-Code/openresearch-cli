import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAN_COMMAND,
  commandsForSlashContext,
  commandsForHarness,
  effectiveCommandPlanMode,
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

test("slash context follows the caret and limits inline commands", () => {
  assert.deepEqual(slashCommandContext("/pl", 3), {
    query: "pl",
    start: 0,
    end: 3,
    inline: false,
  });
  assert.deepEqual(slashCommandContext("investigate /pl now", 15), {
    query: "pl",
    start: 12,
    end: 15,
    inline: true,
  });
  assert.equal(slashCommandContext("investigate/path", 16), null);

  const commands = [
    PLAN_COMMAND,
    { name: "review", description: "Review", argHint: "", source: "user" },
  ];
  assert.deepEqual(commandsForSlashContext(commands, false), commands);
  assert.deepEqual(commandsForSlashContext(commands, true), [PLAN_COMMAND]);
});

test("removing a Plan command preserves the surrounding message", () => {
  assert.deepEqual(
    removeSlashCommand("/plan investigate", {
      query: "plan",
      start: 0,
      end: 5,
      inline: false,
    }),
    { text: "investigate", cursor: 0 },
  );
  assert.deepEqual(
    removeSlashCommand("investigate /plan this", {
      query: "plan",
      start: 12,
      end: 17,
      inline: true,
    }),
    { text: "investigate this", cursor: 12 },
  );
  assert.deepEqual(
    removeSlashCommand("investigate /plan", {
      query: "plan",
      start: 12,
      end: 17,
      inline: true,
    }),
    { text: "investigate", cursor: 11 },
  );
});

test("a requested toggle overrides pending Plan state for an immediate send", () => {
  assert.equal(effectiveCommandPlanMode("command", undefined, false), false);
  assert.equal(effectiveCommandPlanMode("command", undefined, true), true);
  assert.equal(effectiveCommandPlanMode("command", true, false), true);
  assert.equal(effectiveCommandPlanMode("command", false, true), false);
  assert.equal(effectiveCommandPlanMode("permission", true, true), undefined);
  assert.equal(effectiveCommandPlanMode("command", undefined, null), undefined);
});
