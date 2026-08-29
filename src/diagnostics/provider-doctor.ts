import {
  normalizeHttpStatus,
  ProviderRequestError,
  type NormalizedErrorType,
} from "../core/errors/provider-error.js";
import type { ProviderAdapterRegistry } from "../core/providers/provider-adapter-registry.js";
import { ProviderHttpRequestBuilder } from "../core/providers/provider-http-request.js";
import type { ProviderProfile } from "../core/providers/provider-profile.js";
import type { SecretStore } from "../core/security/secret-store.js";
import { SseDecoder } from "../bridge/sse/sse-decoder.js";

/**
 * Provider / Model Doctor (spec sections 8, 32).
 *
 * Diagnostics are tiered so that expensive checks only run when explicitly
 * requested: Level 0 metadata, Level 1 minimal inference, Level 2 streaming,
 * Level 3 synthetic tool round-trip. The doctor is never triggered
 * automatically; the health probe service keeps using cheap discovery only.
 */

export type DoctorLevel = 0 | 1 | 2 | 3;

export type DoctorCheckStatus = "PASS" | "DEGRADED" | "FAIL" | "SKIPPED";

export type DoctorProtocol = "openai-responses" | "openai-chat-completions";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly latencyMs?: number;
  readonly details?: string;
  readonly errorType?: NormalizedErrorType;
}

export interface DoctorReport {
  readonly providerId: string;
  readonly modelId?: string;
  readonly protocol?: DoctorProtocol;
  readonly level: DoctorLevel;
  readonly checks: readonly DoctorCheck[];
  readonly verdict: DoctorCheckStatus;
}

export interface RunDoctorOptions {
  readonly modelId?: string;
  readonly level?: DoctorLevel;
}

export interface ProviderDoctorOptions {
  readonly secretStore: SecretStore;
  readonly adapterRegistry: ProviderAdapterRegistry;
  readonly fetchImpl?: typeof fetch;
  readonly monotonicNow?: () => number;
}

const minimalPrompt = "Reply exactly: OK";
const syntheticToolName = "providerdock_echo";

export class ProviderDoctor {
  private readonly requests: ProviderHttpRequestBuilder;
  private readonly registry: ProviderAdapterRegistry;
  private readonly fetchImpl: typeof fetch;
  private readonly monotonicNow: () => number;

