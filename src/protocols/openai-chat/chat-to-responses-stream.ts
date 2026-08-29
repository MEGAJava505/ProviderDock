import type { CanonicalRequest } from "../canonical/canonical-protocol.js";
import {
  canonicalToolToResponsesDefinition,
  ChatToResponsesTranslationError,
  deterministicItemId,
  translateChatResponseToResponses,
} from "./chat-to-responses-response.js";

export type ResponsesStreamEventRecord = Record<string, unknown>;

export interface ChatToResponsesStreamOptions {
  readonly request: CanonicalRequest;
  readonly now?: () => Date;
}

export interface FinishChatStreamOptions {
  readonly forceFailure?: boolean;
  readonly message?: string;
}

interface ReasoningStreamState {
  readonly kind: "reasoning";
  readonly id: string;
  readonly outputIndex: number;
  text: string;
}

interface MessageStreamState {
  readonly kind: "message";
  readonly id: string;
  readonly outputIndex: number;
  text: string;
  refusal: string;
}

interface ToolStreamState {
  readonly kind: "tool";
  readonly chatIndex: number;
  callId: string | undefined;
  name: string | undefined;
  arguments: string;
  emittedArgumentLength: number;
  outputIndex: number | undefined;
  itemId: string | undefined;
  custom: boolean;
  added: boolean;
}

type OutputStreamState = ReasoningStreamState | MessageStreamState | ToolStreamState;

/** Stateful Chat chunk translator that emits real Responses events as deltas arrive. */
export class ChatToResponsesStreamTranslator {
  private readonly request: CanonicalRequest;
  private readonly now: () => Date;
  private sequenceNumber = 0;
  private started = false;
  private terminal = false;
  private upstreamId: string | undefined;
  private responseId: string | undefined;
  private model: string;
  private createdAt: number | undefined;
  private finishReason: unknown;
  private usage: unknown;
  private reasoning: ReasoningStreamState | undefined;
  private message: MessageStreamState | undefined;
  private readonly tools = new Map<number, ToolStreamState>();
  private nextOutputIndex = 0;

  constructor(options: ChatToResponsesStreamOptions) {
    this.request = options.request;
    this.now = options.now ?? (() => new Date());
    this.model = options.request.model;
  }

  get terminalEventSeen(): boolean {
    return this.terminal;
  }

