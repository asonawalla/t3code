/**
 * Workflow run view model: turns one AgentPanelWorkflowGroup into what the
 * Agents panel and the chat card show — honest member states, one step per
 * declared phase, and a run summary that says where the run is, what is in
 * flight, and what comes next. Pure; timestamps are returned as epoch
 * milliseconds so callers own the clock (live elapsed text ticks in the DOM).
 */
import {
  isTerminalSubagentStatus,
  subagentDisplayState,
  type AgentPanelWorkflowGroup,
  type RuntimeSubagent,
  type SubagentDisplayState,
} from "./subagentRuntime.ts";

export type DisplayStateTally = Record<SubagentDisplayState, number>;

export function tallyDisplayStates(states: ReadonlyArray<SubagentDisplayState>): DisplayStateTally {
  const tally: DisplayStateTally = {
    running: 0,
    waiting: 0,
    queued: 0,
    idle: 0,
    done: 0,
    failed: 0,
    stopped: 0,
    notRun: 0,
  };
  for (const state of states) tally[state] += 1;
  return tally;
}

export type WorkflowStepState =
  | "running"
  | "queued"
  | "starting"
  | "waiting"
  | "done"
  | "partial"
  | "failed"
  | "stopped"
  | "notRun";

export interface WorkflowStepError {
  readonly text: string;
  readonly labels: ReadonlyArray<string>;
}

export interface WorkflowStep {
  readonly key: string;
  /** 1-based position among declared phases, for "Phase 2 of 3"; null for agents outside any phase. */
  readonly ordinal: number | null;
  readonly title: string;
  readonly members: ReadonlyArray<RuntimeSubagent>;
  readonly states: ReadonlyArray<SubagentDisplayState>;
  readonly tally: DisplayStateTally;
  readonly state: WorkflowStepState;
  /** `audit:` when every member label shares it; rows drop it. */
  readonly prefix: string | null;
  readonly tokens: number;
  /** Earliest observed member start; null when the client never saw one start. */
  readonly startedAt: number | null;
  /** Latest member completion once the step settled; null while it runs. */
  readonly endedAt: number | null;
  /** Previous step's title, for "waiting on Audit". */
  readonly waitingOn: string | null;
  /** Distinct member errors, excluding the run-level error. */
  readonly errors: ReadonlyArray<WorkflowStepError>;
  /** Every member shares one state, so rows need not repeat it. */
  readonly uniform: boolean;
  /** Every failed member reported zero tokens: the step died before doing work. */
  readonly neverStarted: boolean;
}

export type WorkflowRunState = "starting" | "running" | "done" | "partial" | "failed" | "stopped";

export interface WorkflowRunSummary {
  readonly state: WorkflowRunState;
  readonly live: boolean;
  readonly name: string;
  /** The coordinator's task sentence, when the run also has a short name. */
  readonly task: string | null;
  readonly steps: ReadonlyArray<WorkflowStep>;
  /** The step the headline talks about. */
  readonly current: WorkflowStep | null;
  /** First step still waiting after the current one, for "next Synthesize". */
  readonly next: WorkflowStep | null;
  readonly headline: string;
  readonly tally: DisplayStateTally;
  readonly total: number;
  readonly tokens: number;
  /** Coordinator start; live elapsed time ticks from here. */
  readonly startedAt: number | null;
  /**
   * Settled runs: the provider-reported duration, else end − start. The
   * reported value wins because the client's start time can be missing or
   * late when older activity rows were not loaded. Null while live.
   */
  readonly durationMs: number | null;
  readonly error: string | null;
}

/** Shared `kind:` prefix of every label, when stripping it leaves each label non-empty. */
export function sharedLabelPrefix(labels: ReadonlyArray<string>): string | null {
  // Only a bare word counts as a kind; `src/a.ts:10` must stay whole.
  const prefix = /^[A-Za-z][\w-]*:/.exec(labels[0] ?? "")?.[0];
  if (prefix === undefined) return null;
  return labels.every((label) => label.startsWith(prefix) && label.length > prefix.length)
    ? prefix
    : null;
}

/**
 * Splits a member label into the part that tells siblings apart and the part
 * that is context: `verify:apps/web/src/Foo.tsx:158#2` under a `verify:`
 * step becomes name `Foo.tsx:158`, replica `2`, context `apps/web/src`.
 */
export function splitMemberLabel(
  label: string,
  prefix: string | null,
): { name: string; replica: string | null; context: string | null } {
  let rest = prefix !== null && label.startsWith(prefix) ? label.slice(prefix.length) : label;
  const replicaMatch = /#(\d+)$/.exec(rest);
  const replica = replicaMatch?.[1] ?? null;
  if (replicaMatch) rest = rest.slice(0, replicaMatch.index);
  const slash = rest.lastIndexOf("/");
  if (slash > 0 && slash < rest.length - 1) {
    return { name: rest.slice(slash + 1), replica, context: rest.slice(0, slash) };
  }
  return { name: rest, replica, context: null };
}

