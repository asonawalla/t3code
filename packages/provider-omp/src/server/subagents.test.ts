import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeOmpSubagentProjection } from "./subagents.ts";

const fixture = Effect.fn("OmpSubagentsTest.fixture")(function* () {
  const now = yield* DateTime.now;
  const driver = ProviderDriverKind.make("omp");
  const instanceId = ProviderInstanceId.make("omp");
  const threadId = ThreadId.make("parent");
  const parentThread: OrchestrationV2AppThread = {
    id: threadId,
    createdBy: "user",
    creationSource: "web",
    projectId: ProjectId.make("project"),
    title: "Parent",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "test/model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    lastVisitedAt: null,
    settledAt: null,
    settledOverride: null,
  };
  const parentProviderThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-parent"),
    driver,
    providerInstanceId: instanceId,
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "/parent.jsonl", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const task: OrchestrationV2Subagent = {
    id: NodeId.make("turn-1:child"),
    threadId,
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("root"),
    origin: "provider_native",
    createdBy: "agent",
    driver,
    providerInstanceId: instanceId,
    providerThreadId: parentProviderThread.id,
    childThreadId: null,
    nativeTaskRef: { driver, nativeId: "child", strength: "strong" },
    prompt: "Check the repository",
    title: "Reviewer",
    model: "test/model",
    status: "running",
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const requests: Record<string, unknown>[] = [];
  let entries: unknown[] = [];
  let nextByte = 0;
  const projection = yield* makeOmpSubagentProjection({
    emit: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    request: (command) =>
      Effect.sync(() => {
        requests.push(command);
        return { sessionFile: command.sessionFile, entries, nextByte };
      }),
  });
  return {
    projection,
    events,
    requests,
    now,
    input: {
      parentThread,
      parentProviderThread,
      parentProviderTurnId: ProviderTurnId.make("turn-1"),
      task,
      sessionFile: "/child.jsonl",
    },
    page: (value: unknown[], offset: number) => {
      entries = value;
      nextByte = offset;
    },
  };
});

it.effect(
  "persists paged native child messages, reasoning and tool output without duplicating replayed entries",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      test.page(
        [
          {
            id: "user-1",
            type: "message",
            message: { role: "user", content: "Check the repository", timestamp: 0 },
          },
        ],
        100,
      );
      const child = yield* test.projection.update(test.input);
      assert.isNotNull(child.childThreadId);
      assert.notEqual(child.providerThreadId, test.input.parentProviderThread.id);
      const created = test.events.find((event) => event.type === "app_thread.created");
      if (created?.type !== "app_thread.created") return assert.fail("Missing child thread");
      assert.equal(created.appThread.lineage.parentThreadId, test.input.parentThread.id);
      assert.equal(created.appThread.activeProviderThreadId, child.providerThreadId);
      const assistant = {
        id: "assistant-1",
        type: "message",
        message: {
          role: "assistant",
          timestamp: 1,
          content: [
            { type: "thinking", thinking: "Check the source" },
            { type: "text", text: "I will inspect it." },
            { type: "toolCall", id: "shell", name: "bash", arguments: { command: "pwd" } },
          ],
        },
      };
      test.page([assistant], 200);
      yield* test.projection.handleEvent({ id: "child", event: { type: "message_end" } });
      const result = {
        id: "result-1",
        type: "message",
        message: {
          role: "toolResult",
          timestamp: 2,
          toolCallId: "shell",
          toolName: "bash",
          content: [{ type: "text", text: "/workspace" }],
          details: { exitCode: 0 },
        },
      };
      test.page([assistant, result], 300);
      yield* test.projection.update({
        ...test.input,
        task: { ...child, status: "completed", completedAt: test.now, result: "Done" },
      });
      assert.deepEqual(
        test.requests.map((request) => request.fromByte),
        [0, 100, 200],
      );
      const messages = test.events.filter((event) => event.type === "message.updated");
      assert.deepEqual(
        messages.map((event) => event.message.text),
        ["Check the repository", "I will inspect it."],
      );
      assert.isTrue(
        test.events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "reasoning" &&
            event.turnItem.text === "Check the source",
        ),
      );
      const tools = test.events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        (event.turnItem.type === "dynamic_tool" || event.turnItem.type === "command_execution")
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(tools, 2);
      assert.equal(tools[0]?.id, tools[1]?.id);
      const terminal = tools[1];
      if (terminal?.type !== "command_execution") return assert.fail("Missing typed child command");
      assert.equal(terminal.status, "completed");
      assert.equal(terminal.output, "/workspace");
      assert.equal(terminal.exitCode, 0);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("gives reused native child ids separate transcripts across parent turns", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    const first = yield* test.projection.update(test.input);
    const second = yield* test.projection.update({
      ...test.input,
      parentProviderTurnId: ProviderTurnId.make("turn-2"),
      task: { ...test.input.task, id: NodeId.make("turn-2:child"), runId: RunId.make("run-2") },
    });
    assert.notEqual(first.childThreadId, second.childThreadId);
    test.page(
      [
        {
          id: "new-result",
          type: "message",
          message: { role: "assistant", content: "New task only" },
        },
      ],
      500,
    );
    yield* test.projection.handleEvent({ id: "child", event: { type: "message_end" } });
    const message = test.events.findLast((event) => event.type === "message.updated");
    assert.equal(message?.message.threadId, second.childThreadId);
    assert.deepEqual(
      test.requests.map((request) => request.fromByte),
      [0, 0, 0],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);
