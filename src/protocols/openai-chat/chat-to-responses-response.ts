import { createHash } from "node:crypto";
import {
  ProviderRequestError,
  type NormalizedErrorType,
} from "../../core/errors/provider-error.js";
import type {
  CanonicalRequest,
  CanonicalToolDefinition,
} from "../canonical/canonical-protocol.js";

export interface ChatToResponsesContext {
  readonly request: CanonicalRequest;
  readonly now?: () => Date;
}

export interface ChatToResponsesTranslation {
  readonly response: Readonly<Record<string, unknown>>;
  readonly terminalEventType: "response.completed" | "response.incomplete" | "response.failed";
}

export class ChatToResponsesTranslationError extends ProviderRequestError {
  constructor(type: NormalizedErrorType, message: string, options: ErrorOptions = {}) {
    super(type, message, { cause: options.cause });
    this.name = "ChatToResponsesTranslationError";
  }
}

export function translateChatResponseToResponses(
  payload: unknown,
  context: ChatToResponsesContext,
): ChatToResponsesTranslation {
  const chat = requireRecord(payload, "Chat Completions response must be a JSON object.");
  if (isRecord(chat.error)) {
    throw translationError(
      "PROVIDER_UNAVAILABLE",
      "Chat provider returned an error object in a successful HTTP response.",
    );
  }
  if (!Array.isArray(chat.choices) || chat.choices.length !== 1) {
    throw translationError(
      "PROTOCOL_ERROR",
      "Chat response must contain exactly one choice for Responses translation.",
    );
  }

  const choice = requireRecord(chat.choices[0], "Chat response choice must be an object.");
  const message = requireRecord(choice.message, "Chat response choice requires a message.");
  const upstreamId =
    typeof chat.id === "string" && chat.id.trim() !== ""
      ? chat.id
      : `chat_providerdock_${context.request.requestId}`;
  const responseId = toResponseId(upstreamId);
  const output = translateChatMessage(message, responseId, context.request.tools);
  const terminal = classifyFinishReason(choice.finish_reason, output.length);
  const nowSeconds = Math.floor((context.now ?? (() => new Date()))().getTime() / 1_000);
  const createdAt = isNonNegativeInteger(chat.created) ? chat.created : nowSeconds;
  const model =
    typeof chat.model === "string" && chat.model.trim() !== ""
      ? chat.model
      : context.request.model;
  const error =
    terminal.type === "response.failed"
      ? {
          code: terminal.reason,
          type: "providerdock_chat_response_failed",
          message: terminal.message,
        }
      : null;

  const response: Record<string, unknown> = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: terminal.status,
    background: false,
    completed_at: nowSeconds,
    error,
    incomplete_details:
      terminal.type === "response.incomplete" ? { reason: terminal.reason } : null,
    instructions: null,
    max_output_tokens: context.request.parameters.maxOutputTokens ?? null,
    model,
    output,
    parallel_tool_calls: context.request.parameters.parallelToolCalls ?? true,
    previous_response_id: null,
    reasoning:
      context.request.parameters.reasoningEffort === undefined &&
      context.request.parameters.reasoningSummary === undefined
        ? null
        : {
            effort: context.request.parameters.reasoningEffort ?? null,
            summary: context.request.parameters.reasoningSummary ?? null,
          },
    service_tier: context.request.parameters.serviceTier ?? "default",
    store: context.request.parameters.store ?? false,
    temperature: context.request.parameters.temperature ?? null,
    text: {
      format: { type: "text" },
      verbosity: context.request.parameters.verbosity ?? "medium",
    },
    tool_choice: context.request.toolChoice ?? "auto",
    tools: context.request.tools.map(canonicalToolToResponsesDefinition),
    top_p: context.request.parameters.topP ?? null,
    truncation: "disabled",
    usage: normalizeChatUsage(chat.usage),
    metadata: context.request.parameters.metadata ?? {},
    providerdock: { upstream_response_id: upstreamId, translated_from: "chat.completion" },
  };

  return { response, terminalEventType: terminal.type };
}

