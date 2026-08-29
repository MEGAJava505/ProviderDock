import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  normalizeHttpStatus,
  ProviderRequestError,
  type NormalizedErrorType,
} from "../../core/errors/provider-error.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import { ProviderHttpRequestBuilder } from "../../core/providers/provider-http-request.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import { encodeSseEvent } from "../sse/sse-decoder.js";
import {
  createCodexModelCatalog,
  type BridgeModelDefinition,
} from "./codex-model-catalog.js";
import { relayResponsesStream } from "./responses-stream-relay.js";
import { isJsonRecord } from "./responses-stream-state.js";
import {
  ResponsesToChatTranslationError,
  translateResponsesRequestToChat,
} from "../../protocols/openai-chat/responses-to-chat-request.js";
import {
  ChatToResponsesTranslationError,
  translateChatResponseToResponses,
} from "../../protocols/openai-chat/chat-to-responses-response.js";
import { ChatToResponsesStreamTranslator } from "../../protocols/openai-chat/chat-to-responses-stream.js";
import type { CanonicalRequest } from "../../protocols/canonical/canonical-protocol.js";
import {
  relayChatCompletionsStream,
  writeTranslatedEvents,
} from "./chat-completions-stream-relay.js";
import {
  TurnLedger,
  extractResponsesTurnSignature,
  type TurnToken,
} from "../../core/state-machine/turn-ledger.js";

const loopbackHost = "127.0.0.1";
const defaultBodyLimitBytes = 64 * 1024 * 1024;
const fetchForbiddenPorts = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

export interface ResponsesBridgeServerOptions {
  readonly profile: ProviderProfile;
  readonly secretStore: SecretStore;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly models?: readonly BridgeModelDefinition[];
  readonly responsesEndpoint?: string;
  readonly chatCompletionsEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestBodyLimitBytes?: number;
  readonly responseBodyLimitBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly maxSseEventCharacters?: number;
}

export interface ResponsesBridgeAddress {
  readonly host: typeof loopbackHost;
  readonly port: number;
  readonly url: string;
  readonly baseUrl: string;
}

export class ResponsesBridgeServer {
  private readonly profile: ProviderProfile;
  private readonly requests: ProviderHttpRequestBuilder;
  private readonly models: readonly BridgeModelDefinition[];
  private readonly responsesEndpoint: string;
  private readonly chatCompletionsEndpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestBodyLimitBytes: number;
  private readonly responseBodyLimitBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly maxSseEventCharacters: number;
  private readonly activeUpstreamRequests = new Set<AbortController>();
  private readonly turnLedger = new TurnLedger();
  private server: Server | undefined;
  private startTask: Promise<ResponsesBridgeAddress> | undefined;
  private stopTask: Promise<void> | undefined;
  private startedAt: number | undefined;

  constructor(options: ResponsesBridgeServerOptions) {
    this.profile = options.adapterRegistry?.prepareProfile(options.profile) ?? options.profile;
    this.requests = new ProviderHttpRequestBuilder(options.secretStore);
    this.models = normalizeModels(
      options.models ?? this.profile.manualModelIds.map((modelId) => ({ modelId })),
    );
    this.responsesEndpoint = options.responsesEndpoint ?? "responses";
    this.chatCompletionsEndpoint = options.chatCompletionsEndpoint ?? "chat/completions";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestBodyLimitBytes = positiveLimit(
      options.requestBodyLimitBytes,
      defaultBodyLimitBytes,
      "requestBodyLimitBytes",
    );
    this.responseBodyLimitBytes = positiveLimit(
      options.responseBodyLimitBytes,
      defaultBodyLimitBytes,
      "responseBodyLimitBytes",
    );
    this.heartbeatIntervalMs = nonNegativeLimit(
      options.heartbeatIntervalMs,
      15_000,
      "heartbeatIntervalMs",
    );
    this.streamIdleTimeoutMs = nonNegativeLimit(
      options.streamIdleTimeoutMs,
      1_800_000,
      "streamIdleTimeoutMs",
    );
    this.maxSseEventCharacters = positiveLimit(
      options.maxSseEventCharacters,
      16 * 1024 * 1024,
      "maxSseEventCharacters",
    );
  }

  start(): Promise<ResponsesBridgeAddress> {
    if (this.server?.listening) return Promise.resolve(this.address());
    if (this.startTask !== undefined) return this.startTask;
    if (this.stopTask !== undefined) {
      return this.stopTask.then(() => this.start());
    }

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

  address(): ResponsesBridgeAddress {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("Responses bridge is not running.");
    }
    return bridgeAddress(address);
  }

