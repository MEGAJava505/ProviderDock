import { createHash } from "node:crypto";

/**
 * Anti-replay / anti-recursion turn ledger (spec sections 19-21).
 *
 * The ledger tracks every conversation turn a bridge session accepted and the
 * tool calls that were delivered through it. It blocks the exact failure
 * modes observed with AgentRouter: automatic re-submission of an already
 * completed turn, blind replay after a partially streamed response, and the
 * recursive tool loop where an old resolved tool call is presented to the
 * model as pending again.
 */

export const turnStates = [
  "ACCEPTED",
  "STREAMING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "INCOMPLETE",
] as const;

export type TurnState = (typeof turnStates)[number];

export interface TurnToolCall {
  readonly callId: string;
  readonly name: string;
  readonly argumentsHash: string;
}

export interface TurnToolResult {
  readonly callId: string;
  readonly outputHash: string;
}

export interface TurnSignature {
  readonly fingerprint: string;
  readonly toolCalls: readonly TurnToolCall[];
  readonly toolResults: readonly TurnToolResult[];
}

export type TurnAdmission =
  | { readonly decision: "accepted"; readonly token: TurnToken }
  | {
      readonly decision: "blocked";
      readonly code: TurnBlockCode;
      readonly message: string;
    };

export type TurnBlockCode =
  | "TURN_IN_FLIGHT"
  | "TURN_ALREADY_COMPLETED"
  | "UNSAFE_REPLAY"
  | "LEDGER_CAPACITY_EXCEEDED"
  | "TOOL_CALL_CONFLICT"
  | "TOOL_RESULT_CONFLICT"
  | "TOOL_RESULT_UNMATCHED"
  | "TOOL_LOOP_DETECTED";

export interface TurnToken {
  readonly fingerprint: string;
  readonly attempt: number;
}

export class TurnLedgerViolationError extends Error {
  constructor(
    readonly code: Extract<
      TurnBlockCode,
      "LEDGER_CAPACITY_EXCEEDED" | "TOOL_CALL_CONFLICT" | "TOOL_LOOP_DETECTED"
    >,
    message: string,
  ) {
    super(message);
    this.name = "TurnLedgerViolationError";
  }
}

export interface TurnRecordSnapshot {
  readonly fingerprint: string;
  state: TurnState;
  streamStarted: boolean;
  toolActivity: boolean;
  replayUnsafe: boolean;
  attempt: number;
  updatedAtMs: number;
}

export interface ToolCallRecordSnapshot {
  readonly callId: string;
  readonly name: string;
  readonly argumentsHash: string;
  resolved: boolean;
  resultHash?: string;
}

export interface TurnLedgerSnapshot {
  readonly version: 1;
  readonly turns: readonly TurnRecordSnapshot[];
  readonly toolCalls: readonly ToolCallRecordSnapshot[];
}

type TurnRecord = Omit<TurnRecordSnapshot, "fingerprint">;
type ToolCallRecord = Omit<ToolCallRecordSnapshot, "callId">;

export interface TurnLedgerOptions {
  readonly maxTurnRecords?: number;
  readonly maxToolCallRecords?: number;
  readonly initialSnapshot?: TurnLedgerSnapshot;
  readonly now?: () => number;
}

export class TurnLedger {
  private readonly turns = new Map<string, TurnRecord>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private readonly maxTurnRecords: number;
  private readonly maxToolCallRecords: number;
  private readonly now: () => number;

