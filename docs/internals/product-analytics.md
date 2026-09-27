# Product analytics

PostHog product analytics is disabled in this build. The former telemetry environment
variables cannot enable collection.

Existing event callers use the inert
[analytics service](../../apps/server/src/telemetry/AnalyticsService.ts).