  private async listen(): Promise<ResponsesBridgeAddress> {
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
          throw new Error("Responses bridge did not receive a TCP address.");
        }
        if (isBridgePortAllowed(address.port)) {
          this.startedAt = Date.now();
          return bridgeAddress(address);
        }
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
    this.startedAt = undefined;
    if (server === undefined) return;

    for (const controller of this.activeUpstreamRequests) {
      controller.abort(new Error("ProviderDock Responses bridge is stopping."));
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
      if (request.method !== "GET") {
        this.methodNotAllowed(response, "GET");
        return;
      }
      sendJson(response, 200, {
        status: "ok",
        provider_id: this.profile.id,
        uptime_ms: this.startedAt === undefined ? 0 : Date.now() - this.startedAt,
        active_requests: this.activeUpstreamRequests.size,
      });
      return;
    }

    if (requestUrl.pathname === "/v1/models") {
      if (request.method !== "GET") {
        this.methodNotAllowed(response, "GET");
        return;
      }
      sendJson(response, 200, {
        object: "list",
        data: this.models.map((model) => ({
          id: model.modelId,
          object: "model",
          created: 0,
          owned_by: this.profile.id,
        })),
        models: createCodexModelCatalog(this.models),
      });
      return;
    }

    if (requestUrl.pathname === "/v1/responses") {
      if (request.method !== "POST") {
        this.methodNotAllowed(response, "POST");
        return;
      }
      await this.handleResponses(request, response);
      return;
    }

