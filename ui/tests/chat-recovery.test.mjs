import assert from "node:assert/strict";
import test from "node:test";

import { recoveryAction, recoveryTurnOptions, retryStatusLabel } from "../src/chatRecovery.ts";

test("formats ORX retry attempts and countdowns", () => {
  assert.equal(
    retryStatusLabel(
      { retryOwner: "orx", attempt: 2, maximum: 4, nextRetryAt: 13_000 },
      10_100,
    ),
    "Retrying · attempt 2/4 · next attempt in 3s",
  );
});

test("native retries without timing use the compact CLI label", () => {
  assert.equal(retryStatusLabel({ retryOwner: "native", attempt: 1 }, 0), "CLI is retrying…");
});

test("only the two safe recovery actions are accepted", () => {
  assert.equal(recoveryAction("retry"), "retry");
  assert.equal(recoveryAction("continue"), "continue");
  assert.equal(recoveryAction("replay"), null);
});

test("recovery sends only composer axes changed after the failed turn", () => {
  assert.deepEqual(
    recoveryTurnOptions({ model: undefined, permissionMode: "ask", planMode: false }),
    { permissionMode: "ask", planMode: false },
  );
  assert.deepEqual(recoveryTurnOptions({}), {});
});
