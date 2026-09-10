import { createHash } from "node:crypto";
import { portalCatalogSchema, type PortalCatalog } from "./new-api-catalog.js";
import { portalRewardsSchema, portalSubscriptionsSchema, walletSchema, type PortalConnection } from "./portal-types.js";

type Data = Record<string, unknown>;
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid account data");
  return value as Data;
}
function count(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }
function amount(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function time(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (value === 0 || value === "") return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function normalizeSubscriptions(data: Data, now: Date) {
  const rows = data.all_subscriptions ?? data.subscriptions;
  if (!Array.isArray(rows)) throw new Error("Missing subscriptions");
  return portalSubscriptionsSchema.parse({ items: rows.map(value => {
    const row = object(value); const subscription = object(row.subscription);
    const plan = row.plan ? object(row.plan) : {};
    const expiresAt = time(subscription.end_time);
    return { name: typeof plan.title === "string" ? plan.title : "Подписка #" + String(subscription.plan_id),
      status: expiresAt && Date.parse(expiresAt) <= now.valueOf() ? "expired" : subscription.status === "active" && expiresAt ? "active" : "inactive",
      expiresAt, totalQuota: count(subscription.amount_total), usedQuota: count(subscription.amount_used) };
  }) });
}

export function normalizeVessaRewards(data: Data) {
  if (typeof data.enabled !== "boolean") throw new Error("Missing rewards status");
  const charges = count(data.charges_current); const extra = count(data.extra_draws_left);
  return portalRewardsSchema.parse({ enabled: data.enabled,
    availableAttempts: charges === null ? null : charges + (extra ?? 0), maximumAttempts: count(data.charges_max),
    nextAvailableAt: time(data.next_charge_at) ?? time(data.next_available_at), cooldownSeconds: count(data.cooldown_seconds) });
}

export function normalizeVyceWallet(data: Data, connection: PortalConnection) {
  const user = object(data.user);
  if ((typeof user.id !== "number" && typeof user.id !== "string") || typeof user.totalBalance !== "number" || !Number.isFinite(user.totalBalance)) throw new Error("Missing account credits");
  if (connection.userId !== undefined && String(connection.userId) !== String(user.id)) throw new Error("Account mismatch");
  // This provider exposes money, not a quota counter. Preserve money without fabricating tokens.
  return walletSchema.parse({ accountFingerprint: createHash("sha256").update(connection.siteUrl + "\0" + user.id).digest("hex"),
    group: typeof user.tier === "string" ? user.tier : null, remainingQuota: null, usedQuota: null,
    displayBalance: { amount: user.totalBalance, currency: "USD", source: "site-display" } });
}

export function normalizeVyceSubscriptions(data: Data, now: Date) {
  const user = object(data.user); const expiresAt = time(user.tierExpiresAt);
  return portalSubscriptionsSchema.parse({ items: typeof user.tier === "string" && user.tier !== "free" ? [{ name: user.tier,
    status: expiresAt && Date.parse(expiresAt) > now.valueOf() ? "active" : expiresAt ? "expired" : "inactive", expiresAt,
    totalQuota: null, usedQuota: null }] : [] });
}

export function normalizeVyceCatalog(data: Data): PortalCatalog {
  if (!Array.isArray(data.models)) throw new Error("Missing models");
  return portalCatalogSchema.parse({ models: data.models.map(value => {
    const row = object(value);
    return { modelId: row.id, description: typeof row.description === "string" ? row.description : null,
      vendor: null, endpointTypes: [], tags: null, contextTokens: null, billing: "tokens",
      availability: typeof row.status === "string" ? row.status : null,
      basePrices: { currency: "USD", inputPerMillion: amount(row.inputPrice), outputPerMillion: amount(row.outputPrice),
        cacheReadInputPerMillion: null, cacheWriteInputPerMillion: null, perRequest: null }, groups: [] };
  }) });
}
