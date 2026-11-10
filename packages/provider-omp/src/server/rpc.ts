import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

export class OmpRpcError extends Schema.TaggedError<OmpRpcError>()("OmpRpcError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `OMP RPC ${this.operation} failed.`;
  }
}

type RecordValue = Record<string, unknown>;

export interface OmpRpcConnection {
  readonly send: (record: RecordValue) => Effect.Effect<void, OmpRpcError>;
  readonly request: (
    record: RecordValue,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, OmpRpcError>;
  readonly events: Queue.Queue<RecordValue, OmpRpcError>;
  readonly exited: Effect.Effect<number, OmpRpcError>;
  readonly terminate: Effect.Effect<void>;
}

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeSync(JsonValue);
const encodeJson = Schema.encodeSync(JsonValue);

function record(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an OMP frame object");
  }
  return value as RecordValue;
}

function makeDecoder() {
  let pending:
    | { id: string; count: number; size: number; parts: Buffer[]; received: number }
    | undefined;
  return (value: RecordValue): RecordValue | undefined => {
    if (value.type !== "rpc_chunk") {
      if (pending !== undefined) throw new Error("Interrupted OMP chunk sequence");
      return value;
    }
    const { chunkId, index, count, byteLength, data } = value;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > 256 ||
      index >= count ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < MAX_FRAME_BYTES ||
      byteLength > MAX_MESSAGE_BYTES ||
      typeof data !== "string"
    )
      throw new Error("Invalid OMP chunk metadata");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > CHUNK_BYTES || bytes.toString("base64") !== data) {
      throw new Error("Invalid OMP chunk payload");
    }
    if (pending === undefined) {
      if (index !== 0) throw new Error("Missing first OMP chunk");
      pending = { id: chunkId, count, size: byteLength, parts: [], received: 0 };
    }
    if (
      pending.id !== chunkId ||
      pending.count !== count ||
      pending.size !== byteLength ||
      pending.parts.length !== index ||
      pending.received + bytes.length > pending.size
    ) {
      throw new Error("Inconsistent OMP chunk sequence");
    }
    pending.parts.push(bytes);
    pending.received += bytes.length;
    if (pending.parts.length !== pending.count) return undefined;
    if (pending.received !== pending.size) throw new Error("Incomplete OMP chunk payload");
    const decoded = record(decodeJson(Buffer.concat(pending.parts).toString("utf8")));
    pending = undefined;
    if (decoded.type === "rpc_chunk") throw new Error("Nested OMP chunk payload");
    return decoded;
  };
}

