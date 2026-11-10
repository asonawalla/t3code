import {
  ProviderDriverKind,
  isRuntimeModeAbove,
  parseGoalCommand,
  type OrchestrationV2PlanStep,
  type PlanId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { makeOmpSubagentProjection } from "./subagents.ts";
import { makeOmpModelSelection } from "./modelSelection.ts";
import { makeOmpHostTools } from "./hostTools.ts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "@t3tools/provider-core/server/adapterDriver";
import { OmpSettings } from "../settings.ts";
import { OMP_SESSION_COMMANDS } from "./commands.ts";
import { makeOmpRpcConnection, type OmpRpcConnection } from "./rpc.ts";
import { ompApprovalChoice, ompApprovalMode, ompApprovalPresentation } from "./approvals.ts";
import { ompGoal } from "./goals.ts";
import { makeOmpTurnHistory, ompForkBoundary, forkOmpSession } from "./history.ts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");
const decodeSettings = Schema.decodeSync(OmpSettings);

const capabilities = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: true,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const entries = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const contentText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : entries(value)
        .map((item) => text(record(item).text) ?? "")
        .join("\n");
const nonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const ref = (nativeId: string) => ({ driver: OMP_PROVIDER, nativeId, strength: "strong" as const });
const protocolError = (detail: string, cause?: unknown) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: OMP_PROVIDER,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

interface TextItem {
  readonly id: string;
  readonly kind: "assistant_message" | "reasoning";
  readonly startedAt: DateTime.Utc;
  text: string;
  completed: boolean;
  scheduled: boolean;
}
interface Turn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  entity: OrchestrationV2ProviderTurn;
  planId: PlanId | null;
  compaction: { id: string; startedAt: DateTime.Utc } | null;
  readonly texts: Map<string, TextItem>;
  readonly tools: Map<
    string,
    {
      name: string;
      args: unknown;
      startedAt: DateTime.Utc;
      completed: boolean;
      item: OrchestrationV2TurnItem | null;
    }
  >;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  result: RecordValue | null;
  interrupted: boolean;
  retire: boolean;
}
interface PendingQuestion {
  readonly nativeId: string;
  readonly method: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
  readonly approvalOptions: ReadonlyArray<string> | null;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly item: OrchestrationV2TurnItem;
}

export interface OmpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly makeConnection?: typeof makeOmpRpcConnection;
}

