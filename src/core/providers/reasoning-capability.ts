export type ReasoningCapabilitySource =
  | "official-model-catalog"
  | "provider-metadata"
  | "probe"
  | "user-override";

export type ReasoningCapability =
  | { readonly kind: "unknown" }
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "effort";
      readonly values: readonly string[];
      readonly default?: string;
      readonly source: ReasoningCapabilitySource;
    }
  | {
      readonly kind: "thinking-mode";
      readonly mode: "forced" | "toggle" | "adaptive" | "unknown";
      readonly source: ReasoningCapabilitySource;
    };

export const unknownReasoningCapability: ReasoningCapability = { kind: "unknown" };