  feed(payload: unknown): readonly ResponsesStreamEventRecord[] {
    if (this.terminal) return [];
    const chunk = requireRecord(payload, "Chat stream chunk must be a JSON object.");
    if (isRecord(chunk.error)) {
      throw protocolError("Chat stream contained an upstream error object.");
    }
    this.observeIdentity(chunk);
    const events = this.ensureStarted();
    if (chunk.usage !== undefined) this.usage = chunk.usage;

    if (!Array.isArray(chunk.choices)) {
      throw protocolError("Chat stream chunk choices must be an array.");
    }
    if (chunk.choices.length > 1) {
      throw protocolError("Chat stream cannot translate more than one choice.");
    }
    if (chunk.choices.length === 0) return events;

    const choice = requireRecord(chunk.choices[0], "Chat stream choice must be an object.");
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

    const reasoningDelta = firstString(delta.reasoning_content, delta.reasoning);
    if (reasoningDelta !== undefined && reasoningDelta !== "") {
      events.push(...this.addReasoningDelta(reasoningDelta));
    }
    const textDelta = parseTextDelta(delta.content);
    if (textDelta !== "") events.push(...this.addTextDelta(textDelta));
    if (typeof delta.refusal === "string" && delta.refusal !== "") {
      events.push(...this.addRefusalDelta(delta.refusal));
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) {
        throw protocolError("Chat stream tool_calls delta must be an array.");
      }
      for (const [position, rawTool] of delta.tool_calls.entries()) {
        events.push(...this.addToolDelta(rawTool, position));
      }
    } else if (isRecord(delta.function_call)) {
      events.push(
        ...this.addToolDelta(
          { index: 0, type: "function", function: delta.function_call },
          0,
        ),
      );
    }
    return events;
  }

  finish(options: FinishChatStreamOptions = {}): readonly ResponsesStreamEventRecord[] {
    if (this.terminal) return [];
    const events = this.ensureStarted();
    if (options.forceFailure === true) {
      events.push(
        ...this.fail(
          options.message ?? "Chat stream ended after a malformed or conflicting event.",
          false,
        ),
      );
      return events;
    }

    try {
      const toolCalls = [...this.tools.values()]
        .sort((left, right) => left.chatIndex - right.chatIndex)
        .map((tool) => this.completeToolIdentity(tool));
      const translated = translateChatResponseToResponses(
        {
          id: this.requireResponseId(),
          created: this.createdAt,
          model: this.model,
          choices: [
            {
              finish_reason: this.finishReason ?? null,
              message: {
                role: "assistant",
                content: this.message?.text || null,
                ...(this.message?.refusal ? { refusal: this.message.refusal } : {}),
                ...(this.reasoning?.text ? { reasoning_content: this.reasoning.text } : {}),
                ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
              },
            },
          ],
          usage: this.usage,
        },
        { request: this.request, now: this.now },
      );
      if (translated.terminalEventType === "response.failed") {
        events.push(...this.fail("Chat stream did not produce a safe terminal response.", false));
        return events;
      }

      const translatedOutput = Array.isArray(translated.response.output)
        ? translated.response.output.filter(isRecord)
        : [];
      const orderedOutput = this.finalizeOutputItems(events, translatedOutput);
      const response = { ...translated.response, output: orderedOutput };
      events.push(this.event(translated.terminalEventType, { response }));
      this.terminal = true;
      return events;
    } catch (error) {
      const message =
        error instanceof ChatToResponsesTranslationError
          ? "Chat stream produced an invalid terminal response."
          : "Chat stream terminal translation failed."
      events.push(...this.fail(message, false));
      return events;
    }
  }

  fail(message: string, includeStart = true): readonly ResponsesStreamEventRecord[] {
    if (this.terminal) return [];
    const events = includeStart ? this.ensureStarted() : [];
    const response = this.responseSnapshot("failed", [], {
      code: "INCOMPLETE_RESPONSE",
      type: "providerdock_chat_stream_failed",
      message,
    });
    events.push(this.event("response.failed", { response }));
    this.terminal = true;
    return events;
  }

  private observeIdentity(chunk: Record<string, unknown>): void {
    if (typeof chunk.id === "string" && chunk.id !== "") {
      if (this.upstreamId !== undefined && this.upstreamId !== chunk.id) {
        throw protocolError("Chat stream changed response id between chunks.");
      }
      this.upstreamId = chunk.id;
      this.responseId ??= toResponseId(chunk.id);
    }
    if (typeof chunk.model === "string" && chunk.model !== "") {
      if (this.model !== this.request.model && this.model !== chunk.model) {
        throw protocolError("Chat stream changed model between chunks.");
      }
      this.model = chunk.model;
    }
    if (isNonNegativeInteger(chunk.created)) {
      if (this.createdAt !== undefined && this.createdAt !== chunk.created) {
        throw protocolError("Chat stream changed created timestamp between chunks.");
      }
      this.createdAt = chunk.created;
    }
  }

  private ensureStarted(): ResponsesStreamEventRecord[] {
    if (this.started) return [];
    this.started = true;
    this.responseId ??= toResponseId(
      this.upstreamId ?? `chat_providerdock_${this.request.requestId}`,
    );
    const response = this.responseSnapshot("in_progress", [], null);
    return [
      this.event("response.created", { response }),
      this.event("response.in_progress", { response }),
    ];
  }

  private addReasoningDelta(delta: string): ResponsesStreamEventRecord[] {
    const events: ResponsesStreamEventRecord[] = [];
    if (this.reasoning === undefined) {
      const id = deterministicItemId("rs", this.requireResponseId(), "reasoning");
      this.reasoning = {
        kind: "reasoning",
        id,
        outputIndex: this.allocateOutputIndex(),
        text: "",
      };
      events.push(
        this.event("response.output_item.added", {
          output_index: this.reasoning.outputIndex,
          item: { id, type: "reasoning", summary: [], status: "in_progress" },
        }),
        this.event("response.reasoning_summary_part.added", {
          item_id: id,
          output_index: this.reasoning.outputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }),
      );
    }
    this.reasoning.text += delta;
    events.push(
      this.event("response.reasoning_summary_text.delta", {
        item_id: this.reasoning.id,
        output_index: this.reasoning.outputIndex,
        summary_index: 0,
        delta,
      }),
    );
    return events;
  }

  private addTextDelta(delta: string): ResponsesStreamEventRecord[] {
    const events: ResponsesStreamEventRecord[] = [];
    if (this.message?.refusal) {
      throw protocolError("Chat stream mixed refusal and output text deltas.");
    }
    if (this.message === undefined) {
      const id = deterministicItemId("msg", this.requireResponseId(), "message");
      this.message = {
        kind: "message",
        id,
        outputIndex: this.allocateOutputIndex(),
        text: "",
        refusal: "",
      };
      events.push(
        this.event("response.output_item.added", {
          output_index: this.message.outputIndex,
          item: {
            id,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }),
        this.event("response.content_part.added", {
          item_id: id,
          output_index: this.message.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [], logprobs: [] },
        }),
      );
    }
    this.message.text += delta;
    events.push(
      this.event("response.output_text.delta", {
        item_id: this.message.id,
        output_index: this.message.outputIndex,
        content_index: 0,
        delta,
        logprobs: [],
      }),
    );
    return events;
  }

  private addRefusalDelta(delta: string): ResponsesStreamEventRecord[] {
    const events: ResponsesStreamEventRecord[] = [];
    if (this.message?.text) {
      throw protocolError("Chat stream mixed output text and refusal deltas.");
    }
    if (this.message === undefined) {
      const id = deterministicItemId("msg", this.requireResponseId(), "message");
      this.message = {
        kind: "message",
        id,
        outputIndex: this.allocateOutputIndex(),
        text: "",
        refusal: "",
      };
      events.push(
        this.event("response.output_item.added", {
          output_index: this.message.outputIndex,
          item: {
            id,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }),
        this.event("response.content_part.added", {
          item_id: id,
          output_index: this.message.outputIndex,
          content_index: 0,
          part: { type: "refusal", refusal: "" },
        }),
      );
    }
    this.message!.refusal += delta;
    events.push(
      this.event("response.refusal.delta", {
        item_id: this.message!.id,
        output_index: this.message!.outputIndex,
        content_index: 0,
        delta,
      }),
    );
    return events;
  }

  private addToolDelta(rawValue: unknown, position: number): ResponsesStreamEventRecord[] {
    const value = requireRecord(rawValue, `Chat stream tool call delta ${position} must be an object.`);
    const chatIndex = isNonNegativeInteger(value.index) ? value.index : position;
    const state = this.tools.get(chatIndex) ?? {
      kind: "tool" as const,
      chatIndex,
      callId: undefined,
      name: undefined,
      arguments: "",
      emittedArgumentLength: 0,
      outputIndex: undefined,
      itemId: undefined,
      custom: false,
      added: false,
    };
    this.tools.set(chatIndex, state);
    if (value.type !== undefined && value.type !== "function") {
      throw protocolError(`Chat stream tool call type '${String(value.type)}' is unsupported.`);
    }
    if (value.id !== undefined) {
      const id = requireNonEmptyString(value.id, "Chat stream tool call id must be a string.");
      if (state.callId !== undefined && state.callId !== id) {
        throw protocolError(`Chat stream tool index ${chatIndex} changed call id.`);
      }
      state.callId = id;
    }
    const fn = value.function === undefined
      ? {}
      : requireRecord(value.function, "Chat stream function delta must be an object.");
    if (fn.name !== undefined) {
      const fragment = requireString(fn.name, "Chat stream function name delta must be a string.");
      const previousName = state.name;
      state.name = mergeNameFragment(state.name, fragment);
      if (state.added && previousName !== state.name) {
        throw protocolError(`Chat stream tool index ${chatIndex} changed function name.`);
      }
      const definition = this.request.tools.find((tool) => tool.name === state.name);
      state.custom = definition?.type === "custom";
    }
    if (fn.arguments !== undefined) {
      state.arguments += requireString(
        fn.arguments,
        "Chat stream function arguments delta must be a string.",
      );
    }

    const definition = this.request.tools.find((tool) => tool.name === state.name);
    if (
      definition === undefined ||
      definition.type === "custom" ||
      state.callId === undefined ||
      state.name === undefined
    ) {
      return [];
    }
    return this.emitFunctionToolProgress(state);
  }

  private emitFunctionToolProgress(state: ToolStreamState): ResponsesStreamEventRecord[] {
    const events: ResponsesStreamEventRecord[] = [];
    if (!state.added) {
      state.outputIndex = this.allocateOutputIndex();
      state.itemId = deterministicItemId(
        "fc",
        this.requireResponseId(),
        String(state.chatIndex),
        state.callId!,
      );
      state.added = true;
      events.push(
        this.event("response.output_item.added", {
          output_index: state.outputIndex,
          item: {
            id: state.itemId,
            type: "function_call",
            status: "in_progress",
            call_id: state.callId,
            name: state.name,
            arguments: "",
          },
        }),
      );
    }
    const delta = state.arguments.slice(state.emittedArgumentLength);
    if (delta !== "") {
      state.emittedArgumentLength = state.arguments.length;
      events.push(
        this.event("response.function_call_arguments.delta", {
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta,
        }),
      );
    }
    return events;
  }

  private completeToolIdentity(state: ToolStreamState): Record<string, unknown> {
    if (state.name === undefined || state.name === "") {
      throw protocolError(`Chat stream tool index ${state.chatIndex} ended without a name.`);
    }
    state.callId ??= deterministicItemId(
      "call",
      this.requireResponseId(),
      String(state.chatIndex),
      state.name,
    );
    const definition = this.request.tools.find((tool) => tool.name === state.name);
    if (definition === undefined) {
      throw protocolError(`Chat stream requested unknown tool '${state.name}'.`);
    }
    state.custom = definition.type === "custom";
    return {
      index: state.chatIndex,
      id: state.callId,
      type: "function",
      function: { name: state.name, arguments: state.arguments },
    };
  }

  private finalizeOutputItems(
    events: ResponsesStreamEventRecord[],
    translatedOutput: readonly Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const outputById = new Map(
      translatedOutput.flatMap((item) => (typeof item.id === "string" ? [[item.id, item] as const] : [])),
    );
    const states: OutputStreamState[] = [];
    if (this.reasoning !== undefined) states.push(this.reasoning);
    if (this.message !== undefined) states.push(this.message);
    const sortedTools = [...this.tools.values()].sort(
      (left, right) => left.chatIndex - right.chatIndex,
    );
    for (const [position, tool] of sortedTools.entries()) {
      if (tool.chatIndex !== position) {
        throw protocolError("Chat stream tool indexes must be contiguous and start at zero.");
      }
      if (!tool.added) {
        tool.outputIndex = this.allocateOutputIndex();
        const prefix = tool.custom ? "ctc" : "fc";
        tool.itemId = deterministicItemId(
          prefix,
          this.requireResponseId(),
          String(tool.chatIndex),
          tool.callId!,
        );
      }
      states.push(tool);
    }
    states.sort((left, right) => left.outputIndex! - right.outputIndex!);

    const ordered: Record<string, unknown>[] = [];
    for (const state of states) {
      const completedId = state.kind === "tool" ? state.itemId : state.id;
      const completed = outputById.get(completedId ?? "");
      if (completed === undefined) continue;
      if (state.kind === "reasoning") {
        events.push(
          this.event("response.reasoning_summary_text.done", {
            item_id: state.id,
            output_index: state.outputIndex,
            summary_index: 0,
            text: state.text,
          }),
          this.event("response.reasoning_summary_part.done", {
            item_id: state.id,
            output_index: state.outputIndex,
            summary_index: 0,
            part: { type: "summary_text", text: state.text },
          }),
          this.event("response.output_item.done", {
            output_index: state.outputIndex,
            item: completed,
          }),
        );
      } else if (state.kind === "message") {
        events.push(
          ...(state.text === ""
            ? []
            : [
                this.event("response.output_text.done", {
                  item_id: state.id,
                  output_index: state.outputIndex,
                  content_index: 0,
                  text: state.text,
                  logprobs: [],
                }),
                this.event("response.content_part.done", {
                  item_id: state.id,
                  output_index: state.outputIndex,
                  content_index: 0,
                  part: {
                    type: "output_text",
                    text: state.text,
                    annotations: [],
                    logprobs: [],
                  },
                }),
              ]),
          ...(state.refusal === ""
            ? []
            : [
                this.event("response.refusal.done", {
                  item_id: state.id,
                  output_index: state.outputIndex,
                  content_index: 0,
                  refusal: state.refusal,
                }),
                this.event("response.content_part.done", {
                  item_id: state.id,
                  output_index: state.outputIndex,
                  content_index: 0,
                  part: { type: "refusal", refusal: state.refusal },
                }),
              ]),
          this.event("response.output_item.done", {
            output_index: state.outputIndex,
            item: completed,
          }),
        );
      } else {
        if (!state.added) {
          events.push(
            this.event("response.output_item.added", {
              output_index: state.outputIndex,
              item: { ...completed, status: "in_progress", ...(state.custom ? { input: "" } : { arguments: "" }) },
            }),
          );
        }
        const value = state.custom ? completed.input : completed.arguments;
        const deltaType = state.custom
          ? "response.custom_tool_call_input.delta"
          : "response.function_call_arguments.delta";
        const doneType = state.custom
          ? "response.custom_tool_call_input.done"
          : "response.function_call_arguments.done";
        if (typeof value === "string" && (state.custom || state.emittedArgumentLength === 0)) {
          events.push(
            this.event(deltaType, {
              item_id: state.itemId,
              output_index: state.outputIndex,
              delta: value,
            }),
          );
        }
        events.push(
          this.event(doneType, {
            item_id: state.itemId,
            output_index: state.outputIndex,
            ...(state.custom ? { input: value } : { arguments: value }),
          }),
          this.event("response.output_item.done", {
            output_index: state.outputIndex,
            item: completed,
          }),
        );
      }
      ordered.push(completed);
    }
    return ordered;
  }

  private responseSnapshot(
    status: "in_progress" | "failed",
    output: readonly Record<string, unknown>[],
    error: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    return {
      id: this.requireResponseId(),
      object: "response",
      created_at: this.createdAt ?? nowSeconds,
      status,
      background: false,
      completed_at: status === "failed" ? nowSeconds : null,
      error,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: this.request.parameters.maxOutputTokens ?? null,
      model: this.model,
      output,
      parallel_tool_calls: this.request.parameters.parallelToolCalls ?? true,
      previous_response_id: null,
      reasoning:
        this.request.parameters.reasoningEffort === undefined &&
        this.request.parameters.reasoningSummary === undefined
          ? null
          : {
              effort: this.request.parameters.reasoningEffort ?? null,
              summary: this.request.parameters.reasoningSummary ?? null,
            },
      service_tier: this.request.parameters.serviceTier ?? "default",
      store: this.request.parameters.store ?? false,
      temperature: this.request.parameters.temperature ?? null,
      text: { format: { type: "text" }, verbosity: this.request.parameters.verbosity ?? "medium" },
      tool_choice: this.request.toolChoice ?? "auto",
      tools: this.request.tools.map(canonicalToolToResponsesDefinition),
      top_p: this.request.parameters.topP ?? null,
      truncation: "disabled",
      usage: null,
      metadata: this.request.parameters.metadata ?? {},
    };
  }

  private event(type: string, fields: Record<string, unknown>): ResponsesStreamEventRecord {
    const event = { type, sequence_number: this.sequenceNumber, ...fields };
    this.sequenceNumber += 1;
    return event;
  }

  private allocateOutputIndex(): number {
    const result = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    return result;
  }

  private requireResponseId(): string {
    this.responseId ??= toResponseId(
      this.upstreamId ?? `chat_providerdock_${this.request.requestId}`,
    );
    return this.responseId;
  }
}

function parseTextDelta(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw protocolError("Chat stream content delta has invalid type.");
  return value
    .map((part) => {
      if (!isRecord(part) || !["text", "output_text"].includes(String(part.type))) {
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

function toResponseId(upstreamId: string): string {
  return upstreamId.startsWith("resp_")
    ? upstreamId
    : deterministicItemId("resp", upstreamId);
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
  const result = requireString(value, message).trim();
  if (result === "") throw protocolError(message);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function protocolError(message: string): ChatToResponsesTranslationError {
  return new ChatToResponsesTranslationError("PROTOCOL_ERROR", message);
}
