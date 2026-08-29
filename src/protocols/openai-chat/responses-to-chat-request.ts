import { createHash, randomUUID } from "node:crypto";
import {
  ProviderRequestError,
  type NormalizedErrorType,
} from "../../core/errors/provider-error.js";
import type {
  CanonicalContentBlock,
  CanonicalConversationItem,
  CanonicalModelParameters,
  CanonicalRequest,
  CanonicalRole,
  CanonicalToolDefinition,
  CanonicalToolHistoryRecord,
} from "../canonical/canonical-protocol.js";

export interface ResponsesToChatTranslationOptions {
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly now?: () => Date;
  readonly developerRole?: "developer" | "system";
}

export interface ResponsesToChatTranslation {
  readonly canonical: CanonicalRequest;
  readonly chatRequest: Readonly<Record<string, unknown>>;
  readonly toolHistory: readonly CanonicalToolHistoryRecord[];
}

export class ResponsesToChatTranslationError extends ProviderRequestError {
  constructor(type: NormalizedErrorType, message: string, options: ErrorOptions = {}) {
    super(type, message, { cause: options.cause });
    this.name = "ResponsesToChatTranslationError";
  }
}

const knownRequestFields = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "seed",
  "service_tier",
  "store",
  "metadata",
  "previous_response_id",
  "conversation",
  "background",
  "include",
  "max_tool_calls",
  "truncation",
  "user",
]);

export function translateResponsesRequestToChat(
  payload: unknown,
  options: ResponsesToChatTranslationOptions = {},
): ResponsesToChatTranslation {
  const request = requireRecord(payload, "Responses request must be a JSON object.");
  validateKnownRequestFields(request);
  const model = requireNonEmptyString(request.model, "Responses request requires a model.");
  rejectStatefulReferences(request);

  const requestId = options.requestId ?? `req_providerdock_${randomUUID().replaceAll("-", "")}`;
  const sessionId = options.sessionId ?? "providerdock-bridge";
  const items: CanonicalConversationItem[] = [];
  if (request.instructions !== undefined) {
    items.push({
      type: "message",
      role: options.developerRole ?? "system",
      content: [
        {
          type: "text",
          text: requireString(request.instructions, "Responses instructions must be a string."),
          sourceType: "input_text",
        },
      ],
      extensions: {},
    });
  }
  items.push(...parseResponsesInput(request.input));

  const tools = parseTools(request.tools);
  const parameters = parseParameters(request);
  const stream = request.stream === true;
  const canonical: CanonicalRequest = {
    requestId,
    sessionId,
    model,
    items,
    tools,
    ...(request.tool_choice === undefined ? {} : { toolChoice: request.tool_choice }),
    parameters,
    stream,
    extensions: buildCanonicalExtensions(request),
  };
  const toolHistory = validateToolHistory(canonical, options.now ?? (() => new Date()));
  const chatRequest = encodeChatRequest(canonical, request);
  return { canonical, chatRequest, toolHistory };
}

function parseResponsesInput(value: unknown): CanonicalConversationItem[] {
  if (typeof value === "string") {
    return [messageItem("user", [{ type: "text", text: value, sourceType: "input_text" }])];
  }
  if (!Array.isArray(value)) {
    throw translationError("INVALID_REQUEST", "Responses input must be a string or item array.");
  }

  return value.map((rawItem, index) => parseInputItem(rawItem, index));
}

