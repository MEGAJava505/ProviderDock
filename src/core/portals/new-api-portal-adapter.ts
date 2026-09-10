import { createHash } from "node:crypto";
import type { SecretStore } from "../security/secret-store.js";
import { normalizeNewApiCatalog, normalizeNewApiPerformance } from "./new-api-catalog.js";
import { normalizeSubscriptions, normalizeVessaRewards, normalizeVyceWallet, normalizeVyceSubscriptions, normalizeVyceCatalog } from "./portal-account-data.js";
import { portalSnapshotSchema, type PortalConnection, type PortalErrorCode, type PortalObservation,
  type PortalSnapshot, type PortalSiteInfo, type PortalCheckIn, type PortalWallet, type ProviderPortalAdapter } from "./portal-types.js";

type JsonRecord = Record<string, unknown>;
class PortalReadError extends Error {
  constructor(readonly code: PortalErrorCode, readonly httpStatus?: number, readonly retryAt?: string) { super(code); }
}
export interface NewApiPortalOptions { readonly fetchImpl?: typeof fetch; readonly timeoutMs?: number; }

/** New API's dashboard account contract, independent of its inference API. GET only. */
export class NewApiPortalAdapter implements ProviderPortalAdapter {
  readonly id = "new-api";
  readonly displayName = "Авто — New API, Vessa, Vyce AI";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly secrets: SecretStore, options: NewApiPortalOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async read(connection: PortalConnection, now: Date): Promise<PortalSnapshot> {
    // Resolve once so both private reads use the same account credential.
    const credential = connection.auth.kind !== "none"
      ? await this.secrets.get(connection.auth.secretRef).catch(() => undefined) : undefined;
    const observe = async <T>(path: string, privateRead: boolean, normalize: (data: JsonRecord) => T,
      envelope: boolean | "plain" = false, optionalAuth = false): Promise<PortalObservation<T>> => {
      const sourceUrl = new URL(path, connection.siteUrl).href;
      const base = { sourceUrl, observedAt: now.toISOString(), expiresAt: new Date(now.valueOf() + connection.refreshIntervalMs).toISOString() };
      try {
        if (privateRead && !credential) throw new PortalReadError(connection.auth.kind === "none" ? "AUTH_REQUIRED" : "MISSING_SECRET");
        const data = await this.getJson(sourceUrl, privateRead || optionalAuth ? credential : undefined,
          (privateRead || optionalAuth) && credential ? connection.userId : undefined, now, envelope, connection.auth.kind,
          connection.userAgent);
        const value = normalize(data);
        if (credential && JSON.stringify(value).includes(credential)) throw new PortalReadError("INVALID_RESPONSE");
        return { ...base, status: "ok", value };
      } catch (error) {
        const failure = error instanceof PortalReadError ? error : new PortalReadError("INVALID_RESPONSE");
        return { ...base, status: ["AUTH_REQUIRED", "MISSING_SECRET", "ACCOUNT_MISMATCH"].includes(failure.code) ? "auth-required" :
          failure.code === "UNSUPPORTED_ENDPOINT" ? "unsupported" : "error", code: failure.code,
          ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
          ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }), value: null };
      }
    };
    const hostname = new URL(connection.siteUrl).hostname;
    if (hostname === "vyceai.com" || hostname === "www.vyceai.com") {
      // Its website uses a session cookie/Bearer JWT, not a New API integration token.
      const dashboard = await observe("/user/dashboard", true, (data) => data, "plain");
      const user = dashboard.value?.user;
      const mismatch = connection.userId !== undefined && isRecord(user) && String(user.id) !== String(connection.userId);
      const project = <T>(normalize: (data: JsonRecord) => T): PortalObservation<T> => {
        if (mismatch) return { ...dashboard, status: "auth-required", code: "ACCOUNT_MISMATCH", value: null };
        if (!dashboard.value) return { ...dashboard, value: null };
        try { return { ...dashboard, value: normalize(dashboard.value) }; }
        catch { return { ...dashboard, status: "error", code: "INVALID_RESPONSE", value: null }; }
      };
      const unsupported = { sourceUrl: connection.siteUrl, observedAt: now.toISOString(),
        expiresAt: new Date(now.valueOf() + connection.refreshIntervalMs).toISOString(), status: "unsupported", code: "UNSUPPORTED_ENDPOINT", value: null };
      return portalSnapshotSchema.parse({ site: unsupported, checkIn: unsupported,
        wallet: project(data => normalizeVyceWallet(data, connection)), subscriptions: project(data => normalizeVyceSubscriptions(data, now)),
        catalog: project(normalizeVyceCatalog) });
    }
    const vessa = ["vsllm.cc", "vsllm.com", "www.vsllm.cc", "www.vsllm.com"].includes(hostname);
    const [site, walletRaw, checkInRaw, catalogRaw, performanceRaw] = await Promise.all([
      observe("/api/status", false, normalizeSite),
      observe("/api/user/self", true, (data) => normalizeWallet(data, connection, credential)),
      observe("/api/user/checkin", true, normalizeCheckIn),
      observe("/api/pricing", false, normalizeNewApiCatalog, true, true),
      observe("/api/perf-metrics/summary", false, normalizeNewApiPerformance, false, true),
    ]);
    let wallet = walletRaw;
    if (wallet.value && wallet.value.remainingQuota !== null && site.value) {
      wallet = { ...wallet, value: { ...wallet.value, displayBalance: displayQuota(wallet.value.remainingQuota, site.value) } };
    }
    let checkIn = site.value?.checkInEnabled === false
      ? { ...site, value: disabledCheckIn() } : checkInRaw;
    if (wallet.code === "ACCOUNT_MISMATCH") checkIn = { ...checkIn, status: "auth-required", code: "ACCOUNT_MISMATCH", value: null };
    const mismatch = wallet.code === "ACCOUNT_MISMATCH";
    const catalog = mismatch ? { ...catalogRaw, status: "auth-required", code: "ACCOUNT_MISMATCH", value: null } :
      catalogRaw.value && site.value ? { ...catalogRaw, value: { models: catalogRaw.value.models.map(model => {
        const convert = (prices: typeof model.basePrices) => {
          const unit = displayQuota(site.value!.quotaPerUnit ?? 0, site.value!);
          if (!unit) return prices;
          const value = (amount: number | null) => amount === null ? null : amount * unit.amount;
          return { currency: unit.currency, inputPerMillion: value(prices.inputPerMillion), outputPerMillion: value(prices.outputPerMillion),
            cacheReadInputPerMillion: value(prices.cacheReadInputPerMillion), cacheWriteInputPerMillion: value(prices.cacheWriteInputPerMillion),
            perRequest: value(prices.perRequest) };
        };
        return { ...model, basePrices: convert(model.basePrices), groups: model.groups.map(group => ({ ...group, prices: group.prices ? convert(group.prices) : null })) };
      }) } } : catalogRaw;
    const performance = mismatch ? { ...performanceRaw, status: "auth-required", code: "ACCOUNT_MISMATCH", value: null } : performanceRaw;
    const extras = vessa ? await Promise.all([
      observe("/api/subscription/self", true, (data) => normalizeSubscriptions(data, now)),
      observe("/api/gwent/status", true, normalizeVessaRewards),
    ]) : [];
    return portalSnapshotSchema.parse({ site, wallet, checkIn, catalog, performance,
      ...(vessa ? { subscriptions: mismatch ? { ...extras[0], status: "auth-required", code: "ACCOUNT_MISMATCH", value: null } : extras[0],
        rewards: mismatch ? { ...extras[1], status: "auth-required", code: "ACCOUNT_MISMATCH", value: null } : extras[1] } : {}) });
  }

  private async getJson(url: string, credential: string | undefined, userId: number | undefined, now: Date, envelope: boolean | "plain", authKind: PortalConnection["auth"]["kind"], userAgent?: string): Promise<JsonRecord> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      const headers = new Headers({ Accept: "application/json" });
      if (credential) headers.set(authKind === "cookie" ? "Cookie" : "Authorization", authKind === "cookie" ? credential : "Bearer " + credential);
      if (credential && authKind === "cookie" && userAgent) headers.set("User-Agent", userAgent);
      if (userId !== undefined) headers.set("New-Api-User", String(userId));
      response = await this.fetchImpl(url, { method: "GET", headers, redirect: "manual", cache: "no-store", signal: abort.signal });
      const status = response.status;
      if (status >= 300 && status < 400) throw new PortalReadError("REDIRECT_BLOCKED", status);
      if (status === 401 || status === 403) throw new PortalReadError("AUTH_REQUIRED", status);
      if ([404, 405, 501].includes(status)) throw new PortalReadError("UNSUPPORTED_ENDPOINT", status);
      if (status === 429) {
        const raw = response.headers.get("retry-after") ?? "";
        const millis = /^\d+$/.test(raw) ? Number(raw) * 1_000 : Date.parse(raw) - now.valueOf();
        const wait = Number.isFinite(millis) ? Math.max(60_000, Math.min(86_400_000, millis)) : 300_000;
        throw new PortalReadError("RATE_LIMITED", status, new Date(now.valueOf() + wait).toISOString());
      }
      if (!response.ok) throw new PortalReadError("UPSTREAM_ERROR", status);
      if (!response.headers.get("content-type")?.toLowerCase().includes("json")) throw new PortalReadError("INVALID_RESPONSE", status);
      const reader = response.body?.getReader();
      if (!reader) throw new PortalReadError("INVALID_RESPONSE", status);
      const onAbort = () => { void reader.cancel().catch(() => undefined); };
      abort.signal.addEventListener("abort", onAbort, { once: true });
      if (abort.signal.aborted) onAbort();
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 1_048_576) throw new PortalReadError("INVALID_RESPONSE", status);
          chunks.push(value);
        }
      } finally { abort.signal.removeEventListener("abort", onAbort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (abort.signal.aborted) throw new PortalReadError("TIMEOUT");
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(parsed)) throw new PortalReadError("INVALID_RESPONSE", status);
      if (envelope === "plain") return parsed;
      if (parsed.success !== true) {
        // Never return the upstream message or raw body: they may echo credentials.
        throw new PortalReadError(typeof parsed.code === "string" && /^(AUTH_|UNAUTHORIZED|UNAUTHENTICATED)/.test(parsed.code)
          ? "AUTH_REQUIRED" : "UPSTREAM_ERROR", status);
      }
      if (envelope) return parsed;
      if (!isRecord(parsed.data)) throw new PortalReadError("INVALID_RESPONSE", status);
      return parsed.data;
    } catch (error) {
      if (error instanceof PortalReadError) throw error;
      if (abort.signal.aborted) throw new PortalReadError("TIMEOUT");
      throw new PortalReadError(response ? "INVALID_RESPONSE" : "NETWORK_ERROR");
    } finally { clearTimeout(timer); await response?.body?.cancel().catch(() => undefined); }
  }
}

