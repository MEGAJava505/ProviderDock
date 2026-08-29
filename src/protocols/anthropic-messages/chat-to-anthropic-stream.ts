import { createHash } from "node:crypto";
import { AnthropicTranslationError, isRecord } from "./anthropic-to-chat-request.js";
import {
  mapStopReason,
  mapUsage,
  parseToolArguments,
} from "./chat-to-anthropic-response.js";

export interface AnthropicStreamEvent {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ChatToAnthropicStreamOptions {
  readonly model: string;
  readonly messageIdFactory?: () => string;
  readonly allowedToolNames?: readonly string[];
}

type OpenBlockKind = "thinking" | "text";

interface OpenBlock {
  readonly kind: OpenBlockKind;
  readonly index: number;
}

interface ToolStreamState {
  readonly chatIndex: number;
  id?: string;
  name?: string;
  arguments: string;
}

export interface CompletedAnthropicToolUse {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Stateful Chat SSE -> strictly ordered Anthropic Messages SSE translator. */
export class ChatToAnthropicStreamTranslator {
  private readonly model: string;
  private readonly messageIdFactory: () => string;
  private readonly allowedToolNames: readonly string[] | undefined;
  private started = false;
  private terminal = false;
  private successful = false;
  private messageId: string | undefined;
  private upstreamId: string | undefined;
  private upstreamModel: string | undefined;
  private finishReason: unknown;
  private usage: unknown;
  private nextBlockIndex = 0;
  private openBlock: OpenBlock | undefined;
  private hasContent = false;
  private readonly tools = new Map<number, ToolStreamState>();
  private completedTools: readonly CompletedAnthropicToolUse[] = [];

  constructor(options: ChatToAnthropicStreamOptions) {
    this.model = options.model;
    this.messageIdFactory =
      options.messageIdFactory ??
      (() => deterministicId("msg_providerdock", options.model, String(Date.now())));
    this.allowedToolNames = options.allowedToolNames;
  }

  get terminalEventSeen(): boolean {
    return this.terminal;
  }

  get terminalSucceeded(): boolean {
    return this.terminal && this.successful;
  }

  get completedToolUses(): readonly CompletedAnthropicToolUse[] {
    return this.completedTools;
  }

  feed(payload: unknown): readonly AnthropicStreamEvent[] {
    if (this.terminal) return [];
    if (!isRecord(payload)) throw protocolError("Chat stream chunk must be a JSON object.");
    if (isRecord(payload.error)) {
      throw protocolError("Chat stream contained an upstream error object.");
    }
    this.observeIdentity(payload);
    const events: AnthropicStreamEvent[] = [];
    this.ensureStarted(events);
    if (payload.usage !== undefined && payload.usage !== null) this.usage = payload.usage;

    if (!Array.isArray(payload.choices)) {
      throw protocolError("Chat stream chunk choices must be an array.");
    }
    if (payload.choices.length > 1) {
      throw protocolError("Chat stream cannot translate more than one choice.");
    }
    if (payload.choices.length === 0) return events;

    const choice = payload.choices[0];
    if (!isRecord(choice)) throw protocolError("Chat stream choice must be an object.");
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (
        this.finishReason !== undefined &&
        this.finishReason !== null &&
        this.finishReason !== choice.finish_reason
      ) {
        throw protocolError("Chat stream changed finish_reason after it was set.");
      }
      this.finishReason = choice.finish_reason;
    }
    const delta = isRecord(choice.delta)
      ? choice.delta
      : isRecord(choice.message)
        ? choice.message
        : {};
    if (delta.role !== undefined && delta.role !== "assistant") {
      throw protocolError("Chat stream delta role must be assistant.");
    }

