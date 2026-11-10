import {
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const Model = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  reasoning: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Struct({ efforts: Schema.Array(Schema.String) })),
  api: Schema.optional(Schema.String),
  identity: Schema.optional(Schema.Struct({ class: Schema.String })),
  serviceTiers: Schema.optional(Schema.Array(Schema.String)),
});
const decodeInventory = Schema.decodeUnknownSync(Schema.Struct({ models: Schema.Array(Model) }));
const decodeState = Schema.decodeUnknownSync(
  Schema.Struct({
    model: Schema.optional(Model),
    thinkingLevel: Schema.optional(Schema.String),
  }),
);
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LABELS: Record<string, string> = {
  inherit: "OMP default",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export function parseOmpModelSlug(slug: string) {
  const slash = slug.indexOf("/");
  return slash > 0 && slash < slug.length - 1
    ? { provider: slug.slice(0, slash), modelId: slug.slice(slash + 1) }
    : null;
}

export function ompModelCapabilities(
  model: Partial<typeof Model.Type>,
  thinkingLevel?: string,
): ModelCapabilities {
  const optionDescriptors: ProviderOptionDescriptor[] = [];
  const efforts = model.reasoning
    ? EFFORTS.filter((effort) => model.thinking?.efforts.includes(effort))
    : [];
  if (efforts.length > 0) {
    const levels = ["inherit", "off", ...efforts];
    const defaultLevel =
      thinkingLevel !== undefined && levels.includes(thinkingLevel) ? thinkingLevel : "inherit";
    optionDescriptors.push({
      id: "thinking",
      label: "Thinking",
      role: "reasoning",
      type: "select",
      options: levels.map((id) => ({
        id,
        label: LABELS[id] ?? id,
        ...(id === defaultLevel ? { isDefault: true } : {}),
      })),
    });
  }
  // Codex priority availability is account-specific; never infer it from the model name.
  const openai =
    model.provider === "openai" ||
    model.provider === "openai-codex" ||
    (model.identity?.class === "openai" &&
      model.provider !== "fireworks" &&
      model.provider !== "github-copilot" &&
      (model.provider === "openrouter" ||
        ["openai-completions", "openai-responses", "openai-codex-responses"].includes(
          model.api ?? "",
        )));
  const fast = openai
    ? model.provider !== "openai-codex" || model.serviceTiers?.includes("priority") === true
    : model.api === "anthropic-messages" ||
      model.provider === "google" ||
      model.provider === "google-vertex" ||
      (model.provider === "openrouter" &&
        ["anthropic", "gemini"].includes(model.identity?.class ?? ""));
  if (fast)
    optionDescriptors.push({
      id: "fastMode",
      label: "Fast",
      description: "Use OMP's priority service tier when supported by the model provider.",
      type: "boolean",
    });
  return { optionDescriptors };
}

export function parseOmpModels(
  inventory: unknown,
  state: unknown = {},
): ReadonlyArray<ServerProviderModel> {
  const { models } = decodeInventory(inventory);
  const active = decodeState(state);
  const output: ServerProviderModel[] = [
    {
      slug: "default",
      name: "OMP default",
      isCustom: false,
      isDefault: true,
      capabilities: ompModelCapabilities(active.model ?? {}, active.thinkingLevel),
    },
  ];
  const seen = new Set<string>();
  for (const model of models) {
    const slug = `${model.provider}/${model.id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const isActive = model.provider === active.model?.provider && model.id === active.model.id;
    output.push({
      slug,
      name: model.name ?? slug,
      subProvider: model.provider,
      isCustom: false,
      capabilities: ompModelCapabilities(model, isActive ? active.thinkingLevel : undefined),
    });
  }
  return output;
}
