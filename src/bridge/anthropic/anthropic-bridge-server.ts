import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import {
  normalizeHttpStatus,
  ProviderRequestError,
  type NormalizedErrorType,
} from "../../core/errors/provider-error.js";
import { ProviderHttpRequestBuilder } from "../../core/providers/provider-http-request.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import {
  TurnLedger,
  TurnLedgerViolationError,
  extractAnthropicDeliveredToolCalls,
  extractAnthropicTurnSignature,
  type TurnToken,
} from "../../core/state-machine/turn-ledger.js";
import { SseDecodeError, SseDecoder, encodeSseEvent } from "../sse/sse-decoder.js";
import { isBridgePortAllowed } from "../responses/responses-bridge-server.js";
import {
  AnthropicTranslationError,
  translateAnthropicRequestToChat,
  isRecord,
} from "../../protocols/anthropic-messages/anthropic-to-chat-request.js";
import { translateChatResponseToAnthropic } from "../../protocols/anthropic-messages/chat-to-anthropic-response.js";
import {
  ChatToAnthropicStreamTranslator,
  type AnthropicStreamEvent,
} from "../../protocols/anthropic-messages/chat-to-anthropic-stream.js";

const loopbackHost = "127.0.0.1";
const defaultBodyLimitBytes = 64 * 1024 * 1024;

export interface AnthropicBridgeServerOptions {
  readonly profile: ProviderProfile;
  readonly secretStore: SecretStore;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly messagesEndpoint?: string;
  readonly chatCompletionsEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestBodyLimitBytes?: number;
  readonly responseBodyLimitBytes?: number;
  readonly streamIdleTimeoutMs?: number;
  /** Optional bearer/x-api-key required from the loopback Claude client. */
  readonly clientToken?: string;
}

export interface AnthropicBridgeAddress {
  readonly host: typeof loopbackHost;
  readonly port: number;
  readonly url: string;
}

type BridgeMode = "native-anthropic" | "openai-chat";

/**
 * Loopback-only Anthropic Messages bridge for Claude Code (spec Phase 3).
 *
 * For providers that natively speak Anthropic Messages the bridge relays
 * requests with authentication injected from the secret store and required
 * Anthropic headers preserved. For OpenAI Chat Completions providers it
 * translates requests and responses (including SSE) through the canonical
 * layer. Every turn passes the anti-replay TurnLedger before upstream contact.
 */
export class AnthropicBridgeServer {
  private readonly profile: ProviderProfile;
  private readonly requests: ProviderHttpRequestBuilder;
  private readonly mode: BridgeMode;
  private readonly messagesEndpoint: string;
  private readonly chatCompletionsEndpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestBodyLimitBytes: number;
  private readonly responseBodyLimitBytes: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly clientToken: string | undefined;
  private readonly turnLedger = new TurnLedger();
  private readonly activeUpstreamRequests = new Set<AbortController>();
  private server: Server | undefined;
  private startTask: Promise<AnthropicBridgeAddress> | undefined;
  private stopTask: Promise<void> | undefined;

  constructor(options: AnthropicBridgeServerOptions) {
    this.profile = options.adapterRegistry?.prepareProfile(options.profile) ?? options.profile;
    this.requests = new ProviderHttpRequestBuilder(options.secretStore);
    this.mode = resolveBridgeMode(this.profile);
    this.messagesEndpoint = options.messagesEndpoint ?? "messages";
    this.chatCompletionsEndpoint = options.chatCompletionsEndpoint ?? "chat/completions";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestBodyLimitBytes = options.requestBodyLimitBytes ?? defaultBodyLimitBytes;
    this.responseBodyLimitBytes = options.responseBodyLimitBytes ?? defaultBodyLimitBytes;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 1_800_000;
    this.clientToken = options.clientToken;
  }