function parseInputItem(value: unknown, index: number): CanonicalConversationItem {
  const item = requireRecord(value, `Responses input item ${index} must be an object.`);
  const type = typeof item.type === "string" ? item.type : undefined;

  if (type === undefined || type === "message") {
    const role = parseRole(item.role, index);
    return {
      type: "message",
      role,
      content: parseMessageContent(item.content, role, index),
      extensions: collectUnknownFields(item, new Set(["type", "role", "content", "status", "id"])),
    };
  }
  if (type === "function_call" || type === "custom_tool_call") {
    return {
      type: "tool_call",
      toolType: type === "function_call" ? "function" : "custom",
      ...(typeof item.id === "string" ? { itemId: item.id } : {}),
      callId: requireNonEmptyString(
        item.call_id,
        `Responses ${type} item ${index} requires call_id.`,
      ),
      name: requireNonEmptyString(item.name, `Responses ${type} item ${index} requires name.`),
      arguments: normalizeArguments(item.arguments ?? item.input, type, index),
      extensions: collectUnknownFields(
        item,
        new Set(["type", "id", "call_id", "name", "arguments", "input", "status"]),
      ),
    };
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return {
      type: "tool_result",
      toolType: type === "function_call_output" ? "function" : "custom",
      callId: requireNonEmptyString(
        item.call_id,
        `Responses ${type} item ${index} requires call_id.`,
      ),
      output: normalizeToolOutput(item.output),
      extensions: collectUnknownFields(item, new Set(["type", "call_id", "output", "status", "id"])),
    };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.flatMap((part) =>
          isRecord(part) && typeof part.text === "string" ? [part.text] : [],
        )
      : [];
    return {
      type: "reasoning",
      summary,
      ...(typeof item.encrypted_content === "string"
        ? { encryptedContent: item.encrypted_content }
        : {}),
      extensions: collectUnknownFields(
        item,
        new Set(["type", "id", "summary", "encrypted_content", "status"]),
      ),
    };
  }

  throw translationError(
    "UNSUPPORTED_FEATURE",
    `Responses input item type '${String(type)}' is not supported by the Chat adapter.`,
  );
}

function parseMessageContent(
  value: unknown,
  role: CanonicalRole,
  itemIndex: number,
): CanonicalContentBlock[] {
  if (typeof value === "string") {
    return [{ type: "text", text: value, sourceType: role === "assistant" ? "output_text" : "input_text" }];
  }
  if (!Array.isArray(value)) {
    throw translationError(
      "INVALID_REQUEST",
      `Responses message item ${itemIndex} content must be a string or array.`,
    );
  }

  return value.map((rawPart, partIndex) => {
    const part = requireRecord(
      rawPart,
      `Responses message item ${itemIndex} content part ${partIndex} must be an object.`,
    );
    const type = requireNonEmptyString(
      part.type,
      `Responses message item ${itemIndex} content part ${partIndex} requires type.`,
    );
    if (["input_text", "output_text", "text", "refusal"].includes(type)) {
      return {
        type: "text" as const,
        text: requireString(
          type === "refusal" ? part.refusal ?? part.text : part.text,
          `Responses ${type} part requires text.`,
        ),
        sourceType: type as "input_text" | "output_text" | "text" | "refusal",
      };
    }
    if (type === "input_image") {
      if (role !== "user") {
        throw translationError(
          "UNSUPPORTED_FEATURE",
          "Chat translation only supports image content in user messages.",
        );
      }
      const imageUrl = requireNonEmptyString(
        part.image_url,
        "Chat translation requires input_image.image_url; file_id images are unsupported.",
      );
      const detail = parseImageDetail(part.detail);
      return {
        type: "image" as const,
        imageUrl,
        ...(detail === undefined ? {} : { detail }),
      };
    }
    throw translationError(
      "UNSUPPORTED_FEATURE",
      `Responses content part type '${type}' is not supported by the Chat adapter.`,
    );
  });
}

