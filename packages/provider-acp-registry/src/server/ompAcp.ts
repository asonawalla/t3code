import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface OmpTaskSpec {
  readonly id: string;
  readonly agent: string | null;
  readonly task: string;
}

function parseTaskSpecs(rawInput: Record<string, unknown> | undefined): ReadonlyArray<OmpTaskSpec> {
  const tasks = Array.isArray(rawInput?.tasks) ? rawInput.tasks : [];
  const specs: Array<OmpTaskSpec> = [];
  for (const [index, entry] of tasks.entries()) {
    const task = record(entry);
    const text = stringField(task, "task");
    if (text === null) continue;
    specs.push({
      id: stringField(task, "name") ?? stringField(task, "id") ?? String(index),
      agent: stringField(task, "agent"),
      task: text,
    });
  }
  if (specs.length === 0) {
    const single = stringField(rawInput, "task") ?? stringField(rawInput, "prompt");
    if (single !== null) {
      specs.push({ id: "0", agent: stringField(rawInput, "agent"), task: single });
    }
  }
  return specs;
}

interface OmpProgress {
  readonly id: string;
  readonly agent: string | null;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly model: string | null;
  readonly output: string | null;
}

function parseProgress(rawOutput: unknown): ReadonlyMap<string, OmpProgress> {
  const details = record(record(rawOutput)?.details);
  const entries = Array.isArray(details?.progress) ? details.progress : [];
  const byId = new Map<string, OmpProgress>();
  for (const [index, entry] of entries.entries()) {
    const progress = record(entry);
    const id = stringField(progress, "id") ?? String(index);
    const status = stringField(progress, "status");
    const recentOutput = Array.isArray(progress?.recentOutput) ? progress.recentOutput : [];
    byId.set(id, {
      id,
      agent: stringField(progress, "agent"),
      status:
        status === "running" || status === "completed" || status === "failed" ? status : "pending",
      model: stringField(progress, "resolvedModel") ?? stringField(progress, "modelRole"),
      output:
        recentOutput.length > 0
          ? recentOutput.filter((line): line is string => typeof line === "string").join("\n")
          : null,
    });
  }
  return byId;
}

/** oh-my-pi fans one `task` tool call out to N subagents; each progress row becomes one subagent. */
export function extractOmpSubagentUpdates(
  tool: AcpToolCallState,
): ReadonlyArray<AcpAdapterV2SubagentUpdate> | undefined {
  if (tool.data.name !== "task") return undefined;
  const input = record(tool.data.rawInput);
  if (input === undefined) return undefined;
  const specs = parseTaskSpecs(input);
  if (specs.length === 0) return undefined;
  const progress = parseProgress(tool.data.rawOutput);
  return specs.map((spec) => {
    const live = progress.get(spec.id);
    const status =
      tool.status === "failed"
        ? "failed"
        : (live?.status ?? (tool.status === "completed" ? "completed" : "running"));
    return {
      nativeTaskId: `${tool.toolCallId}:${spec.id}`,
      childSessionId: null,
      prompt: spec.task,
      title: live?.agent ?? spec.agent,
      model: live?.model ?? null,
      status,
      result: status === "completed" || status === "failed" ? (live?.output ?? null) : null,
    };
  });
}