function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function count(value: unknown): number | null { return integer(value) && value >= 0 ? value : null; }
function normalizeSite(data: JsonRecord): PortalSiteInfo {
  const checkInEnabled = typeof data.checkin_enabled === "boolean" ? data.checkin_enabled : null;
  const quotaPerUnit = typeof data.quota_per_unit === "number" && Number.isFinite(data.quota_per_unit) && data.quota_per_unit > 0 ? data.quota_per_unit : null;
  if (checkInEnabled === null && quotaPerUnit === null) throw new PortalReadError("INVALID_RESPONSE");
  const quotaDisplayType = ["USD", "CNY", "TOKENS", "CUSTOM"].includes(String(data.quota_display_type)) ? data.quota_display_type as PortalSiteInfo["quotaDisplayType"] : null;
  const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  return { checkInEnabled, quotaPerUnit, quotaDisplayType,
    usdExchangeRate: positive(data.usd_exchange_rate), customCurrencyExchangeRate: positive(data.custom_currency_exchange_rate),
    customCurrencySymbol: typeof data.custom_currency_symbol === "string" && data.custom_currency_symbol.length > 0 && data.custom_currency_symbol.length <= 16 ? data.custom_currency_symbol : null };
}

/** Use the site's display settings, never its recharge price as an exchange rate. */
export function displayQuota(quota: number, site: PortalSiteInfo): PortalWallet["displayBalance"] {
  if (!site.quotaPerUnit) return null;
  const currency = site.quotaDisplayType === "USD" ? "USD" : site.quotaDisplayType === "CNY" ? "CNY" :
    site.quotaDisplayType === "CUSTOM" ? site.customCurrencySymbol : null;
  const rate = site.quotaDisplayType === "USD" ? 1 : site.quotaDisplayType === "CNY" ? site.usdExchangeRate : site.customCurrencyExchangeRate;
  if (!currency || !rate) return null;
  const amount = quota / site.quotaPerUnit * rate;
  return Number.isFinite(amount) ? { amount, currency, source: "site-display" } : null;
}
function normalizeWallet(data: JsonRecord, connection: PortalConnection, credential?: string): PortalWallet {
  if (!integer(data.id) || data.id < 1 || !integer(data.quota)) throw new PortalReadError("INVALID_RESPONSE");
  if (connection.userId !== undefined && data.id !== connection.userId) throw new PortalReadError("ACCOUNT_MISMATCH");
  const group = typeof data.group === "string" && data.group.length <= 128 && (!credential || !data.group.includes(credential)) ? data.group : null;
  return { accountFingerprint: createHash("sha256").update(connection.siteUrl + "\0" + data.id).digest("hex"),
    group, remainingQuota: data.quota, usedQuota: count(data.used_quota), displayBalance: null };
}
function disabledCheckIn(): PortalCheckIn {
  return { featureEnabled: false, eligibility: "disabled", totalCheckins: null, totalRewardQuota: null,
    records: [], minimumRewardQuota: null, maximumRewardQuota: null, siteTimeZone: null };
}
function normalizeCheckIn(data: JsonRecord): PortalCheckIn {
  if (typeof data.enabled !== "boolean") throw new PortalReadError("INVALID_RESPONSE");
  if (!data.enabled) return disabledCheckIn();
  const stats = isRecord(data.stats) ? data.stats : {};
  const records: PortalCheckIn["records"] = [];
  if (Array.isArray(stats.records)) {
    if (stats.records.length > 31) throw new PortalReadError("INVALID_RESPONSE");
    for (const record of stats.records) {
      if (!isRecord(record) || typeof record.checkin_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(record.checkin_date) || count(record.quota_awarded) === null)
        throw new PortalReadError("INVALID_RESPONSE");
      records.push({ date: record.checkin_date, rewardQuota: record.quota_awarded as number });
    }
  }
  return { featureEnabled: true, eligibility: stats.checked_in_today === true ? "claimed" : stats.checked_in_today === false ? "available" : "unknown",
    totalCheckins: count(stats.total_checkins), totalRewardQuota: count(stats.total_quota), records,
    minimumRewardQuota: count(data.min_quota), maximumRewardQuota: count(data.max_quota), siteTimeZone: null };
}
