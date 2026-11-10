import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { OmpSettings } from "../settings.ts";
import type { makeOmpRpcConnection, OmpRpcError } from "./rpc.ts";
import { makeOmpTextGeneration } from "./textGeneration.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const settings = Schema.decodeSync(OmpSettings)({});

const fixture = Effect.fn("OmpTextTest.fixture")(function* (
  tools: unknown[] = [],
  status = "completed",
) {
  const events = yield* Queue.unbounded<Record<string, unknown>, OmpRpcError>();
  const sent: Record<string, unknown>[] = [];
  let overlay: unknown;
  const fs = yield* FileSystem.FileSystem;
  const makeConnection: typeof makeOmpRpcConnection = Effect.fn("OmpTextTest.connect")(
    function* (options) {
      const configIndex = options.args.indexOf("--config");
      overlay = decodeJson(
        yield* fs.readFileString(options.args[configIndex + 1]!).pipe(Effect.orDie),
      );
      return {
        events,
        terminate: Effect.void,
        exited: Effect.never,
        request: Effect.fn("OmpTextTest.request")((request) => {
          sent.push(request);
          return Effect.succeed(request.type === "get_state" ? { dumpTools: tools } : {});
        }),
        send: Effect.fn("OmpTextTest.send")(function* (request) {
          sent.push(request);
          yield* Queue.offer(events, {
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [
                { type: "text", text: '{"subject":"Native commit title","body":"Description"}' },
              ],
            },
          });
          yield* Queue.offer(events, {
            type: "prompt_result",
            id: request.id,
            status,
            sessionSettled: false,
          });
          yield* Queue.offer(events, { type: "session_settled" });
        }),
      };
    },
  );
  const generator = yield* makeOmpTextGeneration(settings, {}, makeConnection);
  return { generator, sent, getOverlay: () => overlay };
});

const input = {
  cwd: process.cwd(),
  branch: "main",
  stagedSummary: "M README.md",
  stagedPatch: "diff --git a/README.md b/README.md",
  modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "provider/model"),
};

it.effect("generates structured text only after native prompt completion and settlement", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    assert.deepEqual(yield* test.generator.generateCommitMessage(input), {
      subject: "Native commit title",
      body: "Description",
    });
    assert.deepEqual(test.getOverlay(), {
      autolearn: { enabled: false },
      memory: { backend: "off" },
      goal: { enabled: false },
      plan: { enabled: false, defaultOnStartup: false },
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("refuses unexpected tools before sending work and reports native failed prompts", () =>
  Effect.gen(function* () {
    const unsafe = yield* fixture([{ name: "manage_skill" }]);
    const error = yield* unsafe.generator.generateCommitMessage(input).pipe(Effect.flip);
    assert.include(error.detail, "enabled tools");
    assert.isFalse(unsafe.sent.some((command) => command.type === "prompt"));
    const failed = yield* fixture([], "failed");
    assert.equal(
      (yield* failed.generator.generateCommitMessage(input).pipe(Effect.flip)).detail,
      "OMP could not complete text generation.",
    );
    const invalid = yield* fixture();
    const invalidInput = {
      ...input,
      modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "unqualified"),
    };
    assert.include(
      (yield* invalid.generator.generateCommitMessage(invalidInput).pipe(Effect.flip)).detail,
      "provider/model",
    );
    assert.isFalse(invalid.sent.some((command) => command.type === "prompt"));
  }).pipe(Effect.provide(NodeServices.layer)),
);
