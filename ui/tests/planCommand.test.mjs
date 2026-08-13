import assert from "node:assert/strict";
import test from "node:test";
import { commandsForHarness, parsePlanCommand } from "../src/planCommand.ts";

test("Plan is the first command only for command-activated harnesses", () => {
  const skills = [{ name: "review", description: "Review", argHint: "", source: "user" }];
  assert.deepEqual(commandsForHarness(skills, "command").map((item) => item.name), [
    "plan",
    "review",
  ]);
  assert.equal(commandsForHarness(skills, "permission"), skills);
});

test("standalone and inline Plan commands are parsed without toggling", () => {
  assert.deepEqual(parsePlanCommand("/plan", "command"), { prompt: "" });
  assert.deepEqual(parsePlanCommand("/PLAN   investigate this", "command"), {
    prompt: "investigate this",
  });
  assert.equal(parsePlanCommand("/plan", "permission"), null);
  assert.equal(parsePlanCommand("/planner", "command"), null);
});
