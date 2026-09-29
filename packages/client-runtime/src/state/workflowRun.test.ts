import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  deriveAgentPanelModel,
  foldSubagentActivities,
  subagentDisplayState,
  type RuntimeSubagent,
} from "./subagentRuntime.ts";
import {
  arrangeWorkflowRuns,
  sharedLabelPrefix,
  splitMemberLabel,
  summarizeWorkflowRun,
  workflowStepOpensByDefault,
} from "./workflowRun.ts";

function agent(
  partial: Partial<RuntimeSubagent> & Pick<RuntimeSubagent, "id" | "title">,
): RuntimeSubagent {
  return {
    kind: "workflow_agent",
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-27T20:00:00.000Z",
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-27T20:00:00.000Z",
    ...partial,
  };
}

function workflow(
  id: string,
  status: RuntimeSubagent["status"],
  phases: ReadonlyArray<string>,
  startedAt = "2026-09-27T20:00:00.000Z",
): RuntimeSubagent {
  return agent({
    id,
    kind: "workflow",
    title: "Audit the app across design dimensions, then synthesize proposals",
    workflowName: "design-audit",
    status,
    phases: phases.map((title, index) => ({ index: index + 1, title })),
    firstSeenAt: startedAt,
    startedAt,
  });
}

function member(
  parent: RuntimeSubagent,
  index: number,
  phaseIndex: number,
  status: RuntimeSubagent["status"],
  extra: Partial<RuntimeSubagent> = {},
): RuntimeSubagent {
  return agent({
    id: `${parent.id}:wf:${index}`,
    title: `audit:dimension-${index}`,
    parentAgentId: parent.id,
    agentIndex: index,
    phaseIndex,
    status,
    ...extra,
  });
}

const tokens = (totalTokens: number) => ({ usage: { totalTokens } });

function onlyGroup(agents: ReadonlyArray<RuntimeSubagent>) {
  const group = deriveAgentPanelModel({ agents }).workflows[0];
  if (!group) throw new Error("expected one workflow group");
  return group;
}

describe("subagentDisplayState", () => {
  const live = workflow("wf", "running", ["Audit"]);
  const stopped = workflow("wf", "interrupted", ["Audit"]);

  it("reads a pending member that has done work as running, and one that has not as queued", () => {
    expect(subagentDisplayState(member(live, 1, 1, "pending", tokens(900)), live)).toBe("running");
    expect(subagentDisplayState(member(live, 2, 1, "pending"), live)).toBe("queued");
  });

  it("tells members a stopped run cut short from ones that never started", () => {
    expect(subagentDisplayState(member(stopped, 1, 1, "interrupted", tokens(900)), stopped)).toBe(
      "stopped",
    );
    expect(subagentDisplayState(member(stopped, 2, 1, "interrupted"), stopped)).toBe("notRun");
  });
});

describe("a stopped run through the activity fold", () => {
  let sequence = 0;
  const row = (kind: string, payload: Record<string, unknown>): OrchestrationThreadActivity => {
    sequence += 1;
    return {
      id: `activity-${sequence}`,
      tone: "info",
      kind,
      summary: kind,
      payload: { agentKind: "agent", ...payload },
      turnId: null,
      createdAt: `2026-09-27T20:00:${String(sequence).padStart(2, "0")}.000Z`,
    } as unknown as OrchestrationThreadActivity;
  };
  const memberRow = (index: number, phaseIndex: number, extra: Record<string, unknown>) =>
    row("task.progress", {
      taskId: `wf:wf:${index}`,
      title: `impl:${index}`,
      parentAgentId: "wf",
      agentIndex: index,
      phaseIndex,
      ...extra,
    });

  it("names the phase it stopped in and marks queued agents as never run", () => {
    const agents = foldSubagentActivities([
      row("task.started", {
        taskId: "wf",
        taskType: "local_workflow",
        workflowName: "design-round-1",
        title: "Implement, then review",
      }),
      row("task.progress", {
        taskId: "wf",
        taskType: "local_workflow",
        phases: [
          { index: 1, title: "Implement" },
          { index: 2, title: "Review" },
        ],
      }),
      memberRow(1, 1, { status: "running", typedUsage: { totalTokens: 5_000 } }),
      memberRow(2, 1, { status: "completed", typedUsage: { totalTokens: 3_000 } }),
      memberRow(3, 2, { status: "pending" }),
      memberRow(4, 2, { status: "pending" }),
      row("task.completed", { taskId: "wf", status: "stopped" }),
    ]);
    const run = summarizeWorkflowRun(onlyGroup(agents));
    expect(run.state).toBe("stopped");
    expect(run.tally).toMatchObject({ done: 1, stopped: 1, notRun: 2, running: 0, queued: 0 });
    expect(run.steps.map((step) => step.state)).toEqual(["stopped", "notRun"]);
    expect(run.headline).toBe("Stopped in Implement");
  });
});

