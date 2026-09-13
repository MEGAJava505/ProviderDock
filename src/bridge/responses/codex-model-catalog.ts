import { officialReasoningCapabilityFor } from "../../core/providers/official-model-capabilities.js";
import type { ReasoningCapability } from "../../core/providers/reasoning-capability.js";

export interface BridgeModelDefinition {
  readonly modelId: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly contextWindow?: number;
  readonly maxContextWindow?: number;
  readonly defaultReasoningLevel?: string;
  readonly supportedReasoningLevels?: readonly string[];
  readonly reasoning?: ReasoningCapability;
  readonly supportsImages?: boolean;
  readonly supportsParallelToolCalls?: boolean;
  readonly supportsSearchTool?: boolean;
  readonly supportsReasoningSummaries?: boolean;
}

const bridgeInstructions = `You are Codex, a coding agent working in the user's workspace.
Use the provided tools for shell and file operations. Treat a successful tool output as
completed work and do not repeat a side-effecting tool call unless the task requires it.`;

const reasoningDescriptions: Readonly<Record<string, string>> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balanced reasoning for everyday tasks",
  high: "Greater reasoning depth for complex tasks",
  xhigh: "Extra reasoning depth for difficult tasks",
  max: "Maximum reasoning depth",
  ultra: "Maximum reasoning depth for long autonomous tasks",
};

export function createCodexModelInfo(
  model: BridgeModelDefinition,
  priority: number,
): Readonly<Record<string, unknown>> {
  const contextWindow = positiveInteger(model.contextWindow, 128_000);
  const maxContextWindow = Math.max(
    contextWindow,
    positiveInteger(model.maxContextWindow, contextWindow),
  );
  const official = officialReasoningCapabilityFor(model.modelId);
  const explicitReasoning = model.reasoning;
  const isUserOverride =
    explicitReasoning !== undefined &&
    "source" in explicitReasoning &&
    explicitReasoning.source === "user-override";
  const reasoning =
    official.kind !== "unknown" && !isUserOverride
      ? official
      : explicitReasoning ??
        (model.supportedReasoningLevels !== undefined &&
        model.supportedReasoningLevels.length > 0
          ? {
              kind: "effort" as const,
              values: model.supportedReasoningLevels,
              source: "provider-metadata" as const,
            }
          : official);
  const supportedReasoningLevels = reasoning.kind === "effort" ? reasoning.values : [];
  const defaultReasoningLevel =
    reasoning.kind === "effort"
      ? model.defaultReasoningLevel ?? reasoning.default ?? supportedReasoningLevels[0]
      : reasoning.kind === "unknown"
        ? model.defaultReasoningLevel
        : undefined;
  const inputModalities = model.supportsImages === true ? ["text", "image"] : ["text"];

  return {
    slug: model.modelId,
    display_name: model.displayName ?? model.modelId,
    description:
      model.description ?? "Provider model exposed through the local ProviderDock Responses bridge.",
    ...(defaultReasoningLevel === undefined
      ? {}
      : { default_reasoning_level: defaultReasoningLevel }),
    supported_reasoning_levels: supportedReasoningLevels.map((effort) => ({
      effort,
      description: reasoningDescriptions[effort] ?? `Reasoning level: ${effort}`,
    })),
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    input_modalities: inputModalities,
    supports_image_detail_original: model.supportsImages === true,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: model.supportsParallelToolCalls ?? true,
    tool_mode: "direct",
    multi_agent_version: "v2",
    use_responses_lite: false,
    include_skills_usage_instructions: false,
    include_apps_usage_instructions: false,
    include_plugin_usage_instructions: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: null,
    context_window: contextWindow,
    max_context_window: maxContextWindow,
    auto_compact_token_limit: null,
    comp_hash: "providerdock-bridge-v1",
    default_reasoning_summary: "none",
    model_messages: {
      instructions_template: bridgeInstructions,
      instructions_variables: null,
      approvals: null,
      collaboration_modes: null,
      auto_review: null,
      multi_agent: null,
      permissions: null,
      token_budget: null,
      guardian_v2: null,
    },
    base_instructions: bridgeInstructions,
    experimental_supported_tools: [],
    available_in_plans: [],
    supports_search_tool: model.supportsSearchTool ?? false,
    default_service_tier: null,
    service_tiers: [],
    additional_speed_tiers: [],
    supports_reasoning_summary_parameter: model.supportsReasoningSummaries ?? false,
    supports_reasoning_summaries: model.supportsReasoningSummaries ?? false,
  };
}

export function createCodexModelCatalog(
  models: readonly BridgeModelDefinition[],
): readonly Readonly<Record<string, unknown>>[] {
  return models.map((model, index) => createCodexModelInfo(model, index + 1));
}

export function createCodexModelCatalogDocument(
  models: readonly BridgeModelDefinition[],
): { readonly models: readonly Readonly<Record<string, unknown>>[] } {
  return { models: createCodexModelCatalog(models) };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}
