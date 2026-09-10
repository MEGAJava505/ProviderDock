import type { ProviderProfile } from "../providers/provider-profile.js";
import type { ProviderHealthRecord } from "./provider-health-repository.js";

export type ProviderProbeSkipReason =
  | "disabled"
  | "recent-traffic-success"
  | "metadata-ttl"
  | "failure-backoff";

export type ProviderProbePolicyDecision =
  | { readonly action: "probe" }
  | {
      readonly action: "skip";
      readonly reason: ProviderProbeSkipReason;
      readonly nextProbeAt?: string;
    };

export interface ProviderProbePolicyOptions {
  readonly maximumBackoffMs?: number;
}

interface ReachabilityObservation {
  readonly observedAt: string;
  readonly succeeded: boolean;
  readonly source: "probe" | "traffic";
}

/** Decides whether a metadata-only provider probe is useful right now. */
export class ProviderProbePolicy {
  private readonly maximumBackoffMs: number;

  constructor(options: ProviderProbePolicyOptions = {}) {
    this.maximumBackoffMs = options.maximumBackoffMs ?? 6 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.maximumBackoffMs) || this.maximumBackoffMs <= 0) {
      throw new TypeError("maximumBackoffMs must be a positive safe integer.");
    }
  }

  decide(
    profile: ProviderProfile,
    record: ProviderHealthRecord | undefined,
    now: Date = new Date(),
  ): ProviderProbePolicyDecision {
    if (!profile.enabled || !profile.healthCheck.enabled) {
      return { action: "skip", reason: "disabled" };
    }
    const nowMs = now.getTime();
    const ttlMs = profile.healthCheck.metadataTtlMs;
    const observations = reachabilityObservations(record);
    const latestObservation = observations[0];
    if (
      latestObservation?.source === "traffic" &&
      latestObservation.succeeded &&
      nowMs - Date.parse(latestObservation.observedAt) < ttlMs
    ) {
      return skipUntil(
        "recent-traffic-success",
        Date.parse(latestObservation.observedAt) + ttlMs,
      );
    }

    if (latestObservation !== undefined && !latestObservation.succeeded) {
      const consecutiveFailures = observations.findIndex(
        (observation) => observation.succeeded,
      );
      const failureCount =
        consecutiveFailures < 0 ? observations.length : consecutiveFailures;
      const exponent = Math.min(Math.max(0, failureCount - 1), 8);
      const backoffMs = Math.min(
        this.maximumBackoffMs,
        ttlMs * 2 ** exponent,
      );
      const nextProbeAt = Date.parse(latestObservation.observedAt) + backoffMs;
      if (nowMs < nextProbeAt) return skipUntil("failure-backoff", nextProbeAt);
    }

    const latestProbe = record?.latest?.health;
    if (
      latestProbe !== undefined &&
      nowMs - Date.parse(latestProbe.checkedAt) < ttlMs
    ) {
      return skipUntil("metadata-ttl", Date.parse(latestProbe.checkedAt) + ttlMs);
    }
    return { action: "probe" };
  }
}

function reachabilityObservations(
  record: ProviderHealthRecord | undefined,
): readonly ReachabilityObservation[] {
  if (record === undefined) return [];
  return [
    ...record.history.map((snapshot) => ({
      observedAt: snapshot.checkedAt,
      succeeded:
        snapshot.status === "ONLINE" || snapshot.status === "DEGRADED",
      source: "probe" as const,
    })),
    ...record.runtimeSignals.map((signal) => ({
      observedAt: signal.observedAt,
      succeeded: signal.outcome === "completed",
      source: "traffic" as const,
    })),
  ].sort((left, right) => right.observedAt.localeCompare(left.observedAt));
}

function skipUntil(
  reason: ProviderProbeSkipReason,
  timestamp: number,
): ProviderProbePolicyDecision {
  return {
    action: "skip",
    reason,
    nextProbeAt: new Date(timestamp).toISOString(),
  };
}