  constructor(options: TurnLedgerOptions = {}) {
    this.maxTurnRecords = options.maxTurnRecords ?? 512;
    this.maxToolCallRecords = options.maxToolCallRecords ?? 4_096;
    if (!Number.isSafeInteger(this.maxTurnRecords) || this.maxTurnRecords < 1) {
      throw new RangeError("maxTurnRecords must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.maxToolCallRecords) || this.maxToolCallRecords < 1) {
      throw new RangeError("maxToolCallRecords must be a positive safe integer.");
    }
    this.now = options.now ?? Date.now;
    if (options.initialSnapshot !== undefined) this.restore(options.initialSnapshot);
  }

  /** Evaluates a turn before it is sent upstream. */
  admit(signature: TurnSignature): TurnAdmission {
    const toolCheck = this.checkToolIntegrity(signature);
    if (toolCheck !== undefined) return toolCheck;
    const newToolCallCount = this.countNewToolCalls(signature.toolCalls);
    if (this.toolCalls.size + newToolCallCount > this.maxToolCallRecords) {
      return blocked(
        "LEDGER_CAPACITY_EXCEEDED",
        "The session tool-call ledger reached its safety limit. Start a new runtime session.",
      );
    }

    const existing = this.turns.get(signature.fingerprint);
    if (existing !== undefined) {
      if (existing.state === "ACCEPTED" || existing.state === "STREAMING") {
        return blocked(
          "TURN_IN_FLIGHT",
          "An identical turn is already in flight. The duplicate request was not sent upstream.",
        );
      }
      if (existing.state === "COMPLETED") {
        return blocked(
          "TURN_ALREADY_COMPLETED",
          "This turn already completed. Automatic replay after a final answer is blocked; " +
            "start a new turn instead of resending the identical request.",
        );
      }
      if (existing.replayUnsafe || existing.streamStarted || existing.toolActivity) {
        return blocked(
          "UNSAFE_REPLAY",
          "The previous attempt of this turn already streamed output or involved tool " +
            "operations that may have side effects. Automatic replay was blocked and the " +
            "session state was preserved.",
        );
      }
      // Safe retry: the previous attempt failed before any upstream output.
      existing.state = "ACCEPTED";
      existing.attempt += 1;
      existing.updatedAtMs = this.now();
      this.recordToolActivity(signature);
      return { decision: "accepted", token: { fingerprint: signature.fingerprint, attempt: existing.attempt } };
    }

    this.evictIfNeeded();
    if (this.turns.size >= this.maxTurnRecords) {
      return blocked(
        "LEDGER_CAPACITY_EXCEEDED",
        "The session turn ledger is full while all retained turns are still active. " +
          "Wait for them to finish or start a new runtime session.",
      );
    }
    const toolActivity = signature.toolCalls.length > 0 || signature.toolResults.length > 0;
    this.turns.set(signature.fingerprint, {
      state: "ACCEPTED",
      streamStarted: false,
      toolActivity,
      replayUnsafe: toolActivity,
      attempt: 1,
      updatedAtMs: this.now(),
    });
    this.recordToolActivity(signature);
    return { decision: "accepted", token: { fingerprint: signature.fingerprint, attempt: 1 } };
  }

  markStreamStarted(token: TurnToken): void {
    const record = this.currentRecord(token);
    if (record === undefined) return;
    record.streamStarted = true;
    record.replayUnsafe = true;
    record.state = "STREAMING";
    record.updatedAtMs = this.now();
  }

  markToolActivity(token: TurnToken): void {
    const record = this.currentRecord(token);
    if (record === undefined) return;
    record.toolActivity = true;
    record.replayUnsafe = true;
    record.updatedAtMs = this.now();
  }

  /**
   * Records tool calls from a validated upstream response before their
   * completion event is delivered to the client. A reused/conflicting call id
   * is rejected here, at the last safe side-effect barrier.
   */
  recordDeliveredToolCalls(token: TurnToken, calls: readonly TurnToolCall[]): void {
    const record = this.currentRecord(token);
    if (record === undefined) return;

    const batch = new Map<string, TurnToolCall>();
    for (const call of calls) {
      const duplicate = batch.get(call.callId);
      if (
        duplicate !== undefined &&
        (duplicate.name !== call.name || duplicate.argumentsHash !== call.argumentsHash)
      ) {
        throw new TurnLedgerViolationError(
          "TOOL_CALL_CONFLICT",
          `Upstream delivered tool call '${call.callId}' more than once with conflicting data.`,
        );
      }
      batch.set(call.callId, call);

      const known = this.toolCalls.get(call.callId);
      if (
        known !== undefined &&
        (known.name !== call.name || known.argumentsHash !== call.argumentsHash)
      ) {
        throw new TurnLedgerViolationError(
          "TOOL_CALL_CONFLICT",
          `Upstream reused tool call '${call.callId}' with different name or arguments. ` +
            "Delivery was blocked before the client could execute it.",
        );
      }
      if (known?.resolved === true) {
        throw new TurnLedgerViolationError(
          "TOOL_LOOP_DETECTED",
          `Upstream replayed already-resolved tool call '${call.callId}'. ` +
            "Delivery was blocked before duplicate execution.",
        );
      }
    }

    const newToolCallCount = [...batch.keys()].filter(
      (callId) => !this.toolCalls.has(callId),
    ).length;
    if (this.toolCalls.size + newToolCallCount > this.maxToolCallRecords) {
      throw new TurnLedgerViolationError(
        "LEDGER_CAPACITY_EXCEEDED",
        "The session tool-call ledger reached its safety limit. " +
          "Delivery was blocked before execution.",
      );
    }

    for (const call of batch.values()) {
      if (!this.toolCalls.has(call.callId)) {
        this.toolCalls.set(call.callId, {
          name: call.name,
          argumentsHash: call.argumentsHash,
          resolved: false,
        });
      }
    }
    if (batch.size > 0) {
      record.toolActivity = true;
      record.replayUnsafe = true;
      record.updatedAtMs = this.now();
    }
  }

  complete(token: TurnToken): void {
    this.transition(token, "COMPLETED");
  }

  fail(token: TurnToken): void {
    this.transition(token, "FAILED");
  }

  cancel(token: TurnToken): void {
    this.transition(token, "CANCELLED");
  }

  incomplete(token: TurnToken): void {
    this.transition(token, "INCOMPLETE");
  }

  stateOf(fingerprint: string): TurnState | undefined {
    return this.turns.get(fingerprint)?.state;
  }

  /** Returns a deterministic, detached representation safe to persist. */
  snapshot(): TurnLedgerSnapshot {
    return {
      version: 1,
      turns: [...this.turns.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fingerprint, record]) => ({ fingerprint, ...record })),
      toolCalls: [...this.toolCalls.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([callId, record]) => ({ callId, ...record })),
    };
  }

  /**
   * A process crash leaves no proof that an accepted/in-flight turn was safe
   * to repeat. Convert it to INCOMPLETE so recovery always fails closed.
   */
  recoverInterruptedTurns(): boolean {
    let changed = false;
    for (const record of this.turns.values()) {
      if (record.state !== "ACCEPTED" && record.state !== "STREAMING") continue;
      record.state = "INCOMPLETE";
      record.replayUnsafe = true;
      record.updatedAtMs = this.now();
      changed = true;
    }
    return changed;
  }

  private transition(token: TurnToken, state: TurnState): void {
    const record = this.currentRecord(token);
    if (record === undefined) return;
    if (record.state === "COMPLETED" || record.state === "FAILED" || record.state === "CANCELLED") {
      return; // terminal states are final for an attempt
    }
    record.state = state;
    record.updatedAtMs = this.now();
  }

  private currentRecord(token: TurnToken): TurnRecord | undefined {
    const record = this.turns.get(token.fingerprint);
    if (record === undefined || record.attempt !== token.attempt) return undefined;
    return record;
  }

  private checkToolIntegrity(signature: TurnSignature): TurnAdmission | undefined {
    const inRequestCalls = new Map<string, TurnToolCall>();
    for (const call of signature.toolCalls) {
      const duplicate = inRequestCalls.get(call.callId);
      if (
        duplicate !== undefined &&
        (duplicate.name !== call.name || duplicate.argumentsHash !== call.argumentsHash)
      ) {
        return blocked(
          "TOOL_CALL_CONFLICT",
          `Tool call '${call.callId}' appears twice in the request with different arguments.`,
        );
      }
      inRequestCalls.set(call.callId, call);

      const known = this.toolCalls.get(call.callId);
      if (
        known !== undefined &&
        (known.name !== call.name || known.argumentsHash !== call.argumentsHash)
      ) {
        return blocked(
          "TOOL_CALL_CONFLICT",
          `Tool call '${call.callId}' was previously delivered with different arguments. ` +
            "Replaying it was blocked to prevent duplicate side effects.",
        );
      }
    }

    const inRequestResults = new Map<string, TurnToolResult>();
    for (const result of signature.toolResults) {
      const duplicate = inRequestResults.get(result.callId);
      if (duplicate !== undefined && duplicate.outputHash !== result.outputHash) {
        return blocked(
          "TOOL_RESULT_CONFLICT",
          `Tool result '${result.callId}' appears twice with different output.`,
        );
      }
      inRequestResults.set(result.callId, result);
      if (!inRequestCalls.has(result.callId) && !this.toolCalls.has(result.callId)) {
        return blocked(
          "TOOL_RESULT_UNMATCHED",
          `Tool result references unknown tool call '${result.callId}'.`,
        );
      }
      const known = this.toolCalls.get(result.callId);
      if (known?.resolved === true && known.resultHash !== result.outputHash) {
        return blocked(
          "TOOL_RESULT_CONFLICT",
          `Tool call '${result.callId}' was already resolved with a different result. ` +
            "The conflicting result was rejected.",
        );
      }
    }

    // Recursive tool loop: a call the ledger already resolved is presented
    // again without its result, so the model would treat it as pending.
    for (const call of signature.toolCalls) {
      if (inRequestResults.has(call.callId)) continue;
      const known = this.toolCalls.get(call.callId);
      if (known?.resolved === true) {
        return blocked(
          "TOOL_LOOP_DETECTED",
          `Tool call '${call.callId}' was already resolved but is presented as pending ` +
            "again. The request was blocked to break the recursive tool loop.",
        );
      }
    }

    return undefined;
  }

  private recordToolActivity(signature: TurnSignature): void {
    for (const call of signature.toolCalls) {
      const known = this.toolCalls.get(call.callId);
      if (known === undefined) {
        this.toolCalls.set(call.callId, {
          name: call.name,
          argumentsHash: call.argumentsHash,
          resolved: false,
        });
      }
    }
    for (const result of signature.toolResults) {
      const known = this.toolCalls.get(result.callId);
      if (known !== undefined && !known.resolved) {
        known.resolved = true;
        known.resultHash = result.outputHash;
      }
    }
  }

  private countNewToolCalls(calls: readonly TurnToolCall[]): number {
    const newCallIds = new Set<string>();
    for (const call of calls) {
      if (!this.toolCalls.has(call.callId)) newCallIds.add(call.callId);
    }
    return newCallIds.size;
  }

  private restore(snapshot: TurnLedgerSnapshot): void {
    if (snapshot.version !== 1) throw new TypeError("Unsupported turn ledger snapshot version.");
    if (snapshot.turns.length > this.maxTurnRecords) {
      throw new RangeError("Turn ledger snapshot exceeds maxTurnRecords.");
    }
    if (snapshot.toolCalls.length > this.maxToolCallRecords) {
      throw new RangeError("Turn ledger snapshot exceeds maxToolCallRecords.");
    }
    for (const record of snapshot.turns) {
      if (this.turns.has(record.fingerprint)) {
        throw new TypeError(`Duplicate turn fingerprint '${record.fingerprint}' in snapshot.`);
      }
      this.turns.set(record.fingerprint, {
        state: record.state,
        streamStarted: record.streamStarted,
        toolActivity: record.toolActivity,
        replayUnsafe: record.replayUnsafe,
        attempt: record.attempt,
        updatedAtMs: record.updatedAtMs,
      });
    }
    for (const record of snapshot.toolCalls) {
      if (this.toolCalls.has(record.callId)) {
        throw new TypeError(`Duplicate tool call '${record.callId}' in snapshot.`);
      }
      this.toolCalls.set(record.callId, {
        name: record.name,
        argumentsHash: record.argumentsHash,
        resolved: record.resolved,
        ...(record.resultHash === undefined ? {} : { resultHash: record.resultHash }),
      });
    }
  }

  private evictIfNeeded(): void {
    if (this.turns.size < this.maxTurnRecords) return;
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, record] of this.turns) {
      if (
        record.state === "ACCEPTED" ||
        record.state === "STREAMING" ||
        record.state === "COMPLETED" ||
        record.replayUnsafe ||
        record.streamStarted ||
        record.toolActivity
      ) {
        continue;
      }
      if (record.updatedAtMs < oldestAt) {
        oldestAt = record.updatedAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.turns.delete(oldestKey);
  }
}