function parseTools(value: unknown): CanonicalToolDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw translationError("INVALID_REQUEST", "Responses tools must be an array.");
  }

  const names = new Set<string>();
  return value.map((rawTool, index) => {
    const tool = requireRecord(rawTool, `Responses tool ${index} must be an object.`);
    const type = requireNonEmptyString(tool.type, `Responses tool ${index} requires type.`);
    if (type !== "function" && type !== "custom") {
      throw translationError(
        "UNSUPPORTED_FEATURE",
        `Responses tool type '${type}' cannot be represented by Chat Completions safely.`,
      );
    }
    const nestedFunction = type === "function" && isRecord(tool.function) ? tool.function : tool;
    const name = requireNonEmptyString(
      nestedFunction.name,
      `Responses tool ${index} requires a name.`,
    );
    if (names.has(name)) {
      throw translationError("INVALID_REQUEST", `Responses tool name '${name}' is duplicated.`);
    }
    names.add(name);

    if (type === "function") {
      const schema = nestedFunction.parameters ?? nestedFunction.input_schema ?? {};
      if (!isRecord(schema)) {
        throw translationError(
          "INVALID_REQUEST",
          `Responses function tool '${name}' parameters must be an object.`,
        );
      }
      return {
        type: "function" as const,
        name,
        ...(typeof nestedFunction.description === "string"
          ? { description: nestedFunction.description }
          : {}),
        inputSchema: schema,
        ...(typeof nestedFunction.strict === "boolean" ? { strict: nestedFunction.strict } : {}),
        extensions: collectUnknownFields(
          tool,
          new Set(["type", "name", "description", "parameters", "input_schema", "strict", "function"]),
        ),
      };
    }
    if (type === "custom") {
      return {
        type: "custom" as const,
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.format === undefined ? {} : { format: tool.format }),
        extensions: collectUnknownFields(
          tool,
          new Set(["type", "name", "description", "format"]),
        ),
      };
    }
    throw translationError(
      "UNSUPPORTED_FEATURE",
      `Responses tool type '${type}' cannot be represented by Chat Completions safely.`,
    );
  });
}

