import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeOmpModelSelection } from "./modelSelection.ts";

const instanceId = ProviderInstanceId.make("omp");

it.effect("reapplies the picker after native model changes and restores the launch default", () =>
  Effect.gen(function* () {
    let native = { provider: "native", id: "launch", contextWindow: 100_000 };
    let displayed = "default";
    let stateReads = 0;
    const selection = makeOmpModelSelection({
      initialState: { model: native },
      publishModel: (model) =>
        Effect.sync(() => {
          displayed = model;
        }),
      request: (command) =>
        Effect.sync(() => {
          if (command.type === "get_state") {
            stateReads++;
            return { model: native };
          }
          if (command.type === "set_model") {
            native = {
              provider: String(command.provider),
              id: String(command.modelId),
              contextWindow: 200_000,
            };
            return native;
          }
          return {};
        }),
    });
    const picker = { instanceId, model: "native/picker" };
    yield* selection.apply(picker);
    assert.equal(native.id, "picker");
    assert.equal(displayed, "native/picker");

    native = { ...native, id: "fallback" };
    yield* selection.handleEvent({ type: "model_changed" });
    assert.equal(displayed, "native/fallback");
    yield* selection.apply(picker);
    assert.equal(native.id, "picker");
    assert.equal(displayed, "native/picker");

    native = { ...native, id: "slash-command" };
    yield* selection.handleEvent({ type: "config_update", model: native });
    assert.equal(stateReads, 1);
    assert.equal(displayed, "native/slash-command");
    yield* selection.apply({ instanceId, model: "default" });
    assert.equal(native.id, "launch");
    assert.equal(displayed, "native/launch");
  }),
);

it.effect("reports native context capacity and usage with a safe telemetry fallback", () =>
  Effect.gen(function* () {
    let unavailable = false;
    let state: unknown = {
      model: { provider: "native", id: "model", contextWindow: 200_000 },
      contextUsage: { tokens: 14_000, contextWindow: 180_000 },
    };
    const selection = makeOmpModelSelection({
      initialState: state,
      publishModel: () => Effect.void,
      request: () =>
        unavailable
          ? Effect.fail(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: ProviderDriverKind.make("omp"),
                detail: "Unavailable",
              }),
            )
          : Effect.succeed(state),
    });
    const message = { input: 10_000, cacheRead: 2_000, output: 1_000, totalTokens: 13_000 };
    const usage = yield* selection.readUsage(message, "now");
    assert.deepEqual(usage, {
      usedTokens: 14_000,
      maxTokens: 180_000,
      inputTokens: 10_000,
      cachedInputTokens: 2_000,
      outputTokens: 1_000,
      updatedAt: "now",
    });
    unavailable = true;
    const fallback = yield* selection.readUsage(message, "later");
    assert.equal(fallback?.usedTokens, 13_000);
    assert.equal(fallback?.maxTokens, 200_000);
    unavailable = false;
    state = { contextUsage: { tokens: -1, contextWindow: Number.POSITIVE_INFINITY } };
    assert.isUndefined(yield* selection.readUsage({}, "invalid"));
  }),
);
