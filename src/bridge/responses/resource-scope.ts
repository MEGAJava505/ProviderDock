import { ProviderRequestError } from "../../core/errors/provider-error.js";

export interface ResourceScope {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly protocol: "openai-responses" | "openai-chat-completions";
  readonly upstreamResourceId?: string;
}

export const resourceScopeField = "providerdock_resource_scope" as const;

export function resourceScopeKey(scope: ResourceScope): string {
  return JSON.stringify([
    scope.providerId,
    scope.baseUrl,
    scope.protocol,
    scope.upstreamResourceId ?? null,
  ]);
}

export function tagProviderOwnedItems<T>(
  payload: T,
  scope: ResourceScope,
): T {
  return transform(payload, (item) => ({
    ...item,
    [resourceScopeField]: resourceScopeKey(scope),
  })) as T;
}

/**
 * Validates only the request's input tree. Provider-owned encrypted state must
 * carry the scope that created it; it is never silently rewritten or dropped.
 */
export function validateProviderOwnedInput(
  body: unknown,
  scope: ResourceScope,
): void {
  const expected = resourceScopeKey(scope);
  const input = isRecord(body) ? body.input : undefined;
  visitInputReasoning(input, (item) => {
    const hasProviderOwnedState =
      typeof item.encrypted_content === "string" ||
      (typeof item.id === "string" && item.id.trim().length > 0) ||
      Object.prototype.hasOwnProperty.call(item, resourceScopeField);
    if (!hasProviderOwnedState) return;
    if (item[resourceScopeField] !== expected) {
      throw new ResourceScopeMismatchError();
    }
  });
}

export function stripResourceScopeMetadata<T>(payload: T): T {
  return strip(payload) as T;
}

export class ResourceScopeMismatchError extends ProviderRequestError {
  constructor() {
    super(
      "RESOURCE_SCOPE_MISMATCH",
      "RESOURCE_SCOPE_MISMATCH: Provider-owned reasoning state was created by a different upstream resource.",
      { httpStatus: 400 },
    );
    this.name = "ResourceScopeMismatchError";
  }
}

function transform(
  value: unknown,
  map: (item: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => transform(entry, map));
  if (!isRecord(value)) return value;
  const transformed = Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [name, transform(entry, map)]),
  );
  return value.type === "reasoning"
    ? map(transformed)
    : transformed;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => strip(entry));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => name !== resourceScopeField)
      .map(([name, entry]) => [name, strip(entry)]),
  );
}

function visitInputReasoning(
  value: unknown,
  callback: (item: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) visitInputReasoning(entry, callback);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "reasoning") callback(value);
  for (const entry of Object.values(value)) visitInputReasoning(entry, callback);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
