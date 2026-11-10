import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { OmpSettings } from "../settings.ts";
import { makeOmpAdapterV2, OMP_PROVIDER } from "./adapter.ts";
import { OmpRpcError, type OmpRpcConnection } from "./rpc.ts";

const settings = Schema.decodeSync(OmpSettings)({});
const instanceId = ProviderInstanceId.make("omp-prototype");
const threadId = ThreadId.make("omp-thread");
const modelSelection: ModelSelection = { instanceId, model: "default" };
const policy = (runtimeMode: RuntimeMode = "full-access") => ({
  runtimeMode,
  interactionMode: "default" as const,
  cwd: null,
});
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const setup = Effect.fn("OmpAdapterTest.setup")(function* (
  mode: RuntimeMode = "full-access",
  restore?: { readonly path: string; readonly goal: Record<string, unknown> },
) {
  const nativeEvents = yield* Queue.unbounded<Record<string, unknown>, OmpRpcError>();
  const requests = yield* Queue.unbounded<Record<string, unknown>>();
  const exited = yield* Deferred.make<number, OmpRpcError>();
  const goalCreateEntered = yield* Deferred.make<void>();
  const goalCreateReply = yield* Deferred.make<unknown>();
  let holdGoalCreate = false;
  const sent: Array<Record<string, unknown>> = [];
  let sessionFile = "/isolated/session.jsonl";
  let goal: Record<string, unknown> | null = null;
  let goalSettled = true;
  const responses = new Map<string, unknown>();
  const forkRequests: Array<Record<string, unknown>> = [];
  const forkSpawns: Array<{ args: ReadonlyArray<string>; cwd: string | undefined }> = [];
  let terminated = false;
  let rejectAbort = false;
  let promptId: unknown;
  let spawnArgs: readonly string[] = [];
  const connection: OmpRpcConnection = {
    events: nativeEvents,
    exited: Deferred.await(exited),
    terminate: Effect.gen(function* () {
      terminated = true;
      yield* Queue.fail(nativeEvents, new OmpRpcError({ operation: "terminate" }));
    }),
    send: (command) =>
      Effect.gen(function* () {
        sent.push(command);
        if (command.type === "prompt" || command.type === "compact") promptId = command.id;
        yield* Queue.offer(requests, command);
      }),
    request: (command) =>
      Effect.gen(function* () {
        sent.push(command);
        yield* Queue.offer(requests, command);
        if (responses.has(String(command.type))) return responses.get(String(command.type));
        if (command.type === "get_entries") return { entries: [], leafId: null };
        if (command.type === "get_state")
          return {
            sessionFile,
            sessionId: "session-uuid",
            model: { provider: "configured", id: "native" },
            isStreaming: false,
            hasPendingAsyncWork: false,
            isSettled: goalSettled,
            goal:
              goal === null ? null : { enabled: goal.status === "active", mode: "active", goal },
          };
        if (command.type === "goal") {
          if (command.op === "create") {
            goal = {
              objective: command.objective,
              status: "active",
              tokensUsed: 0,
              timeUsedSeconds: 0,
            };
            goalSettled = false;
            if (holdGoalCreate) {
              yield* Deferred.succeed(goalCreateEntered, undefined);
              return yield* Deferred.await(goalCreateReply);
            }
          } else if (command.op === "drop") goal = null;
          else if (goal !== null && command.op !== "get")
            goal = { ...goal, status: command.op === "resume" ? "active" : "paused" };
          return { goal };
        }
        if (command.type === "switch_session") {
          sessionFile = String(command.sessionPath);
          return { cancelled: false };
        }
        if (command.type === "cancel_subagent") {
          return { cancelled: true };
        }
        if (command.type === "abort_and_restore_queue") {
          if (rejectAbort) return yield* new OmpRpcError({ operation: "abort_and_restore_queue" });
          yield* Queue.offer(nativeEvents, {
            type: "prompt_result",
            id: promptId,
            status: "aborted",
            sessionSettled: true,
          });
        }
        return {};
      }),
  };
  const adapter = yield* makeOmpAdapterV2({
    instanceId,
    settings,
    environment: {},
    makeConnection: (spawn) => {
      if (spawn.args.includes("--no-tools"))
        return Effect.gen(function* () {
          forkSpawns.push({ args: spawn.args, cwd: spawn.cwd });
          const events = yield* Queue.unbounded<Record<string, unknown>, OmpRpcError>();
          return {
            ...connection,
            events,
            request: (command) =>
              Effect.sync(() => {
                forkRequests.push(command);
                return command.type === "fork"
                  ? { cancelled: false }
                  : { sessionFile: `/isolated/fork-${forkSpawns.length}.jsonl` };
              }),
          };
        });
      spawnArgs = spawn.args;
      if (restore !== undefined && spawn.args.includes(restore.path)) {
        sessionFile = restore.path;
        goal = { ...restore.goal, status: "paused" };
      }
      return Effect.succeed(connection);
    },
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("omp-session"),
    modelSelection,
    runtimePolicy: policy(mode),
    ...(restore === undefined ? {} : { initialNativeThreadId: restore.path }),
  });
  const observed: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  const eventQueue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const streamEnded =
    yield* Deferred.make<Exit.Exit<void, ProviderAdapter.ProviderAdapterV2Error>>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        observed.push(event);
        yield* Queue.offer(eventQueue, event);
      }),
    ),
    Effect.exit,
    Effect.flatMap((exit) => Deferred.succeed(streamEnded, exit)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy(mode),
  });
  const at = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    createdBy: "user",
    creationSource: "web",
    projectId: ProjectId.make("omp-project"),
    title: "Native OMP",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: mode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    deletedAt: null,
    lastVisitedAt: null,
    settledAt: null,
    settledOverride: null,
  };
  const turnInput: ProviderAdapter.ProviderAdapterV2TurnInput = {
    appThread,
    threadId,
    runId: RunId.make("omp-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("omp-attempt"),
    rootNodeId: NodeId.make("omp-root"),
    providerThread,
    modelSelection,
    runtimePolicy: policy(mode),
    message: {
      messageId: MessageId.make("omp-message"),
      text: "Hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
  };
  const take = Effect.fn("OmpAdapterTest.take")(function* (
    predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
  ) {
    while (true) {
      const event = yield* Queue.take(eventQueue);
      if (predicate(event)) return event;
    }
  });
  const emit = (event: Record<string, unknown>) => Queue.offer(nativeEvents, event);
  return {
    runtime,
    providerThread,
    turnInput,
    observed,
    streamEnded,
    sent,
    emit,
    take,
    connection,
    nativeEvents,
    requests,
    responses,
    goalCreateEntered,
    goalCreateReply,
    holdGoalCreate: () => {
      holdGoalCreate = true;
    },
    forkRequests,
    forkSpawns,
    rejectAbort: () => {
      rejectAbort = true;
    },
    terminated: () => terminated,
    spawnArgs: () => spawnArgs,
    promptId: () => promptId,
  };
});