    sendBridgeError(response, 404, "INVALID_REQUEST", "Bridge route was not found.");
  }

  private async handleResponses(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeUpstreamRequests.add(controller);
    const onRequestAborted = (): void => {
      controller.abort(new Error("Bridge client aborted the request."));
    };
    const onResponseClosed = (): void => {
      if (!response.writableEnded) {
        controller.abort(new Error("Bridge client closed the response connection."));
      }
    };
    request.once("aborted", onRequestAborted);
    response.once("close", onResponseClosed);

    let turnToken: TurnToken | undefined;
    let turnOutcome: "complete" | "fail" | "cancel" | "incomplete" = "fail";
    try {
      const body = await readJsonObject(request, this.requestBodyLimitBytes);
      const admission = this.turnLedger.admit(extractResponsesTurnSignature(body));
      if (admission.decision === "blocked") {
        const headers = new Headers({ "x-providerdock-turn-block": admission.code });
        sendBridgeError(response, 409, "INVALID_REQUEST", admission.message, headers);
        return;
      }
      turnToken = admission.token;
      const wantsStream = body.stream === true;
      if (
        !["auto", "openai-responses", "openai-chat-completions"].includes(
          this.profile.apiType,
        )
      ) {
        throw new BridgeRequestError(
          400,
          "UNSUPPORTED_FEATURE",
          `Bridge cannot translate provider API type '${this.profile.apiType}' yet.`,
        );
      }
      const chatTranslation =
        this.profile.apiType === "openai-chat-completions"
          ? translateResponsesRequestToChat(body)
          : undefined;
      const upstreamPayload = chatTranslation?.chatRequest ?? body;
      const endpoint =
        chatTranslation === undefined ? this.responsesEndpoint : this.chatCompletionsEndpoint;
      const built = await this.requests.build(this.profile, endpoint, {
        accept: wantsStream ? "text/event-stream, application/json" : "application/json",
        contentType: "application/json",
      });

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
        await upstream.body?.cancel().catch(() => undefined);
        const normalizedType = normalizeHttpStatus(upstream.status);
        sendBridgeError(
          response,
          upstream.status,
          normalizedType,
          `Provider '${this.profile.displayName}' returned HTTP ${upstream.status}.`,
          safeUpstreamHeaders(upstream, false),
        );
        return;
      }

      const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
      const isEventStream = contentType.includes("text/event-stream");
      if (chatTranslation !== undefined) {
        turnOutcome = await this.handleChatUpstream(
          response,
          upstream,
          wantsStream,
          isEventStream,
          chatTranslation.canonical,
          controller,
          turnToken,
        );
        return;
      }
      if (wantsStream && isEventStream) {
        if (upstream.body === null) {
          throw new BridgeRequestError(
            502,
            "STREAM_ERROR",
            "Provider returned an empty streaming response body.",
          );
        }
        response.writeHead(200, headersToNode(safeUpstreamHeaders(upstream, true)));
        response.flushHeaders();
        this.turnLedger.markStreamStarted(turnToken);
        const relay = await relayResponsesStream({
          response,
          body: upstream.body,
          abortUpstream: (reason) => controller.abort(reason),
          heartbeatIntervalMs: this.heartbeatIntervalMs,
          idleTimeoutMs: this.streamIdleTimeoutMs,
          maxEventCharacters: this.maxSseEventCharacters,
        });
        if (!response.destroyed && !response.writableEnded) response.end();
        turnOutcome = relay.protocolFailure ? "incomplete" : "complete";
        return;
      }

      if (!wantsStream && isEventStream) {
        await upstream.body?.cancel().catch(() => undefined);
        throw new BridgeRequestError(
          502,
          "PROTOCOL_ERROR",
          "Provider returned SSE for a non-streaming Responses request.",
        );
      }

      const payload = await readUpstreamJson(upstream, this.responseBodyLimitBytes);
      if (!isJsonRecord(payload) || !Array.isArray(payload.output)) {
        throw new BridgeRequestError(
          502,
          "PROTOCOL_ERROR",
          "Provider returned an invalid non-streaming Responses payload.",
        );
      }
      if (wantsStream) {
        this.sendJsonAsEventStream(response, upstream, payload);
      } else {
        sendJson(response, 200, payload, safeUpstreamHeaders(upstream, false));
      }
      turnOutcome = "complete";
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
      request.off("aborted", onRequestAborted);
      response.off("close", onResponseClosed);
      this.activeUpstreamRequests.delete(controller);
    }
  }

  private sendJsonAsEventStream(
    response: ServerResponse,
    upstream: Response,
    payload: unknown,
  ): void {
    if (!isJsonRecord(payload) || !Array.isArray(payload.output)) {
      throw new BridgeRequestError(
        502,
        "PROTOCOL_ERROR",
        "Provider returned an invalid non-streaming Responses payload.",
      );
    }
    const status = payload.status;
    const type =
      status === "failed"
        ? "response.failed"
        : status === "incomplete"
          ? "response.incomplete"
          : "response.completed";
    const normalizedResponse = {
      ...payload,
      object: "response",
      status: type === "response.completed" ? "completed" : status,
    };
    const headers = safeUpstreamHeaders(upstream, true);
    headers.set("x-providerdock-normalization", "json-to-sse");
    response.writeHead(200, headersToNode(headers));
    response.write(
      encodeSseEvent({
        event: type,
        data: JSON.stringify({ type, sequence_number: 0, response: normalizedResponse }),
        comments: [],
      }),
    );
    response.end(encodeSseEvent({ data: "[DONE]", comments: [] }));
  }

  private async handleChatUpstream(
    response: ServerResponse,
    upstream: Response,
    wantsStream: boolean,
    isEventStream: boolean,
    canonicalRequest: CanonicalRequest,
    controller: AbortController,
    turnToken: TurnToken,
  ): Promise<"complete" | "incomplete"> {
    if (wantsStream && isEventStream) {
      if (upstream.body === null) {
        throw new BridgeRequestError(
          502,
          "STREAM_ERROR",
          "Chat provider returned an empty streaming response body.",
        );
      }
      response.writeHead(
        200,
        headersToNode(safeUpstreamHeaders(upstream, true, "chat-completions")),
      );
      response.flushHeaders();
      this.turnLedger.markStreamStarted(turnToken);
      const relay = await relayChatCompletionsStream({
        response,
        body: upstream.body,
        request: canonicalRequest,
        abortUpstream: (reason) => controller.abort(reason),
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        idleTimeoutMs: this.streamIdleTimeoutMs,
        maxEventCharacters: this.maxSseEventCharacters,
      });
      if (!response.destroyed && !response.writableEnded) response.end();
      return relay.protocolFailure ? "incomplete" : "complete";
    }
    if (!wantsStream && isEventStream) {
      await upstream.body?.cancel().catch(() => undefined);
      throw new BridgeRequestError(
        502,
        "PROTOCOL_ERROR",
        "Chat provider returned SSE for a non-streaming request.",
      );
    }

    const payload = await readUpstreamJson(upstream, this.responseBodyLimitBytes);
    if (wantsStream) {
      const translator = new ChatToResponsesStreamTranslator({ request: canonicalRequest });
      const events = [...translator.feed(payload), ...translator.finish()];
      const headers = safeUpstreamHeaders(upstream, true, "chat-completions");
      headers.set("x-providerdock-normalization", "chat-json-to-responses-sse");
      response.writeHead(200, headersToNode(headers));
      response.flushHeaders();
      await writeTranslatedEvents(response, events);
      response.end(encodeSseEvent({ data: "[DONE]", comments: [] }));
      return "complete";
    }

    const translated = translateChatResponseToResponses(payload, { request: canonicalRequest });
    sendJson(
      response,
      200,
      translated.response,
      safeUpstreamHeaders(upstream, false, "chat-completions"),
    );
    return "complete";
  }

  private methodNotAllowed(response: ServerResponse, allow: string): void {
    const headers = new Headers({ Allow: allow });
    sendBridgeError(response, 405, "INVALID_REQUEST", "HTTP method is not allowed.", headers);
  }

  private handleUnexpectedError(response: ServerResponse, error: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof BridgeRequestError) {
      sendBridgeError(response, error.status, error.type, error.message);
      return;
    }
    if (error instanceof ResponsesToChatTranslationError) {
      sendBridgeError(response, 400, error.type, error.message);
      return;
    }
    if (error instanceof ChatToResponsesTranslationError) {
      sendBridgeError(response, 502, error.type, error.message);
      return;
    }
    if (error instanceof ProviderRequestError) {
      sendBridgeError(
        response,
        providerErrorStatus(error.type),
        error.type,
        error.message,
      );
      return;
    }
    sendBridgeError(response, 500, "UNKNOWN", "ProviderDock bridge request failed.");
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

