import type { ProviderHealthRecord } from "./provider-health-repository.js";
import type { ProviderProbeResult } from "./provider-probe-service.js";

export const removedModelRetentionMs = 48 * 60 * 60 * 1000;

/** A failed catalog fetch is not evidence that all the provider's models disappeared. */
export function updateModelRemovals(previous: ProviderHealthRecord | undefined, result: ProviderProbeResult): Record<string, string> {
  const removals: Record<string, string> = Object.assign(Object.create(null), previous?.modelRemovals);
  if (result.health.errorType || !["ONLINE", "DEGRADED"].includes(result.health.status)) return removals;
  if (previous?.latest && previous.latest.health.checkedAt > result.health.checkedAt) return removals;
  const present = new Set(result.models.filter(model => model.source === "discovered").map(model => model.modelId));
  const known = new Set([...(previous?.knownModelIds ?? []), ...(previous?.latest?.models ?? [])
    .filter(model => model.source === "discovered").map(model => model.modelId)]);
  for (const id of known) if (!present.has(id) && !Object.hasOwn(removals, id)) removals[id] = result.health.checkedAt;
  for (const id of present) delete removals[id];
  return Object.fromEntries(Object.entries(removals).slice(-5000));
}
