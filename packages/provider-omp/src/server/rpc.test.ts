import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { makeOmpRpcConnection } from "./rpc.ts";

const fixture = Effect.fn("OmpRpcTest.fixture")(function* (version = 1) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests = yield* Queue.unbounded<Record<string, unknown>>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const emitRaw = (text: string) => Queue.offer(stdout, new TextEncoder().encode(text));
  const emit = (value: unknown) => emitRaw(`${JSON.stringify(value)}\n`);
  yield* emit({ type: "ready", protocolVersion: version, supportedProtocolVersions: [1, 2] });
  let input = "";
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(2_147_483_647),
        exitCode: Deferred.await(exited),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.gen(function* () {
            input += new TextDecoder().decode(bytes);
            let newline: number;
            while ((newline = input.indexOf("\n")) >= 0) {
              const value = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
              input = input.slice(newline + 1);
              if (value.type === "negotiate_protocol") {
                yield* emit({
                  type: "response",
                  id: value.id,
                  command: value.type,
                  success: true,
                  data: { protocolVersion: 2 },
                });
              } else yield* Queue.offer(requests, value);
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  return {
    open: makeOmpRpcConnection({
      command: process.execPath,
      args: [],
      cwd: undefined,
      env: {},
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    emit,
    emitRaw,
    requests,
    crash: Deferred.succeed(exited, ChildProcessSpawner.ExitCode(9)).pipe(
      Effect.andThen(Queue.end(stdout)),
    ),
  };
});

describe("OMP native RPC", () => {
  it.live("negotiates and terminates a real native subprocess", () =>
    Effect.gen(function* () {
      const rpc = yield* makeOmpRpcConnection({
        command: process.execPath,
        args: [
          "-e",
          `
          process.on("SIGTERM", () => process.exit(0));
          process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] }) + "\\n");
          require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
            const command = JSON.parse(line);
            process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true,
              data: command.type === "negotiate_protocol" ? { protocolVersion: 2 } : { isSettled: true } }) + "\\n");
          });
        `,
        ],
        cwd: undefined,
        env: {},
      });
      assert.deepEqual(yield* rpc.request({ type: "get_state" }), { isSettled: true });
      yield* rpc.terminate;
      assert.isAtLeast(yield* rpc.exited, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "correlates out-of-order responses while preserving prompt completion and settling events",
    () =>
      Effect.gen(function* () {
        const fake = yield* fixture();
        const rpc = yield* fake.open;
        const first = yield* rpc.request({ type: "get_state" }).pipe(Effect.forkScoped);
        const requestOne = yield* Queue.take(fake.requests);
        const second = yield* rpc.request({ type: "get_subagents" }).pipe(Effect.forkScoped);
        const requestTwo = yield* Queue.take(fake.requests);
        yield* fake.emit({
          type: "response",
          id: requestTwo.id,
          success: true,
          data: { subagents: [] },
        });
        yield* fake.emit({
          type: "response",
          id: requestOne.id,
          success: true,
          data: { isSettled: false },
        });
        assert.deepEqual(yield* Fiber.join(first), { isSettled: false });
        assert.deepEqual(yield* Fiber.join(second), { subagents: [] });
        yield* rpc.send({ type: "prompt", id: "turn-1", message: "hello" });
        assert.equal((yield* Queue.take(fake.requests)).id, "turn-1");
        yield* fake.emitRaw('{"type":"prompt_re');
        yield* fake.emitRaw('sult","id":"turn-1","status":"completed","sessionSettled":false}\r\n');
        yield* fake.emit({ type: "session_settled" });
        assert.deepEqual(yield* Queue.take(rpc.events), {
          type: "prompt_result",
          id: "turn-1",
          status: "completed",
          sessionSettled: false,
        });
        assert.equal((yield* Queue.take(rpc.events)).type, "session_settled");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("round-trips chunked Unicode and media payloads without truncation", () =>
    Effect.gen(function* () {
      const fake = yield* fixture();
      const rpc = yield* fake.open;
      const value = { type: "message_end", text: "😀\u2028".repeat(250_000) };
      yield* rpc.send(value);
      const chunks: Record<string, unknown>[] = [];
      const first = yield* Queue.take(fake.requests);
      chunks.push(first);
      const count = Number(first.count);
      assert.isAbove(count, 1);
      for (let index = 1; index < count; index++) chunks.push(yield* Queue.take(fake.requests));
      assert.deepEqual(
        JSON.parse(
          Buffer.concat(chunks.map((chunk) => Buffer.from(String(chunk.data), "base64"))).toString(
            "utf8",
          ),
        ),
        value,
      );
      for (const chunk of chunks) yield* fake.emit(chunk);
      assert.deepEqual(yield* Queue.take(rpc.events), value);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects incompatible handshakes and malformed chunk sequences", () =>
    Effect.gen(function* () {
      const incompatible = yield* fixture(3);
      assert.equal((yield* incompatible.open.pipe(Effect.flip)).operation, "unsupported-protocol");
      const fake = yield* fixture();
      const rpc = yield* fake.open;
      yield* fake.emit({
        type: "rpc_chunk",
        chunkId: "broken",
        index: 1,
        count: 2,
        byteLength: 1024 * 1024,
        data: Buffer.from("x").toString("base64"),
      });
      assert.equal((yield* Queue.take(rpc.events).pipe(Effect.flip)).operation, "read");
      assert.equal(
        (yield* rpc.request({ type: "get_state" }).pipe(Effect.asVoid, Effect.flip)).operation,
        "read",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails pending requests on process closure and explicit termination", () =>
    Effect.gen(function* () {
      for (const mode of ["crash", "terminate"] as const) {
        const fake = yield* fixture();
        const rpc = yield* fake.open;
        const pending = yield* rpc
          .request({ type: "get_state" })
          .pipe(Effect.asVoid, Effect.flip, Effect.forkScoped);
        yield* Queue.take(fake.requests);
        if (mode === "crash") yield* fake.crash;
        else yield* rpc.terminate;
        assert.equal((yield* Fiber.join(pending))._tag, "OmpRpcError");
        assert.equal((yield* Queue.take(rpc.events).pipe(Effect.flip))._tag, "OmpRpcError");
        if (mode === "crash") assert.equal(yield* rpc.exited, 9);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
