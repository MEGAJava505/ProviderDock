import { createHash } from "node:crypto";
import {
  AnthropicTranslationError,
  isRecord,
} from "./anthropic-to-chat-request.js";

/** OpenAI Chat Completions -> Anthropic Messages JSON translation. */
export interface ChatToAnthropicOptions {
  readonly model: string;
  readonly messageIdFactory?: () => string;
  /** Undefined disables name validation; an empty array rejects every tool call. */
  readonly allowedToolNames?: readonly string[];
}

export function translateChatResponseToAnthropic(
  payload: unknown,
  options: ChatToAnthropicOptions,
): Readonly<Record<string, unknown>> {
  if (!isRecord(payload)) {
    throw protocolError("Chat provider response must be a JSON object.");
  }
  if (isRecord(payload.error)) {
    throw protocolError("Chat provider returned an error object in a successful response.");
  }
  if (!Array.isArray(payload.choices) || payload.choices.length !== 1) {
    throw protocolError("Chat provider response must contain exactly one choice.");
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw protocolError("Chat provider response did not contain a message choice.");
  }
  const message = choice.message;
  if (message.role !== undefined && message.role !== "assistant") {
    throw protocolError("Chat provider response message role must be assistant.");
  }

  const stopReason = mapStopReason(choice.finish_reason);
  const content: Record<string, unknown>[] = [];
  const reasoning = firstString(message.reasoning_content, message.reasoning);
  if (reasoning !== undefined && reasoning !== "") {
    content.push({ type: "thinking", thinking: reasoning, signature: "" });
  }

  const parsedContent = parseAssistantContent(message.content);
  const refusal = [
    parsedContent.refusal,
    typeof message.refusal === "string" ? message.refusal : "",
  ].join("");
  if (parsedContent.text !== "") content.push({ type: "text", text: parsedContent.text });
  if (refusal !== "") content.push({ type: "text", text: refusal });

  const upstreamId =
    typeof payload.id === "string" && payload.id !== ""
      ? payload.id
      : `chat_${options.model}`;
  const toolCalls = parseToolCalls(message.tool_calls, upstreamId, options.allowedToolNames);
  content.push(...toolCalls);

  if (stopReason === "tool_use" && toolCalls.length === 0) {
    throw protocolError("Chat provider ended for tool calls without returning a valid tool call.");
  }
  if (stopReason !== "tool_use" && toolCalls.length > 0) {
    throw protocolError("Chat provider returned tool calls with a non-tool finish reason.");
  }
  if (content.length === 0) {
    throw new AnthropicTranslationError(
      "INCOMPLETE_RESPONSE",
      "Chat provider response contained no safe Anthropic output blocks.",
    );
  }

  const messageId =
    options.messageIdFactory?.() ?? deterministicId("msg_providerdock", upstreamId);
  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model:
      typeof payload.model === "string" && payload.model !== ""
        ? payload.model
        : options.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: mapUsage(payload.usage),
  };
}

export function mapStopReason(value: unknown): string {
  switch (value) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "stop":
      return "end_turn";
    default:
      throw new AnthropicTranslationError(
        "INCOMPLETE_RESPONSE",
        `Chat provider ended without a supported finish reason (received ${String(value)}).`,
      );
  }
}

export function mapUsage(usage: unknown): Record<string, unknown> {
  if (!isRecord(usage)) return { input_tokens: 0, output_tokens: 0 };
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const result: Record<string, unknown> = {
    input_tokens: nonNegativeInteger(usage.prompt_tokens),
    output_tokens: nonNegativeInteger(usage.completion_tokens),
  };
  const cachedTokens = nonNegativeInteger(promptDetails.cached_tokens);
  if (cachedTokens > 0) result.cache_read_input_tokens = cachedTokens;
  return result;
}

export function parseToolArguments(value: unknown, toolName = "unknown"): Record<string, unknown> {
  if (typeof value !== "string") {
    throw protocolError(`Chat tool '${toolName}' arguments must be a JSON string.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new AnthropicTranslationError(
      "PROTOCOL_ERROR",
      `Chat tool '${toolName}' returned malformed JSON arguments.`,
      { cause: error },
    );
  }
  if (!isRecord(parsed)) {
    throw protocolError(`Chat tool '${toolName}' arguments must decode to a JSON object.`);
  }
  return parsed;
}

function parseToolCalls(
  value: unknown,
  upstreamId: string,
  allowedToolNames: readonly string[] | undefined,
): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw protocolError("Chat response tool_calls must be an array.");
  const calls: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawCall] of value.entries()) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function)) {
      throw protocolError(`Chat tool call ${index} must contain function data.`);
    }
    if (rawCall.type !== undefined && rawCall.type !== "function") {
      throw new AnthropicTranslationError(
        "UNSUPPORTED_FEATURE",
        `Chat tool call type '${String(rawCall.type)}' is not supported.`,
      );
    }
    const name = requireNonEmptyString(
      rawCall.function.name,
      `Chat tool call ${index} requires a function name.`,
    );
    if (allowedToolNames !== undefined && !allowedToolNames.includes(name)) {
      throw protocolError(`Chat provider requested unknown tool '${name}'.`);
    }
    const input = parseToolArguments(rawCall.function.arguments, name);
    const id =
      typeof rawCall.id === "string" && rawCall.id !== ""
        ? rawCall.id
        : deterministicId("toolu_providerdock", upstreamId, String(index), name);
    if (seenIds.has(id)) throw protocolError(`Chat tool call id '${id}' is duplicated.`);
    seenIds.add(id);
    calls.push({ type: "tool_use", id, name, input });
  }
  return calls;
}

function parseAssistantContent(value: unknown): { readonly text: string; readonly refusal: string } {
  if (value === undefined || value === null) return { text: "", refusal: "" };
  if (typeof value === "string") return { text: value, refusal: "" };
  if (!Array.isArray(value)) throw protocolError("Chat assistant content has an invalid type.");
  const text: string[] = [];
  const refusal: string[] = [];
  for (const [index, rawPart] of value.entries()) {
    if (!isRecord(rawPart)) throw protocolError(`Chat content part ${index} must be an object.`);
    if (rawPart.type === "text" || rawPart.type === "output_text") {
      if (typeof rawPart.text !== "string") {
        throw protocolError(`Chat text content part ${index} requires text.`);
      }
      text.push(rawPart.text);
    } else if (rawPart.type === "refusal") {
      const value = firstString(rawPart.refusal, rawPart.text);
      if (value === undefined) throw protocolError(`Chat refusal part ${index} requires text.`);
      refusal.push(value);
    } else {
      throw new AnthropicTranslationError(
        "UNSUPPORTED_FEATURE",
        `Chat content part type '${String(rawPart.type)}' cannot be translated to Anthropic.`,
      );
    }
  }
  return { text: text.join(""), refusal: refusal.join("") };
}

function deterministicId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 24)}`;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw protocolError(message);
  return value;
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function protocolError(message: string): AnthropicTranslationError {
  return new AnthropicTranslationError("PROTOCOL_ERROR", message);
}