function parseParameters(request: Record<string, unknown>): CanonicalModelParameters {
  const reasoning = isRecord(request.reasoning) ? request.reasoning : undefined;
  const text = isRecord(request.text) ? request.text : undefined;
  const metadata = isRecord(request.metadata)
    ? (request.metadata as Readonly<Record<string, string>>)
    : undefined;
  return {
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(typeof request.top_p === "number" ? { topP: request.top_p } : {}),
    ...(isNonNegativeInteger(request.max_output_tokens)
      ? { maxOutputTokens: request.max_output_tokens }
      : {}),
    ...(typeof request.parallel_tool_calls === "boolean"
      ? { parallelToolCalls: request.parallel_tool_calls }
      : {}),
    ...(typeof reasoning?.effort === "string" ? { reasoningEffort: reasoning.effort } : {}),
    ...(typeof reasoning?.summary === "string" ? { reasoningSummary: reasoning.summary } : {}),
    ...(typeof text?.verbosity === "string" ? { verbosity: text.verbosity } : {}),
    ...(Number.isSafeInteger(request.seed) ? { seed: request.seed as number } : {}),
    ...(typeof request.service_tier === "string" ? { serviceTier: request.service_tier } : {}),
    ...(typeof request.store === "boolean" ? { store: request.store } : {}),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function encodeChatRequest(
  canonical: CanonicalRequest,
  original: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const chatTools = canonical.tools.map(encodeChatTool);
  const body: Record<string, unknown> = {
    model: canonical.model,
    messages: encodeChatMessages(canonical.items),
    stream: canonical.stream,
  };
  if (canonical.stream) body.stream_options = { include_usage: true };
  if (chatTools.length > 0) body.tools = chatTools;
  if (canonical.toolChoice !== undefined) body.tool_choice = encodeToolChoice(canonical.toolChoice);
  const parameters = canonical.parameters;
  if (parameters.temperature !== undefined) body.temperature = parameters.temperature;
  if (parameters.topP !== undefined) body.top_p = parameters.topP;
  if (parameters.maxOutputTokens !== undefined) {
    body.max_completion_tokens = parameters.maxOutputTokens;
  }
  if (parameters.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = parameters.parallelToolCalls;
  }
  if (parameters.reasoningEffort !== undefined) body.reasoning_effort = parameters.reasoningEffort;
  if (parameters.verbosity !== undefined) body.verbosity = parameters.verbosity;
  if (parameters.seed !== undefined) body.seed = parameters.seed;
  if (parameters.serviceTier !== undefined) body.service_tier = parameters.serviceTier;
  if (parameters.store !== undefined) body.store = parameters.store;
  if (parameters.metadata !== undefined) body.metadata = parameters.metadata;
  if (typeof original.user === "string") body.user = original.user;

  const responseFormat = encodeResponseFormat(original.text);
  if (responseFormat !== undefined) body.response_format = responseFormat;
  return body;
}

function encodeChatMessages(items: readonly CanonicalConversationItem[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let assistant: Record<string, unknown> | undefined;
  let assistantHasMessage = false;
  const flushAssistant = (): void => {
    if (assistant === undefined) return;
    if (!("content" in assistant)) assistant.content = null;
    messages.push(assistant);
    assistant = undefined;
    assistantHasMessage = false;
  };
  const ensureAssistant = (): Record<string, unknown> => {
    assistant ??= { role: "assistant" };
    return assistant;
  };

  for (const item of items) {
    if (item.type === "message" && item.role === "assistant") {
      if (assistantHasMessage) flushAssistant();
      const pending = ensureAssistant();
      pending.content = encodeMessageContent(item.content, item.role);
      assistantHasMessage = true;
      continue;
    }
    if (item.type === "reasoning") {
      const pending = ensureAssistant();
      if (item.summary.length > 0) pending.reasoning_content = item.summary.join("\n");
      if (item.encryptedContent !== undefined) {
        pending.providerdock_encrypted_reasoning = item.encryptedContent;
      }
      continue;
    }
    if (item.type === "tool_call") {
      const pending = ensureAssistant();
      const toolCalls = Array.isArray(pending.tool_calls)
        ? (pending.tool_calls as Record<string, unknown>[])
        : [];
      toolCalls.push({
        id: item.callId,
        type: "function",
        function: {
          name: item.name,
          arguments:
            item.toolType === "custom"
              ? JSON.stringify({ input: item.arguments })
              : item.arguments,
        },
      });
      pending.tool_calls = toolCalls;
      continue;
    }

    flushAssistant();
    if (item.type === "message") {
      messages.push({ role: item.role, content: encodeMessageContent(item.content, item.role) });
    } else if (item.type === "tool_result") {
      messages.push({ role: "tool", tool_call_id: item.callId, content: item.output });
    }
  }
  flushAssistant();
  return messages;
}

function encodeMessageContent(
  content: readonly CanonicalContentBlock[],
  role: CanonicalRole,
): string | readonly Record<string, unknown>[] {
  const hasImages = content.some((part) => part.type === "image");
  if (!hasImages) {
    return content.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  if (role !== "user") {
    throw translationError(
      "UNSUPPORTED_FEATURE",
      "Only user image messages can be represented by Chat Completions.",
    );
  }
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : {
          type: "image_url",
          image_url: {
            url: part.imageUrl,
            ...(part.detail === undefined ? {} : { detail: part.detail }),
          },
        },
  );
}

function encodeChatTool(tool: CanonicalToolDefinition): Record<string, unknown> {
  if (tool.type === "function") {
    return {
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    };
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
        additionalProperties: false,
      },
    },
  };
}

function encodeToolChoice(value: unknown): unknown {
  if (typeof value === "string" && ["auto", "none", "required"].includes(value)) return value;
  if (isRecord(value) && ["function", "custom"].includes(String(value.type))) {
    return {
      type: "function",
      function: {
        name: requireNonEmptyString(value.name, "Responses named tool_choice requires name."),
      },
    };
  }
  throw translationError(
    "UNSUPPORTED_FEATURE",
    "Responses tool_choice cannot be represented by Chat Completions safely.",
  );
}

function encodeResponseFormat(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.format)) return undefined;
  const format = value.format;
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: requireNonEmptyString(format.name, "Responses JSON schema format requires name."),
        schema: requireRecord(format.schema, "Responses JSON schema format requires schema."),
        ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
      },
    };
  }
  throw translationError(
    "UNSUPPORTED_FEATURE",
    `Responses text format '${String(format.type)}' is not supported by Chat Completions.`,
  );
}