  constructor(options: ProviderDoctorOptions) {
    this.requests = new ProviderHttpRequestBuilder(options.secretStore);
    this.registry = options.adapterRegistry;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async run(profile: ProviderProfile, options: RunDoctorOptions = {}): Promise<DoctorReport> {
    const level = options.level ?? 1;
    const prepared = this.registry.prepareProfile(profile);
    const checks: DoctorCheck[] = [];
    let modelId = options.modelId;
    let protocol: DoctorProtocol | undefined;

    // Level 0 — metadata: connectivity, auth, model discovery.
    const discovery = await this.checkDiscovery(prepared);
    checks.push(discovery.check);
    if (modelId === undefined) {
      modelId = prepared.manualModelIds[0] ?? discovery.firstModelId;
    }

    if (level >= 1) {
      if (discovery.check.status === "FAIL" && discovery.check.errorType === "AUTH_ERROR") {
        checks.push(skipped("inference", "Skipped: authentication failed at Level 0."));
      } else if (modelId === undefined) {
        checks.push(
          skipped("inference", "Skipped: no model available. Pass --model explicitly."),
        );
      } else {
        const inference = await this.checkInference(prepared, modelId);
        checks.push(inference.check);
        protocol = inference.protocol;

        if (level >= 2) {
          if (inference.check.status === "FAIL" || protocol === undefined) {
            checks.push(skipped("streaming", "Skipped: minimal inference failed."));
          } else {
            checks.push(await this.checkStreaming(prepared, modelId, protocol));
          }
        }

        if (level >= 3) {
          if (inference.check.status === "FAIL" || protocol === undefined) {
            checks.push(skipped("tools", "Skipped: minimal inference failed."));
          } else {
            checks.push(await this.checkTools(prepared, modelId, protocol));
          }
        }
      }
    }

    return {
      providerId: prepared.id,
      ...(modelId === undefined ? {} : { modelId }),
      ...(protocol === undefined ? {} : { protocol }),
      level,
      checks,
      verdict: verdictOf(checks),
    };
  }

  private async checkDiscovery(
    profile: ProviderProfile,
  ): Promise<{ check: DoctorCheck; firstModelId?: string }> {
    const startedAt = this.monotonicNow();
    try {
      const adapter = this.registry.resolve(profile);
      const models = await adapter.discoverModels(profile);
      const check: DoctorCheck = {
        name: "connectivity+models",
        status: models.length > 0 ? "PASS" : "DEGRADED",
        latencyMs: this.elapsed(startedAt),
        details:
          models.length > 0
            ? `${models.length} model(s) discovered`
            : "Endpoint reachable but the model list is empty.",
      };
      const firstModelId = models[0]?.modelId;
      return firstModelId === undefined ? { check } : { check, firstModelId };
    } catch (error) {
      return { check: this.failedCheck("connectivity+models", startedAt, error) };
    }
  }

  private async checkInference(
    profile: ProviderProfile,
    modelId: string,
  ): Promise<{ check: DoctorCheck; protocol?: DoctorProtocol }> {
    const startedAt = this.monotonicNow();
    const candidates = protocolCandidates(profile);

    let lastError: DoctorCheck | undefined;
    for (const protocol of candidates) {
      try {
        const { payload } = await this.postJson(
          profile,
          protocol,
          inferenceBody(protocol, modelId, false),
        );
        const analysis = analyzeInferencePayload(protocol, payload);
        return {
          check: {
            name: "inference",
            status: analysis.status,
            latencyMs: this.elapsed(startedAt),
            details: analysis.details,
          },
          protocol,
        };
      } catch (error) {
        const normalized = normalizeError(error);
        // Try the next protocol only when the endpoint itself was rejected.
        const retryable =
          candidates.length > 1 &&
          (normalized.type === "MODEL_NOT_FOUND" || normalized.type === "INVALID_REQUEST");
        lastError = this.failedCheck("inference", startedAt, error);
        if (!retryable) return { check: lastError };
      }
    }
    return { check: lastError ?? skipped("inference", "No protocol candidates available.") };
  }

  private async checkStreaming(
    profile: ProviderProfile,
    modelId: string,
    protocol: DoctorProtocol,
  ): Promise<DoctorCheck> {
    const startedAt = this.monotonicNow();
    try {
      const { response } = await this.postJson(
        profile,
        protocol,
        inferenceBody(protocol, modelId, true),
        true,
      );
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        return {
          name: "streaming",
          status: "DEGRADED",
          latencyMs: this.elapsed(startedAt),
          details: `Provider answered a stream request with '${contentType || "no content type"}'.`,
        };
      }
      if (response.body === null) {
        return {
          name: "streaming",
          status: "FAIL",
          latencyMs: this.elapsed(startedAt),
          details: "Provider returned an empty streaming body.",
        };
      }
      const observed = await observeSseStream(response.body, protocol, profile.timeoutMs);
      const status: DoctorCheckStatus = observed.terminalSeen
        ? observed.duplicates > 0
          ? "DEGRADED"
          : "PASS"
        : "FAIL";
      return {
        name: "streaming",
        status,
        latencyMs: this.elapsed(startedAt),
        details: observed.terminalSeen
          ? `${observed.eventCount} event(s); terminal event received` +
            (observed.duplicates > 0 ? `; ${observed.duplicates} duplicate event(s)` : "")
          : "Stream closed without a terminal event.",
      };
    } catch (error) {
      return this.failedCheck("streaming", startedAt, error);
    }
  }

  private async checkTools(
    profile: ProviderProfile,
    modelId: string,
    protocol: DoctorProtocol,
  ): Promise<DoctorCheck> {
    const startedAt = this.monotonicNow();
    try {
      const { payload } = await this.postJson(
        profile,
        protocol,
        toolCallBody(protocol, modelId),
      );
      const call = extractToolCall(protocol, payload);
      if (call === undefined) {
        return {
          name: "tools",
          status: "DEGRADED",
          latencyMs: this.elapsed(startedAt),
          details: "Model did not produce a tool call for a forced synthetic tool.",
        };
      }

      const { payload: continuation } = await this.postJson(
        profile,
        protocol,
        toolContinuationBody(protocol, modelId, call),
      );
      const finalText = extractOutputText(protocol, continuation);
      return {
        name: "tools",
        status: finalText === undefined || finalText.trim() === "" ? "DEGRADED" : "PASS",
        latencyMs: this.elapsed(startedAt),
        details:
          finalText === undefined || finalText.trim() === ""
            ? "Tool call round-trip succeeded but the continuation had no text output."
            : `Tool call '${call.callId}' resolved and the model produced a final answer.`,
      };
    } catch (error) {
      return this.failedCheck("tools", startedAt, error);
    }
  }

