import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeAcpMcpOverAcpBridge } from "@t3tools/provider-acp/server/mcpOverAcpBridge";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";

export class OmpHostToolsError extends Schema.TaggedError<OmpHostToolsError>()(
  "OmpHostToolsError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "OMP could not access T3 tools.";
  }
}

const ToolPage = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      inputSchema: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  nextCursor: Schema.optional(Schema.String),
});
const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
});
const decodeToolPage = Schema.decodeUnknownEffect(ToolPage);
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);
const decodeArguments = Schema.decodeUnknownEffect(Schema.JsonObject);

export const makeOmpHostTools = Effect.fn("OmpHostTools.make")(
  function* (
    config: McpProviderSessionConfig,
    fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>,
  ) {
    const bridge = yield* makeAcpMcpOverAcpBridge({
      endpoint: config.endpoint,
      authorization: config.authorizationHeader,
      allocateConnectionId: Effect.succeed("omp-host-tools"),
      ...(fetchImplementation === undefined ? {} : { fetchImplementation }),
    });
    yield* Effect.addFinalizer(() => bridge.dispose);
    const { connectionId } = yield* bridge.connect({ serverId: "t3-code" });
    yield* bridge.message({
      connectionId,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t3-omp", version: "1.0.0" },
      },
    });
    yield* bridge.notification({ connectionId, method: "notifications/initialized" });
    const catalog = new Map<string, (typeof ToolPage.Type.tools)[number]>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = yield* bridge
        .message({
          connectionId,
          method: "tools/list",
          params: cursor === undefined ? {} : { cursor },
        })
        .pipe(Effect.flatMap(decodeToolPage));
      // OMP's MCP refresh removes mcp__ names, including RPC host tools registered under that prefix.
      for (const tool of page.tools) catalog.set(`t3_code__${tool.name}`, tool);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (cursors.has(cursor))
          return yield* new OmpHostToolsError({ cause: "Repeated MCP tools cursor" });
        cursors.add(cursor);
      }
    } while (cursor !== undefined);

    return {
      tools: [...catalog.entries()].map(([name, tool]) => ({
        name,
        label: tool.name,
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema,
        loadMode: "discoverable" as const,
      })),
      call: Effect.fn("OmpHostTools.call")(
        function* (name: string, args: Record<string, unknown>) {
          const tool = catalog.get(name);
          if (tool === undefined)
            return yield* new OmpHostToolsError({ cause: "Unknown host tool" });
          const argumentsJson = yield* decodeArguments(args);
          const result = yield* bridge
            .message({
              connectionId,
              method: "tools/call",
              params: { name: tool.name, arguments: argumentsJson },
            })
            .pipe(Effect.flatMap(decodeToolResult));
          return {
            content: result.content,
            details: {
              server: "t3-code",
              tool: tool.name,
              structuredContent: result.structuredContent,
            },
            ...(result.isError === undefined ? {} : { isError: result.isError }),
          };
        },
        Effect.mapError((cause) => new OmpHostToolsError({ cause })),
      ),
      dispose: bridge.dispose,
    };
  },
  Effect.mapError((cause) => new OmpHostToolsError({ cause })),
);
