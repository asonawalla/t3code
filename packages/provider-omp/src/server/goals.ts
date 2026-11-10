import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const NativeGoal = Schema.Struct({
  objective: Schema.String,
  status: Schema.Literals(["active", "paused", "budget-limited", "complete", "dropped"]),
  tokensUsed: Schema.optional(Schema.Finite),
  tokenBudget: Schema.optional(Schema.Finite),
  timeUsedSeconds: Schema.optional(Schema.Finite),
});
const decodeGoal = Schema.decodeUnknownOption(NativeGoal);
const nonNegativeInt = (value: number) => Math.max(0, Math.floor(value));

export function ompGoal(value: unknown): OrchestrationV2ProviderGoal | null | undefined {
  if (value === null) return null;
  const decoded = decodeGoal(value);
  if (Option.isNone(decoded)) return undefined;
  const goal = decoded.value;
  if (goal.status === "dropped") return null;
  const objective = goal.objective.trim();
  if (objective.length === 0) return undefined;
  return {
    objective,
    status: goal.status === "budget-limited" ? "budget_limited" : goal.status,
    ...(goal.tokensUsed === undefined ? {} : { tokensUsed: nonNegativeInt(goal.tokensUsed) }),
    ...(goal.timeUsedSeconds === undefined
      ? {}
      : { timeUsedSeconds: nonNegativeInt(goal.timeUsedSeconds) }),
    tokenBudget: goal.tokenBudget === undefined ? null : nonNegativeInt(goal.tokenBudget),
  };
}
