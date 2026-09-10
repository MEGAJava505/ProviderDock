import type { ProviderHealthRecord } from "../core/health/provider-health-repository.js";
import type { ModelHealthStatus } from "../core/providers/model-catalog.js";
import type { ProviderProfile } from "../core/providers/provider-profile.js";
import type { PortalRecord } from "../core/portals/portal-types.js";
import { removedModelRetentionMs } from "../core/health/model-presence.js";

/** Reading a catalog never performs inference or invents provider billing/load data. */
export function buildModelStorefront(
  providers: readonly ProviderProfile[],
  health: readonly ProviderHealthRecord[],
  now: Date,
  portals: readonly PortalRecord[] = [],
) {
  const records = new Map(health.map((record) => [record.providerId, record]));
  const accounts = new Map(portals.map((record) => [record.connection.providerId, record]));
  const recentAfter = now.valueOf() - 24 * 60 * 60 * 1_000;
  const evidenceTtlMs = 30 * 60 * 1_000;
  return providers.flatMap((profile) => {
    const record = records.get(profile.id);
    const portal = accounts.get(profile.id);
    const siteCatalog = portal?.latest?.catalog;
    const siteModels = new Map((siteCatalog?.value?.models ?? []).map((model) => [model.modelId, model]));
    const performance = portal?.latest?.performance;
    const sitePerformance = new Map((performance?.value?.models ?? []).map((model) => [model.modelId, model]));
    const catalog = new Map((record?.latest?.models ?? []).map((model) => [model.modelId, model]));
    const diagnostics = new Map<string, NonNullable<typeof record>["diagnostics"][number]>();
    for (const diagnostic of record?.diagnostics ?? []) {
      if (diagnostic.doctorLevel < 1) continue;
      const previous = diagnostics.get(diagnostic.modelId);
      if (!previous || diagnostic.checkedAt > previous.checkedAt) diagnostics.set(diagnostic.modelId, diagnostic);
    }
    const signals = new Map<string, NonNullable<typeof record>["runtimeSignals"][number][]>();
    for (const signal of record?.runtimeSignals ?? []) {
      const entries = signals.get(signal.modelId) ?? [];
      entries.push(signal);
      signals.set(signal.modelId, entries);
    }
    const ids = new Set([
      ...profile.manualModelIds, ...catalog.keys(), ...diagnostics.keys(), ...signals.keys(),
      ...(record?.knownModelIds ?? []),
      ...Object.keys(profile.modelPricing),
      ...siteModels.keys(),
    ]);
    return [...ids].filter((modelId) => {
      const removedAt = record?.modelRemovals?.[modelId];
      return !removedAt || now.valueOf() - Date.parse(removedAt) < removedModelRetentionMs;
    }).map((modelId) => {
      const diagnostic = diagnostics.get(modelId);
      const history = (signals.get(modelId) ?? []).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
      const lastSignal = history.at(-1);
      const recent = history.filter((signal) => Date.parse(signal.observedAt) >= recentAfter && Date.parse(signal.observedAt) <= now.valueOf()).slice(-30);
      const runtimeNewest = lastSignal && (!diagnostic || lastSignal.observedAt >= diagnostic.checkedAt);
      const checkedAt = runtimeNewest ? lastSignal.observedAt : diagnostic?.checkedAt;
      const stale = checkedAt !== undefined && (now.valueOf() - Date.parse(checkedAt) > evidenceTtlMs || Date.parse(checkedAt) > now.valueOf());
      let status: ModelHealthStatus = runtimeNewest ? lastSignal.healthStatus :
        diagnostic?.verdict === "PASS" ? "ONLINE" : diagnostic?.verdict === "FAIL" ? "INCOMPATIBLE" :
        diagnostic?.verdict === "DEGRADED" ? "DEGRADED" : "UNKNOWN";
      // Successful metadata refreshes do not overwrite real model checks.
      if (stale) status = "UNKNOWN";
      const probe = record?.latest?.health;
      const freshCatalog = probe && !probe.errorType && ["ONLINE", "DEGRADED"].includes(probe.status) && Date.parse(probe.checkedAt) <= now.valueOf() &&
        now.valueOf() - Date.parse(probe.checkedAt) <= profile.healthCheck.metadataTtlMs;
      const listedForApiKey = catalog.get(modelId)?.source === "discovered";
      const removedAt = record?.modelRemovals?.[modelId] ?? null;
      const disappeared = Boolean(removedAt) || (freshCatalog && !listedForApiKey && (record?.knownModelIds ?? []).includes(modelId));
      const siteHidden = !disappeared && freshCatalog && listedForApiKey && siteCatalog?.status === "ok" &&
        Date.parse(siteCatalog.expiresAt) > now.valueOf() && !siteModels.has(modelId);
      const lifecycle = disappeared ? "removed" : siteHidden ? "site-hidden" : listedForApiKey ? "available" : "unverified";
      let availabilityReason: string | null = null;
      if (disappeared) {
        status = "OFFLINE";
        availabilityReason = "Модель исчезла из списка API";
      }
      const siteStatus = siteModels.get(modelId)?.availability;
      if (siteStatus && siteCatalog && Date.parse(siteCatalog.expiresAt) > now.valueOf() &&
          (!checkedAt || siteCatalog.observedAt >= checkedAt)) {
        if (["offline", "disabled", "maintenance", "coming"].includes(siteStatus)) {
          status = "OFFLINE"; availabilityReason = "Недоступна по данным сайта";
        } else if (["degraded", "unstable"].includes(siteStatus)) {
          status = "DEGRADED"; availabilityReason = "Сайт сообщает об ограничениях";
        }
      }
      if (probe && (!checkedAt || probe.checkedAt >= checkedAt) &&
          Date.parse(probe.checkedAt) <= now.valueOf() &&
          now.valueOf() - Date.parse(probe.checkedAt) <= profile.healthCheck.metadataTtlMs &&
          ["AUTH_ERROR", "OFFLINE", "RATE_LIMITED"].includes(probe.status)) status = probe.status;
      if (disappeared) status = "OFFLINE";
      const locallyDisabled = profile.disabledModelIds.includes(modelId);
      if (!profile.enabled || locallyDisabled) status = "DISABLED";
      const ok = recent.filter((signal) => signal.outcome === "completed").length;
      const total = recent.length;
      const err = total - ok;
      const pricing = profile.modelPricing[modelId];
      return {
        providerId: profile.id, providerName: profile.displayName, modelId,
        displayName: catalog.get(modelId)?.displayName ?? modelId,
        source: catalog.has(modelId) ? "catalog" : "manual", enabled: profile.enabled && !locallyDisabled,
        locallyDisabled, lifecycle, removedAt,
        status, availabilityReason, checkedAt, stale, diagnostic, lastSignal, ok, err, total,
        stability: total ? ok / total * 100 : undefined,
        errPct: total ? err / total * 100 : undefined,
        rateLimited: recent.filter((signal) => signal.httpStatus === 429 || signal.errorType === "RATE_LIMIT").length,
        metadataLatencyMs: probe?.latencyMs,
        catalogCheckedAt: probe?.checkedAt,
        pricing: pricing ? { ...pricing, source: "manual" as const, verifiedAt: null } : null,
        siteModel: siteModels.get(modelId) ?? null,
        siteCatalog: siteCatalog ? { status: siteCatalog.status, sourceUrl: siteCatalog.sourceUrl,
          observedAt: siteCatalog.observedAt, stale: Date.parse(siteCatalog.expiresAt) <= now.valueOf() } : null,
        sitePerformance: sitePerformance.has(modelId) ? { ...sitePerformance.get(modelId)!,
          sourceUrl: performance!.sourceUrl, observedAt: performance!.observedAt,
          stale: Date.parse(performance!.expiresAt) <= now.valueOf(), windowHours: 24 } : null,
        listedForApiKey,
        // Account-specific APIs need provider adapters. Unknown is never zero/free.
        balance: null, providerLoad: null,
      };
    });
  }).sort((a, b) => a.modelId.localeCompare(b.modelId) || a.providerName.localeCompare(b.providerName));
}
