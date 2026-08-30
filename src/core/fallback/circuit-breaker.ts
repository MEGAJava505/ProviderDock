export const circuitStates = ["CLOSED", "OPEN", "HALF_OPEN"] as const;
export type CircuitState = (typeof circuitStates)[number];

export interface CircuitAttemptToken {
  readonly key: string;
  readonly generation: number;
  readonly stateAtAcquire: "CLOSED" | "HALF_OPEN";
}

export type CircuitAcquireResult =
  | { readonly decision: "allowed"; readonly token: CircuitAttemptToken }
  | {
      readonly decision: "blocked";
      readonly state: "OPEN" | "HALF_OPEN";
      readonly retryAtMs?: number;
    };

export interface CircuitSnapshot {
  readonly key: string;
  readonly state: CircuitState;
  readonly consecutiveFailures: number;
  readonly generation: number;
  readonly openedAtMs?: number;
  readonly retryAtMs?: number;
  readonly probeInFlight: boolean;
}

export interface CircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

interface CircuitRecord {
  state: CircuitState;
  consecutiveFailures: number;
  generation: number;
  openedAtMs?: number;
  probeInFlight: boolean;
}

/**
 * Keyed CLOSED/OPEN/HALF_OPEN circuit breaker. A key can represent a provider
 * or a provider/model pair, so callers may maintain both isolation levels.
 */
export class CircuitBreaker {
  private readonly records = new Map<string, CircuitRecord>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.failureThreshold) || this.failureThreshold < 1) {
      throw new RangeError("failureThreshold must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1) {
      throw new RangeError("cooldownMs must be a positive safe integer.");
    }
  }

  tryAcquire(key: string): CircuitAcquireResult {
    const normalizedKey = normalizeKey(key);
    const record = this.recordFor(normalizedKey);
    const now = this.now();

    if (record.state === "OPEN") {
      const retryAtMs = (record.openedAtMs ?? now) + this.cooldownMs;
      if (now < retryAtMs) {
        return { decision: "blocked", state: "OPEN", retryAtMs };
      }
      record.state = "HALF_OPEN";
      record.probeInFlight = false;
      record.generation += 1;
    }

    if (record.state === "HALF_OPEN") {
      if (record.probeInFlight) return { decision: "blocked", state: "HALF_OPEN" };
      record.probeInFlight = true;
      return {
        decision: "allowed",
        token: {
          key: normalizedKey,
          generation: record.generation,
          stateAtAcquire: "HALF_OPEN",
        },
      };
    }

    return {
      decision: "allowed",
      token: {
        key: normalizedKey,
        generation: record.generation,
        stateAtAcquire: "CLOSED",
      },
    };
  }

  recordSuccess(token: CircuitAttemptToken): void {
    const record = this.records.get(token.key);
    if (!this.isCurrent(record, token)) return;
    const completedProbe = token.stateAtAcquire === "HALF_OPEN";
    record.state = "CLOSED";
    record.consecutiveFailures = 0;
    record.probeInFlight = false;
    delete record.openedAtMs;
    if (completedProbe) record.generation += 1;
  }

  recordFailure(
    token: CircuitAttemptToken,
    options: { readonly openImmediately?: boolean } = {},
  ): void {
    const record = this.records.get(token.key);
    if (!this.isCurrent(record, token)) return;
    record.consecutiveFailures += 1;
    if (
      token.stateAtAcquire === "HALF_OPEN" ||
      options.openImmediately === true ||
      record.consecutiveFailures >= this.failureThreshold
    ) {
      record.state = "OPEN";
      record.openedAtMs = this.now();
      record.probeInFlight = false;
      record.generation += 1;
    }
  }

  /** Releases a HALF_OPEN probe that could not produce health evidence. */
  abandon(token: CircuitAttemptToken): void {
    const record = this.records.get(token.key);
    if (!this.isCurrent(record, token) || token.stateAtAcquire !== "HALF_OPEN") return;
    record.state = "OPEN";
    record.openedAtMs = this.now();
    record.probeInFlight = false;
    record.generation += 1;
  }

  snapshot(key: string): CircuitSnapshot {
    const normalizedKey = normalizeKey(key);
    const record = this.recordFor(normalizedKey);
    const retryAtMs =
      record.state === "OPEN" && record.openedAtMs !== undefined
        ? record.openedAtMs + this.cooldownMs
        : undefined;
    return {
      key: normalizedKey,
      state: record.state,
      consecutiveFailures: record.consecutiveFailures,
      generation: record.generation,
      ...(record.openedAtMs === undefined ? {} : { openedAtMs: record.openedAtMs }),
      ...(retryAtMs === undefined ? {} : { retryAtMs }),
      probeInFlight: record.probeInFlight,
    };
  }

  private recordFor(key: string): CircuitRecord {
    let record = this.records.get(key);
    if (record === undefined) {
      record = {
        state: "CLOSED",
        consecutiveFailures: 0,
        generation: 1,
        probeInFlight: false,
      };
      this.records.set(key, record);
    }
    return record;
  }

  private isCurrent(
    record: CircuitRecord | undefined,
    token: CircuitAttemptToken,
  ): record is CircuitRecord {
    return (
      record !== undefined &&
      record.generation === token.generation &&
      record.state === token.stateAtAcquire &&
      (token.stateAtAcquire !== "HALF_OPEN" || record.probeInFlight)
    );
  }
}

function normalizeKey(key: string): string {
  const normalized = key.trim();
  if (normalized === "" || normalized.length > 512) {
    throw new TypeError("Circuit-breaker keys must contain between 1 and 512 characters.");
  }
  return normalized;
}