/** Characters a middle truncation keeps: the `:line` of `file.ts:412`, else the extension. */
export function memberLabelTail(name: string): number {
  const colon = name.lastIndexOf(":");
  if (colon > 0) return name.length - colon;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.length - dot : 0;
}

export function parseTimestamp(iso: string | null): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/** end − start when both are known. */
export function spanMs(start: number | null, end: number | null): number | null {
  return start !== null && end !== null ? end - start : null;
}

function workflowMembers(group: AgentPanelWorkflowGroup): RuntimeSubagent[] {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/** One error shared by every failed member of an all-failed run, or the coordinator's own. */
export function workflowRunError(group: AgentPanelWorkflowGroup): string | null {
  if (group.workflow.error) return group.workflow.error;
  const members = workflowMembers(group);
  if (members.length === 0 || !members.every((member) => member.status === "failed")) return null;
  const errors = new Set(members.map((member) => member.error ?? ""));
  const [only] = errors;
  return errors.size === 1 && only ? only : null;
}

function isStepActive(state: WorkflowStepState): boolean {
  return state === "running" || state === "queued" || state === "starting";
}

function settledStepState(tally: DisplayStateTally, total: number): WorkflowStepState {
  if (tally.notRun === total) return "notRun";
  if (tally.failed === total) return "failed";
  if (tally.stopped + tally.notRun > 0) return "stopped";
  if (tally.failed > 0) return "partial";
  return "done";
}

function earliest(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

function latest(values: ReadonlyArray<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

export function deriveWorkflowSteps(group: AgentPanelWorkflowGroup): WorkflowStep[] {
  const coordinator = group.workflow;
  const runLive = !isTerminalSubagentStatus(coordinator.status);
  const sharedError = workflowRunError(group);
  const sources = group.phases.map((phase) => ({
    key: `phase-${phase.index}`,
    title: phase.title,
    members: phase.members,
  }));
  if (group.unphasedMembers.length > 0) {
    sources.push({
      key: "unphased",
      title: sources.length > 0 ? "Other agents" : "Agents",
      members: group.unphasedMembers,
    });
  }

  const steps = sources.map((source, position): WorkflowStep => {
    const states = source.members.map((member) => subagentDisplayState(member, coordinator));
    const tally = tallyDisplayStates(states);
    const total = states.length;
    const state: WorkflowStepState =
      total === 0
        ? runLive
          ? "waiting"
          : "notRun"
        : tally.running + tally.waiting + tally.idle > 0
          ? "running"
          : tally.queued === total
            ? "queued"
            : tally.queued > 0
              ? "running"
              : settledStepState(tally, total);
    const errorsByText = new Map<string, string[]>();
    source.members.forEach((member, index) => {
      if (states[index] !== "failed" || !member.error || member.error === sharedError) return;
      const labels = errorsByText.get(member.error) ?? [];
      labels.push(member.title);
      errorsByText.set(member.error, labels);
    });
    return {
      key: source.key,
      ordinal: position < group.phases.length ? position + 1 : null,
      title: source.title,
      members: source.members,
      states,
      tally,
      state,
      prefix: sharedLabelPrefix(source.members.map((member) => member.title)),
      tokens: source.members.reduce((sum, member) => sum + (member.usage?.totalTokens ?? 0), 0),
      startedAt: earliest(source.members.map((member) => parseTimestamp(member.startedAt))),
      endedAt: isStepActive(state)
        ? null
        : latest(source.members.map((member) => parseTimestamp(member.completedAt))),
      waitingOn: position > 0 ? (sources[position - 1]?.title ?? null) : null,
      errors: Array.from(errorsByText, ([text, labels]) => ({ text, labels })),
      uniform: states.every((value) => value === states[0]),
      neverStarted:
        tally.failed > 0 &&
        source.members.every(
          (member, index) => states[index] !== "failed" || (member.usage?.totalTokens ?? 0) === 0,
        ),
    };
  });

  // A live coordinator with nothing in flight is setting up its next phase.
  if (runLive && !steps.some((step) => isStepActive(step.state))) {
    const phaseCount = group.phases.length;
    const lastStarted = steps.slice(0, phaseCount).findLastIndex((step) => step.members.length > 0);
    const next = lastStarted + 1 < phaseCount ? steps[lastStarted + 1] : undefined;
    if (next && next.state === "waiting") {
      steps[lastStarted + 1] = { ...next, state: "starting" };
    }
  }
  return steps;
}

function pickCurrentStep(
  steps: ReadonlyArray<WorkflowStep>,
  state: WorkflowRunState,
): WorkflowStep | null {
  const find = (predicate: (step: WorkflowStep) => boolean) => steps.find(predicate) ?? null;
  switch (state) {
    case "running":
    case "starting":
      return (
        // Prefer a declared phase over agents that run outside any phase.
        steps.findLast((step) => isStepActive(step.state) && step.ordinal !== null) ??
        steps.findLast((step) => isStepActive(step.state)) ??
        find((step) => step.state !== "done") ??
        steps.at(-1) ??
        null
      );
    case "failed":
      return find((step) => step.state === "failed" || step.state === "partial");
    case "stopped":
      return (
        steps.findLast((step) => step.state === "stopped") ??
        find((step) => step.state === "notRun")
      );
    case "partial":
      return find((step) => step.state === "partial" || step.state === "failed");
    case "done":
      return null;
  }
}

function runHeadline(
  state: WorkflowRunState,
  current: WorkflowStep | null,
  steps: ReadonlyArray<WorkflowStep>,
  phaseCount: number,
  tally: DisplayStateTally,
): string {
  switch (state) {
    case "running":
    case "starting":
      if (!current) return "Starting";
      return phaseCount > 1 && current.ordinal !== null
        ? `Phase ${current.ordinal} of ${phaseCount} · ${current.title}`
        : current.title;
    case "failed":
      return current ? `Failed in ${current.title}` : "Failed";
    case "stopped":
      return current ? `Stopped in ${current.title}` : "Stopped";
    case "partial":
      return `Completed with ${tally.failed} failed`;
    case "done": {
      if (phaseCount <= 1) return "Completed";
      // A script may skip a declared phase; only claim "all" when each one ran.
      const ran = steps.filter((step) => step.ordinal !== null && step.state !== "notRun").length;
      return ran === phaseCount
        ? `Completed all ${phaseCount} phases`
        : `Completed ${ran} of ${phaseCount} phases`;
    }
  }
}

export function summarizeWorkflowRun(group: AgentPanelWorkflowGroup): WorkflowRunSummary {
  const coordinator = group.workflow;
  const live = !isTerminalSubagentStatus(coordinator.status);
  const steps = deriveWorkflowSteps(group);
  const tally = tallyDisplayStates(steps.flatMap((step) => step.states));
  const total = steps.reduce((sum, step) => sum + step.members.length, 0);
  const state: WorkflowRunState = live
    ? total === tally.queued
      ? "starting"
      : "running"
    : // A coordinator can report completed after every member failed.
      (total > 0 && tally.failed === total) || coordinator.status === "failed"
      ? "failed"
      : coordinator.status === "cancelled" ||
          coordinator.status === "interrupted" ||
          tally.stopped + tally.notRun > 0
        ? "stopped"
        : tally.failed > 0
          ? "partial"
          : "done";
  const current = pickCurrentStep(steps, state);
  const next =
    live && current
      ? (steps.find(
          (step) =>
            step.ordinal !== null &&
            step.state === "waiting" &&
            (current.ordinal === null || step.ordinal > current.ordinal),
        ) ?? null)
      : null;
  const memberTokens = steps.reduce((sum, step) => sum + step.tokens, 0);
  const startedAt = parseTimestamp(coordinator.startedAt);
  const endedAt = parseTimestamp(coordinator.completedAt);
  return {
    state,
    live,
    name: coordinator.workflowName ?? coordinator.title,
    task: coordinator.workflowName ? coordinator.title : null,
    steps,
    current,
    next,
    headline: runHeadline(state, current, steps, group.phases.length, tally),
    tally,
    total,
    // Member rows are what the user sees, so the header adds up to them.
    tokens: total > 0 ? memberTokens : (coordinator.usage?.totalTokens ?? 0),
    startedAt,
    durationMs: live ? null : (coordinator.usage?.durationMs ?? spanMs(startedAt, endedAt)),
    error: workflowRunError(group),
  };
}

/**
 * The run the user asked for leads (the chat card they clicked), else the
 * newest live run, else the newest run. Everything else is history.
 */
export function arrangeWorkflowRuns(
  workflows: ReadonlyArray<AgentPanelWorkflowGroup>,
  preferredId: string | null = null,
): {
  focus: AgentPanelWorkflowGroup | null;
  others: AgentPanelWorkflowGroup[];
} {
  const startOf = (group: AgentPanelWorkflowGroup) =>
    group.workflow.startedAt ?? group.workflow.firstSeenAt;
  const newestFirst = [...workflows].sort((a, b) => startOf(b).localeCompare(startOf(a)));
  const focus =
    newestFirst.find((group) => group.workflow.id === preferredId) ??
    newestFirst.find((group) => !isTerminalSubagentStatus(group.workflow.status)) ??
    newestFirst[0] ??
    null;
  return { focus, others: newestFirst.filter((group) => group !== focus) };
}

/** Steps open by default: whatever is in flight, and whatever went wrong in a settled run. */
export function workflowStepOpensByDefault(step: WorkflowStep, run: WorkflowRunSummary): boolean {
  // A one-agent step already says everything in its own header line.
  if (step.members.length <= 1) return false;
  if (run.live) return step.state === "running" || step.state === "queued";
  return step.state === "failed" || step.state === "partial" || step.state === "stopped";
}
