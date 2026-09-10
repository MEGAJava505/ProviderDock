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

class HelyxReadError extends Error {
  constructor(readonly code: PortalErrorCode, readonly httpStatus?: number) {
    super(code);
    this.name = "HelyxReadError";
  }
}

export interface HelyxPortalOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Helyx AI exposes account and catalog data as server-rendered HTML. */
export class HelyxPortalAdapter implements ProviderPortalAdapter {
  readonly id = "helyx";
  readonly displayName = "Helyx AI";
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly secrets: SecretStore, options: HelyxPortalOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async read(connection: PortalConnection, now: Date): Promise<PortalSnapshot> {
    const unsupported = unsupportedObservation(connection.siteUrl, connection.refreshIntervalMs, now);
    const dashboardUrl = new URL("/dashboard", connection.siteUrl).href;
    const modelsUrl = new URL("/models-list", connection.siteUrl).href;
    const credential = connection.auth.kind === "cookie"
      ? await this.secrets.get(connection.auth.secretRef).catch(() => undefined)
      : undefined;
    const walletTask = credential
      ? this.getHtml(dashboardUrl, { Cookie: credential, ...(connection.userAgent ? { "User-Agent": connection.userAgent } : {}) }, true)
      : Promise.reject(new HelyxReadError(connection.auth.kind === "cookie" ? "MISSING_SECRET" : "AUTH_REQUIRED"));
    const [walletResult, catalogResult] = await Promise.allSettled([
      walletTask,
      this.getHtml(modelsUrl, {}, false),
    ]);
    const wallet = walletResult.status === "fulfilled"
      ? successObservation(
          dashboardUrl,
          connection.refreshIntervalMs,
          now,
          parseWallet(walletResult.value, connection, credential as string),
        )
      : failureObservation<PortalWallet>(dashboardUrl, connection.refreshIntervalMs, now, walletResult.reason);
    const catalog = catalogResult.status === "fulfilled"
      ? successObservation(
          modelsUrl,
          connection.refreshIntervalMs,
          now,
          parseCatalog(catalogResult.value),
        )
      : failureObservation<PortalCatalog>(modelsUrl, connection.refreshIntervalMs, now, catalogResult.reason);
    return portalSnapshotSchema.parse({
      site: unsupported,
      wallet,
      checkIn: unsupported,
      catalog,
      performance: unsupported,
    });
  }

  private async getHtml(
    url: string,
    headerValues: Readonly<Record<string, string>>,
    privateRead: boolean,
  ): Promise<string> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    let response: Response | undefined;
    try {
      const headers = new Headers({ Accept: "text/html" });
      for (const [name, value] of Object.entries(headerValues)) headers.set(name, value);
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "manual",
        cache: "no-store",
        signal: abort.signal,
      });
      const html = await readBoundedHtml(response, abort.signal);
      if (response.status >= 300 && response.status < 400) {
        throw new HelyxReadError(privateRead ? "AUTH_REQUIRED" : "REDIRECT_BLOCKED", response.status);
      }
      if (response.status === 401 || response.status === 403) {
        throw new HelyxReadError("AUTH_REQUIRED", response.status);
      }
      if ([404, 405, 501].includes(response.status)) {
        throw new HelyxReadError("UNSUPPORTED_ENDPOINT", response.status);
      }
      if (response.status === 429) throw new HelyxReadError("RATE_LIMITED", response.status);
      if (!response.ok) throw new HelyxReadError("UPSTREAM_ERROR", response.status);
      if (!response.headers.get("content-type")?.toLowerCase().includes("html")) {
        throw new HelyxReadError("INVALID_RESPONSE", response.status);
      }
      return html;
    } catch (error) {
      if (error instanceof HelyxReadError) throw error;
      if (abort.signal.aborted) throw new HelyxReadError("TIMEOUT");
      throw new HelyxReadError(response ? "INVALID_RESPONSE" : "NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => undefined);
    }
  }
}