  start(): Promise<AnthropicBridgeAddress> {
    if (this.server?.listening) return Promise.resolve(this.address());
    if (this.startTask !== undefined) return this.startTask;
    if (this.stopTask !== undefined) return this.stopTask.then(() => this.start());
    this.startTask = this.listen().finally(() => {
      this.startTask = undefined;
    });
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask !== undefined) return this.stopTask;
    this.stopTask = this.close().finally(() => {
      this.stopTask = undefined;
    });
    return this.stopTask;
  }

  address(): AnthropicBridgeAddress {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("Anthropic bridge is not running.");
    }
    return bridgeAddress(address);
  }

  private async listen(): Promise<AnthropicBridgeAddress> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        this.handleUnexpectedError(response, error);
      });
    });
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    this.server = server;

    try {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await listenOnRandomPort(server);
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Anthropic bridge did not receive a TCP address.");
        }
        if (isBridgePortAllowed(address.port)) return bridgeAddress(address);
        await closeListeningServer(server);
      }
      throw new Error("Unable to allocate a Fetch-compatible loopback bridge port.");
    } catch (error) {
      this.server = undefined;
      server.closeAllConnections?.();
      throw error;
    }
  }

  private async close(): Promise<void> {
    if (this.startTask !== undefined && !this.server?.listening) {
      await this.startTask.catch(() => undefined);
    }
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    for (const controller of this.activeUpstreamRequests) {
      controller.abort(new Error("ProviderDock Anthropic bridge is stopping."));
    }
    this.activeUpstreamRequests.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", `http://${loopbackHost}`);

    if (requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        provider_id: this.profile.id,
        mode: this.mode,
        active_requests: this.activeUpstreamRequests.size,
      });
      return;
    }
    if (requestUrl.pathname === "/v1/messages") {
      if (request.method !== "POST") {
        sendAnthropicError(response, 405, "INVALID_REQUEST", "HTTP method is not allowed.");
        return;
      }
      if (!hasValidClientToken(request, this.clientToken)) {
        sendAnthropicError(
          response,
          401,
          "AUTH_ERROR",
          "The managed Anthropic bridge rejected the loopback client token.",
        );
        return;
      }
      await this.handleMessages(request, response);
      return;
    }
    sendAnthropicError(response, 404, "INVALID_REQUEST", "Bridge route was not found.");
  }

  private async handleMessages(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeUpstreamRequests.add(controller);
    const onResponseClosed = (): void => {
      if (!response.writableEnded) {
        controller.abort(new Error("Bridge client closed the response connection."));
      }
    };
    response.once("close", onResponseClosed);

    let turnToken: TurnToken | undefined;
    let turnOutcome: "complete" | "fail" | "cancel" | "incomplete" = "fail";
    try {
      const body = await readJsonObject(request, this.requestBodyLimitBytes);
      const admission = this.turnLedger.admit(extractAnthropicTurnSignature(body));
      if (admission.decision === "blocked") {
        const headers = new Headers({ "x-providerdock-turn-block": admission.code });
        sendAnthropicError(response, 409, "INVALID_REQUEST", admission.message, headers);
        turnOutcome = "cancel";
        return;
      }
      turnToken = admission.token;
      const wantsStream = body.stream === true;

      const translation =
        this.mode === "openai-chat" ? translateAnthropicRequestToChat(body) : undefined;
      const upstreamPayload = translation?.chatRequest ?? body;
      const endpoint =
        translation === undefined ? this.messagesEndpoint : this.chatCompletionsEndpoint;
      const built = await this.requests.build(this.profile, endpoint, {
        accept: wantsStream ? "text/event-stream, application/json" : "application/json",
        contentType: "application/json",
      });
      if (translation === undefined) {
        forwardAnthropicHeaders(request, built.headers);
      }

      let headerTimedOut = false;
      const headerTimer = setTimeout(() => {
        headerTimedOut = true;
        controller.abort(new Error("Upstream response headers timed out."));
      }, this.profile.timeoutMs);
      headerTimer.unref?.();

      let upstream: Response;
      try {
        upstream = await this.fetchImpl(built.url, {
          method: "POST",
          headers: built.headers,
          body: JSON.stringify(upstreamPayload),
          signal: controller.signal,
        });
      } catch (error) {
        if (response.destroyed || (controller.signal.aborted && !headerTimedOut)) {
          turnOutcome = "cancel";
          return;
        }
        if (headerTimedOut) {
          throw new BridgeRequestError(504, "TIMEOUT", "Provider response headers timed out.");
        }
        throw new BridgeRequestError(502, "NETWORK_ERROR", "Provider request failed.", {
          cause: error,
        });
      } finally {
        clearTimeout(headerTimer);
      }

      if (!upstream.ok) {
        const errorBody = await readUpstreamText(upstream, 64 * 1024);
        sendAnthropicError(
          response,
          upstream.status,
          normalizeHttpStatus(upstream.status),
          `Provider '${this.profile.displayName}' returned HTTP ${upstream.status}.`,
          undefined,
          this.mode === "native-anthropic" ? errorBody : undefined,
        );
        return;
      }

      const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
      const isEventStream = contentType.includes("text/event-stream");
      if (!wantsStream && isEventStream) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new BridgeRequestError(
          502,
          "PROTOCOL_ERROR",
          "Provider returned SSE for a non-streaming Messages request.",
        );
      }

      if (translation === undefined) {
        turnOutcome = await this.relayNative(response, upstream, wantsStream, isEventStream, turnToken);
      } else {
        turnOutcome = await this.relayTranslated(
          response,
          upstream,
          wantsStream,
          isEventStream,
          translation.model,
          translation.toolNames,
          turnToken,
        );
      }
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        turnOutcome = "incomplete";
        response.destroy();
        return;
      }
      this.handleUnexpectedError(response, error);
    } finally {
      if (turnToken !== undefined) {
        if (turnOutcome === "complete") this.turnLedger.complete(turnToken);
        else if (turnOutcome === "cancel") this.turnLedger.cancel(turnToken);
        else if (turnOutcome === "incomplete") this.turnLedger.incomplete(turnToken);
        else this.turnLedger.fail(turnToken);
      }
      response.off("close", onResponseClosed);
      this.activeUpstreamRequests.delete(controller);
    }
  }

  private async relayNative(
    response: ServerResponse,
    upstream: Response,
    wantsStream: boolean,
    isEventStream: boolean,
    turnToken: TurnToken,
  ): Promise<"complete" | "incomplete"> {
    if (wantsStream && isEventStream) {
      if (upstream.body === null) {
        throw new BridgeRequestError(502, "STREAM_ERROR", "Provider returned an empty stream body.");
      }
      response.writeHead(200, sseHeaders("native-anthropic"));
      response.flushHeaders();
      this.turnLedger.markStreamStarted(turnToken);
      const tracker = new NativeAnthropicStreamTracker();
      let terminalError = false;
      const ok = await this.pipeSse(response, upstream.body, (event) => {
        if (event.data === undefined) return false;
        const observation = tracker.observe(event.data);
        if (observation.completedToolUse !== undefined) {
          this.turnLedger.recordDeliveredToolCalls(
            turnToken,
            extractAnthropicDeliveredToolCalls({
              content: [observation.completedToolUse],
            }),
          );
        }
        if (observation.terminalError) terminalError = true;
        return observation.terminal;
      });
      if (!response.destroyed && !response.writableEnded) response.end();
      return ok && !terminalError ? "complete" : "incomplete";
    }

    const payload = await readUpstreamJson(upstream, this.responseBodyLimitBytes);
    if (!isRecord(payload) || payload.type !== "message") {
      throw new BridgeRequestError(
        502,
        "PROTOCOL_ERROR",
        "Provider returned an invalid Anthropic Messages payload.",
      );
    }
    this.turnLedger.recordDeliveredToolCalls(
      turnToken,
      extractAnthropicDeliveredToolCalls(payload),
    );
    if (wantsStream) {
      response.writeHead(200, sseHeaders("native-anthropic-json"));
      response.flushHeaders();
      for (const event of synthesizeAnthropicStream(payload)) {
        response.write(encodeAnthropicEvent(event));
      }
      response.end();
    } else {
      sendJson(response, 200, payload, safeHeaders(upstream));
    }
    return "complete";
  }

  private async relayTranslated(
    response: ServerResponse,
    upstream: Response,
    wantsStream: boolean,
    isEventStream: boolean,
    model: string,
    allowedToolNames: readonly string[],
    turnToken: TurnToken,
  ): Promise<"complete" | "incomplete"> {
    if (wantsStream && isEventStream) {
      if (upstream.body === null) {
        throw new BridgeRequestError(
          502,
          "STREAM_ERROR",
          "Chat provider returned an empty stream body.",
        );
      }
      response.writeHead(200, sseHeaders("openai-chat"));
      response.flushHeaders();
      this.turnLedger.markStreamStarted(turnToken);
      const translator = new ChatToAnthropicStreamTranslator({ model, allowedToolNames });
      let protocolFailure = false;
      const ok = await this.pipeSse(
        response,
        upstream.body,
        (event) => event.data === "[DONE]",
        (event) => {
          if (event.data === undefined || event.data === "[DONE]") return [];
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch (error) {
            throw new AnthropicTranslationError(
              "PROTOCOL_ERROR",
              "Upstream Chat SSE data was not valid JSON.",
              { cause: error },
            );
          }
          return translator.feed(parsed);
        },
      ).catch((error: unknown) => {
        if (error instanceof AnthropicTranslationError || error instanceof SseDecodeError) {
          protocolFailure = true;
          return false;
        }
        throw error;
      });

      if (!response.destroyed && !response.writableEnded) {
        const terminalEvents = protocolFailure
          ? translator.fail("Upstream sent a malformed Chat stream event.")
          : translator.finish();
        if (translator.terminalSucceeded) {
          try {
            this.turnLedger.recordDeliveredToolCalls(
              turnToken,
              extractAnthropicDeliveredToolCalls({
                content: translator.completedToolUses.map((tool) => ({
                  type: "tool_use",
                  ...tool,
                })),
              }),
            );
          } catch (error) {
            if (error instanceof TurnLedgerViolationError) {
              response.write(
                encodeAnthropicEvent({
                  event: "error",
                  data: {
                    type: "error",
                    error: { type: "api_error", message: error.message },
                  },
                }),
              );
              response.end();
              return "incomplete";
            }
            throw error;
          }
        }
        for (const event of terminalEvents) {
          response.write(encodeAnthropicEvent(event));
        }
        response.end();
      }
      return ok && !protocolFailure && translator.terminalSucceeded
        ? "complete"
        : "incomplete";
    }

    const payload = await readUpstreamJson(upstream, this.responseBodyLimitBytes);
    if (wantsStream) {
      // Chat provider ignored stream=true; synthesize a full Anthropic stream.
      const translated = translateChatResponseToAnthropic(payload, {
        model,
        allowedToolNames,
      });
      this.turnLedger.recordDeliveredToolCalls(
        turnToken,
        extractAnthropicDeliveredToolCalls(translated),
      );
      response.writeHead(200, sseHeaders("openai-chat"));
      response.flushHeaders();
      for (const event of synthesizeAnthropicStream(translated)) {
        response.write(encodeAnthropicEvent(event));
      }
      response.end();
      return "complete";
    }
    const translated = translateChatResponseToAnthropic(payload, {
      model,
      allowedToolNames,
    });
    this.turnLedger.recordDeliveredToolCalls(
      turnToken,
      extractAnthropicDeliveredToolCalls(translated),
    );
    sendJson(response, 200, translated, safeHeaders(upstream));
    return "complete";
  }

  /**
   * Streams upstream SSE to the client. `isTerminal` detects the logical end;
   * `translate` (optional) maps upstream frames to Anthropic frames.
   * Returns true when a terminal frame was seen.
   */
  private async pipeSse(
    response: ServerResponse,
    body: ReadableStream<Uint8Array>,
    isTerminal: (event: { readonly data?: string }) => boolean,
    translate?: (event: { readonly data?: string }) => readonly AnthropicStreamEvent[],
  ): Promise<boolean> {
    const decoder = new SseDecoder();
    const reader = body.getReader();
    let terminalSeen = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (this.streamIdleTimeoutMs <= 0) return;
      idleTimer = setTimeout(() => {
        void reader.cancel().catch(() => undefined);
      }, this.streamIdleTimeoutMs);
      idleTimer.unref?.();
    };
    resetIdle();

    try {
      let finished = false;
      while (!finished) {
        const chunk = await reader.read();
        const events = chunk.done ? decoder.finish() : decoder.push(chunk.value);
        resetIdle();
        for (const event of events) {
          const terminal = isTerminal(event);
          if (translate === undefined) {
            if (event.data !== undefined || event.event !== undefined) {
              response.write(
                encodeSseEvent({
                  ...(event.event === undefined ? {} : { event: event.event }),
                  ...(event.data === undefined ? {} : { data: event.data }),
                  comments: event.comments,
                }),
              );
            }
          } else {
            for (const translated of translate(event)) {
              response.write(encodeAnthropicEvent(translated));
            }
          }
          if (terminal) {
            terminalSeen = true;
            finished = true;
            if (!chunk.done) await reader.cancel().catch(() => undefined);
            break;
          }
        }
        if (chunk.done) break;
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      reader.releaseLock();
    }
    return terminalSeen;
  }

  private handleUnexpectedError(response: ServerResponse, error: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof BridgeRequestError) {
      sendAnthropicError(response, error.status, error.type, error.message);
      return;
    }
    if (error instanceof AnthropicTranslationError) {
      const status = error.type === "INVALID_REQUEST" || error.type === "UNSUPPORTED_FEATURE" ? 400 : 502;
      sendAnthropicError(response, status, error.type, error.message);
      return;
    }
    if (error instanceof TurnLedgerViolationError) {
      sendAnthropicError(
        response,
        409,
        "PROTOCOL_ERROR",
        error.message,
        new Headers({ "x-providerdock-turn-block": error.code }),
      );
      return;
    }
    if (error instanceof ProviderRequestError) {
      const status = error.type === "AUTH_ERROR" ? 401 : error.type === "TIMEOUT" ? 504 : 502;
      sendAnthropicError(response, status, error.type, error.message);
      return;
    }
    sendAnthropicError(response, 500, "UNKNOWN", "ProviderDock Anthropic bridge request failed.");
  }
}