export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (
  options: OmpAdapterV2Options,
) {
  const host = yield* ProviderHost.ProviderHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const agentScope = yield* AgentScope;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OMP_PROVIDER,
    getCapabilities: Effect.fn("OmpAdapter.getCapabilities")(() => Effect.succeed(capabilities)),
    planSelectionTransition: Effect.fn("OmpAdapter.planSelectionTransition")(() =>
      Effect.succeed(turnScopedSelectionTransition()),
    ),
    openSession: Effect.fn("OmpAdapter.openSession")(function* (input) {
      if (isRuntimeModeAbove(input.runtimePolicy.runtimeMode, input.runtimePolicy.maxRuntimeMode))
        return yield* protocolError("OMP permissions exceed the environment permission ceiling");
      if (input.runtimePolicy.interactionMode !== "default")
        return yield* protocolError(
          "OMP does not expose its interactive plan mode over native RPC",
        );
      const scope = yield* Effect.scope;
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const sessionDir = `${host.paths.stateDir}/omp-sessions`;
      yield* fileSystem
        .makeDirectory(sessionDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) => protocolError("Cannot create OMP session directory", cause)),
        );
      const configDir = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-omp-rpc-" })
        .pipe(
          Effect.mapError((cause) => protocolError("Cannot create OMP launch settings", cause)),
        );
      const rpcConfig = `${configDir}/config.yml`;
      yield* fileSystem
        .writeFileString(rpcConfig, "goal:\n  continuationModes: [rpc]\n")
        .pipe(
          Effect.mapError((cause) =>
            protocolError("Cannot configure OMP goal continuation", cause),
          ),
        );
      const launch = yield* agentScope.wrap({
        command: options.settings.binaryPath || "omp",
        args: [
          "--mode",
          "rpc-ui",
          "--session-dir",
          sessionDir,
          "--config",
          rpcConfig,
          "--approval-mode",
          ompApprovalMode(input.runtimePolicy.runtimeMode),
          ...(input.initialNativeThreadId === undefined
            ? []
            : ["--session", input.initialNativeThreadId]),
        ],
        name: "omp",
        threadId: input.threadId,
        env: options.environment,
      });
      if (launch.unit !== undefined) {
        const unit = launch.unit;
        yield* Effect.addFinalizer(() => agentScope.stop(unit));
      }
      const connection: OmpRpcConnection = yield* (options.makeConnection ?? makeOmpRpcConnection)({
        ...launch,
        cwd,
        env: options.environment,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) => protocolError("Cannot start native OMP", cause)),
      );
      const request = (value: RecordValue) =>
        connection
          .request(value)
          .pipe(
            Effect.mapError((cause) => protocolError("OMP rejected the native request", cause)),
          );
      const history = makeOmpTurnHistory(request);
      const send = (value: RecordValue) =>
        connection
          .send(value)
          .pipe(Effect.mapError((cause) => protocolError("Cannot send native OMP request", cause)));
      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: OMP_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      let thread: OrchestrationV2ProviderThread | null = null;
      let goalRevision = 0;
      let active: Turn | null = null;
      let pendingBackground = false;
      let closed = false;
      const subagents = new Map<string, OrchestrationV2Subagent>();
      const subagentOutput = new Map<string, string>();
      const questions = new Map<string, PendingQuestion>();
      const eventPermit = yield* Semaphore.make(1);
      const hostCalls = new Map<
        string,
        Fiber.Fiber<void, ProviderAdapter.ProviderAdapterProtocolError>
      >();
      const mcpConfig = yield* mcpSessions.read(input.threadId);
      const hostTools =
        mcpConfig === undefined
          ? undefined
          : yield* makeOmpHostTools(mcpConfig).pipe(
              Effect.mapError((cause) =>
                protocolError("Cannot initialize T3 tools for OMP", cause),
              ),
            );
      const output = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(output, event).pipe(Effect.asVoid);
      const childProjection = yield* makeOmpSubagentProjection({ request, emit }).pipe(
        Effect.provideService(IdAllocator.IdAllocatorV2, ids),
      );
      const ordinal = (turn: Turn, id: string) => {
        const found = turn.ordinals.get(id);
        if (found !== undefined) return found;
        const value = turn.nextOrdinal++;
        turn.ordinals.set(id, value);
        return value;
      };
      const base = (turn: Turn, id: string, startedAt: DateTime.Utc, updatedAt: DateTime.Utc) => ({
        id: ids.derive.turnItemFromProviderItem({ driver: OMP_PROVIDER, nativeItemId: id }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: ids.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId: id }),
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.entity.id,
        nativeItemRef: ref(id),
        parentItemId: null,
        ordinal: ordinal(turn, id),
        startedAt,
        updatedAt,
      });
      const node = (
        turn: Turn,
        id: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        completedAt: DateTime.Utc | null,
      ) =>
        emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: {
            id: ids.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId: id }),
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind,
            status,
            countsForRun: false,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.entity.id,
            nativeItemRef: ref(id),
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt,
            completedAt,
          },
        });
      // Streaming projections are coalesced; tracing belongs to the owning turn.
      const publishText = Effect.fnUntraced(function* (turn: Turn, item: TextItem) {
        const at = yield* DateTime.now;
        const status = item.completed ? "completed" : "running";
        yield* node(turn, item.id, item.kind, status, item.startedAt, item.completed ? at : null);
        const fields = {
          ...base(turn, item.id, item.startedAt, at),
          status,
          title: null,
          completedAt: item.completed ? at : null,
          text: item.text,
          streaming: !item.completed,
        } as const;
        if (item.kind === "reasoning") {
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: { ...fields, type: "reasoning" },
          });
        } else {
          const messageId = ids.derive.messageFromProviderItem({
            driver: OMP_PROVIDER,
            nativeItemId: item.id,
          });
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: { ...fields, type: "assistant_message", messageId },
          });
          yield* emit({
            type: "message.updated",
            driver: OMP_PROVIDER,
            message: {
              id: messageId,
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              nodeId: fields.nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming: !item.completed,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt,
              updatedAt: at,
            },
          });
        }
      });
      const updateStatus = Effect.fn("OmpAdapter.updateStatus")(function* (
        status: OrchestrationV2ProviderSession["status"],
      ) {
        session = { ...session, status, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: OMP_PROVIDER,
          providerSession: session,
        });
      });
      const updateGoal = Effect.fn("OmpAdapter.updateGoal")(function* (value: unknown) {
        const goal = ompGoal(value);
        if (thread === null || goal === undefined) return;
        thread = { ...thread, goal, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: OMP_PROVIDER,
          providerThread: thread,
        });
      });
      const publishTodos = Effect.fn("OmpAdapter.publishTodos")(function* (
        turn: Turn,
        phases: unknown,
      ) {
        if (!Array.isArray(phases)) return;
        const steps: OrchestrationV2PlanStep[] = phases.flatMap((value, phaseIndex) => {
          const phase = record(value);
          return entries(phase.tasks).flatMap((value, taskIndex) => {
            const task = record(value);
            const content = text(task.content)?.trim();
            if (!content) return [];
            const label = [text(phase.name), content].filter(Boolean).join(": ");
            const suffix =
              task.status === "blocked"
                ? ` (Blocked: ${text(task.blocker) ?? "awaiting input"})`
                : task.status === "abandoned"
                  ? " (Abandoned)"
                  : "";
            return [
              {
                id: `${phaseIndex}:${taskIndex}`,
                text: `${label}${suffix}`,
                status:
                  task.status === "in_progress"
                    ? ("running" as const)
                    : task.status === "completed" || task.status === "abandoned"
                      ? ("completed" as const)
                      : ("pending" as const),
              },
            ];
          });
        });
        if (turn.planId === null)
          turn.planId = yield* ids.allocate
            .plan({ driver: OMP_PROVIDER, threadId: turn.input.threadId, runId: turn.input.runId })
            .pipe(
              Effect.mapError((cause) => protocolError("Cannot allocate OMP todo plan", cause)),
            );
        const at = yield* DateTime.now;
        const itemId = `${turn.entity.id}:todos`;
        const fields = base(turn, itemId, turn.entity.startedAt ?? at, at);
        const done = steps.every((step) => step.status === "completed");
        yield* node(turn, itemId, "plan", "completed", fields.startedAt, at);
        yield* emit({
          type: "plan.updated",
          driver: OMP_PROVIDER,
          plan: {
            id: turn.planId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: fields.nodeId,
            kind: "todo_list",
            status: done ? "completed" : "active",
            steps,
          },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...fields,
            type: "todo_list",
            title: "Plan",
            status: "completed",
            completedAt: at,
            planId: turn.planId,
            steps,
          },
        });
      });
      const publishNotice = Effect.fn("OmpAdapter.publishNotice")(function* (
        turn: Turn,
        id: string,
        message: string,
      ) {
        const at = yield* DateTime.now;
        const fields = base(turn, `${turn.entity.id}:notice:${id}`, at, at);
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...fields,
            type: "system_notice",
            title: "OMP",
            message: message.slice(0, 20_000),
            status: "completed",
            completedAt: at,
          },
        });
      });
      const finish = Effect.fn("OmpAdapter.finish")(function* (
        turn: Turn,
        result: RecordValue,
        broken = false,
      ) {
        if (active !== turn) return;
        broken ||= turn.retire;
        for (const item of turn.texts.values()) {
          if (!item.completed) {
            item.completed = true;
            yield* publishText(turn, item);
          }
        }
        const at = yield* DateTime.now;
        active = null;
        pendingBackground = false;
        yield* emit({
          type: "background_work.updated",
          driver: OMP_PROVIDER,
          providerTurnId: turn.entity.id,
          pending: false,
        });
        const status =
          turn.interrupted || result.status === "aborted"
            ? "interrupted"
            : result.status === "error"
              ? "failed"
              : "completed";
        for (const pending of questions.values()) yield* finishQuestion(pending, true);
        for (const [toolCallId, tool] of turn.tools) {
          if (tool.completed || tool.item === null) continue;
          tool.completed = true;
          const toolStatus = status === "completed" ? "cancelled" : status;
          yield* node(
            turn,
            `${turn.entity.id}:tool:${toolCallId}`,
            "tool_call",
            toolStatus,
            tool.startedAt,
            at,
          );
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: { ...tool.item, status: toolStatus, completedAt: at, updatedAt: at },
          });
        }
        if (status !== "completed" || broken) {
          for (const [nativeId, current] of subagents) {
            if (current.runId !== turn.input.runId || current.completedAt !== null) continue;
            const childStatus = status === "failed" ? "failed" : "interrupted";
            const child = yield* childProjection.update({
              parentThread: turn.input.appThread,
              parentProviderThread: turn.input.providerThread,
              parentProviderTurnId: turn.entity.id,
              task: { ...current, status: childStatus, completedAt: at, updatedAt: at },
              refreshTranscript: false,
            });
            subagents.set(nativeId, child);
            yield* emit({ type: "subagent.updated", driver: OMP_PROVIDER, subagent: child });
            const itemId = `${turn.entity.id}:subagent:${nativeId}`;
            yield* node(turn, itemId, "subagent", childStatus, child.startedAt ?? at, at);
            yield* emit({
              type: "turn_item.updated",
              driver: OMP_PROVIDER,
              turnItem: {
                ...base(turn, itemId, child.startedAt ?? at, at),
                type: "subagent",
                status: childStatus,
                title: child.title,
                completedAt: at,
                subagentId: child.id,
                origin: "provider_native",
                driver: OMP_PROVIDER,
                providerInstanceId: options.instanceId,
                childThreadId: child.childThreadId,
                prompt: child.prompt,
                result: child.result,
              },
            });
          }
        }
        yield* emit({
          type: "provider_turn.updated",
          driver: OMP_PROVIDER,
          providerTurn: { ...turn.entity, status, completedAt: at },
        });
        if (thread !== null) {
          thread = {
            ...thread,
            status: broken && !turn.retire ? "error" : "idle",
            goal:
              turn.retire && thread.goal?.status === "active"
                ? { ...thread.goal, status: "paused" }
                : thread.goal,
            updatedAt: at,
          };
          yield* emit({
            type: "provider_thread.updated",
            driver: OMP_PROVIDER,
            providerThread: thread,
            pendingBackgroundWork: false,
          });
        }
        yield* updateStatus(turn.retire ? "stopped" : broken ? "error" : "ready");
        if (status === "failed") {
          const failure = makeProviderFailure({
            message: text(record(result.error).message) ?? "OMP native turn failed",
            class: broken ? "transport_error" : "provider_error",
          });
          yield* emit({
            type: "turn.terminal",
            driver: OMP_PROVIDER,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.entity.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure,
            failureItemOrdinal: turn.nextOrdinal++,
            threadDisposition: broken ? "broken" : "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: OMP_PROVIDER,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.entity.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: broken ? "broken" : "reusable",
          });
        }
        yield* childProjection.clear;
      });
      const finishQuestion = Effect.fn("OmpAdapter.finishQuestion")(function* (
        pending: PendingQuestion,
        cancelled: boolean,
      ) {
        const at = yield* DateTime.now;
        questions.delete(pending.runtimeRequest.id);
        yield* emit({
          type: "runtime_request.updated",
          driver: OMP_PROVIDER,
          runtimeRequest: {
            ...pending.runtimeRequest,
            status: cancelled ? "cancelled" : "resolved",
            resolvedAt: at,
          },
        });
        yield* emit({
          type: "node.updated",
          driver: OMP_PROVIDER,
          node: { ...pending.node, status: cancelled ? "cancelled" : "completed", completedAt: at },
        });
        yield* emit({
          type: "turn_item.updated",
          driver: OMP_PROVIDER,
          turnItem: {
            ...pending.item,
            status: cancelled ? "cancelled" : "completed",
            completedAt: at,
            updatedAt: at,
          },
        });
      });
      const handleQuestion = Effect.fn("OmpAdapter.handleQuestion")(function* (event: RecordValue) {
        const nativeId = text(event.id);
        const method = text(event.method);
        if (method === "cancel") {
          const target = [...questions.values()].find((q) => q.nativeId === event.targetId);
          if (target !== undefined) yield* finishQuestion(target, true);
          return;
        }
        if (
          nativeId === undefined ||
          method === undefined ||
          !["ask", "confirm", "select", "input", "editor"].includes(method)
        )
          return;
        const turn = active;
        if (turn === null) {
          yield* send({ type: "extension_ui_response", id: nativeId, cancelled: true });
          return;
        }
        if (event.secret === true) {
          yield* send({ type: "extension_ui_response", id: nativeId, cancelled: true });
          yield* publishNotice(
            turn,
            nativeId,
            "OMP requested a secret. Complete sign-in in OMP on the server, then retry.",
          );
          return;
        }
        const title = text(event.title)?.trim() || "OMP question";
        const approvalOptions =
          method === "select" && title.startsWith("Allow tool:")
            ? entries(event.options).filter((value): value is string => typeof value === "string")
            : null;
        const approval =
          approvalOptions === null ? null : ompApprovalPresentation(title, approvalOptions);
        const nativeQuestions =
          method === "ask"
            ? entries(event.questions)
            : [
                {
                  id: nativeId,
                  question: text(event.message)?.trim() || title,
                  header: title,
                  options:
                    method === "confirm"
                      ? [{ label: "Yes" }, { label: "No" }]
                      : entries(event.options).map((option, index) => ({
                          label: option,
                          description: text(
                            record(entries(event.optionDetails)[index]).description,
                          ),
                        })),
                },
              ];
        const mapped: OrchestrationV2UserInputQuestion[] = nativeQuestions.map((entry, index) => {
          const q = record(entry);
          return {
            id: text(q.id) ?? String(index),
            header: text(q.header)?.trim() || "Question",
            question: text(q.question)?.trim() || title,
            options: entries(q.options).flatMap((option) => {
              const o = record(option);
              const label = text(o.label)?.trim();
              return label ? [{ label, description: text(o.description)?.trim() || label }] : [];
            }),
            multiSelect: q.multi === true,
            allowCustomAnswer: method !== "select" && method !== "confirm",
            ...(method === "editor" && text(event.prefill) !== undefined
              ? { initialAnswer: text(event.prefill) }
              : {}),
          };
        });
        const at = yield* DateTime.now;
        const requestId = yield* ids.allocate
          .runtimeRequest({
            driver: OMP_PROVIDER,
            providerTurnId: turn.entity.id,
            nativeRequestId: nativeId,
          })
          .pipe(Effect.mapError((cause) => protocolError("Cannot allocate OMP question", cause)));
        const nodeId = ids.derive.approvalNode({ requestId });
        const runtimeRequest: OrchestrationV2RuntimeRequest = {
          id: requestId,
          nodeId,
          providerTurnId: turn.entity.id,
          nativeRequestRef: ref(nativeId),
          kind: approval?.requestKind ?? "user_input",
          status: "pending",
          responseCapability: { type: "live", providerSessionId: input.providerSessionId },
          createdAt: at,
          resolvedAt: null,
        };
        const requestNode: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: approvalOptions === null ? "user_input_request" : "approval_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.entity.id,
          nativeItemRef: ref(nativeId),
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: at,
          completedAt: null,
        };
        const itemFields = {
          ...base(turn, nativeId, at, at),
          id: ids.derive.approvalTurnItem({ requestId }),
          nodeId,
          status: "waiting" as const,
          title,
          completedAt: null,
          requestId,
        };
        const item: OrchestrationV2TurnItem =
          approval === null
            ? { ...itemFields, type: "user_input_request", questions: mapped }
            : {
                ...itemFields,
                type: "approval_request",
                ...approval,
              };
        questions.set(requestId, {
          nativeId,
          method,
          questions: mapped,
          approvalOptions,
          runtimeRequest,
          node: requestNode,
          item,
        });
        yield* emit({ type: "runtime_request.updated", driver: OMP_PROVIDER, runtimeRequest });
        yield* emit({ type: "node.updated", driver: OMP_PROVIDER, node: requestNode });
        yield* emit({ type: "turn_item.updated", driver: OMP_PROVIDER, turnItem: item });
      });
      const modelSelection = makeOmpModelSelection({
        initialState: yield* request({ type: "get_state" }),
        request,
        publishModel: Effect.fn("OmpAdapter.publishModel")(function* (model) {
          if (session.model === model) return;
          session = { ...session, model, updatedAt: yield* DateTime.now };
          yield* emit({
            type: "provider_session.updated",
            driver: OMP_PROVIDER,
            providerSession: session,
          });
        }),
      });
      const applySelection = modelSelection.apply;
      // Native event ordering is preserved by one consumer; no per-chunk tracing.
      const handleEvent = Effect.fnUntraced(function* (event: RecordValue) {
        if (closed) return;
        if (event.type === "model_changed" || event.type === "config_update") {
          yield* modelSelection.handleEvent(event);
          return;
        }
        if (event.type === "goal_updated") {
          goalRevision++;
          yield* updateGoal(event.goal);
          return;
        }
        if (event.type === "host_tool_cancel") {
          const call = hostCalls.get(String(event.targetId));
          if (call !== undefined) yield* Fiber.interrupt(call);
          return;
        }
        if (event.type === "host_tool_call") {
          const callId = text(event.id);
          if (callId === undefined) return;
          if (active === null || hostTools === undefined) {
            yield* send({
              type: "host_tool_result",
              id: callId,
              isError: true,
              result: {
                content: [{ type: "text", text: "T3 tools require an active authorized turn" }],
                details: {},
              },
            });
            return;
          }
          const operation = hostTools
            .call(text(event.toolName) ?? "", record(event.arguments))
            .pipe(
              Effect.matchEffect({
                onSuccess: (result) =>
                  send({
                    type: "host_tool_result",
                    id: callId,
                    result,
                    isError: result.isError === true,
                  }),
                onFailure: () =>
                  send({
                    type: "host_tool_result",
                    id: callId,
                    isError: true,
                    result: {
                      content: [{ type: "text", text: "T3 tool call failed" }],
                      details: {},
                    },
                  }),
              }),
              Effect.ensuring(
                Effect.sync(() => {
                  hostCalls.delete(callId);
                }),
              ),
            );
          hostCalls.set(callId, yield* operation.pipe(Effect.forkIn(scope)));
          return;
        }
        if (event.type === "extension_ui_request") {
          if (active !== null) {
            const message =
              event.method === "notify"
                ? text(event.message)
                : event.method === "setStatus"
                  ? text(event.statusText)
                  : event.method === "setWidget"
                    ? entries(event.widgetLines)
                        .filter((line): line is string => typeof line === "string")
                        .join("\n")
                    : undefined;
            if (message)
              yield* publishNotice(
                active,
                String(event.statusKey ?? event.widgetKey ?? event.id),
                message,
              );
          }
          yield* handleQuestion(event);
          return;
        }
        const turn = active;
        if (turn === null) {
          if (event.type === "agent_start") {
            yield* connection.terminate;
            yield* updateStatus("error");
          }
          return;
        }
        if (event.type === "agent_start") {
          yield* updateStatus("running");
          return;
        }
        if (event.type === "agent_end") {
          const last = entries(event.messages)
            .map(record)
            .findLast((message) => message.role === "assistant");
          turn.result =
            last?.stopReason === "error"
              ? {
                  status: "error",
                  error: { message: text(last.errorMessage) ?? "OMP model request failed" },
                }
              : { status: last?.stopReason === "aborted" ? "aborted" : "completed" };
          return;
        }
        if (event.type === "prompt_result") {
          if (event.id !== turn.entity.id) return;
          turn.result = event;
          if (event.sessionSettled === true) yield* finish(turn, event);
          else {
            pendingBackground = true;
            yield* emit({
              type: "background_work.updated",
              driver: OMP_PROVIDER,
              providerTurnId: turn.entity.id,
              pending: true,
            });
            yield* updateStatus("waiting");
          }
          return;
        }
        if (event.type === "session_settled") {
          if (turn.result !== null) yield* finish(turn, turn.result);
          return;
        }
        if (event.type === "response" && event.id === turn.entity.id) {
          if (event.success === false)
            yield* finish(turn, { status: "error", error: { message: text(event.error) } });
          else if (event.command === "compact") yield* finish(turn, { status: "completed" });
          else if (event.command === "prompt" && record(event.data).agentInvoked === false) {
            turn.result ??= { status: "completed" };
            const state = record(yield* request({ type: "get_state" }));
            if (state.isSettled === true) yield* finish(turn, turn.result);
            else {
              pendingBackground = true;
              yield* emit({
                type: "background_work.updated",
                driver: OMP_PROVIDER,
                providerTurnId: turn.entity.id,
                pending: true,
              });
              yield* updateStatus("waiting");
            }
          }
          return;
        }
        if (event.type === "command_output") {
          yield* publishNotice(
            turn,
            String(event.command ?? event.id ?? turn.nextOrdinal),
            text(event.text) ?? text(event.message) ?? contentText(event.content),
          );
          return;
        }
        if (event.type === "notice" || event.type === "extension_error") {
          // Tool catalog churn is model-facing and can list hundreds of internal T3 callbacks.
          if (event.type === "notice" && event.source === "xdev" && event.level === "info") return;
          yield* publishNotice(
            turn,
            String(event.source ?? event.extensionPath ?? turn.nextOrdinal),
            text(event.message) ?? text(event.error) ?? "OMP extension failed",
          );
          return;
        }
        if (event.type === "todo_auto_clear") {
          yield* publishTodos(turn, []);
          return;
        }
        if (event.type === "message_end" && record(event.message).role === "assistant") {
          const message = record(event.message);
          const prefix = `${turn.entity.id}:${text(event.messageId) ?? "message"}:`;
          const blocks = entries(message.content);
          const retained = new Set<string>();
          for (const [index, value] of blocks.entries()) {
            const block = record(value);
            if (block.type !== "text" && block.type !== "thinking") continue;
            const id = `${prefix}${index}`;
            retained.add(id);
            const item = turn.texts.get(id) ?? {
              id,
              kind:
                block.type === "thinking" ? ("reasoning" as const) : ("assistant_message" as const),
              startedAt: yield* DateTime.now,
              text: "",
              completed: false,
              scheduled: false,
            };
            item.text = (text(block.text) ?? text(block.thinking) ?? "").slice(0, 2_000_000);
            item.completed = true;
            turn.texts.set(id, item);
            yield* publishText(turn, item);
          }
          // Inline edit recovery can remove a streamed block from the authoritative final message.
          for (const item of turn.texts.values())
            if (item.id.startsWith(prefix) && !retained.has(item.id)) {
              item.text = "";
              item.completed = true;
              yield* publishText(turn, item);
            }
          const tokenUsage = yield* modelSelection.readUsage(
            message.usage,
            DateTime.formatIso(yield* DateTime.now),
          );
          if (tokenUsage !== undefined) {
            turn.entity = { ...turn.entity, tokenUsage };
            yield* emit({
              type: "provider_turn.updated",
              driver: OMP_PROVIDER,
              providerTurn: turn.entity,
            });
          }
          return;
        }
        if (
          event.type === "manual_compaction_start" ||
          event.type === "auto_compaction_start" ||
          event.type === "manual_compaction_end" ||
          event.type === "auto_compaction_end"
        ) {
          const at = yield* DateTime.now;
          const started = event.type.endsWith("_start");
          const item = turn.compaction ?? {
            id: `${turn.entity.id}:compact:${turn.nextOrdinal}`,
            startedAt: at,
          };
          turn.compaction = started ? item : null;
          const status = started
            ? "running"
            : event.aborted === true
              ? "cancelled"
              : event.errorMessage && event.skipped !== true
                ? "failed"
                : "completed";
          const result = record(event.result);
          yield* node(turn, item.id, "system", status, item.startedAt, started ? null : at);
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...base(turn, item.id, item.startedAt, at),
              type: "compaction",
              title: "Compacting context",
              driver: OMP_PROVIDER,
              status,
              completedAt: started ? null : at,
              summary: text(result.summary) ?? text(event.errorMessage),
              beforeTokenCount: nonNegative(result.tokensBefore),
              afterTokenCount: nonNegative(result.estimatedTokensAfter),
            },
          });
          return;
        }
        if (event.type === "message_update") {
          const change = record(event.assistantMessageEvent);
          const type = text(change.type) ?? "";
          if (!type.startsWith("text_") && !type.startsWith("thinking_")) return;
          const kind = type.startsWith("thinking_") ? "reasoning" : "assistant_message";
          const itemId = `${turn.entity.id}:${text(event.messageId) ?? "message"}:${String(change.contentIndex ?? 0)}`;
          let item = turn.texts.get(itemId);
          if (item === undefined) {
            item = {
              id: itemId,
              kind,
              startedAt: yield* DateTime.now,
              text: "",
              completed: false,
              scheduled: false,
            };
            turn.texts.set(itemId, item);
          }
          if (type.endsWith("_delta"))
            item.text = (item.text + (text(change.delta) ?? "")).slice(0, 2_000_000);
          if (type.endsWith("_end")) {
            item.text = (text(change.content) ?? item.text).slice(0, 2_000_000);
            item.completed = true;
            yield* publishText(turn, item);
          } else if (!item.scheduled) {
            item.scheduled = true;
            const captured = item;
            yield* Effect.sleep("50 millis").pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  captured.scheduled = false;
                  return captured.completed || active !== turn
                    ? Effect.void
                    : publishText(turn, captured);
                }),
              ),
              Effect.forkIn(scope),
            );
          }
          return;
        }
        if (
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_update" ||
          event.type === "tool_execution_end"
        ) {
          const toolCallId = text(event.toolCallId);
          if (toolCallId === undefined) return;
          const itemId = `${turn.entity.id}:tool:${toolCallId}`;
          const at = yield* DateTime.now;
          const tool = turn.tools.get(toolCallId) ?? {
            name: text(event.toolName) ?? "tool",
            args: event.args ?? {},
            startedAt: at,
            completed: false,
            item: null,
          };
          if (tool.completed) return;
          turn.tools.set(toolCallId, tool);
          const result = event.result ?? event.partialResult;
          const asyncState = text(record(record(record(result).details).async).state);
          // A detached tool's end acknowledges dispatch; its later async update owns completion.
          const completed =
            asyncState === undefined
              ? event.type === "tool_execution_end"
              : ["completed", "failed", "cancelled"].includes(asyncState);
          const status = !completed
            ? "running"
            : asyncState === "cancelled"
              ? "cancelled"
              : asyncState === "failed" || event.isError === true
                ? "failed"
                : "completed";
          tool.completed = completed;
          yield* node(turn, itemId, "tool_call", status, tool.startedAt, completed ? at : null);
          const fields = {
            ...base(turn, itemId, tool.startedAt, at),
            title: tool.name,
            status,
            completedAt: completed ? at : null,
          } as const;
          const args = record(tool.args);
          const details = record(record(result).details);
          const outputText = contentText(record(result).content);
          if (tool.name === "todo" && completed && status === "completed") {
            yield* publishTodos(turn, details.phases);
          }
          let item: OrchestrationV2TurnItem;
          const fileName = text(details.path) ?? text(details.resolvedPath) ?? text(args.path);
          if (tool.name === "bash" || tool.name === "python") {
            const exitCode =
              typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)
                ? details.exitCode
                : undefined;
            item = {
              ...fields,
              type: "command_execution",
              input: text(args.command) ?? text(args.code) ?? "",
              ...(outputText ? { output: outputText } : {}),
              ...(exitCode === undefined ? {} : { exitCode }),
            };
          } else if (["write", "edit", "ast_edit"].includes(tool.name) && fileName?.trim()) {
            item = {
              ...fields,
              type: "file_change",
              fileName,
              diffStr: text(details.diff),
              oldStr: text(details.oldText),
              newStr:
                text(details.newText) ?? (tool.name === "write" ? text(args.content) : undefined),
            };
          } else {
            item = {
              ...fields,
              type: "dynamic_tool",
              toolName: tool.name,
              input: tool.args,
              ...(result === undefined ? {} : { output: result }),
            };
          }
          tool.item = item;
          yield* emit({ type: "turn_item.updated", driver: OMP_PROVIDER, turnItem: item });
          return;
        }
        if (event.type === "subagent_event") {
          yield* childProjection.handleEvent(record(event.payload));
          return;
        }
        if (event.type === "subagent_lifecycle" || event.type === "subagent_progress") {
          const payload = record(event.payload);
          const nativeId = text(payload.id) ?? text(record(payload.progress).id);
          if (nativeId === undefined) return;
          const previous = subagents.get(nativeId);
          const progress = record(payload.progress);
          const nativeStatus = text(payload.status) ?? text(progress.status) ?? text(payload.type);
          if (nativeStatus === "started") subagentOutput.delete(nativeId);
          const status =
            nativeStatus === "completed" || nativeStatus === "complete"
              ? "completed"
              : nativeStatus === "failed" || nativeStatus === "error"
                ? "failed"
                : nativeStatus === "cancelled" || nativeStatus === "aborted"
                  ? "cancelled"
                  : "running";
          const at = yield* DateTime.now;
          const finished = status !== "running";
          const itemId = `${turn.entity.id}:subagent:${nativeId}`;
          const subagentId = ids.derive.nodeFromProviderItem({
            driver: OMP_PROVIDER,
            nativeItemId: itemId,
          });
          const recent = entries(progress.recentOutput)
            .filter((value): value is string => typeof value === "string")
            .join("\n");
          if (recent) subagentOutput.set(nativeId, recent.slice(-10_000));
          const parentTool = turn.tools.get(text(payload.parentToolCallId) ?? "");
          const parentArgs = parentTool?.name === "task" ? record(parentTool.args) : {};
          const tasks = entries(parentArgs.tasks);
          const taskInput =
            tasks.length > 0 ? record(tasks[nonNegative(payload.index) ?? -1]) : parentArgs;
          const task: OrchestrationV2Subagent = {
            id: subagentId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            parentNodeId: turn.input.rootNodeId,
            origin: "provider_native",
            createdBy: "agent",
            driver: OMP_PROVIDER,
            providerInstanceId: options.instanceId,
            providerThreadId: turn.input.providerThread.id,
            childThreadId: null,
            nativeTaskRef: ref(nativeId),
            prompt: text(payload.task) || text(taskInput.task) || previous?.prompt || "",
            title: nativeId,
            model: text(progress.resolvedModel) ?? previous?.model ?? null,
            status,
            result: finished
              ? recent ||
                text(payload.result) ||
                previous?.result ||
                subagentOutput.get(nativeId) ||
                null
              : null,
            ...(recent ? { progress: recent.slice(-200) } : {}),
            startedAt: nativeStatus === "started" ? at : (previous?.startedAt ?? at),
            completedAt: finished ? at : null,
            updatedAt: at,
          };
          const sessionFile = text(payload.sessionFile);
          const child = yield* childProjection.update({
            parentThread: turn.input.appThread,
            parentProviderThread: turn.input.providerThread,
            parentProviderTurnId: turn.entity.id,
            task,
            ...(sessionFile === undefined ? {} : { sessionFile }),
          });
          subagents.set(nativeId, child);
          yield* emit({ type: "subagent.updated", driver: OMP_PROVIDER, subagent: child });
          yield* node(turn, itemId, "subagent", status, child.startedAt ?? at, child.completedAt);
          yield* emit({
            type: "turn_item.updated",
            driver: OMP_PROVIDER,
            turnItem: {
              ...base(turn, itemId, child.startedAt ?? at, at),
              type: "subagent",
              status,
              title: child.title,
              completedAt: child.completedAt,
              subagentId,
              origin: "provider_native",
              driver: OMP_PROVIDER,
              providerInstanceId: options.instanceId,
              childThreadId: child.childThreadId,
              prompt: child.prompt,
              result: child.result,
            },
          });
        }
      });
      yield* Stream.fromQueue(connection.events).pipe(
        Stream.runForEach((event) => eventPermit.withPermits(1)(handleEvent(event))),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            if (closed) return;
            if (active !== null)
              yield* finish(
                active,
                { status: "error", error: { message: "OMP connection closed" } },
                true,
              );
            else yield* updateStatus("error");
            yield* Queue.fail(output, protocolError("OMP native event stream failed", cause));
          }),
        ),
        Effect.forkIn(scope),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          yield* Queue.end(output);
        }),
      );
      yield* request({ type: "set_event_filter", events: null, messageUpdates: "delta" });
      yield* request({ type: "set_subagent_subscription", level: "events" });
      yield* request({ type: "set_ask_dialog", enabled: true });
      if (hostTools !== undefined)
        yield* request({ type: "set_host_tools", tools: hostTools.tools });

      const ensureThread = Effect.fn("OmpAdapter.ensureThread")(function* (
        threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
        preparedSessionFile?: string,
      ) {
        if (active !== null) return yield* protocolError("Cannot replace an active OMP session");
        if (threadInput.runtimePolicy.runtimeMode !== input.runtimePolicy.runtimeMode)
          return yield* protocolError(
            "OMP permission changes require restarting the native session",
          );
        const existing = threadInput.existingProviderThread;
        const target =
          existing?.nativeThreadRef?.nativeId ??
          (thread === null ? input.initialNativeThreadId : undefined);
        const restoredAtLaunch =
          thread === null && target !== undefined && target === input.initialNativeThreadId;
        if (
          !threadInput.forceNewNativeThread &&
          target !== undefined &&
          target !== null &&
          target !== thread?.nativeThreadRef?.nativeId &&
          !restoredAtLaunch
        ) {
          // OMP switch_session resumes active goals; only our paused forks are safe to switch.
          if (target !== preparedSessionFile)
            return yield* protocolError(
              "Reopen OMP with the requested persisted session before resuming it",
            );
          const result = record(yield* request({ type: "switch_session", sessionPath: target }));
          if (result.cancelled === true)
            return yield* protocolError("OMP cancelled session recovery");
          yield* history.reset;
          modelSelection.invalidate();
        } else if (
          threadInput.forceNewNativeThread ||
          (thread === null && !restoredAtLaunch) ||
          (thread !== null && thread.appThreadId !== threadInput.threadId)
        ) {
          const result = record(yield* request({ type: "new_session" }));
          if (result.cancelled === true)
            return yield* protocolError("OMP cancelled session creation");
          yield* history.reset;
          modelSelection.invalidate();
        }
        yield* applySelection(threadInput.modelSelection);
        const state = record(yield* request({ type: "get_state" }));
        const sessionFile = text(state.sessionFile);
        if (sessionFile === undefined)
          return yield* protocolError("OMP did not expose its persisted session file");
        if (state.isStreaming === true || state.hasPendingAsyncWork === true)
          return yield* protocolError("OMP session has unowned active work");
        const at = yield* DateTime.now;
        thread = {
          ...(existing ?? {
            id: ids.derive.providerThread({ driver: OMP_PROVIDER, nativeThreadId: sessionFile }),
            driver: OMP_PROVIDER,
            providerInstanceId: options.instanceId,
            appThreadId: threadInput.threadId,
            ownerNodeId: null,
            nativeConversationHeadRef: null,
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt: at,
          }),
          providerSessionId: input.providerSessionId,
          nativeThreadRef: ref(sessionFile),
          status: "idle",
          goal:
            ompGoal(record(state.goal).goal) ??
            (!threadInput.forceNewNativeThread && existing?.goal?.status === "complete"
              ? existing.goal
              : null),
          updatedAt: at,
        };
        yield* emit({
          type: "provider_thread.updated",
          driver: OMP_PROVIDER,
          providerThread: thread,
        });
        return thread;
      });
      const prepareMessage = Effect.fn("OmpAdapter.prepareMessage")(function* (
        message: ProviderAdapter.ProviderAdapterV2TurnInput["message"],
      ) {
        const slashCommand = /^\/([^\s]+)/.exec(message.text.trim())?.[1]?.toLowerCase();
        if (slashCommand !== undefined && OMP_SESSION_COMMANDS.has(slashCommand))
          return yield* protocolError("Use T3 thread controls to change OMP sessions");
        const prompt = yield* providerMessageTextWithAttachmentPaths({
          text: message.text,
          attachments: message.attachments.filter((attachment) => attachment.type !== "image"),
          resolveAttachmentPath: host.resolveAttachmentPath,
          resolveExtractedTextPath: host.resolveExtractedTextPath,
        }).pipe(Effect.mapError((cause) => protocolError("Cannot prepare OMP prompt", cause)));
        const images = [];
        for (const attachment of message.attachments) {
          if (attachment.type !== "image") continue;
          const path = host.resolveAttachmentPath(attachment);
          if (path === null) return yield* protocolError("Cannot resolve OMP image attachment");
          const data = yield* fileSystem
            .readFile(path)
            .pipe(
              Effect.mapError((cause) => protocolError("Cannot read OMP image attachment", cause)),
            );
          images.push({
            type: "image",
            data: Buffer.from(data).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        return { message: prompt, ...(images.length === 0 ? {} : { images }) };
      });
      const start = Effect.fn("OmpAdapter.startTurn")(function* (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        compact: boolean,
      ) {
        if (active !== null) return yield* protocolError("An OMP turn is already active");
        if (
          thread === null ||
          thread.nativeThreadRef?.nativeId == null ||
          thread.nativeThreadRef.nativeId !== turnInput.providerThread.nativeThreadRef?.nativeId ||
          thread.appThreadId !== turnInput.threadId ||
          turnInput.providerThread.appThreadId !== turnInput.threadId ||
          turnInput.providerThread.providerSessionId !== input.providerSessionId
        )
          return yield* protocolError("OMP turn belongs to an unregistered thread");
        if (turnInput.runtimePolicy.runtimeMode !== input.runtimePolicy.runtimeMode)
          return yield* protocolError(
            "OMP permission changes require restarting the native session",
          );
        yield* applySelection(turnInput.modelSelection);
        const slashCommand = /^\/([^\s]+)/.exec(turnInput.message.text.trim())?.[1]?.toLowerCase();
        const prepared = yield* prepareMessage(turnInput.message);
        const nativeTurnRef = yield* history.capture();
        const at = yield* DateTime.now;
        const entity: OrchestrationV2ProviderTurn = {
          id: ids.derive.providerTurn({
            driver: OMP_PROVIDER,
            nativeTurnId: String(turnInput.attemptId),
          }),
          providerThreadId: turnInput.providerThread.id,
          nodeId: turnInput.rootNodeId,
          runAttemptId: turnInput.attemptId,
          nativeTurnRef,
          ordinal: turnInput.providerTurnOrdinal,
          status: "running",
          startedAt: at,
          completedAt: null,
        };
        const turn: Turn = {
          input: turnInput,
          entity,
          planId: null,
          compaction: null,
          texts: new Map(),
          tools: new Map(),
          ordinals: new Map(),
          nextOrdinal: 1,
          result: null,
          interrupted: false,
          retire: false,
        };
        active = turn;
        // Fork adoption replaces the adapter-derived ID with T3's durable provider thread row.
        thread = {
          ...turnInput.providerThread,
          goal: thread.goal,
          ...(thread.contextUsage === undefined ? {} : { contextUsage: thread.contextUsage }),
          status: "active",
          firstRunOrdinal: turnInput.providerThread.firstRunOrdinal ?? turnInput.runOrdinal,
          lastRunOrdinal: turnInput.runOrdinal,
          updatedAt: at,
        };
        yield* emit({
          type: "provider_turn.updated",
          driver: OMP_PROVIDER,
          threadId: turnInput.threadId,
          providerTurn: entity,
        });
        yield* emit({
          type: "provider_thread.updated",
          driver: OMP_PROVIDER,
          providerThread: thread,
        });
        yield* updateStatus("running");
        const goalCommand = compact ? null : parseGoalCommand(turnInput.message);
        if (goalCommand !== null) {
          yield* Effect.gen(function* () {
            const beforeGet = goalRevision;
            const current = record(yield* request({ type: "goal", op: "get" }));
            const completedGoal =
              current.goal == null && thread?.goal?.status === "complete" ? thread.goal : null;
            if (
              beforeGet === goalRevision &&
              (goalCommand.type !== "show" || completedGoal === null)
            )
              yield* updateGoal(current.goal);
            if (goalCommand.type === "show") {
              const goal = thread?.goal;
              yield* publishNotice(
                turn,
                "goal",
                goal == null
                  ? "No goal is set."
                  : `Goal ${goal.status.replaceAll("_", " ")}: ${goal.objective}`,
              );
              yield* finish(turn, { status: "completed" });
              return;
            }
            if (goalCommand.type === "set" && current.goal != null)
              yield* request({ type: "goal", op: "drop" });
            if (
              current.goal == null &&
              (goalCommand.type === "pause" || goalCommand.type === "resume")
            ) {
              yield* publishNotice(turn, "goal", "No goal is set.");
              yield* finish(turn, { status: "completed" });
              return;
            }
            const beforeChange = goalRevision;
            const result = record(
              yield* request({
                type: "goal",
                op:
                  goalCommand.type === "set"
                    ? "create"
                    : goalCommand.type === "clear"
                      ? "drop"
                      : goalCommand.type,
                ...(goalCommand.type === "set" ? { objective: goalCommand.objective } : {}),
              }),
            );
            if (beforeChange === goalRevision) yield* updateGoal(result.goal);
            turn.result ??= { status: "completed" };
            if (goalCommand.type === "clear" || goalCommand.type === "pause") {
              yield* finish(turn, turn.result);
              return;
            }
            const state = record(yield* request({ type: "get_state" }));
            if (active !== turn) return;
            if (state.isSettled === true) yield* finish(turn, turn.result);
            else {
              pendingBackground = true;
              yield* emit({
                type: "background_work.updated",
                driver: OMP_PROVIDER,
                providerTurnId: turn.entity.id,
                pending: true,
              });
            }
          }).pipe(
            Effect.tapError((cause) =>
              finish(turn, { status: "error", error: { message: cause.message } }),
            ),
          );
          return;
        }
        yield* send(
          compact
            ? { type: "compact", id: entity.id }
            : {
                type: "prompt",
                id: entity.id,
                message: [
                  ...(slashCommand === undefined ? (turnInput.appContext ?? []) : []).map(
                    (context) => context.text,
                  ),
                  prepared.message,
                ].join("\n\n"),
                ...(prepared.images === undefined ? {} : { images: prepared.images }),
              },
        ).pipe(
          Effect.tapError(() =>
            finish(turn, { status: "error", error: { message: "Cannot submit OMP prompt" } }, true),
          ),
        );
      });
      const readSnapshot = Effect.fn("OmpAdapter.readThreadSnapshot")(function* (
        snapshotInput: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput,
      ) {
        const bound = thread;
        const nativeId = snapshotInput.providerThread.nativeThreadRef?.nativeId;
        if (bound === null || nativeId == null || bound.nativeThreadRef?.nativeId !== nativeId)
          return yield* protocolError("OMP snapshot belongs to another native session");
        // Only the active branch belongs in a handoff; get_entries also contains abandoned branches.
        const result = record(yield* request({ type: "get_messages" }));
        const messages = entries(result.messages).flatMap((value, index) => {
          const message = record(value);
          const role = message.role;
          if (role !== "user" && role !== "assistant") return [];
          const content = contentText(message.content);
          if (!content) return [];
          const at = Option.getOrElse(
            DateTime.make(typeof message.timestamp === "number" ? message.timestamp : Number.NaN),
            () => bound.createdAt,
          );
          return [
            {
              id: ids.derive.messageFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId: `${nativeId}:snapshot:${index}`,
              }),
              threadId: bound.appThreadId ?? input.threadId,
              runId: null,
              nodeId: null,
              role: role as "user" | "assistant",
              text: content,
              attachments: [],
              streaming: false,
              createdBy: role === "user" ? ("user" as const) : ("agent" as const),
              creationSource: "provider" as const,
              createdAt: at,
              updatedAt: at,
            },
          ];
        });
        return { providerThread: bound, providerTurns: [], messages, runtimeRequests: [] };
      });
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: OMP_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return session;
        },
        events: Stream.fromQueue(output),
        hasPendingBackgroundWork: Effect.sync(() => pendingBackground),
        backgroundTasksEndWithProcess: true,
        ensureThread,
        resumeThread: (resume) =>
          ensureThread({
            threadId: resume.threadId ?? resume.providerThread.appThreadId ?? input.threadId,
            existingProviderThread: resume.providerThread,
            modelSelection: resume.modelSelection ?? input.modelSelection,
            runtimePolicy: resume.runtimePolicy ?? input.runtimePolicy,
          }),
        startTurn: (turnInput) => start(turnInput, false),
        compactThread: (turnInput) => start(turnInput, true),
        steerTurn: Effect.fn("OmpAdapter.steerTurn")(function* (steer) {
          if (active?.entity.id !== steer.providerTurnId)
            return yield* protocolError("OMP steer targets a stale turn");
          yield* request({ type: "steer", ...(yield* prepareMessage(steer.message)) });
        }),
        interruptTurn: Effect.fn("OmpAdapter.interruptTurn")(function* (interrupt) {
          const turn = active;
          if (turn === null || turn.entity.id !== interrupt.providerTurnId) return;
          turn.interrupted = true;
          turn.retire = true;
          closed = true;
          // OMP abort leaves asynchronous bash/eval jobs alive; retiring the process also stops their wakeups.
          yield* request({ type: "abort_and_restore_queue" }).pipe(Effect.ignore);
          yield* connection.terminate;
          if (launch.unit !== undefined) yield* agentScope.stop(launch.unit);
          yield* eventPermit.withPermits(1)(finish(turn, { status: "aborted" }, true));
          yield* Queue.end(output);
        }),
        stopSubagent: Effect.fn("OmpAdapter.stopSubagent")(function* (stop) {
          const child = subagents.get(stop.nativeTaskId);
          if (
            child === undefined ||
            (child.providerThreadId !== stop.providerThread.id &&
              child.threadId !== stop.providerThread.appThreadId)
          )
            return yield* protocolError("OMP child is not owned by this thread");
          if (
            stop.requestedAt !== undefined &&
            child.startedAt !== null &&
            DateTime.toEpochMillis(stop.requestedAt) < DateTime.toEpochMillis(child.startedAt)
          )
            return yield* protocolError("OMP child stop request predates this task");
          const result = record(
            yield* request({ type: "cancel_subagent", subagentId: stop.nativeTaskId }),
          );
          if (result.cancelled !== true && child.status === "running")
            return yield* protocolError("OMP did not confirm child cancellation");
        }),
        respondToRuntimeRequest: Effect.fn("OmpAdapter.respondToRuntimeRequest")(function* (
          response,
        ) {
          const pending = questions.get(response.requestId);
          if (pending === undefined)
            return yield* protocolError("OMP question is no longer pending");
          const answers = response.answers;
          let payload: RecordValue = { cancelled: true };
          if (pending.approvalOptions !== null && response.decision !== undefined) {
            const selected = ompApprovalChoice(pending.approvalOptions, response.decision);
            if (selected !== undefined) payload = { value: selected };
          } else if (answers !== undefined) {
            if (pending.method === "ask")
              payload = {
                answers: pending.questions.map((q) => {
                  const answer = answers[q.id];
                  const values =
                    typeof answer === "string"
                      ? [answer]
                      : entries(answer).filter((v): v is string => typeof v === "string");
                  const selectedOptions = values.filter((v) =>
                    q.options.some((o) => o.label === v),
                  );
                  const customInput = values.filter((v) => !selectedOptions.includes(v)).join("\n");
                  return { id: q.id, selectedOptions, ...(customInput ? { customInput } : {}) };
                }),
              };
            else if (pending.method === "confirm")
              payload = { confirmed: answers[pending.questions[0]!.id] === "Yes" };
            else {
              const value = answers[pending.questions[0]!.id];
              if (typeof value === "string") payload = { value };
            }
          }
          yield* send({ type: "extension_ui_response", id: pending.nativeId, ...payload });
          yield* finishQuestion(pending, payload.cancelled === true);
        }, eventPermit.withPermits(1)),
        readThreadSnapshot: readSnapshot,
        rollbackThread: Effect.fn("OmpAdapter.rollbackThread")(function* (rollback) {
          if (active !== null || pendingBackground)
            return yield* protocolError("Cannot roll back while native OMP work is active");
          if (
            thread === null ||
            thread.id !== rollback.providerThread.id ||
            thread.nativeThreadRef?.nativeId !== rollback.providerThread.nativeThreadRef?.nativeId
          )
            return yield* protocolError("OMP rollback belongs to another native session");
          const source = thread;
          const sourceFile = source.nativeThreadRef?.nativeId;
          if (sourceFile == null)
            return yield* protocolError("OMP rollback source has no persisted conversation");
          const turns = rollback.providerThreadTurns.filter(
            (turn) => turn.providerThreadId === source.id,
          );
          const target = rollback.target;
          if (
            target.type === "provider_turn" &&
            !turns.some((turn) => turn.id === target.providerTurn.id)
          )
            return yield* protocolError("OMP rollback target turn is missing");
          const keptOrdinal =
            rollback.target.type === "thread_start" ? 0 : rollback.target.providerTurn.ordinal;
          const boundary = yield* ompForkBoundary(turns, keptOrdinal);
          if (boundary.type === "latest") return yield* readSnapshot({ providerThread: source });
          const sessionFile = yield* forkOmpSession({
            sourceFile,
            boundary,
            command: options.settings.binaryPath || "omp",
            sessionDir,
            cwd,
            env: options.environment,
            ...(options.makeConnection === undefined
              ? {}
              : { makeConnection: options.makeConnection }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
          if (thread !== source || active !== null || pendingBackground)
            return yield* protocolError("OMP rollback ownership changed while forking");
          const updated = yield* ensureThread(
            {
              threadId: source.appThreadId ?? input.threadId,
              modelSelection: input.modelSelection,
              runtimePolicy: input.runtimePolicy,
              existingProviderThread: {
                ...source,
                goal: null,
                nativeThreadRef: ref(sessionFile),
                nativeConversationHeadRef: null,
              },
            },
            sessionFile,
          );
          return yield* readSnapshot({ providerThread: updated });
        }),
        forkThread: Effect.fn("OmpAdapter.forkThread")(function* (fork) {
          if (active !== null || pendingBackground)
            return yield* protocolError("Cannot fork while native OMP work is active");
          const source = fork.sourceProviderThread;
          const sourceFile = source.nativeThreadRef?.nativeId;
          if (sourceFile == null)
            return yield* protocolError("OMP fork source has no persisted conversation");
          const turns = (fork.sourceProviderTurns ?? []).filter(
            (turn) => turn.providerThreadId === source.id,
          );
          const target = turns.find((turn) => turn.id === fork.providerTurnId);
          if (fork.providerTurnId !== undefined && target === undefined)
            return yield* protocolError("OMP fork target turn is missing");
          const boundary =
            target === undefined
              ? { type: "latest" as const }
              : yield* ompForkBoundary(turns, target.ordinal);
          const sessionFile = yield* forkOmpSession({
            sourceFile,
            boundary,
            command: options.settings.binaryPath || "omp",
            sessionDir,
            cwd: fork.runtimePolicy?.cwd ?? cwd,
            env: options.environment,
            ...(options.makeConnection === undefined
              ? {}
              : { makeConnection: options.makeConnection }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
          const at = yield* DateTime.now;
          return yield* ensureThread(
            {
              threadId: fork.targetThreadId,
              modelSelection: fork.modelSelection ?? input.modelSelection,
              runtimePolicy: fork.runtimePolicy ?? input.runtimePolicy,
              existingProviderThread: {
                ...source,
                goal: boundary.type === "latest" ? source.goal : null,
                id: ids.derive.providerThread({
                  driver: OMP_PROVIDER,
                  nativeThreadId: sessionFile,
                }),
                appThreadId: fork.targetThreadId,
                ownerNodeId: fork.ownerNodeId ?? null,
                nativeThreadRef: ref(sessionFile),
                nativeConversationHeadRef: null,
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                pendingBackgroundTasks: [],
                forkedFrom: {
                  providerThreadId: source.id,
                  ...(fork.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: fork.providerTurnId }),
                },
                createdAt: at,
                updatedAt: at,
              },
            },
            sessionFile,
          );
        }),
      };
      return runtime;
    }),
  });
});

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | McpProviderSessions.McpProviderSessions;
export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_PROVIDER,
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input) {
      const environment = yield* HostProcess.Environment;
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, environment),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create native OMP adapter",
              cause,
            }),
        ),
      ),
  ),
};
