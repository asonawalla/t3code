import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeOmpHostTools } from "./hostTools.ts";

const config = {
  environmentId: EnvironmentId.make("environment"),
  providerInstanceId: ProviderInstanceId.make("omp"),
  providerSessionId: "omp-session",
  threadId: ThreadId.make("thread"),
  endpoint: "http://127.0.0.1:1/mcp",
  authorizationHeader: "Bearer test-credential",
  browserToolsAvailable: true,
};

describe("OMP host tools", () => {
  it.effect(
    "discovers paginated tools and returns authenticated MCP results through native tool names",
    () =>
      Effect.gen(function* () {
        const seen: Array<{ method: string; headers: Headers; body: Record<string, unknown> }> = [];
        const host = yield* makeOmpHostTools(config, async (_url, init) => {
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
          seen.push({ method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
          if (init?.method === "DELETE") return new Response(null, { status: 204 });
          if (body.method === "notifications/initialized")
            return new Response(null, { status: 202 });
          const params = body.params as Record<string, unknown>;
          const result =
            body.method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  serverInfo: { name: "t3", version: "1" },
                }
              : body.method === "tools/list"
                ? {
                    tools: [
                      { name: params.cursor ? "second" : "first", inputSchema: { type: "object" } },
                    ],
                    ...(params.cursor ? {} : { nextCursor: "page-2" }),
                  }
                : {
                    content: [{ type: "text", text: "verified" }],
                    structuredContent: { value: 42 },
                    isError: false,
                  };
          return Response.json(
            { jsonrpc: "2.0", id: body.id, result },
            {
              headers: { "mcp-session-id": "http-session" },
            },
          );
        });
        assert.deepEqual(
          host.tools.map((tool) => tool.name),
          ["t3_code__first", "t3_code__second"],
        );
        assert.deepEqual(yield* host.call("t3_code__second", { answer: 42 }), {
          content: [{ type: "text", text: "verified" }],
          details: { server: "t3-code", tool: "second", structuredContent: { value: 42 } },
          isError: false,
        });
        const called = seen.at(-1)!;
        assert.deepEqual(called.body.params, { name: "second", arguments: { answer: 42 } });
        assert.equal(called.headers.get("authorization"), config.authorizationHeader);
        assert.equal(called.headers.get("mcp-session-id"), "http-session");
        assert.equal(called.headers.get("mcp-protocol-version"), "2025-06-18");
        const count = seen.length;
        assert.equal(
          (yield* host.call("unregistered", {}).pipe(Effect.asVoid, Effect.flip))._tag,
          "OmpHostToolsError",
        );
        assert.equal(seen.length, count);
        yield* host.dispose;
        assert.equal(seen.at(-1)?.method, "DELETE");
      }).pipe(Effect.scoped),
  );

  it.effect("cancels an in-flight T3 tool request when its native call is interrupted", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<AbortSignal>();
      const host = yield* makeOmpHostTools(config, async (_url, init) => {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (body.method === "tools/call") {
          if (!init?.signal) throw new Error("Missing abort signal");
          started.resolve(init.signal);
          return new Promise<Response>(() => {});
        }
        if (init?.method === "DELETE" || body.method === "notifications/initialized") {
          return new Response(null, { status: 204 });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
              : { tools: [{ name: "wait", inputSchema: { type: "object" } }] },
        });
      });
      const call = yield* host.call("t3_code__wait", {}).pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(call);
      assert.isTrue(signal.aborted);
    }).pipe(Effect.scoped),
  );
});