class BridgeRequestError extends Error {
  constructor(
    readonly status: number,
    readonly type: NormalizedErrorType,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "BridgeRequestError";
  }
}

function resolveBridgeMode(profile: ProviderProfile): BridgeMode {
  if (profile.apiType === "anthropic-messages") return "native-anthropic";
  if (["auto", "openai-chat-completions"].includes(profile.apiType)) {
    return "openai-chat";
  }
  throw new ProviderRequestError(
    "UNSUPPORTED_FEATURE",
    `Anthropic bridge cannot serve provider API type '${profile.apiType}'.`,
  );
}

/** Preserves Anthropic-specific headers from the Claude Code client (spec 5.2). */
function forwardAnthropicHeaders(request: IncomingMessage, headers: Headers): void {
  for (const name of ["anthropic-version", "anthropic-beta"]) {
    const value = request.headers[name];
    if (typeof value === "string" && value !== "") headers.set(name, value);
    else if (Array.isArray(value) && value.length > 0) headers.set(name, value.join(","));
  }
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
}

function hasValidClientToken(request: IncomingMessage, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  const authorization = request.headers.authorization;
  const bearer =
    typeof authorization === "string" && /^Bearer\s+/i.test(authorization)
      ? authorization.replace(/^Bearer\s+/i, "")
      : undefined;
  const apiKeyHeader = request.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const received = bearer ?? apiKey;
  if (received === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

interface NativeAnthropicStreamObservation {
  readonly terminal: boolean;
  readonly terminalError: boolean;
  readonly completedToolUse?: Readonly<Record<string, unknown>>;
}

interface NativeToolBlockState {
  readonly id: string;
  readonly name: string;
  readonly initialInput: Readonly<Record<string, unknown>>;
  partialJson: string;
}

/** Validates native Anthropic SSE and assembles tool input before block_stop is relayed. */
class NativeAnthropicStreamTracker {
  private readonly toolBlocks = new Map<number, NativeToolBlockState>();

  observe(data: string): NativeAnthropicStreamObservation {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (error) {
      throw new AnthropicTranslationError(
        "PROTOCOL_ERROR",
        "Native Anthropic SSE data was not valid JSON.",
        { cause: error },
      );
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      throw new AnthropicTranslationError(
        "PROTOCOL_ERROR",
        "Native Anthropic SSE data must be a typed event object.",
      );
    }

    if (parsed.type === "content_block_start") {
      const index = requireStreamIndex(parsed.index);
      const block = isRecord(parsed.content_block) ? parsed.content_block : undefined;
      if (block?.type === "tool_use") {
        if (this.toolBlocks.has(index)) {
          throw new AnthropicTranslationError(
            "PROTOCOL_ERROR",
            `Native Anthropic stream duplicated tool block index ${index}.`,
          );
        }
        if (
          typeof block.id !== "string" ||
          block.id === "" ||
          typeof block.name !== "string" ||
          block.name === "" ||
          !isRecord(block.input)
        ) {
          throw new AnthropicTranslationError(
            "PROTOCOL_ERROR",
            `Native Anthropic tool block ${index} has invalid identity or input.`,
          );
        }
        this.toolBlocks.set(index, {
          id: block.id,
          name: block.name,
          initialInput: block.input,
          partialJson: "",
        });
      }
    } else if (parsed.type === "content_block_delta") {
      const index = requireStreamIndex(parsed.index);
      const state = this.toolBlocks.get(index);
      const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
      if (state !== undefined && delta?.type === "input_json_delta") {
        if (typeof delta.partial_json !== "string") {
          throw new AnthropicTranslationError(
            "PROTOCOL_ERROR",
            `Native Anthropic tool block ${index} has invalid input_json_delta.`,
          );
        }
        state.partialJson += delta.partial_json;
      }
    } else if (parsed.type === "content_block_stop") {
      const index = requireStreamIndex(parsed.index);
      const state = this.toolBlocks.get(index);
      if (state !== undefined) {
        this.toolBlocks.delete(index);
        let input: unknown = state.initialInput;
        if (state.partialJson !== "") {
          try {
            input = JSON.parse(state.partialJson);
          } catch (error) {
            throw new AnthropicTranslationError(
              "PROTOCOL_ERROR",
              `Native Anthropic tool block ${index} ended with malformed JSON input.`,
              { cause: error },
            );
          }
        }
        if (!isRecord(input)) {
          throw new AnthropicTranslationError(
            "PROTOCOL_ERROR",
            `Native Anthropic tool block ${index} input must be a JSON object.`,
          );
        }
        return {
          terminal: false,
          terminalError: false,
          completedToolUse: {
            type: "tool_use",
            id: state.id,
            name: state.name,
            input,
          },
        };
      }
    } else if (parsed.type === "message_stop") {
      if (this.toolBlocks.size > 0) {
        throw new AnthropicTranslationError(
          "PROTOCOL_ERROR",
          "Native Anthropic stream stopped with an unfinished tool block.",
        );
      }
      return { terminal: true, terminalError: false };
    } else if (parsed.type === "error") {
      return { terminal: true, terminalError: true };
    }
    return { terminal: false, terminalError: false };
  }
}

function requireStreamIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AnthropicTranslationError(
      "PROTOCOL_ERROR",
      "Native Anthropic content event requires a non-negative index.",
    );
  }
  return value as number;
}