export function normalizeChatUsage(value: unknown): Readonly<Record<string, unknown>> {
  const usage = isRecord(value) ? value : {};
  const promptDetails = isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : isRecord(usage.input_tokens_details)
      ? usage.input_tokens_details
      : {};
  const completionDetails = isRecord(usage.completion_tokens_details)
    ? usage.completion_tokens_details
    : isRecord(usage.output_tokens_details)
      ? usage.output_tokens_details
      : {};
  const inputTokens = nonNegativeInteger(usage.input_tokens, usage.prompt_tokens, 0);
  const outputTokens = nonNegativeInteger(usage.output_tokens, usage.completion_tokens, 0);
  const totalTokens = nonNegativeInteger(usage.total_tokens, inputTokens + outputTokens);

  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: nonNegativeInteger(promptDetails.cached_tokens, 0),
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: nonNegativeInteger(completionDetails.reasoning_tokens, 0),
    },
    total_tokens: totalTokens,
  };
}

function translateChatMessage(
  message: Record<string, unknown>,
  responseId: string,
  tools: readonly CanonicalToolDefinition[],
): Record<string, unknown>[] {
  if (message.role !== undefined && message.role !== "assistant") {
    throw translationError("PROTOCOL_ERROR", "Chat response message role must be assistant.");
  }

  const output: Record<string, unknown>[] = [];
  const reasoningText = firstString(message.reasoning_content, message.reasoning);
  if (reasoningText !== undefined && reasoningText !== "") {
    output.push({
      id: deterministicItemId("rs", responseId, "reasoning"),
      type: "reasoning",
      summary: [{ type: "summary_text", text: reasoningText }],
      encrypted_content:
        typeof message.providerdock_encrypted_reasoning === "string"
          ? message.providerdock_encrypted_reasoning
          : null,
      status: "completed",
    });
  }

  const toolCalls = parseChatToolCalls(message, responseId);
  const seenCallIds = new Set<string>();
  for (const [index, call] of toolCalls.entries()) {
    if (seenCallIds.has(call.callId)) {
      throw translationError(
        "PROTOCOL_ERROR",
        `Chat response duplicated tool call id '${call.callId}'.`,
      );
    }
    seenCallIds.add(call.callId);
    const definition = tools.find((tool) => tool.name === call.name);
    if (definition === undefined) {
      throw translationError(
        "PROTOCOL_ERROR",
        `Chat response requested unknown tool '${call.name}'.`,
      );
    }
    const custom = definition.type === "custom";
    if (custom) {
      output.push({
        id: deterministicItemId("ctc", responseId, String(index), call.callId),
        type: "custom_tool_call",
        status: "completed",
        call_id: call.callId,
        name: call.name,
        input: unwrapCustomToolInput(call.arguments, call.name),
      });
    } else {
      validateFunctionArguments(call.arguments, call.name);
      output.push({
        id: deterministicItemId("fc", responseId, String(index), call.callId),
        type: "function_call",
        status: "completed",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      });
    }
  }

  const parsedContent = parseAssistantContent(message.content);
  const refusal = [
    parsedContent.refusal,
    ...(typeof message.refusal === "string" ? [message.refusal] : []),
  ].join("");
  if (parsedContent.text !== "" || refusal !== "") {
    output.push({
      id: deterministicItemId("msg", responseId, "message"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        ...(parsedContent.text === ""
          ? []
          : [
              {
                type: "output_text",
                text: parsedContent.text,
                annotations: [],
                logprobs: [],
              },
            ]),
        ...(refusal === "" ? [] : [{ type: "refusal", refusal }]),
      ],
    });
  }
  return output;
}

interface ParsedChatToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

function parseChatToolCalls(
  message: Record<string, unknown>,
  responseId: string,
): ParsedChatToolCall[] {
  let rawCalls: unknown[] = [];
  if (Array.isArray(message.tool_calls)) {
    rawCalls = message.tool_calls;
  } else if (isRecord(message.function_call)) {
    rawCalls = [{ type: "function", function: message.function_call }];
  }

  return rawCalls.map((rawCall, index) => {
    const call = requireRecord(rawCall, `Chat tool call ${index} must be an object.`);
    if (call.type !== undefined && call.type !== "function") {
      throw translationError(
        "UNSUPPORTED_FEATURE",
        `Chat tool call type '${String(call.type)}' is unsupported.`,
      );
    }
    const fn = requireRecord(call.function, `Chat tool call ${index} requires function data.`);
    const name = requireNonEmptyString(fn.name, `Chat tool call ${index} requires function name.`);
    const argumentsValue = requireString(
      fn.arguments,
      `Chat tool call '${name}' requires string arguments.`,
    );
    const callId =
      typeof call.id === "string" && call.id.trim() !== ""
        ? call.id
        : deterministicItemId("call", responseId, String(index), name);
    return { callId, name, arguments: argumentsValue };
  });
}

