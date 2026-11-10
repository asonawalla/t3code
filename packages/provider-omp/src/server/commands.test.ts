import { assert, it } from "@effect/vitest";
import { parseOmpCommands } from "./commands.ts";

it("keeps native skills and MCP prompts while excluding session replacement commands and aliases", () => {
  const commands = parseOmpCommands({
    commands: [
      { name: "fork", aliases: ["copy-session"], source: "builtin" },
      {
        name: "model",
        aliases: ["models"],
        source: "builtin",
        description: "Choose model",
        input: { hint: "Model name" },
      },
      { name: "skill:review", source: "skill", description: "Review changes" },
      { name: "mcp:prompt", source: "mcp_prompt" },
      { name: "review", source: "file" },
      { name: "review", source: "extension" },
      { name: "handoff", source: "builtin" },
    ],
  });
  assert.deepEqual(
    commands.map((command) => command.name),
    ["compact", "goal", "model", "models", "skill:review", "mcp:prompt", "review", "handoff"],
  );
  assert.deepEqual(commands[2]?.input, { hint: "Model name" });
});
