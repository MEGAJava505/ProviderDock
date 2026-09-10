import { createHash } from "node:crypto";
import type { SecretStore } from "../security/secret-store.js";
import { portalCatalogSchema, type PortalCatalog } from "./new-api-catalog.js";
import {
  portalSnapshotSchema,
  type PortalConnection,
  type PortalErrorCode,
  type PortalObservation,
  type PortalSnapshot,
  type PortalWallet,
  type ProviderPortalAdapter,
} from "./portal-types.js";

type Data = Record<string, unknown>;

class NofxReadError extends Error {
  constructor(readonly code: PortalErrorCode, readonly httpStatus?: number) {
    super(code);
    this.name = "NofxReadError";
  }
}

export interface NofxPortalOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** NoFX has a custom portal plus an OpenAI-compatible API host discovered from that portal. */
export class NofxPortalAdapter implements ProviderPortalAdapter {
  readonly id = "nofx";
  readonly displayName = "NoFX";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly secrets: SecretStore, options: NofxPortalOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async read(connection: PortalConnection, now: Date): Promise<PortalSnapshot> {
    const unsupported = unsupportedObservation(connection.siteUrl, connection.refreshIntervalMs, now);
    const keysUrl = new URL(
      "/api/portal/api-keys?page=1&pageSize=100&sortBy=created_at&sortOrder=desc",
      connection.siteUrl,
    ).href;
    const credential = connection.auth.kind === "cookie"
      ? await this.secrets.get(connection.auth.secretRef).catch(() => undefined)
      : undefined;
    if (!credential) {
      const code: PortalErrorCode = connection.auth.kind === "cookie" ? "MISSING_SECRET" : "AUTH_REQUIRED";
      const failure = failureObservation(keysUrl, connection.refreshIntervalMs, now, new NofxReadError(code));
      return portalSnapshotSchema.parse({
        site: unsupported,
        wallet: failure,
        checkIn: unsupported,
        catalog: failure,
        performance: unsupported,
      });
    }

    try {
      const keyData = await this.getJson(keysUrl, { Cookie: credential }, now, true);
      const activeKey = selectActiveKey(keyData);
      const apiBase = await this.resolveApiBase(connection, credential, now);
      const usageUrl = new URL("/v1/usage", apiBase).href;
      const modelsUrl = new URL("/v1/models", apiBase).href;
      const apiHeaders = { Authorization: "Bearer " + activeKey.key };
      const [usage, models] = await Promise.allSettled([
        this.getJson(usageUrl, apiHeaders, now),
        this.getJson(modelsUrl, apiHeaders, now),
      ]);
      const wallet = usage.status === "fulfilled"
        ? successObservation(
            usageUrl,
            connection.refreshIntervalMs,
            now,
            normalizeUsage(usage.value, connection, activeKey.userId),
          )
        : failureObservation(usageUrl, connection.refreshIntervalMs, now, usage.reason);
      const catalog = models.status === "fulfilled"
        ? successObservation(
            modelsUrl,
            connection.refreshIntervalMs,
            now,
            normalizeModels(models.value),
          )
        : failureObservation(modelsUrl, connection.refreshIntervalMs, now, models.reason);
      return portalSnapshotSchema.parse({
        site: unsupported,
        wallet,
        checkIn: unsupported,
        catalog,
        performance: unsupported,
      });
    } catch (error) {
      const failure = failureObservation(keysUrl, connection.refreshIntervalMs, now, error);
      return portalSnapshotSchema.parse({
        site: unsupported,
        wallet: failure,
        checkIn: unsupported,
        catalog: failure,
        performance: unsupported,
      });
    }
  }

  private async resolveApiBase(
    connection: PortalConnection,
    credential: string,
    now: Date,
  ): Promise<string> {
    const site = new URL(connection.siteUrl);
    if (site.hostname !== "nofx.one" && site.hostname.endsWith(".nofx.one")) {
      return validateApiBase(site.origin);
    }
    const pageUrl = new URL("/en/api-keys", connection.siteUrl).href;
    const html = await this.getText(pageUrl, { Cookie: credential }, now, "html");
    return validateApiBase(extractApiBase(html));
  }

  private async getJson(
    url: string,
    headers: Readonly<Record<string, string>>,
    now: Date,
    apiKeys = false,
  ): Promise<Data> {
    const text = await this.getText(url, headers, now, "json", apiKeys);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new NofxReadError("INVALID_RESPONSE");
    }
    if (!isRecord(parsed)) throw new NofxReadError("INVALID_RESPONSE");
    return parsed;
  }

  private async getText(
    url: string,
    headerValues: Readonly<Record<string, string>>,
    now: Date,
    expected: "json" | "html",
    apiKeys = false,
  ): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      const headers = new Headers({ Accept: expected === "json" ? "application/json" : "text/html" });
      for (const [name, value] of Object.entries(headerValues)) headers.set(name, value);
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: abort.signal,
      });
      const text = await readBoundedText(response, abort.signal, expected === "html" ? 2_097_152 : 1_048_576);
      if (response.status >= 300 && response.status < 400) {
        throw new NofxReadError("AUTH_REQUIRED", response.status);
      }
      if (response.status === 401 || response.status === 403) {
        throw new NofxReadError("AUTH_REQUIRED", response.status);
      }
      if (response.status === 429) throw new NofxReadError("RATE_LIMITED", response.status);
      if ([404, 405, 501].includes(response.status)) {
        throw new NofxReadError("UNSUPPORTED_ENDPOINT", response.status);
      }
      if (!response.ok) {
        if (apiKeys && response.status === 500 && /API_KEYS_LOAD_FAILED/i.test(text)) {
          throw new NofxReadError("AUTH_REQUIRED", response.status);
        }
        throw new NofxReadError("UPSTREAM_ERROR", response.status);
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (expected === "json" ? !contentType.includes("json") : !contentType.includes("html")) {
        throw new NofxReadError("INVALID_RESPONSE", response.status);
      }
      return text;
    } catch (error) {
      if (error instanceof NofxReadError) throw error;
      if (abort.signal.aborted) throw new NofxReadError("TIMEOUT");
      throw new NofxReadError(response ? "INVALID_RESPONSE" : "NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => undefined);
    }
  }
}