describe("summarizeWorkflowRun", () => {
  it("says where a live run is and what comes next", () => {
    const wf = workflow("wf", "running", ["Audit", "Synthesize", "Critique"]);
    const run = summarizeWorkflowRun(
      onlyGroup([
        wf,
        member(wf, 1, 1, "completed", tokens(140_000)),
        member(wf, 2, 1, "running", tokens(171_000)),
        member(wf, 3, 1, "pending"),
      ]),
    );
    expect(run.state).toBe("running");
    expect(run.headline).toBe("Phase 1 of 3 · Audit");
    expect(run.next?.title).toBe("Synthesize");
    expect(run.tally).toMatchObject({ done: 1, running: 1, queued: 1 });
    expect(run.tokens).toBe(311_000);
    expect(run.steps.map((step) => step.state)).toEqual(["running", "waiting", "waiting"]);
  });

  it("keeps a live run moving between phases before the next agents launch", () => {
    const wf = workflow("wf", "running", ["Audit", "Synthesize"]);
    const run = summarizeWorkflowRun(onlyGroup([wf, member(wf, 1, 1, "completed", tokens(10))]));
    expect(run.state).toBe("running");
    expect(run.steps.map((step) => step.state)).toEqual(["done", "starting"]);
    expect(run.headline).toBe("Phase 2 of 2 · Synthesize");
  });

  it("reports a run whose agents all failed as failed even when the coordinator says completed", () => {
    const wf = workflow("wf", "completed", ["Audit", "Synthesize"]);
    const error = "You've hit your session limit · resets 3:10pm";
    const run = summarizeWorkflowRun(
      onlyGroup([
        wf,
        member(wf, 1, 1, "failed", { ...tokens(102_000), error }),
        member(wf, 2, 1, "failed", { error }),
        member(wf, 3, 2, "failed", { error }),
      ]),
    );
    expect(run.state).toBe("failed");
    expect(run.headline).toBe("Failed in Audit");
    expect(run.error).toBe(error);
    // The run-level error is shown once, not repeated under each step.
    expect(run.steps.flatMap((step) => step.errors)).toEqual([]);
  });

  it("keeps a failed coordinator's outcome when its agents completed", () => {
    const wf = workflow("wf", "failed", ["Audit"]);
    const run = summarizeWorkflowRun(onlyGroup([wf, member(wf, 1, 1, "completed", tokens(10))]));
    expect(run.state).toBe("failed");
  });

  it("does not number agents that run outside any declared phase", () => {
    const wf = workflow("wf", "running", ["Implement", "Review"]);
    const scout = agent({ id: "wf:wf:9", title: "scout", parentAgentId: "wf", status: "running" });
    const run = summarizeWorkflowRun(
      onlyGroup([wf, member(wf, 1, 1, "completed", tokens(1)), { ...scout, ...tokens(1) }]),
    );
    expect(run.steps.map((step) => [step.title, step.ordinal])).toEqual([
      ["Implement", 1],
      ["Review", 2],
      ["Other agents", null],
    ]);
    expect(run.headline).toBe("Other agents");
    expect(run.next?.title).toBe("Review");
  });

  it("does not claim every phase completed when the script skipped one", () => {
    const wf = workflow("wf", "completed", ["Audit", "Fix"]);
    const run = summarizeWorkflowRun(onlyGroup([wf, member(wf, 1, 1, "completed", tokens(10))]));
    expect(run.state).toBe("done");
    expect(run.steps.map((step) => step.state)).toEqual(["done", "notRun"]);
    expect(run.headline).toBe("Completed 1 of 2 phases");
  });

  it("groups distinct member errors per step", () => {
    const wf = workflow("wf", "running", ["Verify"]);
    const run = summarizeWorkflowRun(
      onlyGroup([
        wf,
        member(wf, 1, 1, "failed", { error: "API overloaded" }),
        member(wf, 2, 1, "failed", { error: "API overloaded" }),
        member(wf, 3, 1, "running", tokens(5)),
      ]),
    );
    expect(run.steps[0]?.errors).toEqual([
      { text: "API overloaded", labels: ["audit:dimension-1", "audit:dimension-2"] },
    ]);
  });
});

