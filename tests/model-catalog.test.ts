import { describe, expect, it } from "vitest";
import { mergeModelCatalog, parseProviderProfile } from "../src/index.js";

const profile = parseProviderProfile({
  id: "router",
  displayName: "Router",
  baseUrl: "https://router.example/v1",
});

describe("model catalog", () => {
  it("preserves provider reasoning levels from raw model metadata", () => {
    const [entry] = mergeModelCatalog(profile, [
      {
        modelId: "model-x",
        displayName: "Model X",
        raw: { supported_reasoning_levels: ["low", "high", "max"] },
      },
    ]);

    expect(entry).toMatchObject({ supportedReasoningLevels: ["low", "high", "max"] });
  });

  it("prefers exact official capabilities over provider guesses", () => {
    const [entry] = mergeModelCatalog(profile, [
      {
        modelId: "gpt-6-astra",
        displayName: "GPT-6 Astra",
        raw: { supported_reasoning_levels: ["low", "medium", "high"] },
      },
    ]);

    expect(entry?.reasoning).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "low",
      source: "official-model-catalog",
    });
    expect(entry?.supportedReasoningLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("uses provider metadata only when no official overlay exists", () => {
    const [entry] = mergeModelCatalog(profile, [
      {
        modelId: "provider-only-model",
        displayName: "Provider Only",
        raw: { reasoning_efforts: ["low", "high"] },
      },
    ]);

    expect(entry?.reasoning).toEqual({
      kind: "effort",
      values: ["low", "high"],
      source: "provider-metadata",
    });
  });

  it("reports unknown instead of inventing three efforts", () => {
    const [entry] = mergeModelCatalog(profile, [
      { modelId: "unknown-model", displayName: "Unknown", raw: {} },
    ]);

    expect(entry?.reasoning).toEqual({ kind: "unknown" });
    expect(entry?.supportedReasoningLevels).toBeUndefined();
  });

  it("reports GLM-5.3 as thinking mode", () => {
    const [entry] = mergeModelCatalog(profile, [
      { modelId: "glm-5.3", displayName: "GLM 5.3", raw: {} },
    ]);

    expect(entry?.reasoning).toEqual({
      kind: "thinking-mode",
      mode: "forced",
      source: "official-model-catalog",
    });
    expect(entry?.supportedReasoningLevels).toBeUndefined();
  });
  it("reads nested reasoning-effort aliases", () => {
    const [entry] = mergeModelCatalog(profile, [
      {
        modelId: "model-y",
        displayName: "Model Y",
        raw: { metadata: { reasoning_efforts: ["low", "ultra"] } },
      },
    ]);

    expect(entry).toMatchObject({ supportedReasoningLevels: ["low", "ultra"] });
  });
});
