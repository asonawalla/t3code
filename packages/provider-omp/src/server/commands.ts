import { type ServerProviderSlashCommand, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeCommands = Schema.decodeUnknownSync(
  Schema.Struct({
    commands: Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        description: Schema.optional(Schema.String),
        source: Schema.String,
        aliases: Schema.optional(Schema.Array(Schema.String)),
        input: Schema.optional(Schema.Struct({ hint: Schema.optional(Schema.String) })),
      }),
    ),
  }),
);

// These commands replace or detach the conversation owned by T3's thread.
export const OMP_SESSION_COMMANDS = new Set([
  "new",
  "clear",
  "reset",
  "resume",
  "branch",
  "rewind",
  "fork",
  "tree",
  "exit",
  "quit",
  "q",
  "join",
  "leave",
  "move",
  "wt",
  "worktree",
  "add-dir",
  "remove-dir",
]);

export function parseOmpCommands(data: unknown): ReadonlyArray<ServerProviderSlashCommand> {
  const commands: ServerProviderSlashCommand[] = [
    {
      name: "compact",
      description: "Summarize the conversation and reduce context usage",
      input: { hint: "Optional instructions" },
    },
    {
      name: "goal",
      description: "Create, inspect, pause, resume, or clear an OMP goal",
      input: { hint: "Objective, or pause | resume | clear" },
    },
  ];
  const seen = new Set(commands.map((command) => command.name));
  for (const command of decodeCommands(data).commands) {
    if (command.source === "builtin" && OMP_SESSION_COMMANDS.has(command.name)) continue;
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      if (!name.trim() || seen.has(name)) continue;
      seen.add(name);
      const description = command.description?.trim();
      const hint = command.input?.hint?.trim();
      commands.push({
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      });
    }
  }
  return commands;
}
