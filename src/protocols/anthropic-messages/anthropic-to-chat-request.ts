import {
  ProviderRequestError,
  type NormalizedErrorType,
} from "../../core/errors/provider-error.js";

/**
 * Anthropic Messages -> OpenAI Chat Completions request translation.
 *
 * This is the "OpenAI -> Anthropic adapter" direction from spec Phase 3: it
 * lets Claude Code (which speaks Anthropic Messages) run against a provider
 * that only exposes an OpenAI-compatible Chat Completions endpoint.
 */

export class AnthropicTranslationError extends ProviderRequestError {
  constructor(type: NormalizedErrorType, message: string, options: ErrorOptions = {}) {
    super(type, message, { cause: options.cause });
    this.name = "AnthropicTranslationError";
  }
}

export interface AnthropicToChatTranslation {
  readonly chatRequest: Readonly<Record<string, unknown>>;
  readonly model: string;
  readonly stream: boolean;
  readonly toolNames: readonly string[];
}

export function translateAnthropicRequestToChat(
  payload: unknown,
): AnthropicToChatTranslation {
  const request = requireRecord(payload, "Anthropic Messages request must be a JSON object.");
  const model = requireNonEmptyString(request.model, "Anthropic request requires a model.");
  if (!Array.isArray(request.messages)) {
    throw translationError("INVALID_REQUEST", "Anthropic request requires a messages array.");
  }
  const stream = request.stream === true;

  const messages: Record<string, unknown>[] = [];
  const systemText = parseSystem(request.system);
  if (systemText !== undefined) {
    messages.push({ role: "system", content: systemText });
  }
  for (const [index, rawMessage] of request.messages.entries()) {
    messages.push(...translateMessage(rawMessage, index));
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };

  if (
    !Number.isSafeInteger(request.max_tokens) ||
    (request.max_tokens as number) < 1
  ) {
    throw translationError(
      "INVALID_REQUEST",
      "Anthropic max_tokens must be a positive integer.",
    );
  }
  body.max_tokens = request.max_tokens;
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;
  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0) {
    body.stop = request.stop_sequences;
  }

  const tools = translateTools(request.tools);
  if (tools.length > 0) body.tools = tools;
  const toolChoice = translateToolChoice(request.tool_choice);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  if (isRecord(request.metadata) && typeof request.metadata.user_id === "string") {
    body.user = request.metadata.user_id;
  }

  if (request.thinking !== undefined) {
    throw translationError(
      "UNSUPPORTED_FEATURE",
      "Anthropic extended-thinking configuration cannot be translated safely to generic Chat Completions.",
    );
  }

  return {
    chatRequest: body,
    model,
    stream,
    toolNames: tools.flatMap((tool) => {
      const fn = isRecord(tool.function) ? tool.function : undefined;
      return typeof fn?.name === "string" ? [fn.name] : [];
    }),
  };
}

function parseSystem(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value === "" ? undefined : value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const [index, block] of value.entries()) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else {
        throw translationError(
          "UNSUPPORTED_FEATURE",
          `Anthropic system block ${index} cannot be translated to Chat Completions.`,
        );
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  throw translationError("INVALID_REQUEST", "Anthropic system prompt must be a string or blocks.");
}

function translateMessage(rawMessage: unknown, index: number): Record<string, unknown>[] {
  const message = requireRecord(rawMessage, `Anthropic message ${index} must be an object.`);
  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    throw translationError(
      "INVALID_REQUEST",
      `Anthropic message ${index} role must be 'user' or 'assistant'.`,
    );
  }

  const content = message.content;
  if (typeof content === "string") {
    return [{ role, content }];
  }
  if (!Array.isArray(content)) {
    throw translationError(
      "INVALID_REQUEST",
      `Anthropic message ${index} content must be a string or block array.`,
    );
  }

  if (role === "assistant") return [translateAssistantBlocks(content, index)];
  return translateUserBlocks(content, index);
}