function parseAssistantContent(value: unknown): { readonly text: string; readonly refusal: string } {
  if (value === null || value === undefined) return { text: "", refusal: "" };
  if (typeof value === "string") return { text: value, refusal: "" };
  if (!Array.isArray(value)) {
    throw translationError(
      "PROTOCOL_ERROR",
      "Chat assistant content must be a string, null, or content array.",
    );
  }
  const text: string[] = [];
  const refusal: string[] = [];
  for (const [index, rawPart] of value.entries()) {
      const part = requireRecord(rawPart, `Chat assistant content part ${index} must be an object.`);
      if (["text", "output_text"].includes(String(part.type))) {
        text.push(requireString(part.text, `Chat assistant content part ${index} requires text.`));
        continue;
      }
      if (part.type === "refusal") {
        refusal.push(
          requireString(
            part.refusal ?? part.text,
            `Chat assistant refusal part ${index} requires text.`,
          ),
        );
        continue;
      }
      throw translationError(
        "UNSUPPORTED_FEATURE",
        `Chat assistant content part type '${String(part.type)}' is unsupported.`,
      );
  }
  return { text: text.join(""), refusal: refusal.join("") };
}

function classifyFinishReason(
  value: unknown,
  outputCount: number,
): {
  readonly type: "response.completed" | "response.incomplete" | "response.failed";
  readonly status: "completed" | "incomplete" | "failed";
  readonly reason: string | null;
  readonly message: string | null;
} {
  if (["stop", "tool_calls", "function_call"].includes(String(value)) && outputCount > 0) {
    return { type: "response.completed", status: "completed", reason: null, message: null };
  }
  if (value === "length") {
    return {
      type: "response.incomplete",
      status: "incomplete",
      reason: "max_output_tokens",
      message: null,
    };
  }
  if (value === "content_filter") {
    return {
      type: "response.incomplete",
      status: "incomplete",
      reason: "content_filter",
      message: null,
    };
  }
  return {
    type: "response.failed",
    status: "failed",
    reason: "INCOMPLETE_RESPONSE",
    message:
      outputCount === 0
        ? "Chat response contained no completed output items."
        : `Chat response ended without a supported finish reason (received ${String(value)}).`,
  };
}

export function canonicalToolToResponsesDefinition(
  tool: CanonicalToolDefinition,
): Record<string, unknown> {
  return tool.type === "function"
    ? {
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      }
    : {
        type: "custom",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.format === undefined ? {} : { format: tool.format }),
      };
}

function validateFunctionArguments(value: string, name: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw translationError(
      "PROTOCOL_ERROR",
      `Chat tool '${name}' returned malformed JSON arguments.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw translationError(
      "PROTOCOL_ERROR",
      `Chat tool '${name}' arguments must decode to a JSON object.`,
    );
  }
}

function unwrapCustomToolInput(value: string, name: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw translationError(
      "PROTOCOL_ERROR",
      `Chat custom tool '${name}' returned malformed wrapper arguments.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed) || typeof parsed.input !== "string") {
    throw translationError(
      "PROTOCOL_ERROR",
      `Chat custom tool '${name}' must return a string 'input' argument.`,
    );
  }
  return parsed.input;
}

function toResponseId(upstreamId: string): string {
  return upstreamId.startsWith("resp_")
    ? upstreamId
    : deterministicItemId("resp", upstreamId);
}

export function deterministicItemId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 24)}`;
}

function nonNegativeInteger(...values: readonly unknown[]): number {
  for (const value of values) {
    if (isNonNegativeInteger(value)) return value;
  }
  return 0;
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw translationError("PROTOCOL_ERROR", message);
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw translationError("PROTOCOL_ERROR", message);
  return value;
}

function requireNonEmptyString(value: unknown, message: string): string {
  const result = requireString(value, message).trim();
  if (result === "") throw translationError("PROTOCOL_ERROR", message);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function translationError(
  type: NormalizedErrorType,
  message: string,
  options: ErrorOptions = {},
): ChatToResponsesTranslationError {
  return new ChatToResponsesTranslationError(type, message, options);
}
