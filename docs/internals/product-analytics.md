# Product analytics

Product analytics is disabled in this build: nothing is sent to PostHog or the
`ingest.t3.codes` endpoint. The former telemetry environment variables cannot enable
collection.

Existing event callers use the inert
[analytics service](../../apps/server/src/telemetry/AnalyticsService.ts).
