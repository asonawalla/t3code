import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { makeOmpTurnHistory, ompForkBoundary, forkOmpSession } from "./history.ts";
import { OmpRpcError, type OmpRpcConnection } from "./rpc.ts";

describe("native OMP conversation history", () => {
  it.effect(
    "captures incremental active-branch boundaries and rejects ambiguous legacy turns",
    () =>
      Effect.gen(function* () {
        const responses = yield* Queue.unbounded<unknown>();
        const commands: Array<Record<string, unknown>> = [];
        const history = makeOmpTurnHistory((command) => {
          commands.push(command);
          return Queue.take(responses).pipe(Effect.orDie);
        });
        yield* Queue.offer(responses, {
          entries: [{ id: "model", parentId: null, type: "model_change" }],
          leafId: "model",
        });
        const first = yield* history.capture();
        assert.equal(first.nativeId, "before-message:");
        yield* Queue.offer(responses, {
          entries: [
            { id: "u1", parentId: "model", type: "message" },
            { id: "a1", parentId: "u1", type: "message" },
            { id: "usage", parentId: "a1", type: "model_usage" },
          ],
          leafId: "usage",
        });
        const second = yield* history.capture();
        assert.equal(second.nativeId, "before-message:a1");
        assert.deepEqual(commands.at(-1), { type: "get_entries", since: "model" });
        yield* Queue.offer(responses, { entries: [], leafId: "u1" });
        assert.equal((yield* history.capture()).nativeId, "before-message:u1");
        const at = yield* DateTime.now;
        const turn: OrchestrationV2ProviderTurn = {
          id: ProviderTurnId.make("first"),
          providerThreadId: ProviderThreadId.make("thread"),
          nodeId: NodeId.make("node"),
          runAttemptId: RunAttemptId.make("attempt"),
          nativeTurnRef: first,
          ordinal: 1,
          status: "completed",
          startedAt: at,
          completedAt: at,
        };
        const turns = [
          turn,
          { ...turn, id: ProviderTurnId.make("second"), ordinal: 2, nativeTurnRef: second },
        ];
        assert.deepEqual(yield* ompForkBoundary(turns, 0), { type: "empty" });
        assert.deepEqual(yield* ompForkBoundary(turns, 1), { type: "message", entryId: "a1" });
        assert.deepEqual(yield* ompForkBoundary(turns, 2), { type: "latest" });
        const legacy = yield* ompForkBoundary(
          [{ ...turn, nativeTurnRef: { ...first, strength: "weak" } }],
          0,
        ).pipe(Effect.flip);
        assert.equal(legacy._tag, "ProviderAdapterProtocolError");
        yield* history.reset;
        yield* Queue.offer(responses, {
          entries: [{ id: "new", parentId: null, type: "message" }],
          leafId: "new",
        });
        assert.equal((yield* history.capture()).nativeId, "before-message:new");
        assert.deepEqual(commands.at(-1), { type: "get_entries" });
        yield* Queue.offer(responses, {
          entries: [{ id: "broken", parentId: "absent", type: "custom" }],
          leafId: "broken",
        });
        assert.equal(
          (yield* history.capture().pipe(Effect.flip))._tag,
          "ProviderAdapterProtocolError",
        );
      }),
  );

  it.effect("forks through OMP into the destination cwd and preserves source ownership", () =>
    Effect.gen(function* () {
      const calls: Array<Record<string, unknown>> = [];
      let args: ReadonlyArray<string> = [];
      let cwd: string | undefined;
      let disposed = false;
      let cancelled = false;
      let config = "";
      let goalStatus = "active";
      const fs = yield* FileSystem.FileSystem;
      const makeConnection: typeof import("./rpc.ts").makeOmpRpcConnection = (options) =>
        Effect.gen(function* () {
          args = options.args;
          cwd = options.cwd;
          const configIndex = args.indexOf("--config");
          if (configIndex !== -1)
            config = yield* fs.readFileString(args[configIndex + 1]!).pipe(Effect.orDie);
          const events = yield* Queue.unbounded<Record<string, unknown>, OmpRpcError>();
          const exited = yield* Deferred.make<number, OmpRpcError>();
          const scope = yield* Effect.scope;
          yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              disposed = true;
            }),
          );
          return {
            send: () => Effect.void,
            events,
            exited: Deferred.await(exited),
            terminate: Effect.void,
            request: (command) =>
              Effect.sync(() => {
                calls.push(command);
                if (command.type === "goal") {
                  if (command.op === "pause") goalStatus = "paused";
                  return { goal: { status: goalStatus } };
                }
                return command.type === "fork"
                  ? { cancelled }
                  : { sessionFile: "/sessions/fork.jsonl" };
              }),
          } satisfies OmpRpcConnection;
        });
      const options = {
        sourceFile: "/sessions/source.jsonl",
        boundary: { type: "message", entryId: "a1" } as const,
        command: "omp",
        sessionDir: "/sessions",
        cwd: "/workspace/fork",
        env: {},
        makeConnection,
      };
      assert.equal(yield* forkOmpSession(options), "/sessions/fork.jsonl");
      assert.equal(cwd, "/workspace/fork");
      assert.include(args, "--fork");
      assert.include(args, "/sessions/source.jsonl");
      assert.include(args, "--no-extensions");
      assert.include(config, "continuationModes: []");
      assert.deepEqual(calls, [
        { type: "fork", entryId: "a1" },
        { type: "goal", op: "get" },
        { type: "goal", op: "pause" },
        { type: "get_state" },
      ]);
      assert.isTrue(disposed);
      calls.length = 0;
      yield* forkOmpSession({ ...options, boundary: { type: "empty" } });
      assert.notInclude(args, "--fork");
      assert.deepEqual(calls, [
        { type: "new_session" },
        { type: "goal", op: "get" },
        { type: "get_state" },
      ]);
      cancelled = true;
      assert.equal(
        (yield* forkOmpSession(options).pipe(Effect.flip))._tag,
        "ProviderAdapterProtocolError",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
