import { MAX_SCRIPT_ID_LENGTH } from "@t3tools/contracts";
import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdFromCommand,
  releaseWorktreeScriptRoles,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds scripts with preview settings", () => {
    expect(
      buildProjectScript("dev", {
        name: "Dev server",
        command: "pnpm dev",
        icon: "debug",
        runOnWorktreeCreate: false,
        waitForSetup: false,
        runOnWorktreeRemove: false,
        previewUrl: "http://localhost:5733",
        autoOpenPreview: true,
      }),
    ).toEqual({
      id: "dev",
      name: "Dev server",
      command: "pnpm dev",
      icon: "debug",
      runOnWorktreeCreate: false,
      previewUrl: "http://localhost:5733",
      autoOpenPreview: true,
    });
  });

  it("omits preview settings when no preview URL is configured", () => {
    expect(
      buildProjectScript("test", {
        name: "Test",
        command: "pnpm test",
        icon: "test",
        runOnWorktreeCreate: false,
        waitForSetup: false,
        runOnWorktreeRemove: false,
        previewUrl: null,
        autoOpenPreview: false,
      }),
    ).toEqual({
      id: "test",
      name: "Test",
      command: "pnpm test",
      icon: "test",
      runOnWorktreeCreate: false,
    });
  });

  it("only records async: false for setup scripts that should block the agent", () => {
    const input = {
      name: "Setup",
      command: "pnpm i",
      icon: "configure",
      runOnWorktreeRemove: false,
      previewUrl: null,
      autoOpenPreview: false,
    } as const;
    expect(
      buildProjectScript("setup", { ...input, runOnWorktreeCreate: true, waitForSetup: true }),
    ).toMatchObject({ runOnWorktreeCreate: true, async: false });
    expect(
      buildProjectScript("setup", { ...input, runOnWorktreeCreate: true, waitForSetup: false }),
    ).not.toHaveProperty("async");
    expect(
      buildProjectScript("setup", { ...input, runOnWorktreeCreate: false, waitForSetup: true }),
    ).not.toHaveProperty("async");
  });

  it("only records runOnWorktreeRemove for teardown scripts", () => {
    const input = {
      name: "Teardown",
      command: "docker compose down",
      icon: "configure",
      runOnWorktreeCreate: false,
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
    } as const;
    expect(buildProjectScript("teardown", { ...input, runOnWorktreeRemove: true })).toMatchObject({
      runOnWorktreeRemove: true,
    });
    expect(
      buildProjectScript("teardown", { ...input, runOnWorktreeRemove: false }),
    ).not.toHaveProperty("runOnWorktreeRemove");
  });

  it("clears only the worktree roles a saved script claims", () => {
    const setup = {
      id: "setup",
      name: "Setup",
      command: "bun install",
      icon: "configure" as const,
      runOnWorktreeCreate: true,
    };
    const teardown = {
      id: "teardown",
      name: "Teardown",
      command: "docker compose down",
      icon: "configure" as const,
      runOnWorktreeCreate: false,
      runOnWorktreeRemove: true,
    };
    const neither = { runOnWorktreeCreate: false, runOnWorktreeRemove: false };

    expect(releaseWorktreeScriptRoles(setup, neither)).toBe(setup);
    expect(releaseWorktreeScriptRoles(teardown, neither)).toBe(teardown);
    expect(
      releaseWorktreeScriptRoles(setup, { ...neither, runOnWorktreeCreate: true }),
    ).toMatchObject({ runOnWorktreeCreate: false });
    expect(releaseWorktreeScriptRoles(setup, { ...neither, runOnWorktreeRemove: true })).toBe(
      setup,
    );
    expect(
      releaseWorktreeScriptRoles(teardown, { ...neither, runOnWorktreeRemove: true }),
    ).not.toHaveProperty("runOnWorktreeRemove");
  });

  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command ?? "")).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "", "a".repeat(25)])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("preserves the exact ID at the shortcut length limit", () => {
    const id = "a".repeat(MAX_SCRIPT_ID_LENGTH);
    expect(projectScriptIdFromCommand(commandForProjectScript(id) ?? "")).toBe(id);
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
  });

  it("does not pick a teardown script as the primary action", () => {
    const scripts = [
      {
        id: "teardown",
        name: "Teardown",
        command: "docker compose down",
        icon: "configure" as const,
        runOnWorktreeCreate: false,
        runOnWorktreeRemove: true,
      },
      {
        id: "dev",
        name: "Dev",
        command: "bun dev",
        icon: "play" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("dev");
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });

  it("prefers the worktree path for script cwd resolution", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: "/repo/worktree-a",
      }),
    ).toBe("/repo/worktree-a");
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: null,
      }),
    ).toBe("/repo");
  });
});