function validateToolHistory(
  request: CanonicalRequest,
  now: () => Date,
): CanonicalToolHistoryRecord[] {
  const records = new Map<string, CanonicalToolHistoryRecord>();
  const toolTypes = new Map<string, "function" | "custom">();
  for (const item of request.items) {
    if (item.type === "tool_call") {
      if (records.has(item.callId)) {
        throw translationError(
          "PROTOCOL_ERROR",
          `Tool call '${item.callId}' is duplicated in Responses input history.`,
        );
      }
      records.set(item.callId, {
        toolCallId: item.callId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolName: item.name,
        argumentsHash: sha256(item.arguments),
        status: "DELIVERED",
        createdAt: now().toISOString(),
      });
      toolTypes.set(item.callId, item.toolType);
    } else if (item.type === "tool_result") {
      const call = records.get(item.callId);
      if (call === undefined) {
        throw translationError(
          "PROTOCOL_ERROR",
          `Tool result '${item.callId}' does not reference an earlier tool call.`,
        );
      }
      if (call.status === "RESOLVED") {
        throw translationError(
          "PROTOCOL_ERROR",
          `Tool result '${item.callId}' is duplicated in Responses input history.`,
        );
      }
      if (toolTypes.get(item.callId) !== item.toolType) {
        throw translationError(
          "PROTOCOL_ERROR",
          `Tool result '${item.callId}' type does not match its tool call.`,
        );
      }
      records.set(item.callId, {
        ...call,
        status: "RESOLVED",
        resolvedAt: now().toISOString(),
        resultHash: sha256(item.output),
      });
    }
  }

  const unresolved = [...records.values()].filter((record) => record.status !== "RESOLVED");
  if (unresolved.length > 0) {
    throw translationError(
      "PROTOCOL_ERROR",
      `Responses input contains unresolved tool call(s): ${unresolved
        .map((record) => record.toolCallId)
        .join(", ")}. Automatic continuation was blocked.`,
    );
  }
  return [...records.values()];
}

function rejectStatefulReferences(request: Record<string, unknown>): void {
  if (request.previous_response_id !== undefined && request.previous_response_id !== null) {
    throw translationError(
      "UNSUPPORTED_FEATURE",
      "previous_response_id requires a stateful response store and cannot be translated blindly.",
    );
  }
  if (request.conversation !== undefined && request.conversation !== null) {
    throw translationError(
      "UNSUPPORTED_FEATURE",
      "Responses conversation references are not supported by the stateless Chat adapter.",
    );
  }
  if (request.background === true) {
    throw translationError(
      "UNSUPPORTED_FEATURE",
      "Background Responses requests are not supported by the local Chat bridge.",
    );
  }
}