  private async postJson(
    profile: ProviderProfile,
    protocol: DoctorProtocol,
    body: Record<string, unknown>,
    streaming = false,
  ): Promise<{ response: Response; payload: unknown }> {
    const endpoint = protocol === "openai-responses" ? "responses" : "chat/completions";
    const built = await this.requests.build(profile, endpoint, {
      accept: streaming ? "text/event-stream, application/json" : "application/json",
      contentType: "application/json",
    });

    let response: Response;
    try {
      response = await this.fetchImpl(built.url, {
        method: "POST",
        headers: built.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(profile.timeoutMs),
      });
    } catch (error) {
      if (isAbortOrTimeoutError(error)) {
        throw new ProviderRequestError("TIMEOUT", "Doctor request timed out.", { cause: error });
      }
      throw new ProviderRequestError("NETWORK_ERROR", "Doctor request failed.", { cause: error });
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderRequestError(
        normalizeHttpStatus(response.status),
        `Provider returned HTTP ${response.status}.`,
        { httpStatus: response.status },
      );
    }
    if (streaming) return { response, payload: undefined };

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch (error) {
      throw new ProviderRequestError("PROTOCOL_ERROR", "Provider returned invalid JSON.", {
        cause: error,
      });
    }
    return { response, payload };
  }

  private failedCheck(name: string, startedAt: number, error: unknown): DoctorCheck {
    const normalized = normalizeError(error);
    return {
      name,
      status: "FAIL",
      latencyMs: this.elapsed(startedAt),
      details: normalized.message,
      errorType: normalized.type,
    };
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, Math.round(this.monotonicNow() - startedAt));
  }
}

interface ExtractedToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
}

function protocolCandidates(profile: ProviderProfile): readonly DoctorProtocol[] {
  if (profile.apiType === "openai-responses") return ["openai-responses"];
  if (profile.apiType === "openai-chat-completions") return ["openai-chat-completions"];
  return ["openai-responses", "openai-chat-completions"];
}

function inferenceBody(
  protocol: DoctorProtocol,
  modelId: string,
  stream: boolean,
): Record<string, unknown> {
  if (protocol === "openai-responses") {
    return {
      model: modelId,
      input: minimalPrompt,
      max_output_tokens: 16,
      stream,
    };
  }
  return {
    model: modelId,
    messages: [{ role: "user", content: minimalPrompt }],
    max_tokens: 16,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

const syntheticToolSchema = {
  type: "object",
  properties: { value: { type: "string", description: "Value to echo back." } },
  required: ["value"],
  additionalProperties: false,
} as const;

function toolCallBody(protocol: DoctorProtocol, modelId: string): Record<string, unknown> {
  const prompt = `Call the ${syntheticToolName} tool with value "ok".`;
  if (protocol === "openai-responses") {
    return {
      model: modelId,
      input: prompt,
      max_output_tokens: 128,
      tools: [
        {
          type: "function",
          name: syntheticToolName,
          description: "Echoes the provided value. Safe diagnostic tool without side effects.",
          parameters: syntheticToolSchema,
        },
      ],
      tool_choice: "required",
      stream: false,
    };
  }
  return {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 128,
    tools: [
      {
        type: "function",
        function: {
          name: syntheticToolName,
          description: "Echoes the provided value. Safe diagnostic tool without side effects.",
          parameters: syntheticToolSchema,
        },
      },
    ],
    tool_choice: "required",
    stream: false,
  };
}

function toolContinuationBody(
  protocol: DoctorProtocol,
  modelId: string,
  call: ExtractedToolCall,
): Record<string, unknown> {
  const prompt = `Call the ${syntheticToolName} tool with value "ok".`;
  if (protocol === "openai-responses") {
    return {
      model: modelId,
      input: [
        { type: "message", role: "user", content: prompt },
        {
          type: "function_call",
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments,
        },
        {
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify({ echoed: "ok" }),
        },
      ],
      max_output_tokens: 128,
      tools: [
        {
          type: "function",
          name: syntheticToolName,
          description: "Echoes the provided value. Safe diagnostic tool without side effects.",
          parameters: syntheticToolSchema,
        },
      ],
      stream: false,
    };
  }
  return {
    model: modelId,
    messages: [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: call.callId,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          },
        ],
      },
      { role: "tool", tool_call_id: call.callId, content: JSON.stringify({ echoed: "ok" }) },
    ],
    max_tokens: 128,
    tools: [
      {
        type: "function",
        function: {
          name: syntheticToolName,
          description: "Echoes the provided value. Safe diagnostic tool without side effects.",
          parameters: syntheticToolSchema,
        },
      },
    ],
    stream: false,
  };
}

