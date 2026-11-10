import { assert, it } from "@effect/vitest";
import { ompGoal } from "./goals.ts";

it("decodes native goal accounting and distinguishes removal from unknown state", () => {
  assert.deepEqual(
    ompGoal({
      objective: "  Ship the fix  ",
      status: "budget-limited",
      tokensUsed: 2000,
      tokenBudget: 1000,
      timeUsedSeconds: 80.5,
    }),
    {
      objective: "Ship the fix",
      status: "budget_limited",
      tokensUsed: 2000,
      tokenBudget: 1000,
      timeUsedSeconds: 80,
    },
  );
  assert.isNull(ompGoal({ objective: "Ship the fix", status: "dropped" }));
  assert.isNull(ompGoal(null));
  assert.isUndefined(ompGoal(undefined));
  assert.isUndefined(ompGoal({ objective: "Ship the fix", status: "future-state" }));
  assert.isUndefined(ompGoal({ objective: "", status: "active" }));
  assert.deepEqual(ompGoal({ objective: "Ship the fix", status: "complete" }), {
    objective: "Ship the fix",
    status: "complete",
    tokenBudget: null,
  });
});
