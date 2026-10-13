import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = runtimeInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.match(
      buildCodexDeveloperInstructions("default"),
      /^<collaboration_mode># Collaboration Mode: Default/,
    );
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("describes Markdown media support in the runtime context in both modes", () => {
    {
      const instructions = runtimeInstructions({
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images and videos.*Markdown.*<\/runtime_info>/,
      );
    }
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = runtimeInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.match(buildCodexDeveloperInstructions("plan"), /^<collaboration_mode># Plan Mode/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = runtimeInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = runtimeInstructions({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 tool developer instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };
  const browserPolicy =
    /preview_|Playwright|T3 Code collaborative browser|Do not switch to global browser skills/;

  it("never injects a browser tool policy", () => {
    for (const mode of ["default", "plan"] as const) {
      for (const deviceToolsAvailable of [true, false]) {
        const context = buildCodexAdditionalContext(runtime, deviceToolsAvailable);
        NodeAssert.doesNotMatch(JSON.stringify(context), browserPolicy);
      }
      NodeAssert.doesNotMatch(buildCodexDeveloperInstructions(mode), browserPolicy);
      NodeAssert.match(buildCodexDeveloperInstructions(mode), /<collaboration_mode>/);
      NodeAssert.match(buildCodexDeveloperInstructions(mode), /<\/collaboration_mode>/);
    }
  });

  it("describes device tools only when the turn has them", () => {
    NodeAssert.match(toolInstructions(runtime, true), /device_open/);
    NodeAssert.equal(toolInstructions(runtime, false), "");
    NodeAssert.equal(buildCodexAdditionalContext(runtime).t3_code_tools, undefined);
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return buildCodexAdditionalContext(runtime).t3_code_runtime!.value;
}
function toolInstructions(
  runtime: Parameters<typeof buildCodexAdditionalContext>[0],
  available: boolean,
) {
  return buildCodexAdditionalContext(runtime, available).t3_code_tools?.value ?? "";
}