function blocked(code: TurnBlockCode, message: string): TurnAdmission {
  return { decision: "blocked", code, message };
}

/**
 * Extracts a stable turn signature from a raw OpenAI Responses request body.
 * Unknown shapes never throw here; malformed bodies are rejected later by the
 * protocol translation layer.
 */
export function extractResponsesTurnSignature(body: Readonly<Record<string, unknown>>): TurnSignature {
  const toolCalls: TurnToolCall[] = [];
  const toolResults: TurnToolResult[] = [];

  if (Array.isArray(body.input)) {
    for (const rawItem of body.input) {
      if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) continue;
      const item = rawItem as Record<string, unknown>;
      const type = typeof item.type === "string" ? item.type : undefined;
      const callId = typeof item.call_id === "string" ? item.call_id : undefined;
      if (callId === undefined || callId === "") continue;

      if (type === "function_call" || type === "custom_tool_call") {
        toolCalls.push({
          callId,
          name: typeof item.name === "string" ? item.name : "",
          argumentsHash: sha256(stableStringify(item.arguments ?? item.input ?? "")),
        });
      } else if (type === "function_call_output" || type === "custom_tool_call_output") {
        toolResults.push({
          callId,
          outputHash: sha256(stableStringify(item.output ?? "")),
        });
      }
    }
  }

  const fingerprint = sha256(stableStringify(withoutStreamTransport(body)));

  return { fingerprint, toolCalls, toolResults };
}

