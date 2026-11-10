import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { OmpSettings } from "../settings.ts";
import { checkOmpProviderStatus, discoverOmpWorkspace } from "./status.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.fn("OmpStatusTest.fixture")(function (
  models: unknown[],
  version = "18.18.3",
) {
  const launches: string[][] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
      launches.push(args);
      const versionCheck = args.includes("--version");
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const emit = (frame: unknown) =>
        Queue.offer(stdout, new TextEncoder().encode(`${encodeJson(frame)}\n`));
      if (!versionCheck)
        yield* emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] });
      let buffer = "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(2_147_483_647),
        exitCode: versionCheck ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
        isRunning: Effect.succeed(!versionCheck),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.gen(function* () {
            buffer += new TextDecoder().decode(bytes);
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const input = decodeJson(buffer.slice(0, newline)) as Record<string, unknown>;
              buffer = buffer.slice(newline + 1);
              const data =
                input.type === "negotiate_protocol"
                  ? { protocolVersion: 2 }
                  : input.type === "get_available_models"
                    ? { models }
                    : input.type === "get_available_commands"
                      ? { commands: [{ name: "workspace-check", source: "file" }] }
                      : { model: models[0], thinkingLevel: "high" };
              yield* emit({
                type: "response",
                id: input.id,
                command: input.type,
                success: true,
                data,
              });
            }
          }),
        ),
        stdout: versionCheck
          ? Stream.make(new TextEncoder().encode(`omp/${version}\n`))
          : Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return Effect.succeed({ spawner, launches });
});
const settings = Schema.decodeSync(OmpSettings)({ enabled: true, binaryPath: process.execPath });

it.effect(
  "reports native model authentication and workspace commands without creating sessions",
  () =>
    Effect.gen(function* () {
      const fake = yield* fixture([
        {
          provider: "native",
          id: "model",
          reasoning: true,
          thinking: { efforts: ["low", "high"] },
        },
      ]);
      const snapshot = yield* checkOmpProviderStatus(settings, {}, "/workspace").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.version, "18.18.3");
      assert.equal(snapshot.auth.status, "authenticated");
      assert.isUndefined(snapshot.message);
      assert.equal(snapshot.models[1]?.slug, "native/model");
      assert.include(
        snapshot.slashCommands?.map((command) => command.name) ?? [],
        "workspace-check",
      );
      const workspace = yield* discoverOmpWorkspace(settings, {}, "/other-workspace").pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
      );
      assert.include(
        workspace.slashCommands.map((command) => command.name),
        "workspace-check",
      );
      assert.isTrue(
        fake.launches
          .filter((args) => args.includes("rpc"))
          .every((args) => args.includes("--no-session") && args.includes("--no-ui")),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "distinguishes unavailable credentials, unsupported versions and disabled providers",
  () =>
    Effect.gen(function* () {
      const empty = yield* fixture([]);
      const snapshot = yield* checkOmpProviderStatus(settings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, empty.spawner),
      );
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.equal(snapshot.status, "warning");
      const old = yield* fixture([], "17.0.0");
      const unsupported = yield* checkOmpProviderStatus(settings, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, old.spawner),
      );
      assert.equal(unsupported.status, "error");
      assert.include(unsupported.message ?? "", "18.18.3");
      assert.lengthOf(old.launches, 1);
      const disabled = yield* fixture([]);
      yield* checkOmpProviderStatus({ ...settings, enabled: false }, {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, disabled.spawner),
      );
      assert.lengthOf(disabled.launches, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
);
