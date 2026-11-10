import type { RuntimeMode } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { OmpSettings } from "../settings.ts";
import { parseOmpCommands } from "./commands.ts";
import { parseOmpModels } from "./models.ts";
import { makeOmpRpcConnection, OmpRpcError } from "./rpc.ts";

const PRESENTATION = {
  displayName: "OMP",
  supportedRuntimeModes: [
    "approval-required",
    "auto-accept-edits",
    "full-access",
  ] satisfies ReadonlyArray<RuntimeMode>,
  showInteractionModeToggle: false,
  supportsConversationRollback: true,
  reportsContextWindow: true,
};
const MINIMUM_VERSION = "18.18.3";

export const buildInitialOmpSnapshot = Effect.fn("OmpStatus.initial")(function* (
  settings: OmpSettings,
) {
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: providerModelsFromSettings(parseOmpModels({ models: [] }), settings.customModels, {
      optionDescriptors: [],
    }),
    slashCommands: parseOmpCommands({ commands: [] }),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking OMP availability…"
        : "OMP is disabled in T3 Code settings.",
    },
  });
});

const discoveryConnection = Effect.fn("OmpStatus.connect")(function* (
  settings: OmpSettings,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const rpc = yield* makeOmpRpcConnection({
    command: settings.binaryPath || "omp",
    args: ["--mode", "rpc", "--no-session", "--no-ui"],
    cwd,
    env,
  });
  yield* Stream.runDrain(Stream.fromQueue(rpc.events)).pipe(Effect.ignore, Effect.forkScoped);
  return rpc;
});

export const discoverOmpWorkspace = Effect.fn("OmpStatus.discoverWorkspace")(function* (
  settings: OmpSettings,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const rpc = yield* discoveryConnection(settings, env, cwd);
  const inventory = yield* rpc.request({ type: "get_available_models" });
  const state = yield* rpc.request({ type: "get_state" });
  const commands = yield* rpc.request({ type: "get_available_commands" });
  return yield* Effect.try({
    try: () => ({
      models: providerModelsFromSettings(parseOmpModels(inventory, state), settings.customModels, {
        optionDescriptors: [],
      }),
      slashCommands: parseOmpCommands(commands),
    }),
    catch: (cause) => new OmpRpcError({ operation: "inventory", cause }),
  });
}, Effect.scoped);

export const checkOmpProviderStatus = Effect.fn("OmpStatus.check")(function* (
  settings: OmpSettings,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const initial = yield* buildInitialOmpSnapshot(settings);
  if (!settings.enabled) return initial;
  const versionResult = yield* Effect.gen(function* () {
    const binary = settings.binaryPath || "omp";
    const command = yield* resolveSpawnCommand(binary, ["--version"], { env });
    return yield* spawnAndCollect(
      binary,
      ChildProcess.make(command.command, command.args, {
        env,
        extendEnv: false,
        shell: command.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(10_000), Effect.result);
  if (Result.isFailure(versionResult))
    return {
      ...initial,
      installed: !isCommandMissingCause(versionResult.failure),
      status: "error" as const,
      message: isCommandMissingCause(versionResult.failure)
        ? "OMP is not installed or is missing from PATH. Install OMP, or configure its executable path."
        : "Could not run OMP. Check the executable and environment settings.",
    };
  if (Option.isNone(versionResult.success))
    return {
      ...initial,
      installed: true,
      status: "error" as const,
      message: "OMP timed out while checking its version.",
    };
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0 || version === null || compareSemverVersions(version, MINIMUM_VERSION) < 0)
    return {
      ...initial,
      installed: true,
      version,
      status: "error" as const,
      message: `Native integration requires OMP ${MINIMUM_VERSION} or newer. Update OMP and refresh its status.`,
    };
  const discovery = yield* discoverOmpWorkspace(settings, env, cwd).pipe(
    Effect.timeoutOption(45_000),
    Effect.result,
  );
  if (Result.isFailure(discovery) || Option.isNone(discovery.success))
    return {
      ...initial,
      installed: true,
      version,
      status: "error" as const,
      message:
        "Could not read OMP's native model and command catalog. Check its configuration and refresh provider status.",
    };
  const { models, slashCommands } = discovery.success.value;
  const authenticated = models.some((model) => model.slug !== "default" && !model.isCustom);
  const { message: _checking, ...ready } = initial;
  return {
    ...ready,
    installed: true,
    version,
    status: authenticated ? ("ready" as const) : ("warning" as const),
    auth: {
      status: authenticated ? ("authenticated" as const) : ("unauthenticated" as const),
      type: "omp",
    },
    models,
    slashCommands,
    ...(!authenticated
      ? {
          message:
            "OMP has no available models. Run omp in a terminal to sign in or configure a model provider, then refresh its status.",
        }
      : {}),
  };
});