export function synthesizeAnthropicStream(
  message: Readonly<Record<string, unknown>>,
): readonly AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null, stop_sequence: null },
      },
    },
  ];
  const content = Array.isArray(message.content) ? message.content : [];
  for (const [index, rawBlock] of content.entries()) {
    if (!isRecord(rawBlock)) continue;
    if (rawBlock.type === "text") {
      events.push(
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: String(rawBlock.text ?? "") },
          },
        },
      );
    } else if (rawBlock.type === "tool_use") {
      events.push(
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index,
            content_block: { ...rawBlock, input: {} },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(rawBlock.input ?? {}),
            },
          },
        },
      );
    } else {
      events.push({
        event: "content_block_start",
        data: { type: "content_block_start", index, content_block: rawBlock },
      });
    }
    events.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    });
  }
  events.push(
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: message.stop_reason ?? "end_turn",
          stop_sequence: message.stop_sequence ?? null,
        },
        usage: isRecord(message.usage) ? message.usage : { input_tokens: 0, output_tokens: 0 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  );
  return events;
}

function encodeAnthropicEvent(event: AnthropicStreamEvent): string {
  return encodeSseEvent({
    event: event.event,
    data: JSON.stringify(event.data),
    comments: [],
  });
}

function sseHeaders(mode: string): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-providerdock-bridge": `anthropic-${mode}`,
  };
}

