import {
  ProviderDriverKind,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderTurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";

const driver = ProviderDriverKind.make("omp");
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : undefined);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const contentText = (value: unknown) =>
  typeof value === "string"
    ? value
    : array(value)
        .map(record)
        .filter((part) => part.type === "text")
        .map((part) => string(part.text) ?? "")
        .join("\n");
const ref = (nativeId: string) => ({ driver, nativeId, strength: "strong" as const });
const Transcript = Schema.Struct({
  sessionFile: Schema.String,
  nextByte: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  entries: Schema.Array(Schema.Unknown),
});
const decodeTranscript = Schema.decodeUnknownEffect(Transcript);

interface Child {
  readonly thread: OrchestrationV2AppThread;
  providerThread: OrchestrationV2ProviderThread;
  readonly rootNodeId: OrchestrationV2Subagent["id"];
  task: OrchestrationV2Subagent;
  sessionFile: string | undefined;
  cursor: number;
  nextOrdinal: number;
  readonly seenEntries: Set<string>;
  readonly tools: Map<
    string,
    { name: string; args: unknown; ordinal: number; startedAt: DateTime.Utc; completed: boolean }
  >;
}

export const makeOmpSubagentProjection = Effect.fn("OmpSubagents.make")(function* (options: {
  readonly request: (
    command: Record<string, unknown>,
  ) => Effect.Effect<unknown, ProviderAdapter.ProviderAdapterProtocolError>;
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
}) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const children = new Map<string, Child>();
  const live = new Map<string, Child>();
  const itemBase = (child: Child, nativeId: string, ordinal: number, at: DateTime.Utc) => ({
    id: ids.derive.turnItemFromProviderItem({
      driver,
      nativeItemId: `${child.thread.id}:${nativeId}`,
    }),
    threadId: child.thread.id,
    runId: null,
    nodeId: child.rootNodeId,
    providerThreadId: child.providerThread.id,
    providerTurnId: null,
    nativeItemRef: ref(nativeId),
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  });
  // Transcript entries already share the enclosing sync span; avoid a span for every message block.
  const projectEntry = Effect.fnUntraced(function* (
    child: Child,
    entry: Record<string, unknown>,
    now: DateTime.Utc,
  ) {
    const entryId = string(entry.id);
    if (entry.type !== "message" || entryId === undefined || child.seenEntries.has(entryId)) return;
    child.seenEntries.add(entryId);
    const message = record(entry.message);
    const at = Option.getOrElse(
      DateTime.make(typeof message.timestamp === "number" ? message.timestamp : Number.NaN),
      () => now,
    );
    const role = message.role;
    const nativeId = `${child.thread.id}:message:${entryId}`;
    const text = contentText(message.content);
    if ((role === "user" || role === "assistant") && text) {
      const artifacts = makeSubagentConversationArtifacts({
        messageId: ids.derive.messageFromProviderItem({ driver, nativeItemId: nativeId }),
        turnItemId: ids.derive.turnItemFromProviderItem({ driver, nativeItemId: nativeId }),
        threadId: child.thread.id,
        senderThreadId: child.task.threadId,
        rootNodeId: child.rootNodeId,
        providerThreadId: child.providerThread.id,
        providerTurnId: null,
        nativeItemRef: ref(entryId),
        role,
        text,
        ordinal: child.nextOrdinal++,
        now: at,
      });
      yield* options.emit({ type: "message.updated", driver, message: artifacts.message });
      yield* options.emit({ type: "turn_item.updated", driver, turnItem: artifacts.turnItem });
    }
    if (role === "assistant") {
      for (const [index, value] of array(message.content).entries()) {
        const block = record(value);
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          yield* options.emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...itemBase(child, `${entryId}:thinking:${index}`, child.nextOrdinal++, at),
              type: "reasoning",
              text: block.thinking,
              streaming: false,
            },
          });
        } else if (block.type === "toolCall" && typeof block.id === "string") {
          const tool = {
            name: string(block.name) ?? "tool",
            args: block.arguments,
            ordinal: child.nextOrdinal++,
            startedAt: at,
            completed: false,
          };
          child.tools.set(block.id, tool);
          yield* options.emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...itemBase(child, `tool:${block.id}`, tool.ordinal, at),
              type: "dynamic_tool",
              status: "running",
              completedAt: null,
              toolName: tool.name,
              input: tool.args,
            },
          });
        }
      }
    } else if (role === "toolResult" && typeof message.toolCallId === "string") {
      const tool = child.tools.get(message.toolCallId) ?? {
        name: string(message.toolName) ?? "tool",
        args: {},
        ordinal: child.nextOrdinal++,
        startedAt: at,
        completed: false,
      };
      tool.completed = true;
      child.tools.set(message.toolCallId, tool);
      const base = {
        ...itemBase(child, `tool:${message.toolCallId}`, tool.ordinal, at),
        startedAt: tool.startedAt,
        status: message.isError === true ? ("failed" as const) : ("completed" as const),
      };
      const args = record(tool.args);
      const details = record(message.details);
      const path = string(details.resolvedPath) ?? string(args.path);
      let item: OrchestrationV2TurnItem;
      if (tool.name === "bash" || tool.name === "python")
        item = {
          ...base,
          type: "command_execution",
          input: string(args.command) ?? string(args.code) ?? "",
          output: text,
          ...(typeof details.exitCode === "number" && Number.isInteger(details.exitCode)
            ? { exitCode: details.exitCode }
            : {}),
        };
      else if (["edit", "write", "ast_edit"].includes(tool.name) && path)
        item = {
          ...base,
          type: "file_change",
          fileName: path,
          ...(typeof details.diff === "string" ? { diffStr: details.diff } : {}),
          ...(tool.name === "write" && typeof args.content === "string"
            ? { newStr: args.content }
            : {}),
        };
      else
        item = {
          ...base,
          type: "dynamic_tool",
          toolName: tool.name,
          input: tool.args,
          output: message.content,
        };
      yield* options.emit({ type: "turn_item.updated", driver, turnItem: item });
    }
  });
  const sync = Effect.fn("OmpSubagents.sync")(function* (child: Child) {
    if (child.sessionFile === undefined) return;
    const data = yield* options.request({
      type: "get_subagent_messages",
      sessionFile: child.sessionFile,
      fromByte: child.cursor,
    });
    const transcript = yield* decodeTranscript(data).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver,
            detail: "OMP returned an invalid child transcript",
            cause,
          }),
      ),
    );
    if (transcript.sessionFile !== child.sessionFile)
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "OMP returned a transcript for another child",
      });
    const now = yield* DateTime.now;
    for (const entry of transcript.entries) yield* projectEntry(child, record(entry), now);
    child.cursor = transcript.nextByte;
  });
  const trySync = Effect.fn("OmpSubagents.trySync")((child: Child) =>
    sync(child).pipe(
      Effect.catch(() => Effect.logWarning("OMP child transcript could not be refreshed.")),
    ),
  );
  return {
    clear: Effect.sync(() => {
      children.clear();
      live.clear();
    }),
    update: Effect.fn("OmpSubagents.update")(function* (input: {
      readonly parentThread: OrchestrationV2AppThread;
      readonly parentProviderThread: OrchestrationV2ProviderThread;
      readonly parentProviderTurnId: ProviderTurnId;
      readonly task: OrchestrationV2Subagent;
      readonly sessionFile?: string;
      readonly refreshTranscript?: boolean;
    }) {
      const now = yield* DateTime.now;
      const nativeId = input.task.nativeTaskRef?.nativeId;
      let child = children.get(input.task.id);
      const shouldSync =
        child === undefined ||
        (child.sessionFile === undefined && input.sessionFile !== undefined) ||
        input.task.completedAt !== null;
      if (child === undefined) {
        const childThreadId = ids.derive.threadFromProviderThread({
          driver,
          providerInstanceId: input.task.providerInstanceId,
          nativeThreadId: input.task.id,
        });
        const providerThreadId = ids.derive.providerThread({
          driver,
          providerInstanceId: input.task.providerInstanceId,
          nativeThreadId: input.task.id,
        });
        const rootNodeId = ids.derive.nodeFromProviderItem({
          driver,
          nativeItemId: `${input.task.id}:root`,
        });
        const thread = makeSubagentChildThread({
          parentThread: input.parentThread,
          childThreadId,
          parentNodeId: input.task.id,
          activeProviderThreadId: providerThreadId,
          providerInstanceId: input.task.providerInstanceId,
          modelSelection: {
            ...input.parentThread.modelSelection,
            model: input.task.model ?? input.parentThread.modelSelection.model,
          },
          title: subagentThreadTitle({
            parentTitle: input.parentThread.title,
            title: input.task.title,
            prompt: input.task.prompt,
            ordinal: children.size + 1,
          }),
          now,
          createdBy: "agent",
          creationSource: "provider",
        });
        child = {
          thread,
          rootNodeId,
          task: input.task,
          sessionFile: input.sessionFile,
          cursor: 0,
          nextOrdinal: 100,
          seenEntries: new Set(),
          tools: new Map(),
          providerThread: {
            id: providerThreadId,
            driver,
            providerInstanceId: input.task.providerInstanceId,
            providerSessionId: input.parentProviderThread.providerSessionId,
            appThreadId: childThreadId,
            ownerNodeId: input.task.id,
            nativeThreadRef: input.sessionFile === undefined ? null : ref(input.sessionFile),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: {
              providerThreadId: input.parentProviderThread.id,
              providerTurnId: input.parentProviderTurnId,
            },
            createdAt: now,
            updatedAt: now,
          },
        };
        children.set(input.task.id, child);
        yield* options.emit({ type: "app_thread.created", driver, appThread: thread });
      }
      child.task = {
        ...input.task,
        childThreadId: child.thread.id,
        providerThreadId: child.providerThread.id,
      };
      if (nativeId != null) live.set(nativeId, child);
      if (input.sessionFile !== undefined) child.sessionFile = input.sessionFile;
      child.providerThread = {
        ...child.providerThread,
        nativeThreadRef: child.sessionFile === undefined ? null : ref(child.sessionFile),
        status: input.task.completedAt === null ? "active" : "idle",
        updatedAt: now,
      };
      yield* options.emit({
        type: "provider_thread.updated",
        driver,
        providerThread: child.providerThread,
      });
      yield* options.emit({
        type: "node.updated",
        driver,
        node: {
          id: child.rootNodeId,
          threadId: child.thread.id,
          runId: null,
          parentNodeId: null,
          rootNodeId: child.rootNodeId,
          kind: "root_turn",
          status: input.task.status,
          countsForRun: false,
          providerThreadId: child.providerThread.id,
          providerTurnId: null,
          nativeItemRef: child.providerThread.nativeThreadRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: input.task.startedAt,
          completedAt: input.task.completedAt,
        },
      });
      if (shouldSync && input.refreshTranscript !== false) yield* trySync(child);
      if (input.task.completedAt !== null) {
        for (const [id, tool] of child.tools) {
          if (tool.completed) continue;
          tool.completed = true;
          yield* options.emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...itemBase(child, `tool:${id}`, tool.ordinal, now),
              startedAt: tool.startedAt,
              type: "dynamic_tool",
              status: input.task.status === "completed" ? "failed" : input.task.status,
              toolName: tool.name,
              input: tool.args,
            },
          });
        }
      }
      return child.task;
    }),
    handleEvent: Effect.fn("OmpSubagents.handleEvent")(function* (
      payload: Record<string, unknown>,
    ) {
      const child = typeof payload.id === "string" ? live.get(payload.id) : undefined;
      const event = record(payload.event);
      if (child !== undefined && (event.type === "message_end" || event.type === "agent_end"))
        yield* trySync(child);
    }),
  };
});
