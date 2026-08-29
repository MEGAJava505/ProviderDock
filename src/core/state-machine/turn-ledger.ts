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
  | "TOOL_CALL_CONFLICT"
  | "TOOL_RESULT_CONFLICT"
  | "TOOL_RESULT_UNMATCHED"
  | "TOOL_LOOP_DETECTED";

export interface TurnToken {
  readonly fingerprint: string;
  readonly attempt: number;
}

interface TurnRecord {
  state: TurnState;
  streamStarted: boolean;
  toolActivity: boolean;
  attempt: number;
  updatedAtMs: number;
}

interface ToolCallRecord {
  readonly name: string;
  readonly argumentsHash: string;
  resolved: boolean;
  resultHash?: string;
}

export interface TurnLedgerOptions {
  readonly maxTurnRecords?: number;
  readonly now?: () => number;
}

export class TurnLedger {
  private readonly turns = new Map<string, TurnRecord>();
  private readonly toolCalls = new Map<string, ToolCallRecord>();
  private readonly maxTurnRecords: number;
  private readonly now: () => number;

  constructor(options: TurnLedgerOptions = {}) {
    this.maxTurnRecords = options.maxTurnRecords ?? 512;
    this.now = options.now ?? Date.now;
  }

  /** Evaluates a turn before it is sent upstream. */
  admit(signature: TurnSignature): TurnAdmission {
    const toolCheck = this.checkToolIntegrity(signature);
    if (toolCheck !== undefined) return toolCheck;

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
      if (existing.streamStarted || existing.toolActivity) {
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
    const toolActivity = signature.toolCalls.length > 0 || signature.toolResults.length > 0;
    this.turns.set(signature.fingerprint, {
      state: "ACCEPTED",
      streamStarted: false,
      toolActivity,
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
    record.state = "STREAMING";
    record.updatedAtMs = this.now();
  }

  markToolActivity(token: TurnToken): void {
    const record = this.currentRecord(token);
    if (record === undefined) return;
    record.toolActivity = true;
    record.updatedAtMs = this.now();
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
      if (duplicate !== undefined && duplicate.argumentsHash !== call.argumentsHash) {
        return blocked(
          "TOOL_CALL_CONFLICT",
          `Tool call '${call.callId}' appears twice in the request with different arguments.`,
        );
      }
      inRequestCalls.set(call.callId, call);

      const known = this.toolCalls.get(call.callId);
      if (known !== undefined && known.argumentsHash !== call.argumentsHash) {
        return blocked(
          "TOOL_CALL_CONFLICT",
          `Tool call '${call.callId}' was previously delivered with different arguments. ` +
            "Replaying it was blocked to prevent duplicate side effects.",
        );
      }
    }

    const inRequestResults = new Set<string>();
    for (const result of signature.toolResults) {
      inRequestResults.add(result.callId);
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

  private evictIfNeeded(): void {
    if (this.turns.size < this.maxTurnRecords) return;
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, record] of this.turns) {
      if (record.state === "ACCEPTED" || record.state === "STREAMING") continue;
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

  const fingerprint = sha256(
    stableStringify({
      model: body.model,
      instructions: body.instructions,
      input: body.input,
      tools: body.tools,
      tool_choice: body.tool_choice,
    }),
  );

  return { fingerprint, toolCalls, toolResults };
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
