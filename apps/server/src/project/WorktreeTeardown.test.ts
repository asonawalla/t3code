// @effect-diagnostics nodeBuiltinImport:off - mkfifo runs synchronously to set up the timeout test.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as WorktreeTeardown from "./WorktreeTeardown.ts";

const script = (command: string, runOnWorktreeRemove: boolean): ProjectScript => ({
  id: "teardown",
  name: "Teardown",
  command,
  icon: "configure",
  runOnWorktreeCreate: false,
  runOnWorktreeRemove,
});

/**
 * Builds the service against a project with `scripts` (or no project at all)
 * in fresh project and worktree directories, recording git removals.
 */
const makeFixture = (scripts: ReadonlyArray<ProjectScript> | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-teardown-project-" });
    const worktreePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-teardown-worktree-" });
    const removed: Array<string> = [];
    const teardown = yield* Effect.service(WorktreeTeardown.WorktreeTeardown).pipe(
      Effect.provide(
        WorktreeTeardown.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ProjectService.ProjectService)({
                getByWorkspaceRoot: (workspaceRoot) =>
                  Effect.succeed(
                    scripts === null
                      ? Option.none()
                      : Option.some({
                          id: ProjectId.make("project"),
                          title: "Project",
                          workspaceRoot,
                          repositoryIdentity: null,
                          faviconPath: null,
                          defaultModelSelection: null,
                          scripts: [...scripts],
                          createdAt: "2026-09-01T00:00:00.000Z",
                          updatedAt: "2026-09-01T00:00:00.000Z",
                          deletedAt: null,
                        }),
                  ),
              }),
              Layer.mock(GitWorkflowService.GitWorkflowService)({
                removeWorktree: (input) => Effect.sync(() => void removed.push(input.path)),
              }),
              // Unfolded settings fall back to the project's own scripts.
              ServerSettings.layerTest(),
              // A plain POSIX shell keeps the test independent of the user's login shell.
              Layer.succeed(HostProcess.Environment, { ...process.env, SHELL: "/bin/sh" }),
            ),
          ),
        ),
      ),
    );
    const read = (name: string) =>
      Effect.gen(function* () {
        const file = path.join(worktreePath, name);
        return (yield* fs.exists(file)) ? yield* fs.readFileString(file) : null;
      });
    return { teardown, projectCwd, worktreePath, removed, read, path };
  });

it.layer(NodeServices.layer)("WorktreeTeardown", (it) => {
  it.effect("runs the teardown action in the worktree with the setup variables", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture([
        script('printf "%s\\n%s" "$T3CODE_WORKTREE_PATH" "$T3CODE_PROJECT_ROOT" > torn-down', true),
      ]);
      yield* fixture.teardown.run(fixture);
      assert.strictEqual(
        yield* fixture.read("torn-down"),
        `${fixture.worktreePath}\n${fixture.projectCwd}`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails when the teardown action exits non-zero, keeping the worktree", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture([script("echo stopping; exit 3", true)]);
      const error = yield* fixture.teardown
        .removeWorktree({ cwd: fixture.projectCwd, path: fixture.worktreePath, force: true })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorktreeTeardownError");
      assert.propertyVal(error, "exitCode", 3);
      assert.deepStrictEqual(fixture.removed, []);
    }).pipe(Effect.scoped),
  );

  it.effect("removes the worktree after the teardown action succeeds", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture([script("printf ran > torn-down", true)]);
      yield* fixture.teardown.removeWorktree({
        cwd: fixture.projectCwd,
        path: fixture.worktreePath,
        force: true,
      });
      assert.strictEqual(yield* fixture.read("torn-down"), "ran");
      assert.deepStrictEqual(fixture.removed, [fixture.worktreePath]);
    }).pipe(Effect.scoped),
  );

  // Needs a FIFO, which mkfifo creates; Windows has neither.
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "fails when the teardown action runs past ten minutes",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture([script("printf up > started; exec sleep 600", true)]);
        const started = fixture.path.join(fixture.worktreePath, "started");
        NodeChildProcess.execFileSync("mkfifo", [started]);
        const run = yield* fixture.teardown.run(fixture).pipe(Effect.flip, Effect.forkChild);
        // Opening a FIFO waits for its writer, so this returns once the action runs.
        const fs = yield* FileSystem.FileSystem;
        assert.strictEqual(yield* fs.readFileString(started), "up");
        yield* TestClock.adjust("10 minutes");
        const error = yield* Fiber.join(run);
        assert.strictEqual(error._tag, "WorktreeTeardownError");
        assert.isUndefined(error.exitCode);
      }).pipe(Effect.scoped),
  );

  it.effect("does nothing when the project has no teardown action", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture([script("printf ran > torn-down", false)]);
      yield* fixture.teardown.removeWorktree({
        cwd: fixture.projectCwd,
        path: fixture.worktreePath,
        force: true,
      });
      assert.isNull(yield* fixture.read("torn-down"));
      assert.deepStrictEqual(fixture.removed, [fixture.worktreePath]);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing for a worktree outside any project", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(null);
      yield* fixture.teardown.run(fixture);
    }).pipe(Effect.scoped),
  );
});
