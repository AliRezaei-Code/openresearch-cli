import assert from "node:assert/strict";
import test from "node:test";
import {
  commandsForHarness,
  effectiveCommandPlanMode,
  isAnchoredSlashCommand,
  parsePlanCommand,
  insertSlashCommand,
  normalizeLeadingCommand,
  removeSlashCommand,
  slashCommandContext,
  splitCommandTokens,
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

const isWrite = (name) => name === "write";

test("known command tokens split out wherever they were typed", () => {
  assert.deepEqual(splitCommandTokens("use the /write skill", isWrite), [
    { text: "use the ", command: false },
    { text: "/write", command: true },
    { text: " skill", command: false },
  ]);
  assert.deepEqual(splitCommandTokens("/Write now", isWrite), [
    { text: "/Write", command: true },
    { text: " now", command: false },
  ]);
  assert.deepEqual(splitCommandTokens("/write ", isWrite), [
    { text: "/write", command: true },
    { text: " ", command: false },
  ]);
  assert.deepEqual(splitCommandTokens("", isWrite), []);
  assert.deepEqual(splitCommandTokens("no commands here", isWrite), [
    { text: "no commands here", command: false },
  ]);
  // Unknown commands, paths, and URLs stay plain text.
  assert.deepEqual(splitCommandTokens("/unknown /src/write https://x.dev/write", isWrite), [
    { text: "/unknown /src/write https://x.dev/write", command: false },
  ]);
});

test("splitting a message loses nothing — the chips are painted by offset", () => {
  for (const text of [
    "use the /write skill",
    "/write",
    "  /write  two  spaces  ",
    "line one\n/write args\n\nline three",
    "/write/write /write\t/write",
  ])
    assert.equal(
      splitCommandTokens(text, isWrite)
        .map((segment) => segment.text)
        .join(""),
      text,
    );
});

test("only a leading command is lowercased for the wire — prose is left alone", () => {
  assert.equal(normalizeLeadingCommand("/WRITE the notes", isWrite), "/write the notes");
  assert.equal(normalizeLeadingCommand("Use the /Write skill", isWrite), "Use the /Write skill");
  assert.equal(normalizeLeadingCommand("/Unknown Thing", isWrite), "/Unknown Thing");
});

test("picking a command replaces the token in place", () => {
  const text = "look at /wr now";
  // The caret lands in the args, past the space that already followed.
  assert.deepEqual(insertSlashCommand(text, slashCommandContext(text, 11), "write"), {
    text: "look at /write now",
    cursor: 15,
  });
  // A command ending the draft gets the space its args will need.
  const tail = "look at /wr";
  assert.deepEqual(insertSlashCommand(tail, slashCommandContext(tail, 11), "write"), {
    text: "look at /write ",
    cursor: 15,
  });
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
