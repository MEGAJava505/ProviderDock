import { z } from "zod";
import { secretReferenceSchema } from "../providers/provider-profile.js";
import { portalCatalogSchema, portalPerformanceSchema } from "./new-api-catalog.js";

export const portalConnectionSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  adapterId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).default("new-api"),
  siteUrl: z.string().url().superRefine((value, context) => {
    let url: URL;
    try { url = new URL(value); } catch { return; } // z.string().url() reports malformed URLs.
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
        url.username || url.password || url.search || url.hash) {
      context.addIssue({ code: "custom", message: "Use an HTTPS site URL without credentials, query or fragment (local HTTP is allowed)." });
    }
  }).transform((value) => new URL(value).origin),
  auth: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("bearer"), secretRef: secretReferenceSchema }).strict(),
    z.object({ kind: z.literal("cookie"), secretRef: secretReferenceSchema }).strict(),
  ]).default({ kind: "none" }),
  userId: z.number().int().positive().safe().optional(),
  userAgent: z.string().min(1).max(512).refine((value) => !/[\r\n]/.test(value), "User-Agent must be one line.").optional(),
  autoRefresh: z.boolean().default(true),
  refreshIntervalMs: z.number().int().min(60_000).max(3_600_000).default(300_000),
}).strict();
export type PortalConnection = z.infer<typeof portalConnectionSchema>;

export function portalAdapterIdForSite(siteUrl: string, fallback: string): string {
  const hostname = new URL(siteUrl).hostname.toLowerCase();
  if (hostname === "nofx.one" || hostname.endsWith(".nofx.one")) return "nofx";
  if (hostname === "helyxai.space" || hostname === "www.helyxai.space") return "helyx";
  return fallback;
}

const quota = z.number().int().safe();
const count = quota.nonnegative();
export const walletSchema = z.object({
  accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  group: z.string().max(128).nullable(),
  remainingQuota: quota.nullable(),
  usedQuota: count.nullable(),
  displayBalance: z.object({ amount: z.number().finite(), currency: z.string().min(1).max(16),
    source: z.literal("site-display") }).strict().nullable(),
}).strict();
export const checkInSchema = z.object({
  featureEnabled: z.boolean().nullable(),
  eligibility: z.enum(["available", "claimed", "disabled", "unknown"]),
  totalCheckins: count.nullable(),
  totalRewardQuota: count.nullable(),
  records: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    rewardQuota: count }).strict()).max(31),
  minimumRewardQuota: count.nullable(),
  maximumRewardQuota: count.nullable(),
  siteTimeZone: z.null(), // Do not infer the provider's day from the local clock.
}).strict();
export const siteInfoSchema = z.object({
  checkInEnabled: z.boolean().nullable(),
  quotaPerUnit: z.number().finite().positive().nullable(),
  quotaDisplayType: z.enum(["USD", "CNY", "TOKENS", "CUSTOM"]).nullable(),
  usdExchangeRate: z.number().finite().positive().nullable().optional(),
  customCurrencyExchangeRate: z.number().finite().positive().nullable().optional(),
  customCurrencySymbol: z.string().min(1).max(16).nullable().optional(),
}).strict();

export const portalErrorCodes = ["AUTH_REQUIRED", "MISSING_SECRET", "UNSUPPORTED_ENDPOINT", "RATE_LIMITED",
  "NETWORK_ERROR", "TIMEOUT", "INVALID_RESPONSE", "UPSTREAM_ERROR", "ACCOUNT_MISMATCH", "REDIRECT_BLOCKED"] as const;
export type PortalErrorCode = typeof portalErrorCodes[number];
const observation = <T extends z.ZodTypeAny>(value: T) => z.object({
  status: z.enum(["ok", "auth-required", "unsupported", "error"]),
  code: z.enum(portalErrorCodes).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  sourceUrl: z.string().url(),
  observedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  retryAt: z.string().datetime().optional(),
  value: value.nullable(),
}).strict().refine((item) => (item.status === "ok") === (item.value !== null), "Only successful observations have values.");

export const portalSubscriptionsSchema = z.object({ items: z.array(z.object({
  name: z.string().min(1).max(128), status: z.enum(["active", "expired", "inactive"]),
  expiresAt: z.string().datetime().nullable(), totalQuota: count.nullable(), usedQuota: count.nullable(),
}).strict()).max(100) }).strict();
export const portalRewardsSchema = z.object({
  enabled: z.boolean(), availableAttempts: count.nullable(), maximumAttempts: count.nullable(),
  nextAvailableAt: z.string().datetime().nullable(), cooldownSeconds: count.nullable(),
}).strict();

export const portalSnapshotSchema = z.object({
  site: observation(siteInfoSchema),
  wallet: observation(walletSchema),
  checkIn: observation(checkInSchema),
  catalog: observation(portalCatalogSchema).optional(),
  performance: observation(portalPerformanceSchema).optional(),
  subscriptions: observation(portalSubscriptionsSchema).optional(),
  rewards: observation(portalRewardsSchema).optional(),
}).strict();
export type PortalSnapshot = z.infer<typeof portalSnapshotSchema>;
export type PortalWallet = z.infer<typeof walletSchema>;
export type PortalCheckIn = z.infer<typeof checkInSchema>;
export type PortalSiteInfo = z.infer<typeof siteInfoSchema>;
export type PortalObservation<T> = Omit<PortalSnapshot["wallet"], "value"> & { readonly value: T | null };

export const portalRecordSchema = z.object({
  connection: portalConnectionSchema,
  revision: z.string().uuid(),
  latest: portalSnapshotSchema.optional(),
  lastWallet: z.object({ value: walletSchema, observedAt: z.string().datetime() }).strict().optional(),
  nextRefreshAt: z.string().datetime().optional(),
  failures: z.number().int().nonnegative().max(10).default(0),
}).strict();
export type PortalRecord = z.infer<typeof portalRecordSchema>;

export interface ProviderPortalAdapter {
  readonly id: string;
  readonly displayName: string;
  read(connection: PortalConnection, now: Date): Promise<PortalSnapshot>;
}

export class PortalConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "PortalConfigurationError"; }
}

export class ProviderPortalAdapterRegistry {
  private readonly adapters = new Map<string, ProviderPortalAdapter>();
  register(adapter: ProviderPortalAdapter): this {
    if (this.adapters.has(adapter.id)) throw new PortalConfigurationError("Duplicate portal adapter ID.");
    this.adapters.set(adapter.id, adapter);
    return this;
  }
  resolve(id: string): ProviderPortalAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new PortalConfigurationError("This portal adapter is not installed.");
    return adapter;
  }
  list() { return [...this.adapters.values()].map(({ id, displayName }) => ({ id, displayName })); }
}
