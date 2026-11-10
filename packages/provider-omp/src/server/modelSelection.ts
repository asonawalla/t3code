import {
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import { parseOmpModelSlug } from "./models.ts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const nativeModel = (value: unknown) => {
  const model = record(value);
  return typeof model.provider === "string" && typeof model.id === "string"
    ? { provider: model.provider, modelId: model.id, contextWindow: count(model.contextWindow) }
    : undefined;
};

export function makeOmpModelSelection(options: {
  readonly initialState: unknown;
  readonly request: (
    command: Record<string, unknown>,
  ) => Effect.Effect<unknown, ProviderAdapter.ProviderAdapterProtocolError>;
  readonly publishModel: (model: string) => Effect.Effect<void>;
}) {
  const launchModel = nativeModel(record(options.initialState).model);
  let model = launchModel;
  let appliedModel: string | undefined = "default";
  let appliedThinking: string | undefined;
  let appliedFast: boolean | undefined;
  const observe = Effect.fn("OmpModelSelection.observe")(function* (state: unknown) {
    const next = nativeModel(record(state).model);
    if (next === undefined) return;
    if (next.provider !== model?.provider || next.modelId !== model.modelId)
      appliedModel = undefined;
    model = next;
    yield* options.publishModel(`${next.provider}/${next.modelId}`);
  });
  return {
    invalidate: () => {
      appliedModel = undefined;
    },
    apply: Effect.fn("OmpModelSelection.apply")(function* (selection: ModelSelection) {
      if (selection.model !== appliedModel) {
        const target =
          selection.model === "default" ? launchModel : parseOmpModelSlug(selection.model);
        if (target == null)
          return yield* new ProviderAdapter.ProviderAdapterProtocolError({
            driver: ProviderDriverKind.make("omp"),
            detail:
              selection.model === "default"
                ? "OMP did not expose its configured default model"
                : "OMP model must have provider/model format",
          });
        const selected = yield* options.request({
          type: "set_model",
          provider: target.provider,
          modelId: target.modelId,
        });
        model = nativeModel(selected) ?? { ...target, contextWindow: undefined };
        appliedModel = selection.model;
      }
      if (model !== undefined) yield* options.publishModel(`${model.provider}/${model.modelId}`);
      const thinking = getModelSelectionStringOptionValue(selection, "thinking");
      if (thinking !== undefined || appliedThinking !== undefined)
        yield* options.request({ type: "set_thinking_level", level: thinking ?? "inherit" });
      appliedThinking = thinking;
      const fast = getModelSelectionBooleanOptionValue(selection, "fastMode");
      if (fast !== undefined || appliedFast !== undefined)
        yield* options.request({ type: "set_fast_mode", enabled: fast ?? false });
      appliedFast = fast;
    }),
    handleEvent: Effect.fn("OmpModelSelection.handleEvent")(function* (
      event: Record<string, unknown>,
    ) {
      if (event.type === "config_update") yield* observe(event);
      else if (event.type === "model_changed")
        yield* observe(yield* options.request({ type: "get_state" }));
    }),
    readUsage: Effect.fn("OmpModelSelection.readUsage")(function* (
      messageUsage: unknown,
      updatedAt: string,
    ): Effect.fn.Return<OrchestrationV2ProviderTurnTokenUsage | undefined> {
      const state = yield* options.request({ type: "get_session_stats" }).pipe(Effect.option);
      const context = record(record(Option.getOrUndefined(state)).contextUsage);
      const usage = record(messageUsage);
      const usedTokens = count(context.tokens) ?? count(usage.totalTokens);
      if (usedTokens === undefined) return;
      return {
        usedTokens,
        maxTokens: count(context.contextWindow) ?? model?.contextWindow,
        inputTokens: count(usage.input),
        cachedInputTokens: count(usage.cacheRead),
        outputTokens: count(usage.output),
        updatedAt,
      };
    }),
  };
}