function translateAssistantBlocks(
  blocks: readonly unknown[],
  index: number,
): Record<string, unknown> {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  const callIds = new Set<string>();

  for (const rawBlock of blocks) {
    const block = requireRecord(rawBlock, `Assistant block in message ${index} must be an object.`);
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      const id = requireNonEmptyString(
        block.id,
        `tool_use block in message ${index} requires id.`,
      );
      if (callIds.has(id)) {
        throw translationError(
          "PROTOCOL_ERROR",
          `tool_use id '${id}' is duplicated in Anthropic message ${index}.`,
        );
      }
      callIds.add(id);
      if (!isRecord(block.input)) {
        throw translationError(
          "INVALID_REQUEST",
          `tool_use block '${id}' input must be a JSON object.`,
        );
      }
      toolCalls.push({
        id,
        type: "function",
        function: {
          name: requireNonEmptyString(
            block.name,
            `tool_use block in message ${index} requires name.`,
          ),
          arguments: JSON.stringify(block.input),
        },
      });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      thinkingParts.push(block.thinking);
    } else if (block.type === "redacted_thinking") {
      throw translationError(
        "UNSUPPORTED_FEATURE",
        "Redacted Anthropic thinking blocks cannot be represented safely by Chat Completions.",
      );
    } else {
      throw translationError(
        "UNSUPPORTED_FEATURE",
        `Assistant block type '${String(block.type)}' in message ${index} is not supported.`,
      );
    }
  }

  const result: Record<string, unknown> = { role: "assistant" };
  result.content = textParts.length > 0 ? textParts.join("") : null;
  if (thinkingParts.length > 0) result.reasoning_content = thinkingParts.join("\n");
  if (toolCalls.length > 0) result.tool_calls = toolCalls;
  return result;
}

function translateUserBlocks(
  blocks: readonly unknown[],
  index: number,
): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  const contentParts: Record<string, unknown>[] = [];
  const flushContent = (): void => {
    if (contentParts.length === 0) return;
    const onlyText = contentParts.every((part) => part.type === "text");
    messages.push({
      role: "user",
      content: onlyText
        ? contentParts.map((part) => String(part.text)).join("")
        : [...contentParts],
    });
    contentParts.length = 0;
  };

  for (const rawBlock of blocks) {
    const block = requireRecord(rawBlock, `User block in message ${index} must be an object.`);
    if (block.type === "text" && typeof block.text === "string") {
      contentParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      contentParts.push(translateImageBlock(block, index));
    } else if (block.type === "tool_result") {
      // tool_result must become a Chat 'tool' role message, which cannot be
      // nested inside a user message; flush accumulated user content first.
      flushContent();
      messages.push({
        role: "tool",
        tool_call_id: requireNonEmptyString(
          block.tool_use_id,
          `tool_result block in message ${index} requires tool_use_id.`,
        ),
        content: toolResultText(block.content),
      });
    } else {
      throw translationError(
        "UNSUPPORTED_FEATURE",
        `User block type '${String(block.type)}' in message ${index} is not supported.`,
      );
    }
  }
  flushContent();
  return messages;
}

function translateImageBlock(
  block: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const source = requireRecord(block.source, `Image block in message ${index} requires source.`);
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  if (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  ) {
    return {
      type: "image_url",
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  }
  throw translationError(
    "UNSUPPORTED_FEATURE",
    `Image source type in message ${index} is not supported.`,
  );
}

function toolResultText(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content);
}

function translateTools(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw translationError("INVALID_REQUEST", "Anthropic tools must be an array.");
  }
  const tools: Record<string, unknown>[] = [];
  for (const [index, rawTool] of value.entries()) {
    const tool = requireRecord(rawTool, `Anthropic tool ${index} must be an object.`);
    if (tool.type !== undefined && tool.type !== "custom") {
      // Server-side Anthropic tools (computer use, bash, text editor, web
      // search, and future typed tools) have no generic Chat equivalent.
      throw translationError(
        "UNSUPPORTED_FEATURE",
        `Anthropic server tool type '${String(tool.type)}' cannot be translated to Chat Completions.`,
      );
    }
    if (!isRecord(tool.input_schema)) {
      throw translationError(
        "INVALID_REQUEST",
        `Anthropic tool ${index} requires an input_schema object.`,
      );
    }
    tools.push({
      type: "function",
      function: {
        name: requireNonEmptyString(tool.name, `Anthropic tool ${index} requires a name.`),
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: tool.input_schema,
      },
    });
  }
  return tools;
}

function translateToolChoice(value: unknown): unknown {
  if (value === undefined) return undefined;
  const choice = requireRecord(value, "Anthropic tool_choice must be an object.");
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool") {
    return {
      type: "function",
      function: {
        name: requireNonEmptyString(choice.name, "Anthropic tool_choice.tool requires name."),
      },
    };
  }
  throw translationError(
    "INVALID_REQUEST",
    `Anthropic tool_choice type '${String(choice.type)}' is not supported.`,
  );
}

function translationError(type: NormalizedErrorType, message: string): AnthropicTranslationError {
  return new AnthropicTranslationError(type, message);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw translationError("INVALID_REQUEST", message);
  return value;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value === "") {
    throw translationError("INVALID_REQUEST", message);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
