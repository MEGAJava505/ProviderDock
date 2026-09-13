import type { ProviderProfile } from "./provider-profile.js";
import {
  officialReasoningCapabilityFor,
} from "./official-model-capabilities.js";
import type { ReasoningCapability } from "./reasoning-capability.js";

export const modelHealthStatuses = [
  "UNKNOWN",
  "CHECKING",
  "ONLINE",
  "DEGRADED",
  "OFFLINE",
  "AUTH_ERROR",
  "RATE_LIMITED",
  "INCOMPATIBLE",
  "DISABLED",
] as const;

export type ModelHealthStatus = (typeof modelHealthStatuses)[number];

export const capabilityStatuses = ["SUPPORTED", "UNSUPPORTED", "DEGRADED", "UNKNOWN"] as const;
export type CapabilityStatus = (typeof capabilityStatuses)[number];

export const clientCompatibilityStatuses = [
  "NATIVE",
  "ADAPTER",
  "INCOMPATIBLE",
  "UNKNOWN",
] as const;
export type ClientCompatibilityStatus = (typeof clientCompatibilityStatuses)[number];

export interface DiscoveredProviderModel {
  readonly modelId: string;
  readonly displayName: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ModelCatalogEntry {
  readonly internalId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly source: "discovered" | "manual";
  readonly healthStatus: ModelHealthStatus;
  readonly codexCompatibility: ClientCompatibilityStatus;
  readonly claudeCompatibility: ClientCompatibilityStatus;
  readonly reasoning: ReasoningCapability;
  readonly supportedReasoningLevels?: readonly string[];
}

export function mergeModelCatalog(
  profile: ProviderProfile,
  discoveredModels: readonly DiscoveredProviderModel[],
): readonly ModelCatalogEntry[] {
  const models = new Map<string, ModelCatalogEntry>();

  for (const modelId of profile.manualModelIds) {
    models.set(modelId, createEntry(profile.id, modelId, modelId, "manual", "UNKNOWN"));
  }

  for (const model of discoveredModels) {
    models.set(
      model.modelId,
      createEntry(
        profile.id,
        model.modelId,
        model.displayName,
        "discovered",
        "UNKNOWN",
        model.raw,
      ),
    );
  }

  return [...models.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

export function resolveReasoningCapability(
  modelId: string,
  raw?: Readonly<Record<string, unknown>>,
): ReasoningCapability {
  const official = officialReasoningCapabilityFor(modelId);
  if (official.kind !== "unknown") return official;

  const levels = raw === undefined ? undefined : supportedReasoningLevels(raw);
  return levels === undefined
    ? { kind: "unknown" }
    : { kind: "effort", values: levels, source: "provider-metadata" };
}

function createEntry(
  providerId: string,
  modelId: string,
  displayName: string,
  source: ModelCatalogEntry["source"],
  healthStatus: ModelHealthStatus,
  raw?: Readonly<Record<string, unknown>>,
): ModelCatalogEntry {
  const reasoning = resolveReasoningCapability(modelId, raw);
  return {
    internalId: `${providerId}:${modelId}`,
    providerId,
    modelId,
    displayName,
    source,
    healthStatus,
    codexCompatibility: "UNKNOWN",
    claudeCompatibility: "UNKNOWN",
    reasoning,
    ...(reasoning.kind === "effort" && reasoning.values.length > 0
      ? { supportedReasoningLevels: reasoning.values }
      : {}),
  };
}

const reasoningLevelAliases = [
  "supported_reasoning_levels",
  "supported_reasoning_efforts",
  "reasoning_efforts",
  "reasoning_levels",
] as const;

function supportedReasoningLevels(
  raw: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  const levels = new Set<string>();
  const containers = [raw, raw.metadata, raw.capabilities];
  for (const container of containers) {
    if (!isRecord(container)) continue;
    for (const alias of reasoningLevelAliases) {
      const value = container[alias];
      if (!Array.isArray(value)) continue;
      for (const level of value) {
        if (typeof level !== "string") continue;
        const normalized = level.trim();
        if (normalized !== "") levels.add(normalized);
      }
    }
  }
  return levels.size === 0 ? undefined : [...levels];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
