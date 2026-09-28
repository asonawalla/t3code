import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  teardownProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";

const TEARDOWN_TIMEOUT = Duration.minutes(10);
const OUTPUT_TAIL_LENGTH = 4_000;

/**
 * Runs a project's teardown action in a worktree before T3 Code removes it,
 * for example to stop services its setup action started. The action runs
 * headless in the user's login shell: a terminal would need the workspace
 * lease that the removing caller already holds.
 */
export class WorktreeTeardown extends Context.Service<
  WorktreeTeardown,
  {
    /** False when the action fails or times out, so the caller keeps the worktree. */
    readonly run: (input: {
      readonly projectCwd: string;
      readonly worktreePath: string;
    }) => Effect.Effect<boolean>;
  }
>()("t3/project/WorktreeTeardown") {}

export const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const hostEnvironment = yield* HostProcessEnvironment;

  const run: WorktreeTeardown["Service"]["run"] = Effect.fn("WorktreeTeardown.run")(
    function* (input) {
      const project = Option.getOrUndefined(
        yield* snapshots.getActiveProjectByWorkspaceRoot(input.projectCwd),
      );
      if (project === undefined) return true;
      const script = teardownProjectScript(
        resolveProjectScripts(yield* settingsService.getSettings, project),
      );
      if (script === null) return true;
      const [shell, args] =
        platform === "win32"
          ? [hostEnvironment.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", script.command]]
          : [hostEnvironment.SHELL ?? "/bin/sh", ["-lc", script.command]];
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(shell, args, {
              cwd: input.worktreePath,
              env: {
                ...hostEnvironment,
                ...projectScriptRuntimeEnv({
                  project: { cwd: project.workspaceRoot },
                  worktreePath: input.worktreePath,
                }),
              },
              stdin: "ignore",
            }),
          );
          return yield* Effect.all(
            [child.exitCode, Stream.mkString(Stream.decodeText(child.all))],
            { concurrency: "unbounded" },
          );
        }),
      ).pipe(Effect.timeoutOption(TEARDOWN_TIMEOUT));
      if (Option.isSome(result) && result.value[0] === 0) return true;
      yield* Effect.logWarning("worktree teardown failed; keeping the worktree", {
        worktreePath: input.worktreePath,
        script: script.name,
        exitCode: Option.isSome(result) ? result.value[0] : "timed out",
        output: Option.isSome(result) ? result.value[1].slice(-OUTPUT_TAIL_LENGTH) : "",
      });
      return false;
    },
    Effect.catch((error) =>
      Effect.logWarning("worktree teardown failed; keeping the worktree", { error }).pipe(
        Effect.as(false),
      ),
    ),
  );

  return { run } satisfies WorktreeTeardown["Service"];
});

export const layer = Layer.effect(WorktreeTeardown, make);