function safeHeaders(upstream: Response): Headers {
  const headers = new Headers({ "cache-control": "no-store" });
  for (const [name, value] of upstream.headers) {
    if (/^(x-)?rate-?limit/i.test(name) || /^(retry-after|request-id|x-request-id)$/i.test(name)) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function readJsonObject(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limitBytes) {
      request.resume();
      throw new BridgeRequestError(413, "INVALID_REQUEST", "Request body exceeds the limit.");
    }
    chunks.push(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new BridgeRequestError(400, "INVALID_REQUEST", "Request body is not valid JSON.", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new BridgeRequestError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }
  return parsed;
}

async function readUpstreamJson(response: Response, limitBytes: number): Promise<unknown> {
  const text = await readUpstreamText(response, limitBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BridgeRequestError(502, "PROTOCOL_ERROR", "Provider returned invalid JSON.", {
      cause: error,
    });
  }
}

async function readUpstreamText(response: Response, limitBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limitBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Headers = new Headers(),
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("content-length", String(encoded.length));
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  response.writeHead(status, Object.fromEntries(headers.entries()));
  response.end(encoded);
}

function sendAnthropicError(
  response: ServerResponse,
  status: number,
  type: NormalizedErrorType,
  message: string,
  headers: Headers = new Headers(),
  upstreamBody?: string,
): void {
  let errorPayload: Record<string, unknown> = {
    type: anthropicErrorType(status),
    message,
  };
  // For native relays, prefer the provider's own Anthropic error shape.
  if (upstreamBody !== undefined) {
    try {
      const parsed = JSON.parse(upstreamBody) as unknown;
      if (
        isRecord(parsed) &&
        isRecord(parsed.error) &&
        typeof parsed.error.type === "string" &&
        typeof parsed.error.message === "string"
      ) {
        errorPayload = parsed.error as Record<string, unknown>;
      }
    } catch {
      // keep the normalized payload
    }
  }
  sendJson(
    response,
    status,
    {
      type: "error",
      error: errorPayload,
      providerdock: { normalized_type: type, http_status: status },
    },
    headers,
  );
}

function anthropicErrorType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  return "api_error";
}

function bridgeAddress(address: AddressInfo): AnthropicBridgeAddress {
  return {
    host: loopbackHost,
    port: address.port,
    url: `http://${loopbackHost}:${address.port}`,
  };
}

function listenOnRandomPort(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: loopbackHost, port: 0, exclusive: true });
  });
}

function closeListeningServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}
