import { describe, expect, it } from "vitest";
import {
  CircuitBreaker,
  FallbackSessionRouter,
  logicalRouteKey,
  orderedLogicalRoutes,
  parseLogicalModelGroup,
  type FallbackAttempt,
  type LogicalModelGroup,
} from "../src/index.js";

function group(): LogicalModelGroup {
  return parseLogicalModelGroup({
    id: "gpt-x",
    routes: [
      { providerId: "secondary", modelId: "gpt-x", priority: 90 },
      { providerId: "primary", modelId: "gpt-x", priority: 100 },
    ],
  });
}

function selected(
  result: ReturnType<ReturnType<FallbackSessionRouter["beginTurn"]>["start"]>,
): FallbackAttempt {
  if (result.decision !== "selected") throw new Error(`expected route: ${result.code}`);
  return result.attempt;
}

describe("logical models", () => {
  it("validates unique enabled routes and orders them deterministically", () => {
    const parsed = group();
    expect(orderedLogicalRoutes(parsed).map(logicalRouteKey)).toEqual([
      "primary:gpt-x",
      "secondary:gpt-x",
    ]);
    expect(() =>
      parseLogicalModelGroup({
        id: "bad",
        routes: [
          { providerId: "same", modelId: "m" },
          { providerId: "same", modelId: "m" },
        ],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseLogicalModelGroup({
        id: "disabled",
        routes: [{ providerId: "one", modelId: "m", enabled: false }],
      }),
    ).toThrow(/enabled route/i);
  });
});

describe("CircuitBreaker", () => {
  it("moves CLOSED -> OPEN -> HALF_OPEN -> CLOSED with one probe", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 100,
      now: () => now,
    });
    const first = breaker.tryAcquire("provider:model");
    if (first.decision !== "allowed") throw new Error("expected closed circuit");
    breaker.recordFailure(first.token);
    expect(breaker.snapshot("provider:model")).toMatchObject({
      state: "CLOSED",
      consecutiveFailures: 1,
    });

    const second = breaker.tryAcquire("provider:model");
    if (second.decision !== "allowed") throw new Error("expected second attempt");
    breaker.recordFailure(second.token);
    expect(breaker.snapshot("provider:model")).toMatchObject({
      state: "OPEN",
      retryAtMs: 1_100,
    });
    expect(breaker.tryAcquire("provider:model")).toMatchObject({
      decision: "blocked",
      state: "OPEN",
    });
    expect(breaker.snapshot("another:model").state).toBe("CLOSED");

    now = 1_100;
    const probe = breaker.tryAcquire("provider:model");
    if (probe.decision !== "allowed") throw new Error("expected half-open probe");
    expect(probe.token.stateAtAcquire).toBe("HALF_OPEN");
    expect(breaker.tryAcquire("provider:model")).toMatchObject({
      decision: "blocked",
      state: "HALF_OPEN",
    });
    breaker.recordSuccess(probe.token);
    expect(breaker.snapshot("provider:model")).toMatchObject({
      state: "CLOSED",
      consecutiveFailures: 0,
      probeInFlight: false,
    });
  });

  it("reopens after a failed half-open probe and ignores stale tokens", () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: () => now });
    const initial = breaker.tryAcquire("route");
    if (initial.decision !== "allowed") throw new Error("expected attempt");
    breaker.recordFailure(initial.token);
    now = 10;
    const probe = breaker.tryAcquire("route");
    if (probe.decision !== "allowed") throw new Error("expected probe");
    breaker.recordFailure(probe.token);
    breaker.recordSuccess(initial.token);
    expect(breaker.snapshot("route")).toMatchObject({ state: "OPEN", openedAtMs: 10 });
  });
});

