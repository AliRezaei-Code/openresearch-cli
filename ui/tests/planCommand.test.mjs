import assert from "node:assert/strict";
import test from "node:test";
import {
  commandsForHarness,
  effectiveCommandPlanMode,
  parsePlanCommand,
} from "../src/planCommand.ts";

test("Plan is the first command only for command-activated harnesses", () => {
  const skills = [{ name: "review", description: "Review", argHint: "", source: "user" }];
  assert.deepEqual(commandsForHarness(skills, "command").map((item) => item.name), [
    "plan",
    "review",
  ]);
  assert.deepEqual(commandsForHarness(skills, "permission"), skills);
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
    ["review"],
  );
});

test("standalone and inline Plan commands are parsed without toggling", () => {
  assert.deepEqual(parsePlanCommand("/plan", "command"), { prompt: "" });
  assert.deepEqual(parsePlanCommand("/PLAN   investigate this", "command"), {
    prompt: "investigate this",
  });
  assert.equal(parsePlanCommand("/plan", "permission"), null);
  assert.equal(parsePlanCommand("/planner", "command"), null);
});

test("pending Plan transitions override stored state for an immediate send", () => {
  assert.equal(effectiveCommandPlanMode("command", false, false), false);
  assert.equal(effectiveCommandPlanMode("command", false, true), true);
  assert.equal(effectiveCommandPlanMode("command", true, false), true);
  assert.equal(effectiveCommandPlanMode("permission", true, true), undefined);
  assert.equal(effectiveCommandPlanMode("command", false, null), undefined);
});