const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.scoped, Effect.provide(testLayer));

describe("native OMP adapter", () => {
  it.effect("owns background work until session settlement and ignores unrelated terminals", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* setup();
        yield* fixture.runtime.startTurn(fixture.turnInput);
        const started = yield* fixture.take((event) => event.type === "provider_turn.updated");
        assert.equal(started.type, "provider_turn.updated");
        yield* fixture.emit({
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Parent response" },
        });
        yield* fixture.emit({
          type: "tool_execution_start",
          toolCallId: "stream-marker",
          toolName: "read",
          args: {},
        });
        yield* fixture.take(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "read",
        );
        yield* TestClock.adjust("50 millis");
        const streaming = fixture.observed.findLast((event) => event.type === "message.updated");
        assert.equal(streaming?.type, "message.updated");
        if (streaming?.type === "message.updated") {
          assert.equal(streaming.message.text, "Parent response");
          assert.isTrue(streaming.message.streaming);
        }
        yield* fixture.emit({
          type: "tool_execution_end",
          toolCallId: "stream-marker",
          toolName: "read",
          result: { content: [] },
        });
        yield* fixture.emit({
          type: "message_update",
          messageId: "m1",
          assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Parent response" },
        });
        yield* fixture.emit({
          type: "tool_execution_start",
          toolCallId: "task-1",
          toolName: "task",
          args: {
            tasks: [
              { name: "other-child", task: "A different assignment" },
              { name: "child-1", task: "Check behavior" },
            ],
          },
        });
        yield* fixture.emit({
          type: "tool_execution_end",
          toolCallId: "task-1",
          toolName: "task",
          result: {
            content: [{ type: "text", text: "Background job started" }],
            details: { async: { state: "running", jobId: "child-1", type: "task" } },
          },
        });
        const dispatched = yield* fixture.take(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "task" &&
            event.turnItem.output !== undefined,
        );
        if (dispatched.type !== "turn_item.updated") return assert.fail("Missing dispatched task");
        assert.equal(dispatched.turnItem.status, "running");
        assert.isNull(dispatched.turnItem.completedAt);
        yield* fixture.emit({
          type: "prompt_result",
          id: fixture.promptId(),
          status: "completed",
          sessionSettled: false,
        });
        yield* fixture.take(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "waiting",
        );
        fixture.responses.set("get_subagent_messages", {
          sessionFile: "/isolated/child-1.jsonl",
          nextByte: 100,
          entries: [
            {
              id: "child-user",
              type: "message",
              message: { role: "user", content: "Check behavior", timestamp: 0 },
            },
          ],
        });
        yield* fixture.emit({
          type: "subagent_lifecycle",
          payload: {
            id: "child-1",
            agent: "task",
            index: 1,
            status: "started",
            parentToolCallId: "task-1",
            sessionFile: "/isolated/child-1.jsonl",
          },
        });
        const childStarted = yield* fixture.take((event) => event.type === "subagent.updated");
        if (childStarted.type !== "subagent.updated") return assert.fail("Missing started child");
        assert.equal(childStarted.subagent.title, "child-1");
        assert.equal(childStarted.subagent.prompt, "Check behavior");
        yield* fixture.emit({
          type: "subagent_progress",
          payload: {
            agent: "worker",
            task: "Check behavior",
            index: 1,
            progress: {
              id: "child-1",
              status: "running",
              recentOutput: ["Working"],
              resolvedModel: "test/model",
            },
          },
        });
        yield* fixture.emit({
          type: "prompt_result",
          id: "stale-prompt",
          status: "completed",
          sessionSettled: true,
        });
        yield* fixture.emit({ type: "agent_end" });
        yield* fixture.take(
          (event) =>
            event.type === "subagent.updated" && event.subagent.prompt === "Check behavior",
        );
        assert.equal(fixture.observed.filter((event) => event.type === "turn.terminal").length, 0);
        assert.isTrue(yield* fixture.runtime.hasPendingBackgroundWork!);
        const child = fixture.observed.findLast((event) => event.type === "subagent.updated");
        assert.equal(child?.type, "subagent.updated");
        if (child?.type === "subagent.updated") {
          assert.equal(child.subagent.prompt, "Check behavior");
          assert.equal(child.subagent.nativeTaskRef?.nativeId, "child-1");
          assert.isNotNull(child.subagent.childThreadId);
          assert.notEqual(child.subagent.providerThreadId, fixture.providerThread.id);
          assert.isTrue(
            fixture.observed.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.threadId === child.subagent.childThreadId &&
                event.message.text === "Check behavior",
            ),
          );
        }
        yield* fixture.runtime.stopSubagent!({
          providerThread: fixture.providerThread,
          nativeTaskId: "child-1",
        });
        assert.deepEqual(
          fixture.sent.find((command) => command.type === "cancel_subagent"),
          { type: "cancel_subagent", subagentId: "child-1" },
        );
        yield* fixture.emit({
          type: "subagent_lifecycle",
          payload: { id: "child-1", agent: "worker", index: 0, status: "aborted" },
        });
        const cancelled = yield* fixture.take(
          (event) => event.type === "subagent.updated" && event.subagent.status === "cancelled",
        );
        if (cancelled.type !== "subagent.updated" || cancelled.subagent.startedAt === null)
          return assert.fail("Missing cancelled child");
        assert.equal(cancelled.subagent.result, "Working");
        yield* TestClock.adjust("1 second");
        yield* fixture.emit({
          type: "subagent_lifecycle",
          payload: { id: "child-1", agent: "worker", index: 0, status: "started" },
        });
        yield* fixture.take(
          (event) => event.type === "subagent.updated" && event.subagent.status === "running",
        );
        const staleStop = yield* fixture.runtime.stopSubagent!({
          providerThread: fixture.providerThread,
          nativeTaskId: "child-1",
          requestedAt: cancelled.subagent.startedAt,
        }).pipe(Effect.flip);
        assert.equal(staleStop._tag, "ProviderAdapterProtocolError");
        assert.equal(
          fixture.sent.filter((command) => command.type === "cancel_subagent").length,
          1,
        );
        yield* fixture.emit({
          type: "subagent_lifecycle",
          payload: { id: "child-1", agent: "worker", index: 0, status: "completed" },
        });
        const completed = yield* fixture.take(
          (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
        );
        if (completed.type === "subagent.updated") assert.isNull(completed.subagent.result);
        yield* fixture.emit({ type: "agent_start" });
        yield* fixture.emit({
          type: "message_update",
          messageId: "m2",
          assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Child delivery" },
        });
        yield* fixture.emit({
          type: "tool_execution_update",
          toolCallId: "task-1",
          toolName: "task",
          partialResult: {
            content: [{ type: "text", text: "Background job finished" }],
            details: { async: { state: "completed", jobId: "child-1", type: "task" } },
          },
        });
        yield* fixture.emit({
          type: "tool_execution_update",
          toolCallId: "task-1",
          toolName: "task",
          partialResult: {
            content: [{ type: "text", text: "Stale progress" }],
            details: { async: { state: "running", jobId: "child-1", type: "task" } },
          },
        });
        yield* fixture.emit({ type: "session_settled" });
        const terminal = yield* fixture.take((event) => event.type === "turn.terminal");
        if (terminal.type === "turn.terminal") assert.equal(terminal.status, "completed");
        assert.isFalse(yield* fixture.runtime.hasPendingBackgroundWork!);
        assert.equal(fixture.observed.filter((event) => event.type === "turn.terminal").length, 1);
        const task = fixture.observed.findLast(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        );
        if (task?.type !== "turn_item.updated" || task.turnItem.type !== "dynamic_tool")
          return assert.fail("Missing completed task");
        assert.equal(task.turnItem.status, "completed");
        assert.isNotNull(task.turnItem.completedAt);
        assert.deepEqual(task.turnItem.output, {
          content: [{ type: "text", text: "Background job finished" }],
          details: { async: { state: "completed", jobId: "child-1", type: "task" } },
        });
        assert.isFalse(fixture.terminated());
        const message = fixture.observed.findLast((event) => event.type === "message.updated");
        if (message?.type === "message.updated") {
          assert.equal(message.message.text, "Child delivery");
          assert.isFalse(message.message.streaming);
        }
      }),
    ),
  );

  it.effect("projects OMP tools, phased todos, final messages, and context usage", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* setup();
        yield* fixture.runtime.startTurn(fixture.turnInput);
        yield* fixture.emit({
          type: "notice",
          level: "info",
          source: "xdev",
          message: "xd://: unmounted mcp__t3_code__preview_open",
        });
        yield* fixture.emit({
          type: "notice",
          level: "warning",
          source: "xdev",
          message: "A tool could not be loaded",
        });
        yield* fixture.emit({
          type: "message_update",
          messageId: "authoritative",
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: 0,
            content: "Inline edit payload",
          },
        });
        yield* fixture.emit({
          type: "message_end",
          messageId: "authoritative",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Applied the edit." }],
            usage: { input: 100, output: 20, cacheRead: 80, totalTokens: 200 },
          },
        });
        yield* fixture.emit({
          type: "tool_execution_start",
          toolCallId: "shell",
          toolName: "bash",
          args: { command: "printf hello" },
        });
        yield* fixture.emit({
          type: "tool_execution_end",
          toolCallId: "shell",
          toolName: "bash",
          result: { content: [{ type: "text", text: "hello" }], details: { exitCode: 0 } },
        });
        yield* fixture.emit({
          type: "tool_execution_start",
          toolCallId: "edit",
          toolName: "edit",
          args: { path: "src/main.ts", edits: [{ op: "replace", pos: "1#abc", lines: "new" }] },
        });
        yield* fixture.emit({
          type: "tool_execution_end",
          toolCallId: "edit",
          toolName: "edit",
          result: { content: [{ type: "text", text: "Edited" }], details: { diff: "-old\n+new" } },
        });
        yield* fixture.emit({
          type: "tool_execution_start",
          toolCallId: "todos",
          toolName: "todo",
          args: { op: "init" },
        });
        yield* fixture.emit({
          type: "tool_execution_end",
          toolCallId: "todos",
          toolName: "todo",
          result: {
            content: [],
            details: {
              op: "init",
              phases: [
                {
                  name: "Implement",
                  tasks: [
                    { content: "Write code", status: "completed" },
                    { content: "Verify", status: "in_progress" },
                    { content: "Ship", status: "blocked", blocker: "Review" },
                  ],
                },
              ],
            },
          },
        });
        yield* fixture.emit({
          type: "prompt_result",
          id: fixture.promptId(),
          status: "completed",
          sessionSettled: true,
        });
        yield* fixture.take((event) => event.type === "turn.terminal");
        const finalMessage = fixture.observed.findLast((event) => event.type === "message.updated");
        assert.equal(
          finalMessage?.type === "message.updated" && finalMessage.message.text,
          "Applied the edit.",
        );
        const tools = fixture.observed
          .filter((event) => event.type === "turn_item.updated")
          .map((event) => event.turnItem);
        assert.deepEqual(
          tools.filter((item) => item.type === "system_notice").map((item) => item.message),
          ["A tool could not be loaded"],
        );
        const shell = tools.findLast((item) => item.type === "command_execution");
        assert.equal(shell?.type, "command_execution");
        if (shell?.type === "command_execution") {
          assert.equal(shell.input, "printf hello");
          assert.equal(shell.output, "hello");
          assert.equal(shell.exitCode, 0);
        }
        const edit = tools.findLast((item) => item.type === "file_change");
        assert.equal(edit?.type, "file_change");
        if (edit?.type === "file_change") {
          assert.equal(edit.fileName, "src/main.ts");
          assert.equal(edit.diffStr, "-old\n+new");
        }
        const todos = tools.findLast((item) => item.type === "todo_list");
        assert.equal(todos?.type, "todo_list");
        if (todos?.type === "todo_list") {
          assert.deepEqual(
            todos.steps.map((step) => step.status),
            ["completed", "running", "pending"],
          );
          assert.include(todos.steps[2]!.text, "Blocked: Review");
        }
        const completed = fixture.observed.findLast(
          (event) => event.type === "provider_turn.updated",
        );
        assert.equal(
          completed?.type === "provider_turn.updated" &&
            completed.providerTurn.tokenUsage?.usedTokens,
          200,
        );
        assert.include(fixture.spawnArgs(), "rpc-ui");
      }),
    ),
  );

  it.effect.each([false, true])(
    "steers and retires background work even when abort fails: %s",
    (rejectAbort) =>
      run(
        Effect.gen(function* () {
          const fixture = yield* setup();
          yield* fixture.runtime.startTurn(fixture.turnInput);
          const started = yield* fixture.take((event) => event.type === "provider_turn.updated");
          if (started.type !== "provider_turn.updated") return assert.fail("Missing provider turn");
          yield* fixture.runtime.steerTurn({
            threadId,
            runId: fixture.turnInput.runId,
            providerThread: fixture.providerThread,
            providerTurnId: started.providerTurn.id,
            message: { ...fixture.turnInput.message, text: "Change direction" },
          });
          assert.deepEqual(
            fixture.sent.find((command) => command.type === "steer"),
            { type: "steer", message: "Change direction" },
          );
          const denied = yield* fixture.runtime
            .steerTurn({
              threadId,
              runId: fixture.turnInput.runId,
              providerThread: fixture.providerThread,
              providerTurnId: started.providerTurn.id,
              message: { ...fixture.turnInput.message, text: "/new" },
            })
            .pipe(Effect.flip);
          assert.equal(denied._tag, "ProviderAdapterProtocolError");
          assert.lengthOf(
            fixture.sent.filter((command) => command.type === "steer"),
            1,
          );

          yield* fixture.emit({
            type: "prompt_result",
            id: fixture.promptId(),
            status: "completed",
            sessionSettled: false,
          });
          yield* fixture.take(
            (event) =>
              event.type === "provider_session.updated" &&
              event.providerSession.status === "waiting",
          );
          fixture.responses.set("get_subagent_messages", {
            sessionFile: "/isolated/running-child.jsonl",
            nextByte: 100,
            entries: [
              {
                id: "child-tool",
                type: "message",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      id: "pending-tool",
                      name: "read",
                      arguments: { path: "README.md" },
                    },
                  ],
                },
              },
            ],
          });
          yield* fixture.emit({
            type: "subagent_lifecycle",
            payload: {
              id: "running-child",
              status: "started",
              agent: "worker",
              sessionFile: "/isolated/running-child.jsonl",
            },
          });
          const runningChild = yield* fixture.take((event) => event.type === "subagent.updated");
          if (runningChild.type !== "subagent.updated") return assert.fail("Missing running child");
          if (rejectAbort) fixture.rejectAbort();
          yield* fixture.emit({
            type: "goal_updated",
            goal: { objective: "Finish the interrupted goal", status: "active", tokensUsed: 42 },
          });
          yield* fixture.take(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.status === "active",
          );
          yield* fixture.emit({
            type: "tool_execution_start",
            toolCallId: "pending-parent-tool",
            toolName: "bash",
            args: { command: "long-running-command" },
          });
          yield* fixture.take(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          );
          yield* fixture.runtime.interruptTurn({
            providerThread: fixture.providerThread,
            providerTurnId: started.providerTurn.id,
          });
          assert.isTrue(Exit.isSuccess(yield* Deferred.await(fixture.streamEnded)));
          const terminal = yield* fixture.take((event) => event.type === "turn.terminal");
          if (terminal.type === "turn.terminal") assert.equal(terminal.status, "interrupted");
          assert.equal(fixture.sent.filter((command) => command.type === "prompt").length, 1);
          assert.isTrue(fixture.terminated());
          assert.equal(fixture.runtime.providerSession.status, "stopped");
          const stoppedThread = fixture.observed.findLast(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.id === fixture.providerThread.id,
          );
          assert.equal(
            stoppedThread?.type === "provider_thread.updated" &&
              stoppedThread.providerThread.goal?.status,
            "paused",
          );
          assert.lengthOf(
            fixture.observed.filter((event) => event.type === "turn.terminal"),
            1,
          );
          assert.isTrue(fixture.sent.some((command) => command.type === "abort_and_restore_queue"));
          if (terminal.type === "turn.terminal") assert.equal(terminal.threadDisposition, "broken");
          const finalChild = fixture.observed.findLast(
            (event) => event.type === "subagent.updated",
          );
          assert.equal(finalChild?.subagent.status, "interrupted");
          const childNodes = fixture.observed.filter(
            (event) =>
              event.type === "node.updated" &&
              event.node.threadId === runningChild.subagent.childThreadId,
          );
          const childNode = childNodes.at(-1);
          assert.equal(childNode?.type === "node.updated" && childNode.node.status, "interrupted");
          const childTool = fixture.observed.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.threadId === runningChild.subagent.childThreadId,
          );
          assert.equal(
            childTool?.type === "turn_item.updated" && childTool.turnItem.status,
            "interrupted",
          );
          const parentTool = fixture.observed.findLast(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          );
          assert.equal(
            parentTool?.type === "turn_item.updated" && parentTool.turnItem.status,
            "interrupted",
          );
        }),
      ),
  );

  it.effect.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
    "maps native approvals and typed dialogs in %s",
    (mode) =>
      run(
        Effect.gen(function* () {
          const fixture = yield* setup(mode);
          assert.include(
            fixture.spawnArgs(),
            mode === "full-access" ? "yolo" : mode === "auto-accept-edits" ? "write" : "always-ask",
          );
          yield* fixture.runtime.startTurn(fixture.turnInput);
          yield* fixture.emit({
            type: "extension_ui_request",
            id: "permission-1",
            method: "select",
            title: "Allow tool: write\nPath: /isolated/result.txt",
            options: ["Approve", "Approve write for this session", "Deny"],
          });
          const permission = yield* fixture.take(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
          );
          if (
            permission.type !== "turn_item.updated" ||
            permission.turnItem.type !== "approval_request"
          )
            return assert.fail("Missing approval");
          assert.equal(permission.turnItem.requestKind, "file-change");
          assert.deepEqual(
            permission.turnItem.options?.map((option) => option.decision),
            ["decline", "acceptForSession", "accept"],
          );
          yield* fixture.runtime.respondToRuntimeRequest({
            requestId: permission.turnItem.requestId,
            decision: "decline",
          });
          assert.deepEqual(
            fixture.sent.find((command) => command.id === "permission-1"),
            { type: "extension_ui_response", id: "permission-1", value: "Deny" },
          );
          yield* fixture.emit({
            type: "extension_ui_request",
            id: "confirm-1",
            method: "confirm",
            title: "Continue?",
            message: "Confirm selection",
          });
          const confirmation = yield* fixture.take(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "user_input_request" &&
              event.turnItem.status === "waiting",
          );
          if (
            confirmation.type !== "turn_item.updated" ||
            confirmation.turnItem.type !== "user_input_request"
          )
            return assert.fail("Missing confirmation");
          assert.isFalse(confirmation.turnItem.questions[0]?.allowCustomAnswer);
          yield* fixture.runtime.respondToRuntimeRequest({
            requestId: confirmation.turnItem.requestId,
            answers: { "confirm-1": "Yes" },
          });
          assert.deepEqual(
            fixture.sent.find((command) => command.id === "confirm-1"),
            { type: "extension_ui_response", id: "confirm-1", confirmed: true },
          );
          for (const method of ["select", "editor"] as const) {
            yield* fixture.emit({
              type: "extension_ui_request",
              id: method,
              method,
              title: "Extension choice",
              options: ["First"],
              prefill: "Existing text",
            });
            const prompt = yield* fixture.take(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "user_input_request" &&
                event.turnItem.questions[0]?.id === method,
            );
            if (
              prompt.type !== "turn_item.updated" ||
              prompt.turnItem.type !== "user_input_request"
            )
              return assert.fail("Missing extension question");
            assert.equal(prompt.turnItem.questions[0]?.allowCustomAnswer, method === "editor");
            if (method === "editor")
              assert.equal(prompt.turnItem.questions[0]?.initialAnswer, "Existing text");
            yield* fixture.runtime.respondToRuntimeRequest({
              requestId: prompt.turnItem.requestId,
              answers: { [method]: method === "editor" ? "Edited text" : "First" },
            });
          }
          yield* fixture.emit({
            type: "extension_ui_request",
            id: "ask-1",
            method: "ask",
            questions: [
              {
                id: "choices",
                question: "Pick features",
                multi: true,
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          });
          const ask = yield* fixture.take(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "user_input_request" &&
              event.turnItem.questions[0]?.id === "choices",
          );
          if (ask.type !== "turn_item.updated" || ask.turnItem.type !== "user_input_request")
            return assert.fail("Missing ask");
          assert.isTrue(ask.turnItem.questions[0]?.multiSelect);
          yield* fixture.runtime.respondToRuntimeRequest({
            requestId: ask.turnItem.requestId,
            answers: { choices: ["A", "B"] },
          });
          assert.deepEqual(
            fixture.sent.find((command) => command.id === "ask-1"),
            {
              type: "extension_ui_response",
              id: "ask-1",
              answers: [{ id: "choices", selectedOptions: ["A", "B"] }],
            },
          );
        }),
      ),
  );

  it.effect("resumes the persisted native file and compacts without submitting a prompt", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* setup("full-access", {
          path: "/isolated/prior.jsonl",
          goal: { objective: "Recover interrupted work", status: "active" },
        });
        assert.include(fixture.spawnArgs(), "--session");
        assert.equal(fixture.providerThread.goal?.status, "paused");
        yield* fixture.runtime.ensureThread({
          threadId,
          runtimePolicy: policy(),
          modelSelection: {
            ...modelSelection,
            model: "configured/alternative",
            options: [
              { id: "thinking", value: "low" },
              { id: "fastMode", value: true },
            ],
          },
        });
        const resumed = yield* fixture.runtime.resumeThread({
          providerThread: {
            ...fixture.providerThread,
            nativeThreadRef: {
              driver: OMP_PROVIDER,
              nativeId: "/isolated/prior.jsonl",
              strength: "strong",
            },
          },
        });
        assert.equal(resumed.nativeThreadRef?.nativeId, "/isolated/prior.jsonl");
        assert.isFalse(fixture.sent.some((command) => command.type === "switch_session"));
        assert.isFalse(fixture.sent.some((command) => command.type === "new_session"));
        const rejected = yield* fixture.runtime
          .resumeThread({
            providerThread: {
              ...resumed,
              nativeThreadRef: {
                driver: OMP_PROVIDER,
                nativeId: "/isolated/unowned.jsonl",
                strength: "strong",
              },
            },
          })
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "ProviderAdapterProtocolError");
        assert.isFalse(fixture.sent.some((command) => command.type === "switch_session"));
        assert.deepEqual(
          fixture.sent
            .filter((command) => command.type === "set_model")
            .map((command) => command.modelId),
          ["alternative", "native"],
        );
        assert.deepEqual(
          fixture.sent
            .filter((command) => command.type === "set_thinking_level")
            .map((command) => command.level),
          ["low", "inherit"],
        );
        assert.deepEqual(
          fixture.sent
            .filter((command) => command.type === "set_fast_mode")
            .map((command) => command.enabled),
          [true, false],
        );
        yield* fixture.runtime.compactThread!({ ...fixture.turnInput, providerThread: resumed });
        yield* fixture.emit({
          type: "response",
          command: "compact",
          id: fixture.promptId(),
          success: true,
        });
        const terminal = yield* fixture.take((event) => event.type === "turn.terminal");
        if (terminal.type === "turn.terminal") assert.equal(terminal.status, "completed");
        assert.equal(fixture.sent.filter((command) => command.type === "prompt").length, 0);
      }),
    ),
  );

  it.effect(
    "completes local commands without prompt_result and reads only active-branch history",
    () =>
      run(
        Effect.gen(function* () {
          const fixture = yield* setup();
          yield* fixture.runtime.startTurn({
            ...fixture.turnInput,
            message: { ...fixture.turnInput.message, text: "/model" },
            appContext: [
              { key: "instructions", text: "Application context must not break slash dispatch" },
            ],
          });
          assert.equal(
            fixture.sent.find((command) => command.type === "prompt")?.message,
            "/model",
          );
          yield* fixture.emit({
            type: "command_output",
            command: "model",
            text: "Current model: probe/probe",
          });
          yield* fixture.emit({
            type: "response",
            id: fixture.promptId(),
            command: "prompt",
            success: true,
            data: { agentInvoked: false },
          });
          const terminal = yield* fixture.take((event) => event.type === "turn.terminal");
          assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
          assert.isTrue(
            fixture.observed.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "system_notice" &&
                event.turnItem.message === "Current model: probe/probe",
            ),
          );
          fixture.responses.set("get_messages", {
            messages: [
              { role: "user", content: "Current branch" },
              { role: "assistant", content: [{ type: "text", text: "Preserved reply" }] },
              { role: "toolResult", content: [{ type: "text", text: "Internal result" }] },
            ],
          });
          const snapshot = yield* fixture.runtime.readThreadSnapshot({
            providerThread: fixture.providerThread,
          });
          assert.deepEqual(
            snapshot.messages.map((message) => message.text),
            ["Current branch", "Preserved reply"],
          );
          const rejected = yield* fixture.runtime
            .startTurn({
              ...fixture.turnInput,
              message: { ...fixture.turnInput.message, text: "/new" },
            })
            .pipe(Effect.flip);
          assert.equal(rejected._tag, "ProviderAdapterProtocolError");
          fixture.responses.set("get_state", { isSettled: false, hasPendingAsyncWork: true });
          yield* fixture.runtime.startTurn({
            ...fixture.turnInput,
            attemptId: RunAttemptId.make("local-pending"),
            message: { ...fixture.turnInput.message, text: "/model" },
          });
          yield* fixture.emit({
            type: "response",
            id: fixture.promptId(),
            command: "prompt",
            success: true,
            data: { agentInvoked: false },
          });
          yield* fixture.take((event) => event.type === "background_work.updated" && event.pending);
          assert.equal(
            fixture.observed.filter((event) => event.type === "turn.terminal").length,
            1,
          );
          yield* fixture.emit({ type: "session_settled" });
          yield* fixture.take((event) => event.type === "turn.terminal");
        }),
      ),
  );

  it.effect(
    "rolls back and forks native history at durable turn boundaries without touching the source",
    () =>
      run(
        Effect.gen(function* () {
          const fixture = yield* setup();
          yield* fixture.runtime.startTurn(fixture.turnInput);
          yield* fixture.emit({
            type: "prompt_result",
            id: fixture.promptId(),
            status: "completed",
            sessionSettled: true,
          });
          yield* fixture.take((event) => event.type === "turn.terminal");
          fixture.responses.set("get_entries", {
            entries: [
              { id: "u1", parentId: null, type: "message" },
              { id: "a1", parentId: "u1", type: "message" },
            ],
            leafId: "a1",
          });
          yield* fixture.runtime.startTurn({
            ...fixture.turnInput,
            attemptId: RunAttemptId.make("second"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
          });
          const whileBusy = yield* fixture.runtime
            .forkThread({
              sourceProviderThread: fixture.providerThread,
              targetThreadId: ThreadId.make("target"),
            })
            .pipe(Effect.flip);
          assert.equal(whileBusy._tag, "ProviderAdapterProtocolError");
          yield* fixture.emit({
            type: "prompt_result",
            id: fixture.promptId(),
            status: "completed",
            sessionSettled: true,
          });
          yield* fixture.take((event) => event.type === "turn.terminal");
          const turns = fixture.observed.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed"
              ? [event.providerTurn]
              : [],
          );
          assert.equal(turns[0]!.nativeTurnRef?.nativeId, "before-message:");
          assert.equal(turns[1]!.nativeTurnRef?.nativeId, "before-message:a1");
          const completedSource = yield* fixture.runtime.resumeThread({
            providerThread: {
              ...fixture.providerThread,
              goal: {
                objective: "Completed in the second turn",
                status: "complete",
                tokenBudget: null,
              },
            },
          });
          assert.equal(completedSource.goal?.status, "complete");
          const rolledBack = yield* fixture.runtime.rollbackThread({
            providerThread: completedSource,
            providerThreadTurns: turns,
            target: {
              type: "provider_turn",
              checkpointId: CheckpointId.make("checkpoint"),
              appRunOrdinal: 1,
              providerTurn: turns[0]!,
            },
          });
          assert.equal(rolledBack.providerThread.id, fixture.providerThread.id);
          assert.isNull(rolledBack.providerThread.goal);
          assert.equal(
            rolledBack.providerThread.nativeThreadRef?.nativeId,
            "/isolated/fork-1.jsonl",
          );
          assert.deepEqual(fixture.forkRequests[0], { type: "fork", entryId: "a1" });
          assert.include(fixture.forkSpawns[0]!.args, "/isolated/session.jsonl");
          const fork = yield* fixture.runtime.forkThread({
            sourceProviderThread: rolledBack.providerThread,
            sourceProviderTurns: [],
            targetThreadId: ThreadId.make("target"),
          });
          assert.equal(fork.appThreadId, "target");
          assert.equal(fork.nativeThreadRef?.nativeId, "/isolated/fork-2.jsonl");
          assert.notEqual(fork.id, rolledBack.providerThread.id);
          assert.equal(fork.forkedFrom?.providerThreadId, rolledBack.providerThread.id);
          const historicalFork = yield* fixture.runtime.forkThread({
            sourceProviderThread: completedSource,
            sourceProviderTurns: turns,
            providerTurnId: turns[0]!.id,
            targetThreadId: ThreadId.make("earlier-target"),
          });
          assert.isNull(historicalFork.goal);
          const latestFork = yield* fixture.runtime.forkThread({
            sourceProviderThread: completedSource,
            targetThreadId: ThreadId.make("latest-target"),
          });
          assert.equal(latestFork.goal?.status, "complete");
          assert.equal(fixture.sent.filter((command) => command.type === "fork").length, 0);
          const rebound = {
            ...latestFork,
            id: ProviderThreadId.make("orchestrator-fork"),
          };
          const forkTurn = {
            ...fixture.turnInput,
            threadId: ThreadId.make("latest-target"),
            appThread: { ...fixture.turnInput.appThread, id: ThreadId.make("latest-target") },
            attemptId: RunAttemptId.make("fork-turn"),
            providerThread: rebound,
            message: { ...fixture.turnInput.message, text: "/model" },
          };
          for (const providerThread of [
            { ...rebound, nativeThreadRef: completedSource.nativeThreadRef },
            { ...rebound, appThreadId: ThreadId.make("another-thread") },
            { ...rebound, providerSessionId: ProviderSessionId.make("another-session") },
          ]) {
            const rejected = yield* fixture.runtime
              .startTurn({ ...forkTurn, providerThread })
              .pipe(Effect.flip);
            assert.equal(rejected._tag, "ProviderAdapterProtocolError");
          }
          yield* fixture.runtime.startTurn(forkTurn);
          yield* fixture.emit({
            type: "response",
            command: "prompt",
            id: fixture.promptId(),
            success: true,
            data: { agentInvoked: false },
          });
          yield* fixture.take((event) => event.type === "turn.terminal");
          const adopted = fixture.observed.findLast(
            (event) => event.type === "provider_thread.updated",
          );
          assert.equal(
            adopted?.type === "provider_thread.updated" && adopted.providerThread.id,
            rebound.id,
          );
          const snapshot = yield* fixture.runtime.rollbackThread({
            providerThread: rebound,
            providerThreadTurns: [],
            target: {
              type: "thread_start",
              checkpointId: CheckpointId.make("fork-checkpoint"),
              appRunOrdinal: 0,
            },
          });
          assert.equal(snapshot.providerThread.id, rebound.id);
        }),
      ),
  );

  it.effect("turns transport failure into a failed run instead of leaving it running", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* setup();
        yield* fixture.runtime.startTurn(fixture.turnInput);
        yield* Queue.fail(fixture.nativeEvents, new OmpRpcError({ operation: "read" }));
        const terminal = yield* fixture.take((event) => event.type === "turn.terminal");
        if (terminal.type === "turn.terminal") {
          assert.equal(terminal.status, "failed");
          assert.equal(terminal.threadDisposition, "broken");
        }
      }),
    ),
  );

  it.effect("rejects permissions above the environment ceiling", () =>
    run(
      Effect.gen(function* () {
        for (const mode of ["auto-accept-edits", "auto", "full-access"] as const) {
          const adapter = yield* makeOmpAdapterV2({
            instanceId,
            settings,
            environment: {},
            makeConnection: () => Effect.die("Must reject before spawning"),
          });
          const result = yield* adapter
            .openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("blocked"),
              modelSelection,
              runtimePolicy: { ...policy(mode), maxRuntimeMode: "approval-required" },
            })
            .pipe(Effect.flip);
          assert.equal(result._tag, "ProviderAdapterProtocolError");
        }
      }),
    ),
  );

  it.effect("runs native goals through session settlement and exposes goal accounting", () =>
    run(
      Effect.gen(function* () {
        const fixture = yield* setup();
        fixture.holdGoalCreate();
        const starting = yield* fixture.runtime
          .startTurn({
            ...fixture.turnInput,
            message: { ...fixture.turnInput.message, text: "/goal ship the native integration" },
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(fixture.goalCreateEntered);
        assert.isTrue(
          fixture.sent.some(
            (command) =>
              command.type === "goal" &&
              command.op === "create" &&
              command.objective === "ship the native integration",
          ),
        );
        assert.isFalse(fixture.sent.some((command) => command.type === "prompt"));
        assert.isFalse(fixture.observed.some((event) => event.type === "turn.terminal"));
        yield* fixture.emit({
          type: "goal_updated",
          goal: {
            objective: "ship the native integration",
            status: "complete",
            tokensUsed: 230,
            timeUsedSeconds: 75.3,
          },
        });
        yield* fixture.take(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.goal?.status === "complete",
        );
        yield* Deferred.succeed(fixture.goalCreateReply, {
          goal: {
            objective: "ship the native integration",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
          },
        });
        yield* Fiber.join(starting);
        yield* fixture.emit({
          type: "message_end",
          messageId: "failed-attempt",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "Transient failure",
            content: [],
          },
        });
        yield* fixture.emit({
          type: "agent_end",
          messages: [
            { role: "assistant", stopReason: "error", errorMessage: "Transient failure" },
            {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Recovered" }],
            },
          ],
        });
        yield* fixture.emit({ type: "session_settled" });
        const terminal = yield* fixture.take((event) => event.type === "turn.terminal");
        assert.equal(terminal.type === "turn.terminal" && terminal.status, "completed");
        const goalUpdate = fixture.observed.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        assert.deepEqual(
          goalUpdate?.type === "provider_thread.updated" && goalUpdate.providerThread.goal,
          {
            objective: "ship the native integration",
            status: "complete",
            tokensUsed: 230,
            timeUsedSeconds: 75,
            tokenBudget: null,
          },
        );
        fixture.responses.set("goal", { goal: null });
        yield* fixture.runtime.startTurn({
          ...fixture.turnInput,
          attemptId: RunAttemptId.make("goal-show"),
          message: { ...fixture.turnInput.message, text: "/goal" },
        });
        yield* fixture.take((event) => event.type === "turn.terminal");
        const shown = fixture.observed.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        assert.equal(
          shown?.type === "provider_thread.updated" && shown.providerThread.goal?.status,
          "complete",
        );
        fixture.responses.delete("goal");
        yield* fixture.runtime.startTurn({
          ...fixture.turnInput,
          attemptId: RunAttemptId.make("goal-clear"),
          message: { ...fixture.turnInput.message, text: "/goal clear" },
        });
        yield* fixture.take((event) => event.type === "turn.terminal");
        assert.isTrue(
          fixture.sent.some((command) => command.type === "goal" && command.op === "drop"),
        );
        const cleared = fixture.observed.findLast(
          (event) => event.type === "provider_thread.updated",
        );
        assert.isNull(cleared?.type === "provider_thread.updated" && cleared.providerThread.goal);
      }),
    ),
  );
});