function validateKnownRequestFields(request: Record<string, unknown>): void {
  if (request.stream !== undefined && typeof request.stream !== "boolean") {
    throw translationError("INVALID_REQUEST", "Responses stream must be a boolean.");
  }
  for (const name of ["temperature", "top_p"] as const) {
    const value = request[name];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw translationError("INVALID_REQUEST", `Responses ${name} must be a finite number.`);
    }
  }
  if (
    request.max_output_tokens !== undefined &&
    (!Number.isSafeInteger(request.max_output_tokens) || (request.max_output_tokens as number) < 1)
  ) {
    throw translationError(
      "INVALID_REQUEST",
      "Responses max_output_tokens must be a positive integer.",
    );
  }
  for (const name of ["parallel_tool_calls", "store"] as const) {
    const value = request[name];
    if (value !== undefined && typeof value !== "boolean") {
      throw translationError("INVALID_REQUEST", `Responses ${name} must be a boolean.`);
    }
  }
  if (
    request.seed !== undefined &&
    (!Number.isSafeInteger(request.seed) || typeof request.seed !== "number")
  ) {
    throw translationError("INVALID_REQUEST", "Responses seed must be an integer.");
  }
  for (const name of ["service_tier", "user"] as const) {
    const value = request[name];
    if (value !== undefined && typeof value !== "string") {
      throw translationError("INVALID_REQUEST", `Responses ${name} must be a string.`);
    }
  }
  for (const name of ["reasoning", "text", "metadata"] as const) {
    const value = request[name];
    if (value !== undefined && !isRecord(value)) {
      throw translationError("INVALID_REQUEST", `Responses ${name} must be an object.`);
    }
  }
  if (isRecord(request.metadata)) {
    for (const [name, value] of Object.entries(request.metadata)) {
      if (typeof value !== "string") {
        throw translationError(
          "INVALID_REQUEST",
          `Responses metadata value '${name}' must be a string.`,
        );
      }
    }
  }
  if (
    request.include !== undefined &&
    (!Array.isArray(request.include) || request.include.some((entry) => typeof entry !== "string"))
  ) {
    throw translationError("INVALID_REQUEST", "Responses include must be a string array.");
  }
  if (
    request.max_tool_calls !== undefined &&
    (!Number.isSafeInteger(request.max_tool_calls) || (request.max_tool_calls as number) < 1)
  ) {
    throw translationError(
      "INVALID_REQUEST",
      "Responses max_tool_calls must be a positive integer.",
    );
  }
  if (request.truncation !== undefined && typeof request.truncation !== "string") {
    throw translationError("INVALID_REQUEST", "Responses truncation must be a string.");
  }
}

function buildCanonicalExtensions(
  request: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const rawUnknown = collectUnknownFields(request, knownRequestFields);
  const responsesExtensions: Record<string, unknown> = {};
  for (const name of ["include", "max_tool_calls", "truncation"] as const) {
    if (request[name] !== undefined) responsesExtensions[name] = request[name];
  }
  return {
    ...(Object.keys(rawUnknown).length === 0
      ? {}
      : { "providerdock.raw_request_fields": rawUnknown }),
    ...(Object.keys(responsesExtensions).length === 0
      ? {}
      : { "openai.responses": responsesExtensions }),
  };
}

function messageItem(
  role: CanonicalRole,
  content: readonly CanonicalContentBlock[],
): CanonicalConversationItem {
  return { type: "message", role, content, extensions: {} };
}

function parseRole(value: unknown, index: number): CanonicalRole {
  if (["system", "developer", "user", "assistant"].includes(String(value))) {
    return value as CanonicalRole;
  }
  throw translationError(
    "INVALID_REQUEST",
    `Responses message item ${index} has unsupported role '${String(value)}'.`,
  );
}

function parseImageDetail(
  value: unknown,
): "auto" | "low" | "high" | "original" | undefined {
  if (value === undefined) return undefined;
  if (["auto", "low", "high", "original"].includes(String(value))) {
    return value as "auto" | "low" | "high" | "original";
  }
  throw translationError("INVALID_REQUEST", `Invalid image detail '${String(value)}'.`);
}

function normalizeArguments(value: unknown, type: string, index: number): string {
  if (typeof value === "string") return value;
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  throw translationError(
    "INVALID_REQUEST",
    `Responses ${type} item ${index} arguments must be a string or JSON value.`,
  );
}

function normalizeToolOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) {
    throw translationError("INVALID_REQUEST", "Responses tool output is required.");
  }
  return JSON.stringify(value);
}

function collectUnknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => !known.has(name)));
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw translationError("INVALID_REQUEST", message);
  return value;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw translationError("INVALID_REQUEST", message);
  return value;
}

function requireNonEmptyString(value: unknown, message: string): string {
  const result = requireString(value, message).trim();
  if (result === "") throw translationError("INVALID_REQUEST", message);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function translationError(
  type: NormalizedErrorType,
  message: string,
): ResponsesToChatTranslationError {
  return new ResponsesToChatTranslationError(type, message);
}