/** Extracts completed tool calls from a Responses response or output item. */
export function extractResponsesDeliveredToolCalls(
  payload: Readonly<Record<string, unknown>>,
): readonly TurnToolCall[] {
  const output = Array.isArray(payload.output)
    ? payload.output
    : payload.type === "function_call" || payload.type === "custom_tool_call"
      ? [payload]
      : [];
  const calls: TurnToolCall[] = [];
  for (const rawItem of output) {
    if (typeof rawItem !== "object" || rawItem === null || Array.isArray(rawItem)) continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
    if (typeof item.call_id !== "string" || item.call_id === "") continue;
    calls.push({
      callId: item.call_id,
      name: typeof item.name === "string" ? item.name : "",
      argumentsHash: sha256(stableStringify(item.arguments ?? item.input ?? "")),
    });
  }
  return calls;
}

/**
 * Extracts a stable turn signature from a raw Anthropic Messages request.
 * tool_use blocks in assistant messages are delivered tool calls; tool_result
 * blocks in user messages resolve them.
 */
export function extractAnthropicTurnSignature(
  body: Readonly<Record<string, unknown>>,
): TurnSignature {
  const toolCalls: TurnToolCall[] = [];
  const toolResults: TurnToolResult[] = [];

  if (Array.isArray(body.messages)) {
    for (const rawMessage of body.messages) {
      if (typeof rawMessage !== "object" || rawMessage === null || Array.isArray(rawMessage)) {
        continue;
      }
      const message = rawMessage as Record<string, unknown>;
      if (!Array.isArray(message.content)) continue;
      for (const rawBlock of message.content) {
        if (typeof rawBlock !== "object" || rawBlock === null || Array.isArray(rawBlock)) continue;
        const block = rawBlock as Record<string, unknown>;
        if (block.type === "tool_use" && typeof block.id === "string" && block.id !== "") {
          toolCalls.push({
            callId: block.id,
            name: typeof block.name === "string" ? block.name : "",
            argumentsHash: sha256(stableStringify(block.input ?? {})),
          });
        } else if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string" &&
          block.tool_use_id !== ""
        ) {
          toolResults.push({
            callId: block.tool_use_id,
            outputHash: sha256(stableStringify(block.content ?? "")),
          });
        }
      }
    }
  }

  const fingerprint = sha256(stableStringify(withoutStreamTransport(body)));

  return { fingerprint, toolCalls, toolResults };
}

/** Extracts tool_use blocks from a complete Anthropic message. */
export function extractAnthropicDeliveredToolCalls(
  payload: Readonly<Record<string, unknown>>,
): readonly TurnToolCall[] {
  const calls: TurnToolCall[] = [];
  if (!Array.isArray(payload.content)) return calls;
  for (const rawBlock of payload.content) {
    if (typeof rawBlock !== "object" || rawBlock === null || Array.isArray(rawBlock)) continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type !== "tool_use" || typeof block.id !== "string" || block.id === "") continue;
    calls.push({
      callId: block.id,
      name: typeof block.name === "string" ? block.name : "",
      argumentsHash: sha256(stableStringify(block.input ?? {})),
    });
  }
  return calls;
}

/** Deterministic JSON encoding with sorted object keys. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

function withoutStreamTransport(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result = { ...value };
  delete result.stream;
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
