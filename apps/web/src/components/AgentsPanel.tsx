/**
 * Agents right-panel surface, read like a CI run page. The thread's live
 * workflow run (or its newest run when nothing is live) owns the panel: a
 * pinned header says what the run is for, where it is, and what comes next;
 * below it every declared phase is a step on a vertical rail. Settled steps
 * are one summary line, active steps list their agents as one-line rows.
 * Direct subagents and earlier runs sit quietly below.
 *
 * Visualization rules:
 * - Spawn order is stable and rows never change height as data arrives.
 * - Statuses come from subagentDisplayState, never the raw wire status.
 * - Static glyphs and dots; elapsed text ticks through DOM writes only.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
  SubagentDisplayState,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isTerminalSubagentStatus,
  subagentDisplayState,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  arrangeWorkflowRuns,
  memberLabelTail,
  parseTimestamp,
  spanMs,
  splitMemberLabel,
  summarizeWorkflowRun,
  workflowStepOpensByDefault,
  type WorkflowRunState,
  type WorkflowRunSummary,
  type WorkflowStep,
  type WorkflowStepError,
  type WorkflowStepState,
} from "@t3tools/client-runtime/state/workflowRun";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  Bot,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleStop,
  CircleX,
  Copy,
  Ellipsis,
  FolderOpen,
  RotateCw,
  X,
} from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { orchestrationEnvironment } from "~/state/orchestration";
import { showAnchoredCopySuccessToast } from "~/components/ui/anchoredCopyToast";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { MiddleTruncate } from "~/components/ui/middle-truncate";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * Elapsed text. Live spans render no children and self-tick via DOM writes
 * (zero React commits per tick; the layout effect fills them before paint).
 * Settled spans show the duration the caller computed.
 */
