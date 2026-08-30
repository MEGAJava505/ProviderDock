import type { NormalizedErrorType } from "../errors/provider-error.js";
import {
  CircuitBreaker,
  type CircuitAttemptToken,
} from "./circuit-breaker.js";
import {
  logicalRouteKey,
  orderedLogicalRoutes,
  parseLogicalModelGroup,
  type LogicalModelGroup,
  type LogicalModelRoute,
} from "./logical-model.js";

export const fallbackFailurePhases = [
  "connection-failed",
  "request-rejected",
  "before-output",
  "after-output",
  "after-tool-call",
  "unknown",
] as const;
export type FallbackFailurePhase = (typeof fallbackFailurePhases)[number];

export const continuationStates = ["none", "complete", "ambiguous"] as const;
export type ContinuationState = (typeof continuationStates)[number];

export interface FallbackTurnContext {
  readonly continuationState?: ContinuationState;
  readonly sideEffectsPossible?: boolean;
}

export interface FallbackFailure {
  readonly errorType: NormalizedErrorType;
  readonly phase: FallbackFailurePhase;
  readonly message?: string;
}

export interface FallbackAttempt {
  readonly attemptId: number;
  readonly route: LogicalModelRoute;
}

export interface FallbackNotification {
  readonly kind: "FALLBACK";
  readonly logicalModelId: string;
  readonly from: LogicalModelRoute;
  readonly to: LogicalModelRoute;
  readonly errorType?: NormalizedErrorType;
  readonly phase?: FallbackFailurePhase;
  readonly message: string;
}

export type FallbackBlockCode =
  | "NO_FALLBACK_ROUTE"
  | "FAILURE_NOT_RETRYABLE"
  | "FALLBACK_AFTER_OUTPUT_BLOCKED"
  | "FALLBACK_AFTER_TOOL_CALL_BLOCKED"
  | "FALLBACK_STATE_AMBIGUOUS"
  | "STALE_ATTEMPT";

export type FallbackSelection =
  | {
      readonly decision: "selected";
      readonly attempt: FallbackAttempt;
      readonly notification?: FallbackNotification;
    }
  | {
      readonly decision: "blocked";
      readonly code: FallbackBlockCode;
      readonly message: string;
    };

export interface FallbackSessionSnapshot {
  readonly logicalModelId: string;
  readonly stickyRouteKey?: string;
  readonly fallbackCount: number;
}

/** Session-scoped sticky routing policy for one logical model group. */
export class FallbackSessionRouter {
  readonly group: LogicalModelGroup;
  readonly routes: readonly LogicalModelRoute[];
  private stickyKey: string | undefined;
  private fallbackCount = 0;

  constructor(
    group: LogicalModelGroup,
    readonly circuits: CircuitBreaker = new CircuitBreaker(),
  ) {
    this.group = parseLogicalModelGroup(group);
    this.routes = orderedLogicalRoutes(this.group);
  }

  beginTurn(context: FallbackTurnContext = {}): FallbackTurn {
    return new FallbackTurn(this, {
      continuationState: context.continuationState ?? "none",
      sideEffectsPossible: context.sideEffectsPossible ?? false,
    });
  }

  selectStickyRoute(providerId: string, modelId: string): void {
    const key = logicalRouteKey({ providerId, modelId });
    if (!this.routes.some((route) => logicalRouteKey(route) === key)) {
      throw new TypeError(
        `Route '${providerId}/${modelId}' is not enabled for logical model '${this.group.id}'.`,
      );
    }
    this.stickyKey = key;
  }

  clearStickyRoute(): void {
    this.stickyKey = undefined;
  }

  stickyRoute(): LogicalModelRoute | undefined {
    return this.routes.find((route) => logicalRouteKey(route) === this.stickyKey);
  }

  snapshot(): FallbackSessionSnapshot {
    return {
      logicalModelId: this.group.id,
      ...(this.stickyKey === undefined ? {} : { stickyRouteKey: this.stickyKey }),
      fallbackCount: this.fallbackCount,
    };
  }

  candidateRoutes(): readonly LogicalModelRoute[] {
    const sticky = this.stickyRoute();
    return sticky === undefined
      ? this.routes
      : [sticky, ...this.routes.filter((route) => logicalRouteKey(route) !== this.stickyKey)];
  }

  commitRoute(route: LogicalModelRoute, fallback: boolean): void {
    this.stickyKey = logicalRouteKey(route);
    if (fallback) this.fallbackCount += 1;
  }
}

interface ResolvedFallbackTurnContext {
  readonly continuationState: ContinuationState;
  readonly sideEffectsPossible: boolean;
}

export class FallbackTurn {
  private readonly attemptedRouteKeys = new Set<string>();
  private readonly circuitTokens = new Map<number, CircuitAttemptToken>();
  private nextAttemptId = 1;
  private activeAttempt: FallbackAttempt | undefined;
  private started = false;
  private meaningfulOutput = false;
  private toolCallDelivered = false;

  constructor(
    private readonly session: FallbackSessionRouter,
    private readonly context: ResolvedFallbackTurnContext,
  ) {}

  start(): FallbackSelection {
    if (this.started) {
      return blocked("STALE_ATTEMPT", "This fallback turn has already started.");
    }
    this.started = true;
    const preferred = this.session.candidateRoutes()[0];
    const selection = this.selectNext();
    if (
      selection.decision === "selected" &&
      preferred !== undefined &&
      logicalRouteKey(preferred) !== logicalRouteKey(selection.attempt.route)
    ) {
      return {
        ...selection,
        notification: notification(
          this.session.group.id,
          preferred,
          selection.attempt.route,
          undefined,
          undefined,
          "Preferred route was skipped because its circuit is open.",
        ),
      };
    }
    return selection;
  }

