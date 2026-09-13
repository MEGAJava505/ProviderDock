import { describe, expect, it } from "vitest";
import {
  officialModelCapabilityCatalogVersion,
  officialReasoningCapabilityFor,
} from "../src/index.js";

describe("official model capabilities", () => {
  it("exposes the dated catalog snapshot version", () => {
    expect(officialModelCapabilityCatalogVersion).toBe("2026-09-11");
  });

  it("returns exact Codex catalog efforts", () => {
    expect(officialReasoningCapabilityFor("gpt-6-astra")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "low",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("gpt-5.6-sol")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "low",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("gpt-5.6-terra")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "medium",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("gpt-5.6-luna")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max"],
      default: "medium",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("gpt-daybreak-blue-latest")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "low",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("gpt-daybreak-red-latest")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max", "ultra"],
      default: "medium",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("gpt-5.5")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh"],
      default: "medium",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("gpt-5.4")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh"],
      default: "medium",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("codex-auto-review")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max"],
      default: "medium",
      source: "official-model-catalog",
    });
  });

  it("returns exact Anthropic efforts and unsupported Haiku", () => {
    expect(officialReasoningCapabilityFor("claude-opus-5")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "xhigh", "max"],
      default: "high",
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("claude-sonnet-4.6")).toEqual({
      kind: "effort",
      values: ["low", "medium", "high", "max"],
      source: "official-model-catalog",
    });
    expect(officialReasoningCapabilityFor("claude-haiku-4-5-20251001")).toEqual({
      kind: "unsupported",
    });
  });

  it("models GLM-5.3 as forced thinking mode", () => {
    expect(officialReasoningCapabilityFor("glm-5.3")).toEqual({
      kind: "thinking-mode",
      mode: "forced",
      source: "official-model-catalog",
    });
  });

  it("returns unknown for unrecognized exact model IDs", () => {
    expect(officialReasoningCapabilityFor("totally-unknown-model")).toEqual({
      kind: "unknown",
    });
  });
});