    const reasoning = firstString(delta.reasoning_content, delta.reasoning);
    if (reasoning !== undefined && reasoning !== "") {
      this.ensureBlock(events, "thinking");
      events.push(blockDelta(this.openBlock!.index, {
        type: "thinking_delta",
        thinking: reasoning,
      }));
      this.hasContent = true;
    }
    const text = parseTextDelta(delta.content);
    if (text !== "") {
      this.ensureBlock(events, "text");
      events.push(blockDelta(this.openBlock!.index, { type: "text_delta", text }));
      this.hasContent = true;
    }
    if (typeof delta.refusal === "string" && delta.refusal !== "") {
      this.ensureBlock(events, "text");
      events.push(
        blockDelta(this.openBlock!.index, { type: "text_delta", text: delta.refusal }),
      );
      this.hasContent = true;
    }

    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) {
        throw protocolError("Chat stream tool_calls delta must be an array.");
      }
      for (const [position, rawCall] of delta.tool_calls.entries()) {
        this.feedToolCallDelta(rawCall, position);
      }
    } else if (isRecord(delta.function_call)) {
      this.feedToolCallDelta(
        { index: 0, type: "function", function: delta.function_call },
        0,
      );
    }
    return events;
  }

  /** Validates the terminal state before emitting message_stop. */
  finish(): readonly AnthropicStreamEvent[] {
    if (this.terminal) return [];
    try {
      const stopReason = mapStopReason(this.finishReason);
      const toolUses = this.completeToolUses();
      if (stopReason === "tool_use" && toolUses.length === 0) {
        throw protocolError("Chat stream ended for tool calls without a complete tool call.");
      }
      if (stopReason !== "tool_use" && toolUses.length > 0) {
        throw protocolError("Chat stream returned tool calls with a non-tool finish reason.");
      }
      if (!this.hasContent && toolUses.length === 0) {
        throw new AnthropicTranslationError(
          "INCOMPLETE_RESPONSE",
          "Chat stream contained no safe Anthropic output blocks.",
        );
      }

      const events: AnthropicStreamEvent[] = [];
      this.ensureStarted(events);
      this.closeOpenBlock(events);
      for (const toolUse of toolUses) this.emitToolUse(events, toolUse);
      events.push(
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: mapUsage(this.usage),
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      );
      this.completedTools = toolUses;
      this.successful = true;
      this.terminal = true;
      return events;
    } catch (error) {
      const message =
        error instanceof AnthropicTranslationError
          ? error.message
          : "Chat stream terminal translation failed.";
      return this.fail(message);
    }
  }

  fail(message: string): readonly AnthropicStreamEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    this.successful = false;
    return [
      {
        event: "error",
        data: { type: "error", error: { type: "api_error", message } },
      },
    ];
  }

  private observeIdentity(payload: Record<string, unknown>): void {
    if (typeof payload.id === "string" && payload.id !== "") {
      if (this.upstreamId !== undefined && this.upstreamId !== payload.id) {
        throw protocolError("Chat stream changed response id between chunks.");
      }
      this.upstreamId = payload.id;
      this.messageId ??= deterministicId("msg_providerdock", payload.id);
    }
    if (typeof payload.model === "string" && payload.model !== "") {
      if (this.upstreamModel !== undefined && this.upstreamModel !== payload.model) {
        throw protocolError("Chat stream changed model between chunks.");
      }
      this.upstreamModel = payload.model;
    }
  }

  private feedToolCallDelta(rawCall: unknown, position: number): void {
    if (!isRecord(rawCall)) {
      throw protocolError(`Chat stream tool call delta ${position} must be an object.`);
    }
    if (rawCall.type !== undefined && rawCall.type !== "function") {
      throw new AnthropicTranslationError(
        "UNSUPPORTED_FEATURE",
        `Chat stream tool call type '${String(rawCall.type)}' is not supported.`,
      );
    }
    const chatIndex =
      Number.isSafeInteger(rawCall.index) && (rawCall.index as number) >= 0
        ? (rawCall.index as number)
        : position;
    const state = this.tools.get(chatIndex) ?? {
      chatIndex,
      arguments: "",
    };
    this.tools.set(chatIndex, state);

    if (rawCall.id !== undefined) {
      const id = requireNonEmptyString(rawCall.id, "Chat stream tool call id must be a string.");
      if (state.id !== undefined && state.id !== id) {
        throw protocolError(`Chat stream tool index ${chatIndex} changed call id.`);
      }
      state.id = id;
    }
    const fn =
      rawCall.function === undefined
        ? {}
        : requireRecord(rawCall.function, "Chat stream function delta must be an object.");
    if (fn.name !== undefined) {
      const fragment = requireString(fn.name, "Chat stream function name delta must be a string.");
      state.name = mergeNameFragment(state.name, fragment);
    }
    if (fn.arguments !== undefined) {
      state.arguments += requireString(
        fn.arguments,
        "Chat stream function arguments delta must be a string.",
      );
    }
  }

  private completeToolUses(): CompletedAnthropicToolUse[] {
    const states = [...this.tools.values()].sort((left, right) => left.chatIndex - right.chatIndex);
    const result: CompletedAnthropicToolUse[] = [];
    const seenIds = new Set<string>();
    for (const [position, state] of states.entries()) {
      if (state.chatIndex !== position) {
        throw protocolError("Chat stream tool indexes must be contiguous and start at zero.");
      }
      const name = requireNonEmptyString(
        state.name,
        `Chat stream tool index ${state.chatIndex} ended without a name.`,
      );
      if (this.allowedToolNames !== undefined && !this.allowedToolNames.includes(name)) {
        throw protocolError(`Chat provider requested unknown tool '${name}'.`);
      }
      const id =
        state.id ??
        deterministicId(
          "toolu_providerdock",
          this.messageId ?? this.model,
          String(state.chatIndex),
          name,
        );
      if (seenIds.has(id)) throw protocolError(`Chat stream tool call id '${id}' is duplicated.`);
      seenIds.add(id);
      result.push({ id, name, input: parseToolArguments(state.arguments, name) });
    }
    return result;
  }

  private emitToolUse(events: AnthropicStreamEvent[], toolUse: CompletedAnthropicToolUse): void {
    const index = this.nextBlockIndex;
    this.nextBlockIndex += 1;
    events.push(
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: toolUse.id, name: toolUse.name, input: {} },
        },
      },
      blockDelta(index, {
        type: "input_json_delta",
        partial_json: JSON.stringify(toolUse.input),
      }),
      { event: "content_block_stop", data: { type: "content_block_stop", index } },
    );
  }

  private ensureStarted(events: AnthropicStreamEvent[]): void {
    if (this.started) return;
    this.started = true;
    this.messageId ??= this.messageIdFactory();
    events.push({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model: this.upstreamModel ?? this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    });
  }

  private ensureBlock(events: AnthropicStreamEvent[], kind: OpenBlockKind): void {
    if (this.openBlock?.kind === kind) return;
    this.closeOpenBlock(events);
    const index = this.nextBlockIndex;
    this.nextBlockIndex += 1;
    this.openBlock = { kind, index };
    events.push({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block:
          kind === "thinking"
            ? { type: "thinking", thinking: "", signature: "" }
            : { type: "text", text: "" },
      },
    });
  }

  private closeOpenBlock(events: AnthropicStreamEvent[]): void {
    if (this.openBlock === undefined) return;
    events.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: this.openBlock.index },
    });
    this.openBlock = undefined;
  }
}

function blockDelta(index: number, delta: Record<string, unknown>): AnthropicStreamEvent {
  return {
    event: "content_block_delta",
    data: { type: "content_block_delta", index, delta },
  };
}

function parseTextDelta(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw protocolError("Chat stream content delta has invalid type.");
  return value
    .map((part) => {
      if (!isRecord(part) || (part.type !== "text" && part.type !== "output_text")) {
        throw protocolError("Chat stream content delta included an unsupported part.");
      }
      return requireString(part.text, "Chat stream text delta requires text.");
    })
    .join("");
}

function mergeNameFragment(current: string | undefined, fragment: string): string {
  if (current === undefined || current === "") return fragment;
  if (fragment === "" || fragment === current) return current;
  if (fragment.startsWith(current)) return fragment;
  return current + fragment;
}

function deterministicId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 24)}`;
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError(message);
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw protocolError(message);
  return value;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw protocolError(message);
  return value;
}

function protocolError(message: string): AnthropicTranslationError {
  return new AnthropicTranslationError("PROTOCOL_ERROR", message);
}
