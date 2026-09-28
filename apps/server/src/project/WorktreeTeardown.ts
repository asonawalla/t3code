import type { GitCommandError, VcsRemoveWorktreeInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  teardownProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";

const TEARDOWN_TIMEOUT = "10 minutes";
const OUTPUT_TAIL_LENGTH = 4_000;

export class WorktreeTeardownError extends Schema.TaggedError<WorktreeTeardownError>()(
  "WorktreeTeardownError",
  {
    worktreePath: Schema.String,
    /** Absent when the action timed out or could not start. */
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "The project's teardown action failed, so the worktree was kept. See the server log for its output.";
  }
}

/**
 * Runs a project's teardown action in a worktree before T3 Code removes it,
 * for example to stop services its setup action started. The action runs
 * headless in the user's login shell: a terminal would need the workspace
 * lease that storage cleanup already holds while it removes the worktree.
 */
export class WorktreeTeardown extends Context.Service<
  WorktreeTeardown,
  {
    /**
     * Succeeds when the action exits cleanly or the project has none. Fails
     * when it exits non-zero or runs past ten minutes, so the caller keeps the
     * worktree.
     */
    readonly run: (input: {
      readonly projectCwd: string;
      readonly worktreePath: string;
    }) => Effect.Effect<void, WorktreeTeardownError>;
    /** Removes a worktree once its teardown action has run. */
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, WorktreeTeardownError | GitCommandError>;
  }
>()("t3/project/WorktreeTeardown") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;

  const run: WorktreeTeardown["Service"]["run"] = Effect.fn("WorktreeTeardown.run")(
    function* (input) {
      const failed = (cause: unknown) =>
        new WorktreeTeardownError({ worktreePath: input.worktreePath, cause });
      const project = Option.getOrUndefined(
        yield* projects.getByWorkspaceRoot(input.projectCwd).pipe(Effect.mapError(failed)),
      );
      if (project === undefined) return;
      const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failed));
      const script = teardownProjectScript(resolveProjectScripts(settings, project));
      if (script === null) return;

      const options = {
        cwd: input.worktreePath,
        env: {
          ...hostEnvironment,
          ...projectScriptRuntimeEnv({
            project: { cwd: project.workspaceRoot },
            worktreePath: input.worktreePath,
          }),
        },
        stdin: "ignore",
        forceKillAfter: "5 seconds",
      } as const;
      const command =
        platform === "win32"
          ? // Node hands the command to cmd.exe as written.
            ChildProcess.make(script.command, [], { ...options, shell: true })
          : ChildProcess.make(hostEnvironment.SHELL ?? "/bin/sh", ["-lc", script.command], options);
      // Kept outside the run so a timed-out action still reports what it printed.
      let output = "";
      const exitCode = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(command);
          const [code] = yield* Effect.all(
            [
              child.exitCode,
              child.all.pipe(
                Stream.decodeText,
                Stream.runForEach((chunk) =>
                  Effect.sync(() => {
                    output = (output + chunk).slice(-OUTPUT_TAIL_LENGTH);
                  }),
                ),
              ),
            ],
            { concurrency: "unbounded" },
          );
          return code;
        }),
      ).pipe(Effect.timeoutOption(TEARDOWN_TIMEOUT), Effect.mapError(failed));

      if (Option.isSome(exitCode) && exitCode.value === 0) return;
      // The output is how a user finds out why their action failed.
      yield* Effect.logWarning("worktree teardown action failed; keeping the worktree", {
        worktreePath: input.worktreePath,
        action: script.name,
        exitCode: Option.isSome(exitCode) ? exitCode.value : "timed out",
        output,
      });
      return yield* new WorktreeTeardownError({
        worktreePath: input.worktreePath,
        ...(Option.isSome(exitCode) ? { exitCode: exitCode.value } : {}),
      });
    },
  );

  const removeWorktree: WorktreeTeardown["Service"]["removeWorktree"] = Effect.fn(
    "WorktreeTeardown.removeWorktree",
  )(function* (input) {
    yield* run({ projectCwd: input.cwd, worktreePath: input.path });
    yield* gitWorkflow.removeWorktree(input);
  });

  return WorktreeTeardown.of({ run, removeWorktree });
});

export const layer = Layer.effect(WorktreeTeardown, make);
