import assert from "node:assert/strict";
import test from "node:test";
import {
  orxArgsMatch,
  orxArgv,
  parseOrxLit,
  shellWords,
  unwrapShellBody,
} from "../src/orxCommand.ts";

test("quoted Codex argv is tokenized as a normal command", () => {
  assert.deepEqual(shellWords('"orx" "projects"'), ["orx", "projects"]);
  assert.deepEqual(
    shellWords('"orx" "discover" "embedding" "biology research agents" "--prioritize" "recency"'),
    ["orx", "discover", "embedding", "biology research agents", "--prioritize", "recency"],
  );
  assert.equal(orxArgsMatch('"orx" "projects"', "projects?"), true);
  assert.equal(orxArgsMatch('"orx" "runs" "d81084a9-589e-4c8f-9384-2c0003517216"', "runs?"), true);
  assert.equal(orxArgsMatch('which "orx" "projects"', "projects"), false);
  assert.equal(orxArgsMatch('ORX_DATA_DIR=/tmp "orx" "projects"', "projects"), true);
  assert.equal(orxArgsMatch('orx lit "exp status"', "exp\\s+status"), false);
  assert.deepEqual(shellWords('orx lit ""'), ["orx", "lit", ""]);
  assert.deepEqual(orxArgv('"orx" "logs" "d81084a9-589e-4c8f-9384-2c0003517216"'), [
    "logs",
    "d81084a9-589e-4c8f-9384-2c0003517216",
  ]);
  assert.deepEqual(orxArgv('"orx" "exp" "desc" "experiment-id" "--set" "note"'), [
    "exp",
    "desc",
    "experiment-id",
    "--set",
    "note",
  ]);
});

test("outer shell quotes do not consume quoted argv", () => {
  assert.equal(unwrapShellBody("'orx projects'"), "orx projects");
  assert.equal(unwrapShellBody('"orx" "projects"'), '"orx" "projects"');
  const command = unwrapShellBody('"orx" "discover" "keyword" "biology agent benchmark"');
  assert.deepEqual(parseOrxLit(command), {
    kind: "discover",
    source: "alphaxiv",
    strategy: "keyword",
    query: "biology agent benchmark",
  });
});

test("tokenization stops at shell operators", () => {
  assert.deepEqual(shellWords('orx projects && echo ignored'), ["orx", "projects"]);
});

test("paper discovery commands expose their strategy and query", () => {
  assert.deepEqual(
    parseOrxLit('"orx" "discover" "embedding" "biology research agents" "--published-after" "2024-01-01" "--prioritize" "recency"'),
    {
      kind: "discover",
      source: "alphaxiv",
      strategy: "embedding",
      query: "biology research agents",
    },
  );
  assert.deepEqual(
    parseOrxLit('orx discover keyword "biology agent benchmark" --prioritize=recency'),
    {
      kind: "discover",
      source: "alphaxiv",
      strategy: "keyword",
      query: "biology agent benchmark",
    },
  );
});

test("existing literature and paper parsing remains intact", () => {
  assert.deepEqual(parseOrxLit('orx lit "protein folding" --source openalex'), {
    kind: "lit",
    source: "openalex",
    query: "protein folding",
  });
  assert.deepEqual(parseOrxLit('"orx" "paper" "10.1101/2024.01.01.123456v2"'), {
    kind: "paper",
    source: "biorxiv",
    id: "10.1101/2024.01.01.123456v2",
  });
});
