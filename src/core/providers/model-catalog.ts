import type { ProviderProfile } from "./provider-profile.js";

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
      createEntry(profile.id, model.modelId, model.displayName, "discovered", "ONLINE"),
    );
  }

  return [...models.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

function createEntry(
  providerId: string,
  modelId: string,
  displayName: string,
  source: ModelCatalogEntry["source"],
  healthStatus: ModelHealthStatus,
): ModelCatalogEntry {
  return {
    internalId: `${providerId}:${modelId}`,
    providerId,
    modelId,
    displayName,
    source,
    healthStatus,
    codexCompatibility: "UNKNOWN",
    claudeCompatibility: "UNKNOWN",
  };
}

