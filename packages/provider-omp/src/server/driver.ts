import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { OmpSettings } from "../settings.ts";
import { OmpAdapterV2Driver, type OmpAdapterV2DriverEnv } from "./adapter.ts";
import { buildInitialOmpSnapshot, checkOmpProviderStatus, discoverOmpWorkspace } from "./status.ts";

import { makeOmpTextGeneration } from "./textGeneration.ts";

const DRIVER = ProviderDriverKind.make("omp");
const decode = Schema.decodeSync(OmpSettings);
export type OmpDriverEnv =
  | OmpAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER,
  metadata: {
    displayName: "OMP",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: () => decode({}),
  create: Effect.fn("OmpDriver.create")(function* (input) {
    const host = yield* ProviderHost.ProviderHost;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment = yield* mergeProviderInstanceEnvironment(input.environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId: input.instanceId,
    });
    const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
      ...snapshot,
      instanceId: input.instanceId,
      driver: DRIVER,
      displayName: input.displayName ?? "OMP",
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: continuationIdentity.continuationKey },
      supportsTextGeneration: true,
    });
    const settings = { ...input.config, enabled: input.enabled };
    const textGeneration = yield* makeOmpTextGeneration(settings, environment);
    const base = buildInitialOmpSnapshot(settings);
    const checkProvider = checkOmpProviderStatus(settings, environment, host.paths.cwd).pipe(
      Effect.map(stamp),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const orchestrationAdapter = yield* OmpAdapterV2Driver.create(input).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Could not initialize native OMP.",
            cause,
          }),
      ),
    );
    const snapshot = yield* makeManagedServerProvider({
      resolveMaintenance: () =>
        Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
      getSettings: Effect.succeed(input.config),
      streamSettings: Stream.empty,
      haveSettingsChanged: (a, b) => a !== b,
      initialSnapshot: () => base.pipe(Effect.map(stamp)),
      checkProvider,
      refreshOnInterval: false,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Could not initialize OMP provider status.",
            cause,
          }),
      ),
    );
    return {
      instanceId: input.instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName: input.displayName,
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      enabled: input.enabled,
      snapshot,
      snapshotForCwd: (cwd) =>
        !input.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverOmpWorkspace(settings, environment, cwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER,
                      instanceId: input.instanceId,
                      detail: "Could not discover OMP workspace models and commands.",
                      cause,
                    }),
                ),
              ),
            ]).pipe(
              Effect.map(([current, commands]) => ({
                ...current,
                ...commands,
                slashCommandsPending: false,
              })),
            ),
      orchestrationAdapter,
      textGeneration,
    };
  }),
};