describe("FallbackSessionRouter", () => {
  it("uses priority initially and keeps the successful route sticky", () => {
    const router = new FallbackSessionRouter(group());
    const firstTurn = router.beginTurn();
    const first = selected(firstTurn.start());
    expect(logicalRouteKey(first.route)).toBe("primary:gpt-x");
    expect(firstTurn.reportSuccess(first).decision).toBe("selected");

    const next = selected(router.beginTurn().start());
    expect(logicalRouteKey(next.route)).toBe("primary:gpt-x");
    router.selectStickyRoute("secondary", "gpt-x");
    expect(logicalRouteKey(selected(router.beginTurn().start()).route)).toBe(
      "secondary:gpt-x",
    );
  });

  it("falls back before output, emits a notification, and sticks to secondary", () => {
    const router = new FallbackSessionRouter(group());
    const turn = router.beginTurn();
    const primary = selected(turn.start());
    const decision = turn.reportFailure(primary, {
      errorType: "NETWORK_ERROR",
      phase: "connection-failed",
      message: "Primary connection failed.",
    });
    expect(decision).toMatchObject({
      decision: "selected",
      attempt: { route: { providerId: "secondary", modelId: "gpt-x" } },
      notification: {
        kind: "FALLBACK",
        from: { providerId: "primary" },
        to: { providerId: "secondary" },
        errorType: "NETWORK_ERROR",
      },
    });
    if (decision.decision !== "selected") return;
    turn.reportSuccess(decision.attempt);
    expect(router.snapshot()).toMatchObject({
      stickyRouteKey: "secondary:gpt-x",
      fallbackCount: 1,
    });
    expect(logicalRouteKey(selected(router.beginTurn().start()).route)).toBe(
      "secondary:gpt-x",
    );
  });

  it("blocks full replay after output or tool-call delivery", () => {
    const outputTurn = new FallbackSessionRouter(group()).beginTurn();
    const outputAttempt = selected(outputTurn.start());
    outputTurn.markMeaningfulOutput();
    expect(
      outputTurn.reportFailure(outputAttempt, {
        errorType: "STREAM_ERROR",
        phase: "after-output",
      }),
    ).toMatchObject({ decision: "blocked", code: "FALLBACK_AFTER_OUTPUT_BLOCKED" });

    const toolTurn = new FallbackSessionRouter(group()).beginTurn();
    const toolAttempt = selected(toolTurn.start());
    toolTurn.markToolCallDelivered();
    expect(
      toolTurn.reportFailure(toolAttempt, {
        errorType: "PROVIDER_UNAVAILABLE",
        phase: "after-tool-call",
      }),
    ).toMatchObject({ decision: "blocked", code: "FALLBACK_AFTER_TOOL_CALL_BLOCKED" });
  });

  it("permits complete stateful continuation but blocks ambiguous side effects", () => {
    const safeRouter = new FallbackSessionRouter(group());
    const safeTurn = safeRouter.beginTurn({
      sideEffectsPossible: true,
      continuationState: "complete",
    });
    const safePrimary = selected(safeTurn.start());
    expect(
      safeTurn.reportFailure(safePrimary, {
        errorType: "PROVIDER_UNAVAILABLE",
        phase: "request-rejected",
      }).decision,
    ).toBe("selected");

    const unsafeTurn = new FallbackSessionRouter(group()).beginTurn({
      sideEffectsPossible: true,
      continuationState: "ambiguous",
    });
    const unsafePrimary = selected(unsafeTurn.start());
    expect(
      unsafeTurn.reportFailure(unsafePrimary, {
        errorType: "PROVIDER_UNAVAILABLE",
        phase: "before-output",
      }),
    ).toMatchObject({ decision: "blocked", code: "FALLBACK_STATE_AMBIGUOUS" });
  });

  it("blocks unknown state and non-retryable requests without looping routes", () => {
    const router = new FallbackSessionRouter(group());
    const unknownTurn = router.beginTurn();
    const unknownAttempt = selected(unknownTurn.start());
    expect(
      unknownTurn.reportFailure(unknownAttempt, {
        errorType: "TIMEOUT",
        phase: "unknown",
      }),
    ).toMatchObject({ decision: "blocked", code: "FALLBACK_STATE_AMBIGUOUS" });

    const invalidTurn = new FallbackSessionRouter(group()).beginTurn();
    const invalidAttempt = selected(invalidTurn.start());
    expect(
      invalidTurn.reportFailure(invalidAttempt, {
        errorType: "INVALID_REQUEST",
        phase: "request-rejected",
      }),
    ).toMatchObject({ decision: "blocked", code: "FAILURE_NOT_RETRYABLE" });

    const exhausted = new FallbackSessionRouter(group()).beginTurn();
    const primary = selected(exhausted.start());
    const secondaryDecision = exhausted.reportFailure(primary, {
      errorType: "NETWORK_ERROR",
      phase: "connection-failed",
    });
    if (secondaryDecision.decision !== "selected") throw new Error("expected fallback");
    expect(
      exhausted.reportFailure(secondaryDecision.attempt, {
        errorType: "NETWORK_ERROR",
        phase: "connection-failed",
      }),
    ).toMatchObject({ decision: "blocked", code: "NO_FALLBACK_ROUTE" });
    expect(exhausted.reportFailure(primary, {
      errorType: "NETWORK_ERROR",
      phase: "connection-failed",
    })).toMatchObject({ decision: "blocked", code: "STALE_ATTEMPT" });
  });

  it("skips an open preferred circuit and notifies the caller", () => {
    const circuits = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000 });
    const primaryKey = "primary:gpt-x";
    const token = circuits.tryAcquire(primaryKey);
    if (token.decision !== "allowed") throw new Error("expected circuit attempt");
    circuits.recordFailure(token.token);
    const selection = new FallbackSessionRouter(group(), circuits).beginTurn().start();
    expect(selection).toMatchObject({
      decision: "selected",
      attempt: { route: { providerId: "secondary" } },
      notification: { kind: "FALLBACK", from: { providerId: "primary" } },
    });
  });
});