async function readJsonObject(
  request: IncomingMessage,
  limitBytes: number,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    request.resume();
    throw new BridgeRequestError(
      413,
      "INVALID_REQUEST",
      `Request body exceeds the configured ${limitBytes}-byte limit.`,
    );
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > limitBytes) {
      request.resume();
      throw new BridgeRequestError(
        413,
        "INVALID_REQUEST",
        `Request body exceeds the configured ${limitBytes}-byte limit.`,
      );
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
  if (!isJsonRecord(parsed)) {
    throw new BridgeRequestError(
      400,
      "INVALID_REQUEST",
      "Responses request body must be a JSON object.",
    );
  }
  return parsed;
}

async function readUpstreamJson(response: Response, limitBytes: number): Promise<unknown> {
  if (response.body === null) {
    throw new BridgeRequestError(502, "PROTOCOL_ERROR", "Provider returned an empty JSON body.");
  }
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
        throw new BridgeRequestError(
          502,
          "PROTOCOL_ERROR",
          `Provider JSON response exceeds the configured ${limitBytes}-byte limit.`,
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new BridgeRequestError(
      502,
      "PROTOCOL_ERROR",
      "Provider returned invalid JSON.",
      { cause: error },
    );
  }
}

function safeUpstreamHeaders(
  upstream: Response,
  streaming: boolean,
  bridgeMode = "native-responses",
): Headers {
  const headers = new Headers({
    "cache-control": streaming ? "no-cache, no-transform" : "no-store",
    "x-providerdock-bridge": bridgeMode,
  });
  if (streaming) {
    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.set("connection", "keep-alive");
    headers.set("x-accel-buffering", "no");
  }

  for (const [name, value] of upstream.headers) {
    if (
      /^(x-)?rate-?limit/i.test(name) ||
      /^(retry-after|request-id|x-request-id|openai-processing-ms)$/i.test(name)
    ) {
      headers.set(name, value);
    }
  }
  return headers;
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
  response.writeHead(status, headersToNode(headers));
  response.end(encoded);
}

function sendBridgeError(
  response: ServerResponse,
  status: number,
  type: NormalizedErrorType,
  message: string,
  headers: Headers = new Headers(),
): void {
  sendJson(
    response,
    status,
    {
      error: {
        type: "providerdock_error",
        code: type,
        message,
      },
      providerdock: {
        normalized_type: type,
        http_status: status,
      },
    },
    headers,
  );
}

function headersToNode(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function normalizeModels(models: readonly BridgeModelDefinition[]): readonly BridgeModelDefinition[] {
  const unique = new Map<string, BridgeModelDefinition>();
  for (const model of models) {
    const modelId = model.modelId.trim();
    if (modelId === "") throw new TypeError("Bridge model IDs cannot be empty.");
    unique.set(modelId, { ...model, modelId });
  }
  return [...unique.values()];
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function nonNegativeLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

function providerErrorStatus(type: NormalizedErrorType): number {
  if (type === "AUTH_ERROR") return 401;
  if (type === "PERMISSION_ERROR") return 403;
  if (type === "TIMEOUT") return 504;
  return 502;
}

function bridgeAddress(address: AddressInfo): ResponsesBridgeAddress {
  const url = `http://${loopbackHost}:${address.port}`;
  return {
    host: loopbackHost,
    port: address.port,
    url,
    baseUrl: `${url}/v1`,
  };
}

export function isBridgePortAllowed(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535 && !fetchForbiddenPorts.has(port);
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