function parseWallet(html: string, connection: PortalConnection, credential: string): PortalWallet {
  const paragraphs = [...html.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)].map((match) => ({
    classes: attribute(match[1] ?? "", "class").split(/\s+/),
    text: textContent(match[2] ?? ""),
  }));
  const valueAfter = (label: string): string | undefined => {
    const index = paragraphs.findIndex((item) => item.classes.includes("d-label") && item.text.toLowerCase().includes(label));
    return index >= 0 && paragraphs[index + 1]?.classes.includes("d-stat") ? paragraphs[index + 1]?.text : undefined;
  };
  const balanceText = valueAfter("current balance");
  const balance = balanceText ? money(balanceText) : null;
  if (!balance) throw new HelyxReadError("INVALID_RESPONSE");
  const usedQuota = integerText(valueAfter("total used tokens"));
  return {
    accountFingerprint: createHash("sha256")
      .update(connection.siteUrl + "\0" + credential)
      .digest("hex"),
    group: null,
    remainingQuota: null,
    usedQuota,
    displayBalance: { amount: balance.amount, currency: balance.currency, source: "site-display" },
  };
}

function parseCatalog(html: string): PortalCatalog {
  const models: PortalCatalog["models"] = [];
  const ids = new Set<string>();
  for (const match of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const attributes = match[1] ?? "";
    if (!attribute(attributes, "class").split(/\s+/).includes("model-row")) continue;
    const cells = new Map<string, string>();
    for (const cell of (match[2] ?? "").matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)) {
      const label = attribute(cell[1] ?? "", "data-label").trim().toLowerCase();
      if (label) cells.set(label, cell[2] ?? "");
    }
    const modelId = textContent(cells.get("api string") ?? "").trim();
    if (!modelId || modelId.length > 512 || ids.has(modelId)) {
      throw new HelyxReadError("INVALID_RESPONSE");
    }
    ids.add(modelId);
    const modelCell = cells.get("model") ?? "";
    const bold = /<b\b[^>]*>([\s\S]*?)<\/b>/i.exec(modelCell)?.[1];
    const displayName = textContent(bold ?? modelCell).trim();
    const rates = prices(textContent(cells.get("rate / 1m") ?? ""));
    models.push({
      modelId,
      description: displayName && displayName !== modelId ? displayName : null,
      vendor: bounded(attribute(attributes, "data-provider"), 128),
      endpointTypes: [],
      tags: null,
      contextTokens: contextTokens(textContent(cells.get("context") ?? "")),
      billing: rates.inputPerMillion !== null || rates.outputPerMillion !== null ? "tokens" : "unknown",
      basePrices: rates,
      groups: [],
    });
  }
  if (models.length === 0) throw new HelyxReadError("INVALID_RESPONSE");
  return portalCatalogSchema.parse({ models });
}

function prices(value: string): PortalCatalog["models"][number]["basePrices"] {
  const input = /\bin(?:put)?\b[^$\d-]*\$\s*(-?[\d,.]+)/i.exec(value)?.[1];
  const output = /\bout(?:put)?\b[^$\d-]*\$\s*(-?[\d,.]+)/i.exec(value)?.[1];
  const dollarValues = [...value.matchAll(/\$\s*(-?[\d,.]+)/g)].map((match) => numberText(match[1]));
  return {
    currency: "USD",
    inputPerMillion: numberText(input) ?? dollarValues[0] ?? null,
    outputPerMillion: numberText(output) ?? dollarValues[1] ?? null,
    cacheReadInputPerMillion: null,
    cacheWriteInputPerMillion: null,
    perRequest: null,
  };
}

function contextTokens(value: string): number | null {
  const match = /^([\d,.]+)\s*([KMB])?$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  const multiplier = match[2]?.toUpperCase() === "K" ? 1_000
    : match[2]?.toUpperCase() === "M" ? 1_000_000
      : match[2]?.toUpperCase() === "B" ? 1_000_000_000
        : 1;
  const tokens = amount * multiplier;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null;
}

function money(value: string): { readonly amount: number; readonly currency: string } | null {
  const match = /(?:US)?\$\s*(-?[\d,.]+)/i.exec(value);
  const amount = numberText(match?.[1]);
  return amount === null ? null : { amount, currency: "USD" };
}

function integerText(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/[^\d-]/g, ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function numberText(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1", "i").exec(attributes);
  return decodeHtml(match?.[2] ?? "");
}

function textContent(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function bounded(value: string, maximum: number): string | null {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : null;
}

async function readBoundedHtml(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new HelyxReadError("INVALID_RESPONSE", response.status);
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2_097_152) throw new HelyxReadError("INVALID_RESPONSE", response.status);
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (signal.aborted) throw new HelyxReadError("TIMEOUT");
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
  const failure = error instanceof HelyxReadError ? error : new HelyxReadError("INVALID_RESPONSE");
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
