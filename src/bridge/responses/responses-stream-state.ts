export type JsonRecord = Record<string, unknown>;

export type StreamEventObservation =
  | { readonly kind: "forward"; readonly event: JsonRecord }
  | { readonly kind: "duplicate" }
  | { readonly kind: "after-terminal" };

export interface ResponsesStreamStateOptions {
  readonly now?: () => number;
  readonly responseIdFactory?: () => string;
}

export interface BuildTerminalRepairOptions {
  readonly forceFailure?: boolean;
  readonly message?: string;
}

export class ResponsesStreamProtocolError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ResponsesStreamProtocolError";
  }
}

/** Tracks semantic Responses events independently from transport chunk boundaries. */
export class ResponsesStreamState {
  private readonly seenSequences = new Map<number, string>();
  private readonly seenEventIds = new Map<string, string>();
  private readonly pendingOutputIndexes = new Set<number>();
  private readonly completedOutputItems = new Map<number, unknown>();
  private readonly itemIndexes = new Map<string, number>();
  private responseSnapshot: JsonRecord | undefined;
  private highestSequenceNumber = -1;
  private fallbackOutputIndex = 0;
  private terminal = false;
  private terminalType: "response.completed" | "response.failed" | "response.incomplete" | undefined;
  private readonly now: () => number;
  private readonly responseIdFactory: () => string;

  constructor(options: ResponsesStreamStateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.responseIdFactory =
      options.responseIdFactory ??
      (() => `resp_providerdock_${this.now().toString(36)}_${Math.random().toString(36).slice(2)}`);
  }

  get terminalEventSeen(): boolean {
    return this.terminal;
  }

  get terminalEventType(): "response.completed" | "response.failed" | "response.incomplete" | undefined {
    return this.terminalType;
  }

  observe(event: JsonRecord, eventId?: string): StreamEventObservation {
    if (this.terminal) return { kind: "after-terminal" };

    const serialized = JSON.stringify(event);
    const sequence = event.sequence_number;
    if (Number.isSafeInteger(sequence) && (sequence as number) >= 0) {
      const sequenceNumber = sequence as number;
      const previous = this.seenSequences.get(sequenceNumber);
      if (previous !== undefined) {
        if (previous === serialized) return { kind: "duplicate" };
        throw new ResponsesStreamProtocolError(
          `Conflicting Responses events used sequence number ${sequenceNumber}.`,
        );
      }
      this.seenSequences.set(sequenceNumber, serialized);
      this.highestSequenceNumber = Math.max(this.highestSequenceNumber, sequenceNumber);
    }

    if (eventId !== undefined && eventId !== "") {
      const previous = this.seenEventIds.get(eventId);
      if (previous !== undefined) {
        if (previous === serialized) return { kind: "duplicate" };
        throw new ResponsesStreamProtocolError(
          `Conflicting Responses events used SSE id '${eventId}'.`,
        );
      }
      this.seenEventIds.set(eventId, serialized);
    }

    if (isRecord(event.response)) {
      this.responseSnapshot = { ...this.responseSnapshot, ...event.response };
    }

    if (event.type === "response.output_item.added") {
      const index = this.resolveOutputIndex(event);
      this.pendingOutputIndexes.add(index);
      this.rememberItemIndex(event.item, index);
    } else if (event.type === "response.output_item.done" && event.item !== undefined) {
      const index = this.resolveOutputIndex(event);
      this.pendingOutputIndexes.delete(index);
      this.completedOutputItems.set(index, event.item);
      this.rememberItemIndex(event.item, index);
    }

    const terminalType =
      event.type === "response.completed" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete";
    if (terminalType && !isRecord(event.response)) {
      throw new ResponsesStreamProtocolError(
        `Terminal Responses event '${String(event.type)}' did not contain a response object.`,
      );
    }
    if (event.type === "response.completed" && this.pendingOutputIndexes.size > 0) {
      throw new ResponsesStreamProtocolError(
        "Upstream marked the response completed while output items were still pending.",
      );
    }

    let forwarded = event;
    if (event.type === "response.completed" && isRecord(event.response)) {
      const output = event.response.output;
      if (Array.isArray(output) && output.length === 0 && this.completedOutputItems.size > 0) {
        forwarded = {
          ...event,
          response: {
            ...event.response,
            output: this.completedOutput(),
          },
        };
        this.responseSnapshot = { ...this.responseSnapshot, ...(forwarded.response as JsonRecord) };
      }
    }

    if (terminalType) {
      this.terminal = true;
      this.terminalType = event.type as
        | "response.completed"
        | "response.failed"
        | "response.incomplete";
    }

    return { kind: "forward", event: forwarded };
  }

  buildTerminalRepair(options: BuildTerminalRepairOptions = {}): JsonRecord | undefined {
    if (this.terminal) return undefined;

    const output = this.completedOutput();
    const canComplete =
      options.forceFailure !== true && output.length > 0 && this.pendingOutputIndexes.size === 0;
    const type = canComplete ? "response.completed" : "response.failed";
    const message =
      options.message ?? "Upstream stream ended before a terminal Responses event was received.";
    const response: JsonRecord = {
      ...this.responseSnapshot,
      id: this.responseSnapshot?.id ?? this.responseIdFactory(),
      object: "response",
      status: canComplete ? "completed" : "failed",
      completed_at: Math.floor(this.now() / 1_000),
      output,
      error: canComplete
        ? null
        : {
            code: "INCOMPLETE_RESPONSE",
            type: "providerdock_incomplete_response",
            message,
          },
      incomplete_details: null,
    };

    this.terminal = true;
    this.terminalType = type;
    this.highestSequenceNumber += 1;
    return {
      type,
      sequence_number: this.highestSequenceNumber,
      response,
    };
  }

  private resolveOutputIndex(event: JsonRecord): number {
    if (Number.isSafeInteger(event.output_index) && (event.output_index as number) >= 0) {
      const index = event.output_index as number;
      this.fallbackOutputIndex = Math.max(this.fallbackOutputIndex, index + 1);
      return index;
    }

    const itemId = isRecord(event.item) && typeof event.item.id === "string" ? event.item.id : undefined;
    const knownIndex = itemId === undefined ? undefined : this.itemIndexes.get(itemId);
    if (knownIndex !== undefined) return knownIndex;

    const index = this.fallbackOutputIndex;
    this.fallbackOutputIndex += 1;
    return index;
  }

  private rememberItemIndex(item: unknown, index: number): void {
    if (isRecord(item) && typeof item.id === "string") {
      this.itemIndexes.set(item.id, index);
    }
  }

  private completedOutput(): unknown[] {
    return [...this.completedOutputItems.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item);
  }
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return isRecord(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
