import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import {
  settleProjectScript,
  setupProjectScript,
  teardownProjectScript,
} from "@t3tools/shared/projectScripts";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  releaseClaimedRoles,
} from "./projectScripts";

describe("projectScripts helpers", () => {
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

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary, setup, settle, and teardown scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
      {
        id: "down",
        name: "Down",
        command: "docker compose down",
        icon: "configure" as const,
        runOnWorktreeCreate: false,
        runOnWorktreeRemove: true,
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
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(teardownProjectScript(scripts)?.id).toBe("down");
    expect(
      primaryProjectScript(
        scripts.filter((script) => script.id === "clean" || script.id === "down"),
      ),
    ).toBeNull();
  });

  it("moves the setup, settle, and teardown roles to the script that claims them", () => {
    const input = {
      name: "Next",
      command: "true",
      icon: "play",
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
    } as const;
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
    };
    const teardown = {
      id: "teardown",
      name: "Teardown",
      command: "docker compose down",
      icon: "configure" as const,
      runOnWorktreeCreate: false,
      runOnWorktreeRemove: true,
    };
    const none = { runOnWorktreeCreate: false, runOnSettle: false, runOnWorktreeRemove: false };

    expect(releaseClaimedRoles(holder, { ...input, ...none, runOnSettle: true })).toMatchObject({
      runOnWorktreeCreate: true,
      runOnSettle: false,
    });
    expect(
      releaseClaimedRoles(holder, { ...input, ...none, runOnWorktreeCreate: true }),
    ).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
    expect(releaseClaimedRoles(holder, { ...input, ...none })).toBe(holder);
    // Claiming teardown leaves the setup and settle holder alone.
    expect(releaseClaimedRoles(holder, { ...input, ...none, runOnWorktreeRemove: true })).toBe(
      holder,
    );
    expect(
      releaseClaimedRoles(teardown, { ...input, ...none, runOnWorktreeRemove: true }),
    ).toMatchObject({ runOnWorktreeRemove: false });
    expect(releaseClaimedRoles(teardown, { ...input, ...none, runOnWorktreeCreate: true })).toBe(
      teardown,
    );
  });
});
