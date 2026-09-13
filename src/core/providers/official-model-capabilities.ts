import type { ReasoningCapability } from "./reasoning-capability.js";

/** Snapshot date for the exact official model-capability overlay below. */
export const officialModelCapabilityCatalogVersion = "2026-09-11" as const;

const officialCapabilities: Readonly<Record<string, ReasoningCapability>> = {
  "gpt-6-astra": effort(["low", "medium", "high", "xhigh", "max", "ultra"], "low"),
  "gpt-5.6-sol": effort(["low", "medium", "high", "xhigh", "max", "ultra"], "low"),
  "gpt-5.6-terra": effort(["low", "medium", "high", "xhigh", "max", "ultra"], "medium"),
  "gpt-5.6-luna": effort(["low", "medium", "high", "xhigh", "max"], "medium"),
  "gpt-daybreak-blue-latest": effort(["low", "medium", "high", "xhigh", "max", "ultra"], "low"),
  "gpt-daybreak-red-latest": effort(["low", "medium", "high", "xhigh", "max", "ultra"], "medium"),
  "gpt-5.5": effort(["low", "medium", "high", "xhigh"], "medium"),
  "gpt-5.4": effort(["low", "medium", "high", "xhigh"], "medium"),
  "codex-auto-review": effort(["low", "medium", "high", "xhigh", "max"], "medium"),
  "claude-opus-4.8": effort(["low", "medium", "high", "xhigh", "max"]),
  "claude-opus-5": effort(["low", "medium", "high", "xhigh", "max"], "high"),
  "claude-sonnet-5": effort(["low", "medium", "high", "xhigh", "max"], "high"),
  "claude-sonnet-4.6": effort(["low", "medium", "high", "max"]),
  "claude-haiku-4-5-20251001": { kind: "unsupported" },
  "glm-5.3": {
    kind: "thinking-mode",
    mode: "forced",
    source: "official-model-catalog",
  },
};

export function officialReasoningCapabilityFor(modelId: string): ReasoningCapability {
  return officialCapabilities[modelId] ?? { kind: "unknown" };
}

function effort(values: readonly string[], defaultLevel?: string): ReasoningCapability {
  return {
    kind: "effort",
    values,
    ...(defaultLevel === undefined ? {} : { default: defaultLevel }),
    source: "official-model-catalog",
  };
}
