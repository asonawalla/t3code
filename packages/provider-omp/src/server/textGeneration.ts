import { TextGenerationError } from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { OmpSettings } from "../settings.ts";
import { parseOmpModelSlug } from "./models.ts";
import { makeOmpRpcConnection } from "./rpc.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeTools = Schema.decodeUnknownSync(
  Schema.Struct({ dumpTools: Schema.Array(Schema.Unknown) }),
);
const isTextGenerationError = Schema.is(TextGenerationError);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  makeConnection: typeof makeOmpRpcConnection = makeOmpRpcConnection,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const run: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.run")(
    function* (input) {
      const { operation, modelSelection } = input;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-text-" });
      const configPath = `${directory}/config.json`;
      // --no-tools alone still adds memory/autolearn tools from the user's OMP configuration.
      yield* fs.writeFileString(
        configPath,
        encodeJson({
          autolearn: { enabled: false },
          memory: { backend: "off" },
          goal: { enabled: false },
          plan: { enabled: false, defaultOnStartup: false },
        }),
      );
      const rpc = yield* makeConnection({
        command: settings.binaryPath || "omp",
        args: [
          "--mode",
          "rpc",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-lsp",
          "--no-skills",
          "--no-rules",
          "--no-context-files",
          "--no-ui",
          "--approval-mode",
          "always-ask",
          "--config",
          configPath,
        ],
        cwd: input.cwd,
        env: environment,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      if (modelSelection.model !== "default") {
        const model = parseOmpModelSlug(modelSelection.model);
        if (model === null)
          return yield* new TextGenerationError({
            operation,
            detail: "OMP models must use provider/model format.",
          });
        yield* rpc.request({ type: "set_model", ...model });
      }
      const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
      if (thinking !== undefined)
        yield* rpc.request({ type: "set_thinking_level", level: thinking });
      const fast = getModelSelectionBooleanOptionValue(modelSelection, "fastMode");
      if (fast !== undefined) yield* rpc.request({ type: "set_fast_mode", enabled: fast });
      const state = yield* rpc.request({ type: "get_state" });
      const { dumpTools } = yield* Effect.try({
        try: () => decodeTools(state),
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Could not verify OMP's text generation tool policy.",
            cause,
          }),
      });
      if (dumpTools.length > 0)
        return yield* new TextGenerationError({
          operation,
          detail:
            "OMP enabled tools in its text generation session. Disable custom tool injection for this provider.",
        });
      yield* rpc.send({ id: "text-generation", type: "prompt", message: input.prompt });
      let result = "";
      let completed = false;
      while (true) {
        const event = yield* Queue.take(rpc.events);
        if (event.type === "message_end") {
          const message = record(event.message);
          if (message.role === "assistant")
            result = Array.isArray(message.content)
              ? message.content
                  .map((block) => record(block))
                  .filter((block) => block.type === "text" && typeof block.text === "string")
                  .map((block) => block.text)
                  .join("")
              : "";
        }
        if (event.type === "extension_ui_request" || event.type === "tool_execution_start")
          return yield* new TextGenerationError({
            operation,
            detail: "OMP requested an interactive action during text generation.",
          });
        if (event.type === "response" && event.id === "text-generation" && event.success === false)
          return yield* new TextGenerationError({
            operation,
            detail: "OMP rejected the text generation request.",
          });
        if (event.type === "prompt_result" && event.id === "text-generation") {
          if (event.status !== "completed")
            return yield* new TextGenerationError({
              operation,
              detail: "OMP could not complete text generation.",
            });
          completed = true;
          if (event.sessionSettled === true) break;
        }
        if (event.type === "session_settled" && completed) break;
      }
      if (!result.trim())
        return yield* new TextGenerationError({ operation, detail: "OMP returned empty text." });
      return yield* TextGenerationOperations.decodeJsonReply(input, "OMP", result);
    },
    (effect, input) =>
      effect.pipe(
        Effect.timeoutOption(180_000),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "OMP text generation timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "OMP text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      ),
  );
  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("OMP", run),
  );
});