function Elapsed({
  live,
  start,
  settledMs,
}: {
  live: boolean;
  start: number | null;
  settledMs: number | null;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const tickFrom = live ? start : null;

  useLayoutEffect(() => {
    if (tickFrom === null) return;
    const update = () => {
      // Clamped: start times come from the server clock, which can run ahead of this one.
      if (textRef.current) {
        textRef.current.textContent = formatDuration(Math.max(0, Date.now() - tickFrom));
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [tickFrom]);

  if (tickFrom !== null) return <span ref={textRef} />;
  return <span>{live ? "" : formatDuration(settledMs)}</span>;
}

/** Elapsed for one agent's current activation. */
function AgentElapsed({ agent, live }: { agent: RuntimeSubagent; live: boolean }) {
  const start = parseTimestamp(agent.startedAt);
  return (
    <Elapsed
      live={live}
      start={start}
      settledMs={spanMs(start, parseTimestamp(agent.completedAt))}
    />
  );
}

function formatTokens(tokens: number): string {
  return tokens > 0 ? formatSubagentTokenCount(tokens) : "";
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const STEP_GLYPH: Record<
  WorkflowStepState,
  { icon: typeof CircleDot; tone: string; label: string }
> = {
  running: { icon: CircleDot, tone: "text-info", label: "Running" },
  starting: { icon: CircleDot, tone: "text-info", label: "Starting" },
  queued: { icon: CircleDashed, tone: "text-info", label: "Queued" },
  waiting: { icon: CircleDashed, tone: "text-muted-foreground/50", label: "Waiting" },
  done: { icon: CircleCheck, tone: "text-success", label: "Done" },
  partial: { icon: CircleAlert, tone: "text-warning", label: "Done with failures" },
  failed: { icon: CircleX, tone: "text-destructive", label: "Failed" },
  stopped: { icon: CircleStop, tone: "text-muted-foreground", label: "Stopped" },
  notRun: { icon: CircleSlash, tone: "text-muted-foreground/50", label: "Not run" },
};

const RUN_TO_STEP: Record<WorkflowRunState, WorkflowStepState> = {
  starting: "starting",
  running: "running",
  done: "done",
  partial: "partial",
  failed: "failed",
  stopped: "stopped",
};

function StepGlyph({ state, className }: { state: WorkflowStepState; className?: string }) {
  const { icon: Icon, tone, label } = STEP_GLYPH[state];
  return <Icon aria-label={label} className={cn("size-3.5 shrink-0", tone, className)} />;
}

const DOT_CLASS: Record<SubagentDisplayState, string> = {
  running: "bg-info",
  waiting: "bg-warning",
  queued: "ring-1 ring-inset ring-muted-foreground/60",
  idle: "bg-muted-foreground/50",
  done: "bg-success",
  failed: "bg-destructive",
  stopped: "rounded-[1px] bg-muted-foreground/60",
  notRun: "ring-1 ring-inset ring-muted-foreground/35",
};

function StateDot({ state }: { state: SubagentDisplayState }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[state])} />;
}

// ---------------------------------------------------------------------------
// Progress bars
// ---------------------------------------------------------------------------

const BAR_ORDER: ReadonlyArray<[SubagentDisplayState, string]> = [
  ["done", "bg-success"],
  ["failed", "bg-destructive"],
  ["stopped", "bg-muted-foreground/50"],
  ["idle", "bg-muted-foreground/50"],
  ["running", "bg-info"],
  ["waiting", "bg-warning"],
];

/** One phase's slice of the run bar: settled first, in-flight next, queued is bare track. */
function StepBar({ step, className }: { step: WorkflowStep; className?: string }) {
  const total = step.members.length;
  return (
    <div
      className={cn("flex h-1.5 min-w-0 overflow-hidden rounded-full bg-foreground/10", className)}
    >
      {total > 0
        ? BAR_ORDER.map(([state, tone]) =>
            step.tally[state] > 0 ? (
              <span
                key={state}
                className={cn("h-full", tone)}
                style={{ width: `${(step.tally[state] / total) * 100}%` }}
              />
            ) : null,
          )
        : null}
    </div>
  );
}

/**
 * Whole-run progress: one equal segment per declared phase (future sizes are
 * unknown), matching "Phase N of M". A run without phases gets one segment.
 */
function RunBar({ steps }: { steps: ReadonlyArray<WorkflowStep> }) {
  const phases = steps.filter((step) => step.ordinal !== null);
  return (
    <div className="flex gap-1" aria-hidden>
      {(phases.length > 0 ? phases : steps).map((step) => (
        <StepBar key={step.key} step={step} className="flex-1" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Inline tally fragments separated by middots; empty children drop out. */
function Fragments({ children }: { children: ReactNode }) {
  return Children.toArray(children).flatMap((part, position) => {
    if (position === 0) return [part];
    const key = isValidElement(part) ? part.key : String(part);
    return [
      <span key={`sep${key}`} className="text-muted-foreground/40">
        ·
      </span>,
      part,
    ];
  });
}

/**
 * Identity first: the distinguishing name never truncates before its context
 * does. The context (a path's directory) sits on a wrapping line of fixed
 * height, so when there is no room it drops out instead of showing a stub.
 */
function MemberLabel({
  label,
  prefix,
  attempt,
}: {
  label: string;
  prefix: string | null;
  attempt: number;
}) {
  const parts = splitMemberLabel(label, prefix);
  const tail = memberLabelTail(parts.name);
  return (
    <span className="flex h-4 min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 overflow-hidden">
      <span className="flex max-w-full flex-none items-baseline overflow-hidden text-foreground/90">
        {parts.context !== null && tail > 0 ? (
          <MiddleTruncate value={parts.name} tail={tail} showTitle={false} />
        ) : (
          <span className="min-w-0 truncate">{parts.name}</span>
        )}
        {parts.replica !== null ? (
          <span className="shrink-0 pl-1 text-muted-foreground">#{parts.replica}</span>
        ) : null}
        {attempt > 1 ? (
          <span className="flex shrink-0 items-center gap-0.5 self-center pl-1.5 font-mono text-2xs text-muted-foreground">
            <RotateCw aria-hidden className="size-2.5" />
            <span className="sr-only">attempt</span>
            {attempt}
          </span>
        ) : null}
      </span>
      {parts.context !== null ? (
        <span className="hidden min-w-20 flex-1 basis-0 truncate text-2xs text-muted-foreground/60 @min-[25rem]:block">
          {parts.context}
        </span>
      ) : null}
    </span>
  );
}

const ACTIVITY: Record<SubagentDisplayState, { text: string | null; tone: string }> = {
  running: { text: null, tone: "text-foreground/80" },
  waiting: { text: "waiting", tone: "text-warning-foreground" },
  queued: { text: "queued", tone: "text-muted-foreground/60" },
  idle: { text: "idle", tone: "text-muted-foreground" },
  done: { text: null, tone: "text-muted-foreground/60" },
  failed: { text: "failed", tone: "text-destructive-foreground" },
  stopped: { text: "stopped", tone: "text-muted-foreground" },
  notRun: { text: "not run", tone: "text-muted-foreground/60" },
};

/** Right-hand columns shared by step headers and rows so numbers line up down the rail. */
function Columns({
  activity,
  tokens,
  time,
  trailing,
}: {
  activity?: ReactNode;
  tokens: string;
  time: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-2xs tabular-nums text-muted-foreground">
      {activity}
      <span className="w-10 text-right">{tokens}</span>
      <span className="w-12 text-right">{time}</span>
      <span className="flex w-3 justify-center">{trailing}</span>
    </span>
  );
}

function isLiveState(state: SubagentDisplayState): boolean {
  return state === "running" || state === "waiting";
}

function MemberRow({
  member,
  state,
  prefix,
  quiet,
}: {
  member: RuntimeSubagent;
  state: SubagentDisplayState;
  prefix: string | null;
  /** The step already names this row's state (all members share it). */
  quiet: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activity = ACTIVITY[state];
  const activityText =
    state === "running" ? (member.lastToolName ?? "working") : quiet ? null : activity.text;
  const attempt = member.attempt ?? member.activationCount;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-6 w-full items-center gap-2 rounded-sm pl-1.5 text-left text-xs hover:bg-accent/40"
      >
        <StateDot state={state} />
        <MemberLabel label={member.title} prefix={prefix} attempt={attempt} />
        <Columns
          activity={
            activityText ? (
              <span className={cn("w-14 truncate text-left", activity.tone)}>{activityText}</span>
            ) : undefined
          }
          tokens={formatTokens(member.usage?.totalTokens ?? 0)}
          time={<AgentElapsed agent={member} live={isLiveState(state)} />}
        />
      </button>
      {open ? <MemberDetails member={member} /> : null}
    </div>
  );
}

/** A path-like label that may wrap only after `/` or `:`, never mid-segment. */
function BreakableLabel({ value }: { value: string }) {
  let offset = 0;
  return value.split(/(?<=[/:])/).map((piece) => {
    const start = offset;
    offset += piece.length;
    return (
      <Fragment key={start}>
        {piece}
        {offset < value.length ? <wbr /> : null}
      </Fragment>
    );
  });
}

/** Click-to-open facts for one agent; the only place the full label and error text live. */
function MemberDetails({ member }: { member: RuntimeSubagent }) {
  const facts = [
    formatSubagentModelLabel(member.model, member.effort),
    member.usage ? `${formatSubagentTokenCount(member.usage.totalTokens)} tok` : null,
    member.usage?.toolUses !== undefined ? `${member.usage.toolUses} tool calls` : null,
    member.lastToolName ? `last ${member.lastToolName}` : null,
    (member.attempt ?? 1) > 1 ? `attempt ${member.attempt}` : null,
  ].filter((fact): fact is string => fact !== null);
  const detail = member.error ?? member.result ?? member.progress;
  return (
    <div className="mb-1.5 ml-3.5 mr-5 flex flex-col gap-1 border-l border-border/70 py-0.5 pl-2.5 text-2xs leading-snug">
      <span className="font-mono text-foreground/80">
        <BreakableLabel value={member.title} />
      </span>
      <span className="flex flex-wrap gap-x-3 font-mono text-muted-foreground">
        {facts.map((fact) => (
          <span key={fact} className="whitespace-nowrap">
            {fact}
          </span>
        ))}
      </span>
      {detail ? (
        <span className={member.error ? "text-destructive-foreground" : "text-muted-foreground"}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function StepSummary({ step }: { step: WorkflowStep }) {
  const { tally } = step;
  const total = step.members.length;
  const agents = `${total} ${total === 1 ? "agent" : "agents"}`;
  switch (step.state) {
    case "running": {
      const running = tally.running + tally.waiting;
      if (total === 1) {
        return (
          <Fragments>
            <span className="text-info-foreground">running</span>
            {step.members[0]?.lastToolName ? (
              <span className="font-mono">{step.members[0].lastToolName}</span>
            ) : null}
          </Fragments>
        );
      }
      return (
        <Fragments>
          {running > 0 ? <span className="text-info-foreground">{running} running</span> : null}
          {tally.failed > 0 ? (
            <span className="text-destructive-foreground">{tally.failed} failed</span>
          ) : null}
          <span>
            {tally.done}/{total} done
            {tally.queued > 0 ? (
              <span className="hidden @min-[25rem]:inline">
                <span className="px-1 text-muted-foreground/40">·</span>
                {tally.queued} queued
              </span>
            ) : null}
          </span>
        </Fragments>
      );
    }
    case "queued":
      return <span>{tally.queued} queued</span>;
    case "starting":
      return <span className="text-info-foreground">starting</span>;
    case "waiting":
      return (
        <span className="min-w-0 truncate">
          {step.waitingOn ? `waiting on ${step.waitingOn}` : "waiting"}
        </span>
      );
    case "done":
      return <span>{agents}</span>;
    case "partial":
      return (
        <Fragments>
          <span>{agents}</span>
          <span className="text-destructive-foreground">{tally.failed} failed</span>
        </Fragments>
      );
    case "failed":
      return (
        <Fragments>
          <span className="text-destructive-foreground">
            {total === 1 ? "failed" : `all ${total} failed`}
          </span>
          {step.neverStarted ? <span>never started</span> : null}
        </Fragments>
      );
    case "stopped":
      return (
        <Fragments>
          {tally.stopped > 0 ? <span>{tally.stopped} stopped</span> : null}
          {tally.notRun > 0 ? <span>{tally.notRun} not run</span> : null}
          {tally.done > 0 ? <span>{tally.done} done</span> : null}
        </Fragments>
      );
    case "notRun":
      return <span>not run</span>;
  }
}

/** Failure annotations sit under the rows, so a new failure never pushes a row down. */
function StepErrorLine({ error, prefix }: { error: WorkflowStepError; prefix: string | null }) {
  const first = error.labels[0] ?? "";
  const parts = splitMemberLabel(first, prefix);
  const who =
    error.labels.length === 1
      ? `${parts.name}${parts.replica ? ` #${parts.replica}` : ""}`
      : `${error.labels.length} agents`;
  return (
    <Tooltip>
      <TooltipTrigger render={<div />} className="flex h-6 items-center gap-2 pl-1.5 text-2xs">
        <CircleX aria-hidden className="size-3 shrink-0 text-destructive" />
        <span className="shrink-0 font-medium text-destructive-foreground">{who}</span>
        <span className="min-w-0 truncate text-muted-foreground">{error.text}</span>
      </TooltipTrigger>
      <TooltipPopup className="max-w-80">
        <span className="block font-mono">{error.labels.join(", ")}</span>
        <span className="block pt-1">{error.text}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

function StepItem({
  step,
  run,
  isFirst,
  isLast,
  current,
}: {
  step: WorkflowStep;
  run: WorkflowRunSummary;
  isFirst: boolean;
  isLast: boolean;
  current: boolean;
}) {
  // Presentation state: a manual toggle sticks; otherwise the step follows
  // its default (open while in flight or when something went wrong).
  const [override, setOverride] = useState<boolean | null>(null);
  const expandable = step.members.length > 0;
  const open = expandable && (override ?? workflowStepOpensByDefault(step, run));
  const stepLive = step.state === "running" || step.state === "queued";
  const titleTone =
    step.state === "waiting" || step.state === "notRun"
      ? "text-muted-foreground"
      : current
        ? "text-foreground"
        : "text-foreground/85";
  const header = (
    <>
      <span className="relative z-10 flex size-4 shrink-0 items-center justify-center rounded-full bg-background">
        <StepGlyph state={step.state} />
      </span>
      <span className={cn("min-w-0 max-w-[60%] truncate text-xs font-medium", titleTone)}>
        {step.title}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-2xs text-muted-foreground">
        <StepSummary step={step} />
      </span>
      <Columns
        tokens={formatTokens(step.tokens)}
        time={
          <Elapsed
            live={stepLive}
            start={step.startedAt}
            settledMs={spanMs(step.startedAt, step.endedAt)}
          />
        }
        trailing={
          expandable ? (
            open ? (
              <ChevronDown aria-hidden className="size-3" />
            ) : (
              <ChevronRight aria-hidden className="size-3" />
            )
          ) : null
        }
      />
    </>
  );
  return (
    <li className="relative">
      {isFirst && isLast ? null : (
        <span
          aria-hidden
          className={cn(
            "absolute left-2 w-px -translate-x-1/2 bg-border",
            isFirst ? "top-3.5" : "top-0",
            isLast ? "h-3.5" : "bottom-0",
          )}
        />
      )}
      {expandable ? (
        <button
          type="button"
          onClick={() => setOverride(!open)}
          aria-expanded={open}
          className="flex h-7 w-full items-center gap-2 rounded-sm text-left hover:bg-accent/40"
        >
          {header}
        </button>
      ) : (
        <div className="flex h-7 items-center gap-2">{header}</div>
      )}
      {open ? (
        <div className="pb-1.5 pl-5">
          {step.members.map((member, index) => (
            <MemberRow
              key={member.id}
              member={member}
              state={step.states[index] ?? "queued"}
              prefix={step.prefix}
              quiet={step.uniform}
            />
          ))}
          {step.errors.map((error) => (
            <StepErrorLine key={error.text} error={error} prefix={step.prefix} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function StepList({ run }: { run: WorkflowRunSummary }) {
  return (
    <ol className="flex flex-col">
      {run.steps.map((step, index) => (
        <StepItem
          key={step.key}
          step={step}
          run={run}
          isFirst={index === 0}
          isLast={index === run.steps.length - 1}
          current={step === run.current}
        />
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Run header
// ---------------------------------------------------------------------------

/** Right side of the headline: what is in flight and what comes next, or how it ended. */
function RunAside({ run }: { run: WorkflowRunSummary }) {
  const { tally, total } = run;
  const running = tally.running + tally.waiting;
  if (run.live) {
    return (
      <Fragments>
        {running > 0 ? <span className="text-info-foreground">{running} running</span> : null}
        {total === 0 && !run.next ? <span>no agents yet</span> : null}
        {run.next ? <span className="min-w-0 truncate">next {run.next.title}</span> : null}
      </Fragments>
    );
  }
  return (
    <Fragments>
      {tally.done > 0 ? (
        <span>{run.state === "done" ? `${tally.done} agents` : `${tally.done} done`}</span>
      ) : null}
      {tally.failed > 0 ? (
        <span className="text-destructive-foreground">{tally.failed} failed</span>
      ) : null}
      {tally.stopped > 0 ? <span>{tally.stopped} stopped</span> : null}
      {tally.notRun > 0 ? <span>{tally.notRun} not run</span> : null}
    </Fragments>
  );
}

/** Which run's script is open; one at a time across the focused run and history. */
interface ScriptControls {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly openFor: string | null;
  readonly toggle: (workflowId: string) => void;
}

/** Script, transcript folder, and run ID for one run. */
function RunHandlesMenu({
  group,
  scripts,
}: {
  group: AgentPanelWorkflowGroup;
  scripts: ScriptControls;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => showAnchoredCopySuccessToast(triggerRef),
  });
  const handles = group.workflow.runHandles;
  if (!handles) return null;
  const canShowScript =
    handles.scriptPath !== undefined && scripts.environmentId !== null && scripts.threadId !== null;
  const onToggleScript = () => scripts.toggle(group.workflow.id);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button ref={triggerRef} size="icon-micro" variant="ghost-muted" aria-label="Run files" />
        }
      >
        <Ellipsis aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        {canShowScript ? (
          <MenuItem onClick={onToggleScript}>
            <Braces aria-hidden />
            View workflow script
          </MenuItem>
        ) : null}
        {handles.transcriptDir ? (
          <MenuItem onClick={() => copyToClipboard(handles.transcriptDir ?? "")}>
            <FolderOpen aria-hidden />
            Copy transcript folder
          </MenuItem>
        ) : null}
        {handles.runId ? (
          <MenuItem onClick={() => copyToClipboard(handles.runId ?? "")}>
            <Copy aria-hidden />
            Copy run ID
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** A live run ticks from its start; a settled one shows its duration. Either may be unknown. */
function hasRunTime(run: WorkflowRunSummary): boolean {
  return (run.live ? run.startedAt : run.durationMs) !== null;
}

function RunHeader({
  run,
  group,
  scripts,
}: {
  run: WorkflowRunSummary;
  group: AgentPanelWorkflowGroup;
  scripts: ScriptControls;
}) {
  return (
    <header className="shrink-0 border-b border-border/60 px-3 py-2.5">
      <div className="flex h-5 items-center gap-2">
        <StepGlyph state={RUN_TO_STEP[run.state]} className="size-4" />
        <span className="min-w-0 truncate text-sm font-medium">{run.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums text-muted-foreground">
          <Fragments>
            {run.tokens > 0 ? <span>{formatSubagentTokenCount(run.tokens)} tok</span> : null}
            {hasRunTime(run) ? (
              <span className="text-foreground/80">
                <Elapsed live={run.live} start={run.startedAt} settledMs={run.durationMs} />
              </span>
            ) : null}
          </Fragments>
        </span>
        <RunHandlesMenu group={group} scripts={scripts} />
      </div>
      <div className="flex flex-col gap-2 pl-6 pt-1">
        {run.task ? (
          <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{run.task}</p>
        ) : null}
        {run.error ? (
          <p className="line-clamp-2 text-xs leading-snug text-destructive-foreground">
            {run.error}
          </p>
        ) : null}
        {run.steps.length > 0 ? <RunBar steps={run.steps} /> : null}
        <div className="-mt-0.5 flex h-4 items-center gap-2 text-xs">
          <span className="min-w-0 truncate font-medium text-foreground/90">{run.headline}</span>
          <span className="ml-auto flex min-w-0 items-center gap-1 truncate text-2xs text-muted-foreground">
            <RunAside run={run} />
          </span>
        </div>
      </div>
    </header>
  );
}

/** The script viewer for one run, when the user opened it. */
function RunScript({
  group,
  scripts,
}: {
  group: AgentPanelWorkflowGroup;
  scripts: ScriptControls;
}) {
  const scriptPath = group.workflow.runHandles?.scriptPath;
  if (
    scripts.openFor !== group.workflow.id ||
    scriptPath === undefined ||
    scripts.environmentId === null ||
    scripts.threadId === null
  ) {
    return null;
  }
  return (
    <WorkflowScriptView
      environmentId={scripts.environmentId}
      threadId={scripts.threadId}
      scriptPath={scriptPath}
      onClose={() => scripts.toggle(group.workflow.id)}
    />
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mb-2 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-3xs text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Direct subagents and history
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="flex h-7 items-center gap-2 text-3xs font-medium uppercase tracking-wider text-muted-foreground/70">
      {children}
    </h3>
  );
}

function DirectAgentRow({ agent }: { agent: RuntimeSubagent }) {
  const state = subagentDisplayState(agent, null);
  const live = state === "running" || state === "waiting" || state === "queued";
  const detail = live
    ? (agent.progress ?? agent.lastToolName)
    : (agent.error ?? agent.result ?? agent.progress);
  const stateWord = DIRECT_STATE_WORD[state];
  const role =
    agent.role && agent.role.toLocaleLowerCase() !== agent.title.toLocaleLowerCase()
      ? agent.role
      : null;
  return (
    <div className="relative grid h-10 grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-2 items-center gap-x-2 rounded-sm pl-1.5">
      <StateDot state={state} />
      <span className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="min-w-0 truncate text-foreground/90">{agent.title}</span>
        {role ? (
          <span className="max-w-20 shrink-0 truncate font-mono text-2xs text-muted-foreground">
            {role}
          </span>
        ) : null}
        <span className="sr-only">{stateWord}</span>
      </span>
      <Columns
        tokens={formatTokens(agent.usage?.totalTokens ?? 0)}
        time={<AgentElapsed agent={agent} live={isLiveState(state)} />}
      />
      <span
        className={cn(
          "col-start-2 col-end-4 truncate pr-5 text-2xs",
          state === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {detail ?? stateWord}
      </span>
    </div>
  );
}

/** Direct agents have a free-text line; when it is empty the state itself fills it. */
const DIRECT_STATE_WORD: Record<SubagentDisplayState, string> = {
  running: "Running",
  waiting: "Waiting",
  queued: "Queued",
  idle: "Idle · resumable",
  done: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  notRun: "Not run",
};

function DirectAgents({ agents }: { agents: ReadonlyArray<RuntimeSubagent> }) {
  const running = agents.filter((agent) => isLiveState(subagentDisplayState(agent, null))).length;
  return (
    <section className="mt-3 first:mt-0">
      <SectionHeading>
        <span>Subagents</span>
        <span className="font-mono tracking-normal text-muted-foreground/60">{agents.length}</span>
        {running > 0 ? (
          <span className="normal-case tracking-normal text-info-foreground">
            {running} running
          </span>
        ) : null}
      </SectionHeading>
      {agents.map((agent) => (
        <DirectAgentRow key={agent.id} agent={agent} />
      ))}
    </section>
  );
}

function historyOutcome(run: WorkflowRunSummary): ReactNode {
  switch (run.state) {
    case "failed":
      return (
        <span className="text-destructive-foreground">
          {run.total > 0 && run.tally.failed === run.total ? `all ${run.total} failed` : "failed"}
        </span>
      );
    case "stopped":
      return <span>{run.current ? `stopped in ${run.current.title}` : "stopped"}</span>;
    case "partial":
      return <span className="text-destructive-foreground">{run.tally.failed} failed</span>;
    case "done":
      return <span>{run.total} agents</span>;
    case "running":
    case "starting":
      return <span className="text-info-foreground">{run.headline}</span>;
  }
}

function HistoryRun({
  group,
  now,
  scripts,
}: {
  group: AgentPanelWorkflowGroup;
  now: number;
  scripts: ScriptControls;
}) {
  const [open, setOpen] = useState(false);
  const run = summarizeWorkflowRun(group);
  const endedAt = parseTimestamp(group.workflow.completedAt) ?? run.startedAt;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-2 rounded-sm text-left text-xs hover:bg-accent/40"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <StepGlyph state={RUN_TO_STEP[run.state]} />
        </span>
        <span className="min-w-0 truncate text-foreground/80">{run.name}</span>
        <span className="min-w-0 truncate text-2xs text-muted-foreground">
          {historyOutcome(run)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums text-muted-foreground/80">
          {run.tokens > 0 ? <span>{formatSubagentTokenCount(run.tokens)} tok</span> : null}
          <span>{endedAt !== null && !run.live ? formatAge(now - endedAt) : ""}</span>
          <span className="flex w-3 justify-center">
            {open ? (
              <ChevronDown aria-hidden className="size-3" />
            ) : (
              <ChevronRight aria-hidden className="size-3" />
            )}
          </span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 pb-2 pl-6 pt-0.5">
          {run.task ? (
            <p className="line-clamp-2 text-2xs leading-snug text-muted-foreground">{run.task}</p>
          ) : null}
          {run.error ? (
            <p className="line-clamp-2 text-2xs leading-snug text-destructive-foreground">
              {run.error}
            </p>
          ) : null}
          <div className="flex h-5 items-center justify-end pr-1">
            <RunHandlesMenu group={group} scripts={scripts} />
          </div>
          <RunScript group={group} scripts={scripts} />
          <StepList run={run} />
        </div>
      ) : null}
    </li>
  );
}

/** History ages follow the shared minute clock. */
function HistoryRuns({
  groups,
  scripts,
}: {
  groups: ReadonlyArray<AgentPanelWorkflowGroup>;
  scripts: ScriptControls;
}) {
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const anyLive = groups.some((group) => !isTerminalSubagentStatus(group.workflow.status));
  return (
    <section className="mt-3 first:mt-0">
      <SectionHeading>
        <span>{anyLive ? "Other runs" : "Earlier runs"}</span>
        <span className="font-mono tracking-normal text-muted-foreground/60">{groups.length}</span>
      </SectionHeading>
      <ul>
        {groups.map((group) => (
          <HistoryRun key={group.workflow.id} group={group} now={now} scripts={scripts} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  focusRunId = null,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  /** The run whose chat card opened the panel; it leads even while another run is live. */
  focusRunId?: string | null;
}) {
  const [scriptOpenFor, setScriptOpenFor] = useState<string | null>(null);
  const scripts: ScriptControls = {
    environmentId,
    threadId,
    openFor: scriptOpenFor,
    toggle: (workflowId) =>
      setScriptOpenFor((current) => (current === workflowId ? null : workflowId)),
  };

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          Subagents and workflow runs from this thread show up here with live status, activity, and
          token usage.
        </p>
      </div>
    );
  }

  const { focus, others } = arrangeWorkflowRuns(model.workflows, focusRunId);
  const run = focus ? summarizeWorkflowRun(focus) : null;
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {focus && run ? <RunHeader run={run} group={focus} scripts={scripts} /> : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col px-3 py-2">
          {focus && run ? (
            <>
              <RunScript group={focus} scripts={scripts} />
              {/* Keyed by run so manual step toggles never carry over to another run. */}
              <StepList key={focus.workflow.id} run={run} />
            </>
          ) : null}
          {model.directAgents.length > 0 ? <DirectAgents agents={model.directAgents} /> : null}
          {others.length > 0 ? <HistoryRuns groups={others} scripts={scripts} /> : null}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat card
// ---------------------------------------------------------------------------

/**
 * The chat timeline's entry point for a workflow run: the run's name and
 * headline plus one labelled bar per phase. The whole card opens the panel.
 */
export function WorkflowRunCard({
  group,
  onOpen,
}: {
  group: AgentPanelWorkflowGroup;
  onOpen: () => void;
}) {
  const run = summarizeWorkflowRun(group);
  const running = run.tally.running + run.tally.waiting;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${run.name}: ${run.headline}. Open Agents panel`}
      className="@container flex w-full flex-col gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
    >
      <span className="flex w-full items-center gap-2">
        <StepGlyph state={RUN_TO_STEP[run.state]} />
        <span className="min-w-0 max-w-[50%] shrink-0 truncate text-sm font-medium">
          {run.name}
        </span>
        <span className="min-w-0 truncate text-sm text-muted-foreground">{run.headline}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums text-muted-foreground">
          <Fragments>
            {running > 0 ? <span className="text-info-foreground">{running} running</span> : null}
            {hasRunTime(run) ? (
              <Elapsed live={run.live} start={run.startedAt} settledMs={run.durationMs} />
            ) : null}
          </Fragments>
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </span>
      {run.steps.length > 0 ? (
        <span className="flex w-full gap-1.5 pl-5.5">
          {run.steps.map((step) => (
            <span key={step.key} className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-center gap-1 text-2xs">
                <span
                  className={cn(
                    "min-w-0 truncate",
                    step === run.current ? "text-foreground/90" : "text-muted-foreground",
                  )}
                >
                  {step.title}
                </span>
                {step.members.length > 0 ? (
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground/70">
                    {step.tally.done}/{step.members.length}
                  </span>
                ) : null}
              </span>
              <StepBar step={step} />
            </span>
          ))}
        </span>
      ) : null}
      {run.error ? (
        <span className="w-full truncate pl-5.5 text-xs text-destructive-foreground">
          {run.error}
        </span>
      ) : null}
    </button>
  );
}
