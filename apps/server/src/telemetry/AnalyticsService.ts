/**
 * Inert product analytics service. PostHog and T3 ingest collection is disabled in this build.
 *
 * @module AnalyticsService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

const disabledAnalytics = {
  record: () => Effect.void,
  flush: Effect.void,
  recordOwners: () => Effect.void,
};

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Accept an event without recording or sending it. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** No-op; analytics events are never queued. */
    readonly flush: Effect.Effect<void>;

    /** Accept install owners without recording or sending them. */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.succeed(AnalyticsService.of(disabledAnalytics));

export const layer = Layer.effect(AnalyticsService, make);
