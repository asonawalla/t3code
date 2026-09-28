import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorktreeTeardown from "./WorktreeTeardown.ts";

const script = (command: string, runOnWorktreeRemove: boolean): ProjectScript => ({
  id: "teardown",
  name: "Teardown",
  command,
  icon: "configure",
  runOnWorktreeCreate: false,
  runOnWorktreeRemove,
});

const runTeardown = (scripts: ReadonlyArray<ProjectScript>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-teardown-project-" });
    const worktreePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-teardown-worktree-" });
    const teardown = yield* WorktreeTeardown.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getActiveProjectByWorkspaceRoot: (workspaceRoot) =>
              Effect.succeed(
                Option.some({
                  id: ProjectId.make("project"),
                  title: "Project",
                  workspaceRoot,
                  defaultModelSelection: null,
                  scripts: [...scripts],
                  createdAt: "2026-09-01T00:00:00.000Z",
                  updatedAt: "2026-09-01T00:00:00.000Z",
                  deletedAt: null,
                }),
              ),
          }),
          // Unfolded settings fall back to the project's own scripts.
          ServerSettings.layerTest({ projectSettingsFolded: false }),
        ),
      ),
    );
    const tornDown = yield* teardown.run({ projectCwd, worktreePath });
    const marker = path.join(worktreePath, "torn-down");
    return {
      tornDown,
      marker: (yield* fs.exists(marker)) ? yield* fs.readFileString(marker) : null,
      worktreePath,
    };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("runs the teardown action in the worktree before removal", () =>
  Effect.gen(function* () {
    const result = yield* runTeardown([
      script('printf %s "$T3CODE_WORKTREE_PATH" > torn-down', true),
    ]);
    assert.isTrue(result.tornDown);
    assert.strictEqual(result.marker, result.worktreePath);
  }),
);

it.effect("reports a failing teardown action so the worktree is kept", () =>
  Effect.gen(function* () {
    const result = yield* runTeardown([script("exit 3", true)]);
    assert.isFalse(result.tornDown);
  }),
);

it.effect("allows removal when the project has no teardown action", () =>
  Effect.gen(function* () {
    const result = yield* runTeardown([script("printf ran > torn-down", false)]);
    assert.isTrue(result.tornDown);
    assert.isNull(result.marker);
  }),
);