export const makeOmpRpcConnection = Effect.fn("OmpRpc.connect")(function* (options: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Effect.scope;
  const command = yield* resolveSpawnCommand(options.command, [...options.args], {
    env: options.env,
  }).pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(command.command, command.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        extendEnv: false,
        shell: command.shell,
        detached: platform !== "win32",
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })));

  let childExited = false;
  const exited = yield* Deferred.make<number, OmpRpcError>();
  const signal = (value: NodeJS.Signals) => {
    try {
      signalProcessGroup(Number(child.pid), value);
      return true;
    } catch {
      return false;
    }
  };
  const terminateProcess = Effect.fn("OmpRpc.terminateProcess")(function* () {
    if (childExited) return;
    if (platform === "win32") {
      yield* Effect.gen(function* () {
        const taskkill = yield* spawner.spawn(
          ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
        );
        yield* taskkill.exitCode;
      }).pipe(Effect.scoped, Effect.ignore);
      return;
    }
    if (!signal("SIGTERM")) return;
    const stopped = yield* child.exitCode.pipe(
      Effect.map(Number),
      Effect.timeoutOption(Duration.seconds(1)),
      Effect.orElseSucceed(() => Option.none<number>()),
    );
    if (Option.isSome(stopped)) childExited = true;
    // The PID belongs to this spawned child; never signal it after its exit has been observed.
    if (Option.isNone(stopped) && !childExited) {
      signal("SIGKILL");
    }
  });
  yield* Scope.addFinalizer(scope, terminateProcess().pipe(Effect.uninterruptible));

  const events = yield* Queue.unbounded<RecordValue, OmpRpcError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, OmpRpcError>();
  const down = yield* Deferred.make<never, OmpRpcError>();
  const ready = yield* Deferred.make<void, OmpRpcError>();
  const pending = new Map<string, Deferred.Deferred<unknown, OmpRpcError>>();
  const writePermit = yield* Semaphore.make(1);
  let sequence = 0;
  let protocolVersion = 1;
  const fail = Effect.fn("OmpRpc.fail")(function* (error: OmpRpcError) {
    if (!(yield* Deferred.fail(down, error))) return;
    yield* Deferred.fail(ready, error);
    for (const request of pending.values()) yield* Deferred.fail(request, error);
    pending.clear();
    yield* Queue.fail(outgoing, error);
    yield* Queue.fail(events, error);
  });
  // These handlers run for every streamed frame, so the connection owns their tracing span.
  const route = Effect.fnUntraced(function* (frame: RecordValue) {
    if (frame.type === "ready") {
      if (
        frame.protocolVersion !== 1 ||
        !Array.isArray(frame.supportedProtocolVersions) ||
        !frame.supportedProtocolVersions.includes(2)
      ) {
        return yield* fail(new OmpRpcError({ operation: "unsupported-protocol" }));
      }
      yield* Deferred.succeed(ready, undefined);
      return;
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const response = pending.get(frame.id);
      if (response !== undefined) {
        pending.delete(frame.id);
        if (frame.success === true) yield* Deferred.succeed(response, frame.data);
        else
          yield* Deferred.fail(
            response,
            new OmpRpcError({ operation: "request", cause: frame.error }),
          );
        return;
      }
    }
    yield* Queue.offer(events, frame);
  });

  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onSuccess: (code) =>
        Effect.suspend(() => {
          childExited = true;
          return Deferred.succeed(exited, Number(code));
        }),
      onFailure: (cause) => Deferred.fail(exited, new OmpRpcError({ operation: "exit", cause })),
    }),
    Effect.forkIn(scope),
  );

  yield* Effect.gen(function* () {
    let buffer = "";
    const decode = makeDecoder();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim().length === 0) continue;
            const frame = yield* Effect.try({
              try: () => {
                if (Buffer.byteLength(line) + 1 > MAX_FRAME_BYTES)
                  throw new Error("OMP frame exceeds limit");
                return decode(record(decodeJson(line)));
              },
              catch: (cause) => new OmpRpcError({ operation: "decode", cause }),
            });
            if (frame !== undefined) yield* route(frame);
          }
          if (Buffer.byteLength(buffer) >= MAX_FRAME_BYTES) {
            return yield* new OmpRpcError({ operation: "frame-limit" });
          }
        }),
      ),
    );
    return yield* new OmpRpcError({ operation: "stdout-closed" });
  }).pipe(
    Effect.catchCause((cause) => fail(new OmpRpcError({ operation: "read", cause }))),
    Effect.forkIn(scope),
  );

  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) => fail(new OmpRpcError({ operation: "write", cause }))),
    Effect.forkIn(scope),
  );

  // Writes include host-tool streaming, so avoid creating one tracing span per output frame.
  const send = Effect.fnUntraced(function* (
    value: RecordValue,
  ): Effect.fn.Return<void, OmpRpcError> {
    const bytes = yield* Effect.try({
      try: () => Buffer.from(encodeJson(value), "utf8"),
      catch: (cause) => new OmpRpcError({ operation: "encode", cause }),
    });
    if (
      bytes.length > MAX_MESSAGE_BYTES ||
      (protocolVersion === 1 && bytes.length + 1 > MAX_FRAME_BYTES)
    ) {
      return yield* new OmpRpcError({ operation: "message-limit" });
    }
    const write = (line: string) =>
      Queue.offer(outgoing, new TextEncoder().encode(line)).pipe(
        Effect.flatMap((accepted) => (accepted ? Effect.void : Deferred.await(down))),
      );
    if (bytes.length + 1 <= MAX_FRAME_BYTES) {
      yield* write(`${bytes.toString("utf8")}\n`);
      return;
    }
    const chunkId = `t3-omp-chunk-${sequence++}`;
    const count = Math.ceil(bytes.length / CHUNK_BYTES);
    for (let index = 0; index < count; index++) {
      yield* write(
        `${encodeJson({
          type: "rpc_chunk",
          chunkId,
          index,
          count,
          byteLength: bytes.length,
          data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
        })}\n`,
      );
    }
  }, writePermit.withPermits(1));
  const request = Effect.fn("OmpRpc.request")(function* (
    value: RecordValue,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    const id = `t3-omp-request-${sequence++}`;
    const response = yield* Deferred.make<unknown, OmpRpcError>();
    pending.set(id, response);
    return yield* send({ ...value, id }).pipe(
      Effect.andThen(Effect.raceFirst(Deferred.await(response), Deferred.await(down))),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(new OmpRpcError({ operation: "request-timeout" })),
      }),
      Effect.ensuring(Effect.sync(() => pending.delete(id))),
    );
  });
  yield* Deferred.await(ready).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(REQUEST_TIMEOUT_MS),
      orElse: () => Effect.fail(new OmpRpcError({ operation: "ready-timeout" })),
    }),
  );
  const negotiated = yield* request({ type: "negotiate_protocol", protocolVersion: 2 });
  if (
    typeof negotiated !== "object" ||
    negotiated === null ||
    !("protocolVersion" in negotiated) ||
    negotiated.protocolVersion !== 2
  )
    return yield* new OmpRpcError({ operation: "negotiate" });
  protocolVersion = 2;
  return {
    send,
    request,
    events,
    exited: Deferred.await(exited),
    terminate: fail(new OmpRpcError({ operation: "terminate" })).pipe(
      Effect.andThen(terminateProcess()),
      Effect.ignore,
      Effect.uninterruptible,
    ),
  } satisfies OmpRpcConnection;
});