function selectActiveKey(data: Data): { readonly key: string; readonly userId: string } {
  if (!Array.isArray(data.items) || data.items.length > 1_000) {
    throw new NofxReadError("INVALID_RESPONSE");
  }
  for (const value of data.items) {
    if (!isRecord(value) || !isActive(value.status)) continue;
    const key = typeof value.key === "string" ? value.key.trim() : "";
    const userId = typeof value.user_id === "string" || typeof value.user_id === "number"
      ? String(value.user_id)
      : "";
    if (key && key.length <= 8_192 && userId && userId.length <= 256) return { key, userId };
  }
  throw new NofxReadError("INVALID_RESPONSE");
}

function isActive(value: unknown): boolean {
  return value === true || value === 1 || ["active", "enabled", "valid"].includes(String(value).toLowerCase());
}

function normalizeUsage(data: Data, connection: PortalConnection, userId: string): PortalWallet {
  const amount = finiteNumber(data.remaining) ?? finiteNumber(data.balance);
  const currency = typeof data.unit === "string" ? data.unit.trim() : "";
  if (amount === null || !currency || currency.length > 16) throw new NofxReadError("INVALID_RESPONSE");
  const usage = isRecord(data.usage) ? data.usage : {};
  const total = isRecord(usage.total) ? usage.total : {};
  const usedQuota = nonnegativeInteger(total.total_tokens);
  return {
    accountFingerprint: createHash("sha256")
      .update(connection.siteUrl + "\0" + userId)
      .digest("hex"),
    group: typeof data.planName === "string" && data.planName.length <= 128 ? data.planName : null,
    remainingQuota: null,
    usedQuota,
    displayBalance: { amount, currency, source: "site-display" },
  };
}

function normalizeModels(data: Data): PortalCatalog {
  if (!Array.isArray(data.data) || data.data.length > 5_000) {
    throw new NofxReadError("INVALID_RESPONSE");
  }
  const ids = new Set<string>();
  return portalCatalogSchema.parse({
    models: data.data.map((value) => {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
        throw new NofxReadError("INVALID_RESPONSE");
      }
      const modelId = value.id.trim();
      if (ids.has(modelId)) throw new NofxReadError("INVALID_RESPONSE");
      ids.add(modelId);
      const displayName = typeof value.display_name === "string" ? value.display_name.trim() : "";
      const type = typeof value.type === "string" && value.type.length <= 64 ? value.type : undefined;
      return {
        modelId,
        description: displayName && displayName !== modelId ? displayName : null,
        vendor: typeof value.owned_by === "string" && value.owned_by.length <= 128 ? value.owned_by : null,
        endpointTypes: type ? [type] : [],
        tags: null,
        contextTokens: null,
        billing: "unknown",
        basePrices: {
          currency: "USD",
          inputPerMillion: null,
          outputPerMillion: null,
          cacheReadInputPerMillion: null,
          cacheWriteInputPerMillion: null,
          perRequest: null,
        },
        groups: [],
      };
    }),
  });
}

function extractApiBase(html: string): string {
  const normalized = decodeHtml(html).replace(/\\"/g, '"');
  const match = /"api_base_url"\s*:\s*"([^"\r\n]+)"/i.exec(normalized);
  if (!match?.[1]) throw new NofxReadError("INVALID_RESPONSE");
  return match[1].replace(/\\\//g, "/").replace(/\\u0026/gi, "&");
}

function validateApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NofxReadError("INVALID_RESPONSE");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "nofx.one" && !hostname.endsWith(".nofx.one"))) {
    throw new NofxReadError("REDIRECT_BLOCKED");
  }
  return url.origin;
}

async function readBoundedText(response: Response, signal: AbortSignal, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new NofxReadError("INVALID_RESPONSE", response.status);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new NofxReadError("INVALID_RESPONSE", response.status);
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (signal.aborted) throw new NofxReadError("TIMEOUT");
  return Buffer.concat(chunks).toString("utf8");
}

function successObservation<T>(sourceUrl: string, ttl: number, now: Date, value: T): PortalObservation<T> {
  return {
    status: "ok",
    sourceUrl,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.valueOf() + ttl).toISOString(),
    value,
  };
}

function failureObservation<T>(sourceUrl: string, ttl: number, now: Date, error: unknown): PortalObservation<T> {
  const failure = error instanceof NofxReadError ? error : new NofxReadError("INVALID_RESPONSE");
  return {
    status: ["AUTH_REQUIRED", "MISSING_SECRET", "ACCOUNT_MISMATCH"].includes(failure.code)
      ? "auth-required"
      : failure.code === "UNSUPPORTED_ENDPOINT"
        ? "unsupported"
        : "error",
    code: failure.code,
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    sourceUrl,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.valueOf() + ttl).toISOString(),
    value: null,
  };
}

function unsupportedObservation(sourceUrl: string, ttl: number, now: Date): PortalObservation<never> {
  return {
    status: "unsupported",
    code: "UNSUPPORTED_ENDPOINT",
    sourceUrl,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.valueOf() + ttl).toISOString(),
    value: null,
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/gi, "&");
}

function isRecord(value: unknown): value is Data {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
