import { z } from "zod";

const amount = z.number().finite().nonnegative().nullable();
const label = z.string().min(1).max(512);
export const portalPricesSchema = z.object({
  currency: z.string().min(1).max(16), inputPerMillion: amount, outputPerMillion: amount,
  cacheReadInputPerMillion: amount, cacheWriteInputPerMillion: amount, perRequest: amount,
}).strict();
export const portalCatalogSchema = z.object({
  models: z.array(z.object({
    modelId: label, description: z.string().max(2000).nullable(), vendor: z.string().max(128).nullable(),
    endpointTypes: z.array(z.string().max(64)).max(32), tags: z.string().max(512).nullable(),
    contextTokens: z.number().int().positive().safe().nullable(),
    billing: z.enum(["tokens", "request", "dynamic", "unknown"]),
    availability: z.string().max(32).nullable().optional(),
    basePrices: portalPricesSchema,
    groups: z.array(z.object({ name: z.string().max(128), multiplier: amount,
      prices: portalPricesSchema.nullable() }).strict()).max(100),
  }).strict()).max(5000),
}).strict();
export const portalPerformanceSchema = z.object({
  windowHours: z.literal(24),
  models: z.array(z.object({ modelId: label, tokensPerSecond: amount, latencyMs: amount,
    successRatePct: z.number().finite().min(0).max(100).nullable() }).strict()).max(5000),
}).strict();
export type PortalCatalog = z.infer<typeof portalCatalogSchema>;
export type PortalPrices = z.infer<typeof portalPricesSchema>;

type ObjectData = Record<string, unknown>;
function object(value: unknown): ObjectData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog object");
  return value as ObjectData;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function multiply(...values: (number | null)[]): number | null {
  if (values.includes(null)) return null;
  return number(values.reduce<number>((product, value) => product * value!, 1));
}
function string(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}
function strings(value: unknown, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxCount || value.some((entry) => typeof entry !== "string" || entry.length > maxLength)) throw new Error("Invalid catalog list");
  return [...new Set(value)] as string[];
}

/** New API standard USD credit rates; never apply a guessed recharge discount or account/API-key group. */
export function normalizeNewApiCatalog(envelope: ObjectData): PortalCatalog {
  if (!Array.isArray(envelope.data) || envelope.data.length > 5000) throw new Error("Invalid pricing catalog");
  const ratios = envelope.group_ratio ? object(envelope.group_ratio) : {};
  const vendors = new Map<number, string>();
  if (Array.isArray(envelope.vendors)) for (const value of envelope.vendors.slice(0,5000)) {
    const vendor = object(value);
    if (typeof vendor.id === "number" && string(vendor.name, 128)) vendors.set(vendor.id, vendor.name as string);
  }
  const ids = new Set<string>();
  return portalCatalogSchema.parse({ models: envelope.data.map((value) => {
    const row = object(value);
    const modelId = label.parse(row.model_name);
    if (ids.has(modelId)) throw new Error("Duplicate catalog model");
    ids.add(modelId);
    const dynamic = (typeof row.billing_mode === "string" && !["", "tokens", "token", "request"].includes(row.billing_mode)) ||
      (typeof row.billing_expr === "string" && row.billing_expr.trim() !== "");
    const billing = dynamic ? "dynamic" : row.quota_type === 0 ? "tokens" : row.quota_type === 1 ? "request" : "unknown";
    // The New API contract expresses input USD / 1M as model_ratio * 2.
    const input = billing === "tokens" ? multiply(number(row.model_ratio), 2) : null;
    const basePrices: PortalPrices = { currency: "USD", inputPerMillion: input,
      outputPerMillion: multiply(input, number(row.completion_ratio)),
      cacheReadInputPerMillion: multiply(input, number(row.cache_ratio)),
      cacheWriteInputPerMillion: multiply(input, number(row.create_cache_ratio)),
      perRequest: billing === "request" ? number(row.model_price) : null };
    const groups = strings(row.enable_groups, 100, 128).map((name) => {
      const multiplier = Object.hasOwn(ratios, name) ? number(ratios[name]) : null;
      return { name, multiplier, prices: multiplier === null ? null : {
        currency: "USD", inputPerMillion: multiply(input, multiplier),
        outputPerMillion: multiply(basePrices.outputPerMillion, multiplier),
        cacheReadInputPerMillion: multiply(basePrices.cacheReadInputPerMillion, multiplier),
        cacheWriteInputPerMillion: multiply(basePrices.cacheWriteInputPerMillion, multiplier),
        perRequest: multiply(basePrices.perRequest, multiplier),
      } };
    });
    return { modelId, description: string(row.description, 2000), vendor: vendors.get(row.vendor_id as number) ?? null,
      tags: string(row.tags, 512), endpointTypes: strings(row.supported_endpoint_types, 32, 64),
      contextTokens: Number.isSafeInteger(row.context_length) && Number(row.context_length) > 0 ? row.context_length : null,
      billing, basePrices, groups };
  }) });
}

export function normalizeNewApiPerformance(data: ObjectData) {
  if (!Array.isArray(data.models) || data.models.length > 5000) throw new Error("Invalid performance summary");
  const ids = new Set<string>();
  return portalPerformanceSchema.parse({ windowHours: 24, models: data.models.map((value) => {
    const row = object(value);
    const modelId = label.parse(row.model_name);
    if (ids.has(modelId)) throw new Error("Duplicate performance model");
    ids.add(modelId);
    const success = number(row.success_rate);
    return { modelId, tokensPerSecond: number(row.avg_tps), latencyMs: number(row.avg_latency_ms),
      successRatePct: success !== null && success <= 100 ? success : null };
  }) });
}
