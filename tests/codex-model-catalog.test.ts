import { describe, expect, it } from "vitest";
import { createCodexModelInfo } from "../src/index.js";

describe("createCodexModelInfo", () => {
  it("advertises all six official GPT-6 Astra efforts", () => {
    const info = createCodexModelInfo(
      {
        modelId: "gpt-6-astra",
        reasoning: {
          kind: "effort",
          values: ["low", "medium", "high", "xhigh", "max", "ultra"],
          default: "low",
          source: "official-model-catalog",
        },
      },
      1,
    );

    expect(info.default_reasoning_level).toBe("low");
    expect(info.supported_reasoning_levels).toEqual([
      { effort: "low", description: expect.any(String) },
      { effort: "medium", description: expect.any(String) },
      { effort: "high", description: expect.any(String) },
      { effort: "xhigh", description: expect.any(String) },
      { effort: "max", description: expect.any(String) },
      { effort: "ultra", description: expect.any(String) },
    ]);
  });

  it("does not invent efforts for unknown models", () => {
    const info = createCodexModelInfo(
      { modelId: "unknown-model", reasoning: { kind: "unknown" } },
      2,
    );

    expect(info.default_reasoning_level).toBeUndefined();
    expect(info.supported_reasoning_levels).toEqual([]);
  });

  it("does not expose efforts for forced thinking models", () => {
    const info = createCodexModelInfo(
      {
        modelId: "glm-5.3",
        reasoning: {
          kind: "thinking-mode",
          mode: "forced",
          source: "official-model-catalog",
        },
      },
      3,
    );

    expect(info.default_reasoning_level).toBeUndefined();
    expect(info.supported_reasoning_levels).toEqual([]);
  });

  it("keeps the exact official overlay authoritative over stale provider metadata", () => {
    const info = createCodexModelInfo(
      {
        modelId: "glm-5.3",
        reasoning: {
          kind: "effort",
          values: ["low", "high", "max"],
          source: "provider-metadata",
        },
      },
      4,
    );

    expect(info.default_reasoning_level).toBeUndefined();
    expect(info.supported_reasoning_levels).toEqual([]);
  });
});
