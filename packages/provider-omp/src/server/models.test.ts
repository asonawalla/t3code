import { assert, describe, it } from "@effect/vitest";
import { ompModelCapabilities, parseOmpModelSlug, parseOmpModels } from "./models.ts";

describe("OMP model discovery", () => {
  it("uses the native effort ladder and preserves provider-qualified model ids", () => {
    const model = {
      provider: "openai-codex",
      id: "gpt/example",
      name: "Example",
      reasoning: true,
      thinking: { efforts: ["low", "high", "max"] },
      serviceTiers: ["priority"],
    };
    const models = parseOmpModels({ models: [model, model] }, { model, thinkingLevel: "high" });
    assert.lengthOf(models, 2);
    assert.equal(models[0]?.slug, "default");
    assert.equal(models[1]?.slug, "openai-codex/gpt/example");
    const thinking = models[1]?.capabilities?.optionDescriptors?.find(
      (option) => option.id === "thinking",
    );
    assert.equal(thinking?.type, "select");
    if (thinking?.type !== "select") throw new Error("Missing thinking control");
    assert.deepEqual(
      thinking.options.map((option) => option.id),
      ["inherit", "off", "low", "high", "max"],
    );
    assert.isTrue(thinking.options.find((option) => option.id === "high")?.isDefault);
    assert.deepEqual(parseOmpModelSlug("openai-codex/gpt/example"), {
      provider: "openai-codex",
      modelId: "gpt/example",
    });
    assert.isNull(parseOmpModelSlug("unqualified"));
    assert.isNull(parseOmpModelSlug("provider/"));
    assert.isTrue(
      models[1]?.capabilities?.optionDescriptors?.some((option) => option.id === "fastMode"),
    );
  });

  it("does not invent reasoning or priority support for unsupported models", () => {
    for (const model of [
      { provider: "local", id: "plain", reasoning: false },
      { provider: "local", id: "fixed-thinking", reasoning: true },
      { provider: "openai-codex", id: "basic", reasoning: false, serviceTiers: ["default"] },
      { provider: "github-copilot", api: "openai-responses", identity: { class: "openai" } },
    ])
      assert.deepEqual(ompModelCapabilities(model).optionDescriptors, []);
    assert.throws(() => parseOmpModels({ models: [{ provider: "local" }] }));
  });
});