function analyzeInferencePayload(
  protocol: DoctorProtocol,
  payload: unknown,
): { status: DoctorCheckStatus; details: string } {
  const text = extractOutputText(protocol, payload);
  if (text === undefined) {
    return { status: "FAIL", details: "Response contained no text output." };
  }
  const usagePresent = isRecord(payload) && isRecord(payload.usage);
  const finishPresent = hasFinishSignal(protocol, payload);
  const degraded: string[] = [];
  if (!usagePresent) degraded.push("usage missing");
  if (!finishPresent) degraded.push("finish signal missing");
  if (degraded.length > 0) {
    return { status: "DEGRADED", details: `Text received but ${degraded.join(", ")}.` };
  }
  return { status: "PASS", details: `Model answered ('${text.trim().slice(0, 40)}').` };
}

function hasFinishSignal(protocol: DoctorProtocol, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (protocol === "openai-responses") return typeof payload.status === "string";
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  return isRecord(choice) && typeof choice.finish_reason === "string";
}

function extractOutputText(protocol: DoctorProtocol, payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  if (protocol === "openai-responses") {
    if (typeof payload.output_text === "string" && payload.output_text !== "") {
      return payload.output_text;
    }
    if (!Array.isArray(payload.output)) return undefined;
    const parts: string[] = [];
    for (const item of payload.output) {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const block of item.content) {
        if (isRecord(block) && block.type === "output_text" && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
    return parts.length > 0 ? parts.join("") : undefined;
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  return typeof choice.message.content === "string" ? choice.message.content : undefined;
}

function extractToolCall(protocol: DoctorProtocol, payload: unknown): ExtractedToolCall | undefined {
  if (!isRecord(payload)) return undefined;
  if (protocol === "openai-responses") {
    if (!Array.isArray(payload.output)) return undefined;
    for (const item of payload.output) {
      if (!isRecord(item) || item.type !== "function_call") continue;
      if (typeof item.call_id !== "string" || typeof item.name !== "string") continue;
      return {
        callId: item.call_id,
        name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : "{}",
      };
    }
    return undefined;
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!isRecord(choice) || !isRecord(choice.message)) return undefined;
  const calls = choice.message.tool_calls;
  if (!Array.isArray(calls)) return undefined;
  for (const rawCall of calls) {
    if (!isRecord(rawCall) || typeof rawCall.id !== "string" || !isRecord(rawCall.function)) {
      continue;
    }
    if (typeof rawCall.function.name !== "string") continue;
    return {
      callId: rawCall.id,
      name: rawCall.function.name,
      arguments:
        typeof rawCall.function.arguments === "string" ? rawCall.function.arguments : "{}",
    };
  }
  return undefined;
}

interface SseObservation {
  readonly eventCount: number;
  readonly duplicates: number;
  readonly terminalSeen: boolean;
}

async function observeSseStream(
  body: ReadableStream<Uint8Array>,
  protocol: DoctorProtocol,
  timeoutMs: number,
): Promise<SseObservation> {
  const decoder = new SseDecoder();
  const reader = body.getReader();
  const seen = new Set<string>();
  let eventCount = 0;
  let duplicates = 0;
  let terminalSeen = false;
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new ProviderRequestError("TIMEOUT", "Stream read timed out.")),
            Math.max(1, deadline - Date.now()),
          );
          timer.unref?.();
        }),
      ]);
      if (chunk.done) break;
      for (const event of decoder.push(chunk.value)) {
        if (event.data === undefined) continue;
        if (event.data === "[DONE]") {
          return { eventCount, duplicates, terminalSeen };
        }
        eventCount += 1;
        if (seen.has(event.data)) duplicates += 1;
        else seen.add(event.data);
        if (isTerminalStreamEvent(protocol, event.data)) terminalSeen = true;
      }
      if (terminalSeen && protocol === "openai-chat-completions") {
        // Chat streams may only close with [DONE]; keep reading briefly, but
        // a finish_reason already proves terminal semantics.
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { eventCount, duplicates, terminalSeen };
}

function isTerminalStreamEvent(protocol: DoctorProtocol, data: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (protocol === "openai-responses") {
    return (
      parsed.type === "response.completed" ||
      parsed.type === "response.failed" ||
      parsed.type === "response.incomplete"
    );
  }
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  return isRecord(choice) && typeof choice.finish_reason === "string";
}

function skipped(name: string, details: string): DoctorCheck {
  return { name, status: "SKIPPED", details };
}

function verdictOf(checks: readonly DoctorCheck[]): DoctorCheckStatus {
  let verdict: DoctorCheckStatus = "PASS";
  for (const check of checks) {
    if (check.status === "FAIL") return "FAIL";
    if (check.status === "DEGRADED") verdict = "DEGRADED";
  }
  return verdict;
}

function normalizeError(error: unknown): ProviderRequestError {
  return error instanceof ProviderRequestError
    ? error
    : new ProviderRequestError("UNKNOWN", "Unexpected doctor failure.", { cause: error });
}

function isAbortOrTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