  markMeaningfulOutput(): void {
    this.meaningfulOutput = true;
  }

  markToolCallDelivered(): void {
    this.toolCallDelivered = true;
    this.meaningfulOutput = true;
  }

  reportSuccess(attempt: FallbackAttempt): FallbackSelection {
    const token = this.currentToken(attempt);
    if (token === undefined) return staleAttempt();
    this.session.circuits.recordSuccess(token);
    this.session.commitRoute(attempt.route, false);
    this.activeAttempt = undefined;
    return { decision: "selected", attempt };
  }

  reportFailure(
    attempt: FallbackAttempt,
    failure: FallbackFailure,
  ): FallbackSelection {
    const token = this.currentToken(attempt);
    if (token === undefined) return staleAttempt();
    this.activeAttempt = undefined;
    if (countsForCircuit(failure.errorType)) {
      this.session.circuits.recordFailure(token, {
        openImmediately: opensCircuitImmediately(failure.errorType),
      });
    } else {
      this.session.circuits.abandon(token);
    }

    const safetyBlock = this.safetyBlock(failure);
    if (safetyBlock !== undefined) return safetyBlock;

    const selection = this.selectNext();
    if (selection.decision === "blocked") return selection;
    this.session.commitRoute(selection.attempt.route, true);
    return {
      ...selection,
      notification: notification(
        this.session.group.id,
        attempt.route,
        selection.attempt.route,
        failure.errorType,
        failure.phase,
        failure.message ??
          `Route '${logicalRouteKey(attempt.route)}' failed before meaningful execution.`,
      ),
    };
  }

  private selectNext(): FallbackSelection {
    for (const route of this.session.candidateRoutes()) {
      const key = logicalRouteKey(route);
      if (this.attemptedRouteKeys.has(key)) continue;
      const acquired = this.session.circuits.tryAcquire(key);
      if (acquired.decision === "blocked") continue;
      const attempt = { attemptId: this.nextAttemptId, route };
      this.nextAttemptId += 1;
      this.attemptedRouteKeys.add(key);
      this.circuitTokens.set(attempt.attemptId, acquired.token);
      this.activeAttempt = attempt;
      this.session.commitRoute(route, false);
      return { decision: "selected", attempt };
    }
    return blocked(
      "NO_FALLBACK_ROUTE",
      `No unused healthy route remains for logical model '${this.session.group.id}'.`,
    );
  }

  private currentToken(attempt: FallbackAttempt): CircuitAttemptToken | undefined {
    if (
      this.activeAttempt?.attemptId !== attempt.attemptId ||
      logicalRouteKey(this.activeAttempt.route) !== logicalRouteKey(attempt.route)
    ) {
      return undefined;
    }
    return this.circuitTokens.get(attempt.attemptId);
  }

  private safetyBlock(failure: FallbackFailure): FallbackSelection | undefined {
    if (this.toolCallDelivered || failure.phase === "after-tool-call") {
      return blocked(
        "FALLBACK_AFTER_TOOL_CALL_BLOCKED",
        "A tool call may already have executed; full-turn fallback was blocked.",
      );
    }
    if (this.meaningfulOutput || failure.phase === "after-output") {
      return blocked(
        "FALLBACK_AFTER_OUTPUT_BLOCKED",
        "Meaningful output already reached the client; full-turn fallback was blocked.",
      );
    }
    if (
      failure.phase === "unknown" ||
      (this.context.sideEffectsPossible && this.context.continuationState !== "complete")
    ) {
      return blocked(
        "FALLBACK_STATE_AMBIGUOUS",
        "Safe continuation cannot be proven from the retained history.",
      );
    }
    if (
      failure.phase !== "connection-failed" &&
      failure.phase !== "request-rejected" &&
      failure.phase !== "before-output"
    ) {
      return blocked(
        "FALLBACK_STATE_AMBIGUOUS",
        "The provider failure did not occur at a safe fallback boundary.",
      );
    }
    if (!isFallbackRetryable(failure.errorType)) {
      return blocked(
        "FAILURE_NOT_RETRYABLE",
        `Failure '${failure.errorType}' must be fixed instead of replayed automatically.`,
      );
    }
    return undefined;
  }
}

function notification(
  logicalModelId: string,
  from: LogicalModelRoute,
  to: LogicalModelRoute,
  errorType: NormalizedErrorType | undefined,
  phase: FallbackFailurePhase | undefined,
  message: string,
): FallbackNotification {
  return {
    kind: "FALLBACK",
    logicalModelId,
    from,
    to,
    ...(errorType === undefined ? {} : { errorType }),
    ...(phase === undefined ? {} : { phase }),
    message,
  };
}

function blocked(code: FallbackBlockCode, message: string): FallbackSelection {
  return { decision: "blocked", code, message };
}

function staleAttempt(): FallbackSelection {
  return blocked("STALE_ATTEMPT", "The fallback attempt is no longer active.");
}

function isFallbackRetryable(type: NormalizedErrorType): boolean {
  return type !== "INVALID_REQUEST";
}

function countsForCircuit(type: NormalizedErrorType): boolean {
  return type !== "INVALID_REQUEST";
}

function opensCircuitImmediately(type: NormalizedErrorType): boolean {
  return (
    type === "AUTH_ERROR" ||
    type === "PERMISSION_ERROR" ||
    type === "MODEL_NOT_FOUND" ||
    type === "RATE_LIMIT" ||
    type === "QUOTA_EXCEEDED"
  );
}
