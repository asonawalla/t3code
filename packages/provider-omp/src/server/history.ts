import { ProviderDriverKind, type OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeOmpRpcConnection } from "./rpc.ts";

const driver = ProviderDriverKind.make("omp");
const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const BOUNDARY_PREFIX = "before-message:";
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const protocolError = (detail: string, cause?: unknown) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export function makeOmpTurnHistory(
  request: (
    command: Record<string, unknown>,
  ) => Effect.Effect<unknown, ProviderAdapter.ProviderAdapterProtocolError>,
) {
  const entries = new Map<string, { parentId: string | null; message: boolean }>();
  let cursor: string | undefined;
  return {
    reset: Effect.sync(() => {
      entries.clear();
      cursor = undefined;
    }),
    capture: Effect.fn("OmpHistory.capture")(function* () {
      const result = record(
        yield* request({ type: "get_entries", ...(cursor === undefined ? {} : { since: cursor }) }),
      );
      if (
        !Array.isArray(result.entries) ||
        !(result.leafId === null || typeof result.leafId === "string")
      )
        return yield* protocolError("OMP did not return a durable conversation boundary");
      for (const value of result.entries) {
        const entry = record(value);
        if (
          typeof entry.id !== "string" ||
          !(entry.parentId === null || typeof entry.parentId === "string")
        )
          return yield* protocolError("OMP returned a malformed session entry");
        entries.set(entry.id, { parentId: entry.parentId, message: entry.type === "message" });
        cursor = entry.id;
      }
      let head = result.leafId;
      const visited = new Set<string>();
      while (head !== null) {
        if (visited.has(head)) return yield* protocolError("OMP session history contains a cycle");
        visited.add(head);
        const entry = entries.get(head);
        if (entry === undefined)
          return yield* protocolError("OMP conversation boundary is missing from its history");
        if (entry.message) break;
        head = entry.parentId;
      }
      // OMP forks include the target message; this cursor is the last message before a T3 turn.
      return { driver, nativeId: `${BOUNDARY_PREFIX}${head ?? ""}`, strength: "strong" as const };
    }),
  };
}

export type OmpForkBoundary =
  | { readonly type: "latest" | "empty" }
  | { readonly type: "message"; readonly entryId: string };

export const ompForkBoundary = Effect.fn("OmpHistory.forkBoundary")(function* (
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  keptOrdinal: number,
) {
  const next = turns
    .filter((turn) => turn.ordinal > keptOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  if (next === undefined) return { type: "latest" } as const;
  const boundary = next.nativeTurnRef;
  if (boundary?.strength !== "strong" || !boundary.nativeId?.startsWith(BOUNDARY_PREFIX))
    return yield* protocolError(
      "This OMP turn predates durable rollback boundaries; fork the latest conversation instead",
    );
  const entryId = boundary.nativeId.slice(BOUNDARY_PREFIX.length);
  return entryId.length === 0
    ? ({ type: "empty" } as const)
    : ({ type: "message", entryId } as const);
});

export const forkOmpSession = Effect.fn("OmpHistory.forkSession")(function* (options: {
  readonly sourceFile: string;
  readonly boundary: OmpForkBoundary;
  readonly command: string;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly makeConnection?: typeof makeOmpRpcConnection;
}) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-fork-" });
      const configPath = `${configDir}/config.yml`;
      // Historical forks can restore an active goal before an owning T3 turn exists.
      yield* fs.writeFileString(configPath, "goal:\n  continuationModes: []\n");
      const connection = yield* (options.makeConnection ?? makeOmpRpcConnection)({
        command: options.command,
        args: [
          "--mode",
          "rpc",
          "--session-dir",
          options.sessionDir,
          "--no-extensions",
          "--no-tools",
          "--config",
          configPath,
          ...(options.boundary.type === "empty" ? [] : ["--fork", options.sourceFile]),
        ],
        cwd: options.cwd,
        env: options.env,
      });
      yield* Stream.runDrain(Stream.fromQueue(connection.events)).pipe(
        Effect.ignore,
        Effect.forkScoped,
      );
      if (options.boundary.type === "empty") {
        const created = record(yield* connection.request({ type: "new_session" }));
        if (created.cancelled === true)
          return yield* protocolError("OMP cancelled the empty conversation fork");
      }
      if (options.boundary.type === "message") {
        const fork = record(
          yield* connection.request({ type: "fork", entryId: options.boundary.entryId }),
        );
        if (fork.cancelled === true)
          return yield* protocolError("OMP cancelled the conversation fork");
      }
      const goal = record(yield* connection.request({ type: "goal", op: "get" }));
      if (record(goal.goal).status === "active")
        yield* connection.request({ type: "goal", op: "pause" });
      const state = record(yield* connection.request({ type: "get_state" }));
      if (
        typeof state.sessionFile !== "string" ||
        state.sessionFile.length === 0 ||
        state.sessionFile === options.sourceFile
      )
        return yield* protocolError("OMP did not create a distinct persisted conversation fork");
      if (state.isStreaming === true || state.hasPendingAsyncWork === true)
        return yield* protocolError("OMP fork unexpectedly started background work");
      return state.sessionFile;
    }),
  ).pipe(
    Effect.mapError((cause) =>
      isProtocolError(cause)
        ? cause
        : protocolError("Cannot fork the native OMP conversation", cause),
    ),
  );
});