describe("arrangeWorkflowRuns", () => {
  it("puts the live run in focus even when an older run is newer in the list", () => {
    const old = workflow("old", "completed", ["Audit"], "2026-09-27T18:00:00.000Z");
    const current = workflow("live", "running", ["Audit"], "2026-09-27T19:00:00.000Z");
    const newestSettled = workflow("done", "completed", ["Audit"], "2026-09-27T19:30:00.000Z");
    const { workflows } = deriveAgentPanelModel({ agents: [old, current, newestSettled] });
    const { focus, others } = arrangeWorkflowRuns(workflows);
    expect(focus?.workflow.id).toBe("live");
    expect(others.map((group) => group.workflow.id)).toEqual(["done", "old"]);
  });

  it("focuses the newest run when nothing is live", () => {
    const old = workflow("old", "completed", ["Audit"], "2026-09-27T18:00:00.000Z");
    const newer = workflow("newer", "failed", ["Audit"], "2026-09-27T19:00:00.000Z");
    const { workflows } = deriveAgentPanelModel({ agents: [old, newer] });
    expect(arrangeWorkflowRuns(workflows).focus?.workflow.id).toBe("newer");
  });

  it("focuses the run the user opened, even while another is live", () => {
    const opened = workflow("opened", "completed", ["Audit"], "2026-09-27T18:00:00.000Z");
    const current = workflow("live", "running", ["Audit"], "2026-09-27T19:00:00.000Z");
    const { workflows } = deriveAgentPanelModel({ agents: [opened, current] });
    expect(arrangeWorkflowRuns(workflows, "opened").focus?.workflow.id).toBe("opened");
  });
});

describe("workflowStepOpensByDefault", () => {
  it("opens in-flight steps of a live run and troubled steps of a settled one", () => {
    const liveWf = workflow("live", "running", ["Audit", "Synthesize"]);
    const liveRun = summarizeWorkflowRun(
      onlyGroup([
        liveWf,
        member(liveWf, 1, 1, "running", tokens(1)),
        member(liveWf, 2, 1, "completed", tokens(1)),
      ]),
    );
    expect(liveRun.steps.map((step) => workflowStepOpensByDefault(step, liveRun))).toEqual([
      true,
      false,
    ]);

    const doneWf = workflow("done", "completed", ["Audit", "Verify"]);
    const doneRun = summarizeWorkflowRun(
      onlyGroup([
        doneWf,
        member(doneWf, 1, 1, "completed", tokens(1)),
        member(doneWf, 2, 1, "completed", tokens(1)),
        member(doneWf, 3, 2, "failed", tokens(1)),
        member(doneWf, 4, 2, "completed", tokens(1)),
      ]),
    );
    expect(doneRun.steps.map((step) => workflowStepOpensByDefault(step, doneRun))).toEqual([
      false,
      true,
    ]);
  });
});

describe("member labels", () => {
  it("keeps the part of a path label that tells siblings apart", () => {
    const labels = [
      "verify:apps/server/src/provider/Layers/ClaudeAdapter.ts:3525",
      "verify:apps/server/src/provider/Layers/ClaudeAdapter.ts:3525#2",
    ];
    const prefix = sharedLabelPrefix(labels);
    expect(prefix).toBe("verify:");
    expect(splitMemberLabel(labels[1] ?? "", prefix)).toEqual({
      name: "ClaudeAdapter.ts:3525",
      replica: "2",
      context: "apps/server/src/provider/Layers",
    });
  });

  it("only strips a prefix every label shares", () => {
    expect(sharedLabelPrefix(["audit:tokens", "review:tokens"])).toBeNull();
    expect(sharedLabelPrefix(["synthesize"])).toBeNull();
    // A file path is not a kind prefix; stripping it would leave bare line numbers.
    expect(sharedLabelPrefix(["src/a.ts:10", "src/a.ts:20"])).toBeNull();
  });
});

describe("provider start times", () => {
  it("time a workflow member from when the provider says it started", () => {
    const [member] = foldSubagentActivities([
      {
        id: "activity-start",
        tone: "info",
        kind: "task.progress",
        summary: "task.progress",
        payload: {
          agentKind: "agent",
          taskId: "wf:wf:1",
          title: "survey:auth.ts",
          parentAgentId: "wf",
          status: "running",
          summary: "sleep 25",
          startedAt: "2026-09-29T00:10:00.000Z",
        },
        turnId: null,
        // The row arrived (or survived a reload) well after the agent started.
        createdAt: "2026-09-29T00:10:40.000Z",
      } as unknown as OrchestrationThreadActivity,
    ]);
    expect(member?.startedAt).toBe("2026-09-29T00:10:00.000Z");
    expect(member?.progress).toBe("sleep 25");
  });
});

describe("run duration", () => {
  it("prefers the provider-reported duration once a run settles", () => {
    // The client first saw this run one second before it ended (older
    // activity rows were not loaded), but the provider reports 22m 48s.
    const wf = {
      ...workflow("wf", "completed", ["Draft"], "2026-09-27T21:36:35.000Z"),
      completedAt: "2026-09-27T21:36:36.000Z",
      usage: { totalTokens: 1_549_544, durationMs: 1_368_191 },
    };
    const run = summarizeWorkflowRun(onlyGroup([wf, member(wf, 1, 1, "completed", tokens(1))]));
    expect(run.durationMs).toBe(1_368_191);
  });

  it("has no settled duration while the run is live", () => {
    const wf = workflow("wf", "running", ["Draft"]);
    expect(summarizeWorkflowRun(onlyGroup([wf])).durationMs).toBeNull();
  });
});
