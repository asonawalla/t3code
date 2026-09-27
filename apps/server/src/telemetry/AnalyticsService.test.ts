import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("does not resolve identity or send events when legacy settings enable telemetry", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const httpClient = HttpClient.make((request) => {
      requests.push(request.url);
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
    });

    // No filesystem or server configuration is provided: identity resolution must not run.
    yield* Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("test.disabled", { provider: "codex" });
      yield* analytics.flush;
    }).pipe(
      Effect.provide(AnalyticsService.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "https://posthog.example.test",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 1,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

    assert.deepEqual(requests, []);
  }),
);
