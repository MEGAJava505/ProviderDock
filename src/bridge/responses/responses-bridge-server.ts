import type { ModelProtocolResolver } from "../../core/providers/model-protocol.js";
import { assertModelEnabled, ModelDisabledError, type ModelAccessCheck } from "../../core/providers/model-access.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import {
  normalizeHttpStatus,
  providerErrorGuidance,
  ProviderRequestError,
  type NormalizedErrorType,
} from "../../core/errors/provider-error.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import { ProviderHttpRequestBuilder } from "../../core/providers/provider-http-request.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import { readSanitizedProviderErrorBody } from "../../core/security/provider-error-redaction.js";
import {
  FallbackSessionRouter,
  type FallbackFailure,
  type FallbackFailurePhase,
  type FallbackNotification,
} from "../../core/fallback/fallback-session-router.js";
import {
  fallbackFailurePhaseForHttpStatus,
  isConnectionEstablishmentFailure,
} from "../../core/fallback/fallback-failure-policy.js";
import {
  logicalRouteKey,
  type LogicalModelRoute,
} from "../../core/fallback/logical-model.js";
import type { ProviderFallbackConfiguration } from "../../core/fallback/provider-fallback-configuration.js";
import { encodeSseEvent } from "../sse/sse-decoder.js";
import {
  createCodexModelCatalog,
  type BridgeModelDefinition,
} from "./codex-model-catalog.js";
import { relayResponsesStream } from "./responses-stream-relay.js";
import { normalizeResponsesResponse } from "../../protocols/openai-responses/response-normalization.js";
import {
  ResponsesStreamProtocolError,
  isJsonRecord,
} from "./responses-stream-state.js";
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
  TurnLedgerViolationError,
  extractResponsesDeliveredToolCalls,
  extractResponsesTurnSignature,
  type TurnSignature,
  type TurnToken,
} from "../../core/state-machine/turn-ledger.js";
import {
  PersistentTurnLedger,
  TurnLedgerPersistenceError,
  type TurnLedgerStore,
} from "../../core/state-machine/persistent-turn-ledger.js";
import {
  TokenUsageAccumulator,
  createUsageTelemetryEvent,
  extractOpenAiTokenUsage,
  type NormalizedTokenUsage,
  type UsageEventSink,
  type UsageOutcome,
  type UsageProtocol,
} from "../../core/usage/usage-event.js";
import {
  createProviderRuntimeHealthSignal,
  type ProviderRuntimeHealthSignalSink,
  type ProviderRuntimeOutcome,
} from "../../core/health/provider-runtime-health.js";

const loopbackHost = "127.0.0.1";
const defaultBodyLimitBytes = 64 * 1024 * 1024;
import { isLoopbackPortAllowed } from "../../core/http/loopback-port.js";

export interface ResponsesBridgeServerOptions {
  readonly profile: ProviderProfile;
  readonly secretStore: SecretStore;
  readonly modelAccessCheck?: ModelAccessCheck;
  readonly protocolResolver?: ModelProtocolResolver;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly fallback?: ResponsesBridgeFallbackConfiguration;
  readonly onFallback?: (notification: FallbackNotification) => void;
  /** Session-scoped prompt-profile instructions prepended to every turn. */
  readonly sessionInstructions?: string;
  readonly models?: readonly BridgeModelDefinition[];
  readonly responsesEndpoint?: string;
  readonly chatCompletionsEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestBodyLimitBytes?: number;
  readonly responseBodyLimitBytes?: number;
  readonly heartbeatIntervalMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly maxSseEventCharacters?: number;
  readonly turnLedgerStore?: TurnLedgerStore;
  readonly sessionId?: string;
  readonly usageSink?: UsageEventSink;
  readonly healthSignalSink?: ProviderRuntimeHealthSignalSink;
}

export type ResponsesBridgeFallbackConfiguration = ProviderFallbackConfiguration;

export interface ResponsesBridgeAddress {
  readonly host: typeof loopbackHost;
  readonly port: number;
  readonly url: string;
  readonly baseUrl: string;
}

interface ResolvedBridgeRoute {
  readonly route: LogicalModelRoute;
  readonly profile: ProviderProfile;
}

interface OpenedUpstream {
  readonly upstream: Response;
  readonly redactionValues: readonly string[];
  readonly canonicalRequest?: CanonicalRequest;
}

interface RouteSelectionMetadata {
  readonly route: ResolvedBridgeRoute;
  readonly notification?: FallbackNotification;
}

interface SelectedUpstream extends OpenedUpstream, RouteSelectionMetadata {
  readonly fallbackBlock?: {
    readonly code: string;
    readonly message: string;
  };
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
  private readonly turnLedger: PersistentTurnLedger;
  private readonly fallbackSession: FallbackSessionRouter | undefined;
  private readonly fallbackRoutes = new Map<string, ResolvedBridgeRoute>();
  private readonly autoChatRoutes = new Set<string>();
  private readonly onFallback: ((notification: FallbackNotification) => void) | undefined;
  private readonly sessionInstructions: string | undefined;
  private readonly sessionId: string;
  private readonly usageSink: UsageEventSink | undefined;
  private readonly healthSignalSink: ProviderRuntimeHealthSignalSink | undefined;
  private readonly pendingHealthSignals = new Set<Promise<void>>();
  private lastFallback: FallbackNotification | undefined;
  private server: Server | undefined;
  private startTask: Promise<ResponsesBridgeAddress> | undefined;
  private stopTask: Promise<void> | undefined;
  private startedAt: number | undefined;

  private readonly modelAccessCheck: ModelAccessCheck | undefined;
  private readonly protocolResolver: ModelProtocolResolver | undefined;
  private readonly resolvedProtocols = new Map<string, UsageProtocol>();

  constructor(options: ResponsesBridgeServerOptions) {
    const prepareProfile = (profile: ProviderProfile): ProviderProfile =>
      options.adapterRegistry?.prepareProfile(profile) ?? profile;
    const preparedPrimary = prepareProfile(options.profile);
    if (options.fallback === undefined) {
    this.modelAccessCheck = options.modelAccessCheck;
    this.protocolResolver = options.protocolResolver;
    this.profile = preparedPrimary;
      this.fallbackSession = undefined;
    } else {
      this.fallbackSession = new FallbackSessionRouter(options.fallback.logicalModel);
      const profiles = new Map<string, ProviderProfile>();
      for (const rawProfile of options.fallback.profiles) {
        const profile = prepareProfile(rawProfile);
        if (profiles.has(profile.id)) {
          throw new TypeError(`Duplicate fallback provider profile '${profile.id}'.`);
        }
        profiles.set(profile.id, profile);
      }
      for (const route of this.fallbackSession.routes) {
        const profile = profiles.get(route.providerId);
        if (profile === undefined) {
          throw new TypeError(
            `Logical model '${this.fallbackSession.group.id}' has no profile for provider '${route.providerId}'.`,
          );
        }
        if (!profile.enabled) {
          throw new TypeError(
            `Logical model '${this.fallbackSession.group.id}' route '${logicalRouteKey(route)}' uses a disabled provider.`,
          );
        }
        this.fallbackRoutes.set(logicalRouteKey(route), { route, profile });
      }
      const preferred = this.fallbackSession.routes[0];
      if (preferred === undefined) {
        throw new TypeError("A fallback bridge requires at least one enabled route.");
      }
      const preferredProfile = this.requireFallbackRoute(preferred).profile;
      if (preparedPrimary.id !== preferredProfile.id) {
        throw new TypeError(
          `Fallback bridge primary profile '${preparedPrimary.id}' does not match preferred route provider '${preferredProfile.id}'.`,
        );
      }
      this.profile = preferredProfile;
    }
    this.onFallback = options.onFallback;
    this.sessionInstructions = normalizeSessionInstructions(options.sessionInstructions);
    this.sessionId = options.sessionId ?? `bridge-${randomUUID()}`;
    this.usageSink = options.usageSink;
    this.healthSignalSink = options.healthSignalSink;
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
    this.turnLedger = new PersistentTurnLedger({
      ...(options.turnLedgerStore === undefined ? {} : { store: options.turnLedgerStore }),
    });
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
    await this.turnLedger.initialize();
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
    if (server === undefined) {
      await this.flushHealthSignals();
      return;
    }

    for (const controller of this.activeUpstreamRequests) {
      controller.abort(new Error("ProviderDock Responses bridge is stopping."));
    }
    this.activeUpstreamRequests.clear();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections?.();
    });
    await this.flushHealthSignals();
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
      const activeProfile = this.activeRouteProfile();
      sendJson(response, 200, {
        status: "ok",
        // Keep the bridge identity stable for crash recovery even when the
        // session's sticky logical-model route changes underneath it.
        provider_id: this.profile.id,
        ...(this.fallbackSession === undefined
          ? {}
          : {
              logical_model_id: this.fallbackSession.group.id,
              active_provider_id: activeProfile.id,
              fallback: this.fallbackSession.snapshot(),
              ...(this.lastFallback === undefined
                ? {}
                : { last_fallback: this.lastFallback }),
            }),
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
          owned_by: this.fallbackSession?.group.id ?? this.profile.id,
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
    const usageRequestId = randomUUID();
    try {
      const body = this.applySessionInstructions(
        await readJsonObject(request, this.requestBodyLimitBytes),
      );
      const turnSignature = extractResponsesTurnSignature(body);
      const admission = await this.turnLedger.admit(turnSignature);
      if (admission.decision === "blocked") {
        const headers = new Headers({ "x-providerdock-turn-block": admission.code });
        sendBridgeError(response, 409, "INVALID_REQUEST", admission.message, headers);
        return;
      }
      turnToken = admission.token;
      const wantsStream = body.stream === true;
      let selectedForHealth: SelectedUpstream | undefined;
      try {
        const selected = await this.openUpstream(
          body,
          wantsStream,
          controller,
          turnSignature,
          usageRequestId,
        );
        selectedForHealth = selected;
        const { upstream } = selected;

        if (!upstream.ok) {
          const sanitizedDetail = await readSanitizedProviderErrorBody(upstream, {
            sensitiveValues: selected.redactionValues,
          });
          const normalizedType = normalizeHttpStatus(upstream.status);
          const headers = this.routeHeaders(
            safeUpstreamHeaders(upstream, false),
            selected,
          );
          if (selected.fallbackBlock !== undefined) {
            headers.set("x-providerdock-fallback-block", selected.fallbackBlock.code);
          }
          sendBridgeError(
            response,
            upstream.status,
            normalizedType,
            `Provider '${selected.route.profile.displayName}' returned HTTP ${upstream.status}.${sanitizedDetail === undefined ? "" : ` ${sanitizedDetail}`}`,
            headers,
          );
          return;
        }

        const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
        const isEventStream = contentType.includes("text/event-stream");
        if (selected.canonicalRequest !== undefined) {
          turnOutcome = await this.handleChatUpstream(
            response,
            upstream,
            wantsStream,
            isEventStream,
            selected.canonicalRequest,
            controller,
            turnToken,
            selected,
            usageRequestId,
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
          response.writeHead(
            200,
            headersToNode(
              this.routeHeaders(safeUpstreamHeaders(upstream, true), selected),
            ),
          );
          response.flushHeaders();
          await this.turnLedger.markStreamStarted(turnToken);
          const usage = new TokenUsageAccumulator();
          const relay = await relayResponsesStream({
            response,
            body: upstream.body,
            abortUpstream: (reason) => controller.abort(reason),
            heartbeatIntervalMs: this.heartbeatIntervalMs,
            idleTimeoutMs: this.streamIdleTimeoutMs,
            maxEventCharacters: this.maxSseEventCharacters,
            beforeForwardEvent: async (event) => {
              usage.observe(extractOpenAiTokenUsage(event));
              try {
                await this.recordDeliveredResponsesCalls(admission.token, event);
              } catch (error) {
                throw new ResponsesStreamProtocolError(
                  error instanceof Error ? error.message : "Tool-call replay was blocked.",
                  { cause: error },
                );
              }
            },
          });
          if (!response.destroyed && !response.writableEnded) response.end();
          turnOutcome =
            !relay.protocolFailure && relay.terminalEventType === "response.completed"
              ? "complete"
              : "incomplete";
          await this.recordUsage(
            selected,
            usageRequestId,
            "openai-responses",
            usage.snapshot(),
            turnOutcome === "complete" ? "completed" : "incomplete",
          );
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

        const payload = normalizeResponsesResponse(
          await readUpstreamJson(upstream, this.responseBodyLimitBytes),
        );
        await this.recordDeliveredResponsesCalls(turnToken, payload);
        if (wantsStream) {
          this.sendJsonAsEventStream(response, upstream, payload, selected);
        } else {
          sendJson(
            response,
            200,
            payload,
            this.routeHeaders(safeUpstreamHeaders(upstream, false), selected),
          );
        }
        turnOutcome =
          payload.status === "failed" || payload.status === "incomplete"
            ? "incomplete"
            : "complete";
        await this.recordUsage(
          selected,
          usageRequestId,
          "openai-responses",
          extractOpenAiTokenUsage(payload),
          turnOutcome === "complete" ? "completed" : "incomplete",
        );
      } catch (error) {
        if (error instanceof BridgeRequestCancelledError) {
          turnOutcome = "cancel";
          return;
        }
        const failure = runtimeFailureFromError(error);
        if (selectedForHealth !== undefined && failure !== undefined) {
          await this.recordRuntimeHealth(
            selectedForHealth.route,
            responsesProtocolForRoute(selectedForHealth.route),
            "failed",
            usageRequestId,
            failure,
          );
        }
        throw error;
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
        if (turnOutcome === "complete") await this.turnLedger.complete(turnToken);
        else if (turnOutcome === "cancel") await this.turnLedger.cancel(turnToken);
        else if (turnOutcome === "incomplete") await this.turnLedger.incomplete(turnToken);
        else await this.turnLedger.fail(turnToken);
      }
      request.off("aborted", onRequestAborted);
      response.off("close", onResponseClosed);
      this.activeUpstreamRequests.delete(controller);
    }
  }

  private async openUpstream(
    body: Readonly<Record<string, unknown>>,
    wantsStream: boolean,
    controller: AbortController,
    signature: TurnSignature,
    requestId: string,
  ): Promise<SelectedUpstream> {
    if (this.fallbackSession === undefined) {
      const route: ResolvedBridgeRoute = {
        profile: this.profile,
        route: {
          providerId: this.profile.id,
          modelId:
            typeof body.model === "string"
              ? body.model
              : (this.models[0]?.modelId ?? "unknown"),
          priority: 0,
          enabled: true,
        },
      };
      try {
        const opened = await this.fetchRoute(body, wantsStream, controller, route);
        if (!opened.upstream.ok) {
          const errorType = normalizeHttpStatus(opened.upstream.status);
          await this.recordRuntimeHealth(
            route,
            responsesProtocolForRoute(route),
            "failed",
            requestId,
            {
              errorType,
              phase: fallbackFailurePhaseForHttpStatus(opened.upstream.status),
              message: `Provider '${route.profile.displayName}' returned HTTP ${opened.upstream.status}.`,
              httpStatus: opened.upstream.status,
            },
          );
        }
        return { ...opened, route };
      } catch (error) {
        const failure = fallbackFailureFromError(error);
        if (failure !== undefined) {
          await this.recordRuntimeHealth(
            route,
            responsesProtocolForRoute(route),
            "failed",
            requestId,
            failure,
          );
        }
        if (error instanceof UpstreamAttemptError) {
          throw new BridgeRequestError(
            providerErrorStatus(error.type),
            error.type,
            error.message,
            { cause: error },
          );
        }
        throw error;
      }
    }

    if (body.model !== this.fallbackSession.group.id) {
      throw new BridgeRequestError(
        400,
        "INVALID_REQUEST",
        `Fallback bridge exposes logical model '${this.fallbackSession.group.id}', not '${String(body.model)}'.`,
      );
    }

    const toolResultIds = new Set(signature.toolResults.map((result) => result.callId));
    const hasToolActivity = signature.toolCalls.length > 0 || signature.toolResults.length > 0;
    const hasUnresolvedCall = signature.toolCalls.some(
      (call) => !toolResultIds.has(call.callId),
    );
    const turn = this.fallbackSession.beginTurn({
      sideEffectsPossible: hasToolActivity,
      continuationState: !hasToolActivity
        ? "none"
        : !hasUnresolvedCall && signature.toolResults.length > 0
          ? "complete"
          : "ambiguous",
    });
    let selection = turn.start();
    if (selection.decision === "blocked") {
      throw new BridgeRequestError(
        503,
        "PROVIDER_UNAVAILABLE",
        selection.message,
        { headers: fallbackBlockHeaders(selection.code) },
      );
    }

    let latestNotification = this.publishFallback(selection.notification);
    while (selection.decision === "selected") {
      const attempt = selection.attempt;
      const route = this.requireFallbackRoute(attempt.route);
      try {
        const opened = await this.fetchRoute(body, wantsStream, controller, route);
        if (opened.upstream.ok) {
          turn.reportSuccess(attempt);
          return {
            ...opened,
            route,
            ...(latestNotification === undefined
              ? {}
              : { notification: latestNotification }),
          };
        }

        const errorType = normalizeHttpStatus(opened.upstream.status);
        const failure: FallbackFailure & { readonly httpStatus: number } = {
          errorType,
          phase: fallbackFailurePhaseForHttpStatus(opened.upstream.status),
          message: `Provider '${route.profile.displayName}' returned HTTP ${opened.upstream.status}.`,
          httpStatus: opened.upstream.status,
        };
        await this.recordRuntimeHealth(
          route,
          responsesProtocolForRoute(route),
          "failed",
          requestId,
          failure,
        );
        const failed = turn.reportFailure(attempt, failure);
        if (failed.decision === "selected") {
          await opened.upstream.body?.cancel().catch(() => undefined);
          latestNotification =
            this.publishFallback(failed.notification) ?? latestNotification;
          selection = failed;
          continue;
        }
        return {
          ...opened,
          route,
          ...(latestNotification === undefined
            ? {}
            : { notification: latestNotification }),
          fallbackBlock: { code: failed.code, message: failed.message },
        };
      } catch (error) {
        if (error instanceof BridgeRequestCancelledError) throw error;
        const failure = fallbackFailureFromError(error);
        if (failure === undefined) throw error;
        await this.recordRuntimeHealth(
          route,
          responsesProtocolForRoute(route),
          "failed",
          requestId,
          failure,
        );
        const failed = turn.reportFailure(attempt, failure);
        if (failed.decision === "selected") {
          latestNotification =
            this.publishFallback(failed.notification) ?? latestNotification;
          selection = failed;
          continue;
        }

        const headers = this.routeHeaders(new Headers(), {
          route,
          ...(latestNotification === undefined
            ? {}
            : { notification: latestNotification }),
        });
        headers.set("x-providerdock-fallback-block", failed.code);
        throw new BridgeRequestError(
          providerErrorStatus(failure.errorType),
          failure.errorType,
          failure.message ?? `Provider '${route.profile.displayName}' request failed.`,
          { cause: error, headers },
        );
      }
    }

    throw new BridgeRequestError(
      503,
      "PROVIDER_UNAVAILABLE",
      "No fallback route could be selected.",
    );
  }

  private applySessionInstructions(
    body: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    if (this.sessionInstructions === undefined) return body;
    const existing = body.instructions;
    if (existing !== undefined && existing !== null && typeof existing !== "string") {
      throw new BridgeRequestError(
        400,
        "INVALID_REQUEST",
        "Responses instructions must be a string when a prompt profile is active.",
      );
    }
    return {
      ...body,
      instructions:
        typeof existing === "string" && existing.trim().length > 0
          ? `${this.sessionInstructions}\n\n${existing}`
          : this.sessionInstructions,
    };
  }

  private async fetchRoute(
    body: Readonly<Record<string, unknown>>,
    wantsStream: boolean,
    controller: AbortController,
    route: ResolvedBridgeRoute,
  ): Promise<OpenedUpstream> {
    const automatic = route.profile.apiType === "auto";
    if (route.profile.apiType === "auto" && this.protocolResolver && !this.resolvedProtocols.has(logicalRouteKey(route.route))) {
      const modelId = this.fallbackSession ? route.route.modelId : typeof body.model === "string" ? body.model : route.route.modelId;
      const protocol = await this.protocolResolver(route.profile, modelId, "codex");
      if (protocol) this.resolvedProtocols.set(logicalRouteKey(route.route), protocol);
    }
    const known = route.profile.apiType === "auto" ? this.resolvedProtocols.get(logicalRouteKey(route.route)) : undefined;
    if (known) route = { ...route, profile: { ...route.profile, apiType: known } };

    if (
      !["auto", "openai-responses", "openai-chat-completions"].includes(
        route.profile.apiType,
      )
    ) {
      throw new BridgeRequestError(
        400,
        "UNSUPPORTED_FEATURE",
        `Bridge cannot translate provider API type '${route.profile.apiType}' yet.`,
      );
    }

    const routedBody =
      this.fallbackSession === undefined ? body : { ...body, model: route.route.modelId };
    const chatTranslation =
      route.profile.apiType === "openai-chat-completions" ||
      (route.profile.apiType === "auto" && this.autoChatRoutes.has(logicalRouteKey(route.route)))
        ? translateResponsesRequestToChat(routedBody)
        : undefined;
    const upstreamPayload = chatTranslation?.chatRequest ?? routedBody;
    const endpoint =
      chatTranslation === undefined ? this.responsesEndpoint : this.chatCompletionsEndpoint;
    const requestedModel = typeof routedBody.model === "string" ? String(routedBody.model) : route.route.modelId;
    if (this.modelAccessCheck) await this.modelAccessCheck(route.profile.id, requestedModel);
    else assertModelEnabled(route.profile, requestedModel);
    const built = await this.requests.build(route.profile, endpoint, {
      accept: wantsStream ? "text/event-stream, application/json" : "application/json",
      contentType: "application/json",
    });

    let headerTimedOut = false;
    const headerTimer = setTimeout(() => {
      headerTimedOut = true;
      controller.abort(new Error("Upstream response headers timed out."));
    }, route.profile.timeoutMs);
    headerTimer.unref?.();
    try {
      this.resolvedProtocols.set(logicalRouteKey(route.route), chatTranslation === undefined ? "openai-responses" : "openai-chat-completions");
      const upstream = await this.fetchImpl(built.url, {
        method: "POST",
        headers: built.headers,
        body: JSON.stringify(upstreamPayload),
        signal: controller.signal,
      });
      // Only a definitive endpoint rejection permits trying another protocol.
      // Never replay an accepted response, a timeout, or a partial stream.
      if (automatic && [404, 405, 501].includes(upstream.status)) {
        await upstream.body?.cancel().catch(() => undefined);
        clearTimeout(headerTimer);
        const alternate = chatTranslation === undefined ? "openai-chat-completions" : "openai-responses";
        const chat = await this.fetchRoute(body, wantsStream, controller, {
          ...route, profile: { ...route.profile, apiType: alternate },
        });
        if (chat.upstream.ok) {
          if (alternate === "openai-chat-completions") this.autoChatRoutes.add(logicalRouteKey(route.route));
          else this.autoChatRoutes.delete(logicalRouteKey(route.route));
          this.resolvedProtocols.set(logicalRouteKey(route.route), alternate);
        }
        return chat;
      }
      return {
        upstream,
        redactionValues: built.redactionValues,
        ...(chatTranslation === undefined
          ? {}
          : { canonicalRequest: chatTranslation.canonical }),
      };
    } catch (error) {
      if (error instanceof ProviderRequestError || error instanceof UpstreamAttemptError) throw error;
      if (controller.signal.aborted && !headerTimedOut) {
        throw new BridgeRequestCancelledError();
      }
      if (headerTimedOut) {
        throw new UpstreamAttemptError(
          "TIMEOUT",
          "unknown",
          "Provider response headers timed out; execution state is unknown.",
          { cause: error },
        );
      }
      throw new UpstreamAttemptError(
        "NETWORK_ERROR",
        isConnectionEstablishmentFailure(error) ? "connection-failed" : "unknown",
        isConnectionEstablishmentFailure(error)
          ? "Provider connection failed before the request was accepted."
          : "Provider connection failed with an unknown execution state.",
        { cause: error },
      );
    } finally {
      clearTimeout(headerTimer);
    }
  }

  private requireFallbackRoute(route: LogicalModelRoute): ResolvedBridgeRoute {
    const resolved = this.fallbackRoutes.get(logicalRouteKey(route));
    if (resolved === undefined) {
      throw new TypeError(`Fallback route '${logicalRouteKey(route)}' is not configured.`);
    }
    return resolved;
  }

  private activeRouteProfile(): ProviderProfile {
    const sticky = this.fallbackSession?.stickyRoute();
    return sticky === undefined ? this.profile : this.requireFallbackRoute(sticky).profile;
  }

  private publishFallback(
    notification: FallbackNotification | undefined,
  ): FallbackNotification | undefined {
    if (notification === undefined) return undefined;
    this.lastFallback = notification;
    try {
      this.onFallback?.(notification);
    } catch {
      // Observability callbacks must never change routing or replay behavior.
    }
    return notification;
  }

  private routeHeaders(headers: Headers, selected: RouteSelectionMetadata): Headers {
    const result = new Headers(headers);
    result.set("x-providerdock-provider-id", selected.route.profile.id);
    if (this.fallbackSession !== undefined) {
      result.set("x-providerdock-logical-model", this.fallbackSession.group.id);
    }
    if (selected.notification !== undefined) {
      result.set("x-providerdock-fallback", "true");
      result.set("x-providerdock-fallback-from", selected.notification.from.providerId);
      result.set("x-providerdock-fallback-to", selected.notification.to.providerId);
      if (selected.notification.errorType !== undefined) {
        result.set("x-providerdock-fallback-reason", selected.notification.errorType);
      }
    }
    return result;
  }

  private sendJsonAsEventStream(
    response: ServerResponse,
    upstream: Response,
    payload: unknown,
    selected: SelectedUpstream,
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
    const headers = this.routeHeaders(safeUpstreamHeaders(upstream, true), selected);
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
    selected: SelectedUpstream,
    usageRequestId: string,
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
        headersToNode(
          this.routeHeaders(
            safeUpstreamHeaders(upstream, true, "chat-completions"),
            selected,
          ),
        ),
      );
      response.flushHeaders();
      await this.turnLedger.markStreamStarted(turnToken);
      const usage = new TokenUsageAccumulator();
      const relay = await relayChatCompletionsStream({
        response,
        body: upstream.body,
        request: canonicalRequest,
        abortUpstream: (reason) => controller.abort(reason),
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        idleTimeoutMs: this.streamIdleTimeoutMs,
        maxEventCharacters: this.maxSseEventCharacters,
        beforeForwardEvent: async (event) => {
          usage.observe(extractOpenAiTokenUsage(event));
          try {
            await this.recordDeliveredResponsesCalls(turnToken, event);
          } catch (error) {
            throw new ChatToResponsesTranslationError(
              "PROTOCOL_ERROR",
              error instanceof Error ? error.message : "Tool-call replay was blocked.",
              { cause: error },
            );
          }
        },
      });
      if (!response.destroyed && !response.writableEnded) response.end();
      const outcome =
        !relay.protocolFailure && relay.terminalEventType === "response.completed"
        ? "complete"
        : "incomplete";
      await this.recordUsage(
        selected,
        usageRequestId,
        "openai-chat-completions",
        usage.snapshot(),
        outcome === "complete" ? "completed" : "incomplete",
      );
      return outcome;
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
      const usage = new TokenUsageAccumulator();
      for (const event of events) usage.observe(extractOpenAiTokenUsage(event));
      for (const event of events) await this.recordDeliveredResponsesCalls(turnToken, event);
      const headers = this.routeHeaders(
        safeUpstreamHeaders(upstream, true, "chat-completions"),
        selected,
      );
      headers.set("x-providerdock-normalization", "chat-json-to-responses-sse");
      response.writeHead(200, headersToNode(headers));
      response.flushHeaders();
      await writeTranslatedEvents(response, events);
      response.end(encodeSseEvent({ data: "[DONE]", comments: [] }));
      const outcome = translator.terminalEventType === "response.completed"
        ? "complete"
        : "incomplete";
      await this.recordUsage(
        selected,
        usageRequestId,
        "openai-chat-completions",
        usage.snapshot(),
        outcome === "complete" ? "completed" : "incomplete",
      );
      return outcome;
    }

    const translated = translateChatResponseToResponses(payload, { request: canonicalRequest });
    await this.recordDeliveredResponsesCalls(turnToken, translated.response);
    sendJson(
      response,
      200,
      translated.response,
      this.routeHeaders(
        safeUpstreamHeaders(upstream, false, "chat-completions"),
        selected,
      ),
    );
    const outcome = translated.terminalEventType === "response.completed"
      ? "complete"
      : "incomplete";
    await this.recordUsage(
      selected,
      usageRequestId,
      "openai-chat-completions",
      extractOpenAiTokenUsage(translated.response),
      outcome === "complete" ? "completed" : "incomplete",
    );
    return outcome;
  }

  private async recordUsage(
    selected: SelectedUpstream,
    requestId: string,
    protocol: UsageProtocol,
    usage: NormalizedTokenUsage | undefined,
    outcome: UsageOutcome,
  ): Promise<void> {
    await this.recordRuntimeHealth(
      selected.route,
      protocol,
      outcome,
      requestId,
    );
    if (this.usageSink === undefined || usage === undefined) return;
    try {
      await this.usageSink(
        createUsageTelemetryEvent({
          profile: selected.route.profile,
          modelId: selected.route.route.modelId,
          ...(this.fallbackSession === undefined
            ? {}
            : { logicalModelId: this.fallbackSession.group.id }),
          client: "codex",
          protocol,
          sessionId: this.sessionId,
          requestId,
          outcome,
          usage,
        }),
      );
    } catch {
      // Local telemetry must never change response or replay semantics.
    }
  }

  private recordRuntimeHealth(
    route: ResolvedBridgeRoute,
    protocol: UsageProtocol,
    outcome: ProviderRuntimeOutcome,
    requestId: string,
    failure: (FallbackFailure & { readonly httpStatus?: number }) | undefined = undefined,
  ): void {
    if (this.healthSignalSink === undefined) return;
    protocol = this.resolvedProtocols.get(logicalRouteKey(route.route)) ?? protocol;
    try {
      const task = Promise.resolve(this.healthSignalSink(
        createProviderRuntimeHealthSignal({
          providerId: route.profile.id,
          modelId: route.route.modelId,
          client: "codex",
          protocol,
          sessionId: this.sessionId,
          requestId,
          ...(this.fallbackSession === undefined
            ? {}
            : { logicalModelId: this.fallbackSession.group.id }),
          outcome,
          ...(failure?.errorType === undefined
            ? {}
            : { errorType: failure.errorType }),
          ...(failure?.httpStatus === undefined
            ? {}
            : { httpStatus: failure.httpStatus }),
          ...(failure?.phase === undefined
            ? {}
            : { executionPhase: failure.phase }),
          ...(failure?.message === undefined
            ? {}
            : { errorMessage: failure.message }),
        }),
      ))
        .catch(() => undefined)
        .finally(() => {
          this.pendingHealthSignals.delete(task);
        });
      this.pendingHealthSignals.add(task);
    } catch {
      // Health observability must never change response or replay semantics.
    }
  }

  private async flushHealthSignals(): Promise<void> {
    if (this.pendingHealthSignals.size === 0) return;
    await Promise.allSettled([...this.pendingHealthSignals]);
  }

  private async recordDeliveredResponsesCalls(
    turnToken: TurnToken,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const item = isJsonRecord(payload.item) ? payload.item : undefined;
    const responsePayload = isJsonRecord(payload.response) ? payload.response : undefined;
    const source =
      payload.type === "response.output_item.done" && item !== undefined
        ? item
        : responsePayload ?? payload;
    await this.turnLedger.recordDeliveredToolCalls(
      turnToken,
      extractResponsesDeliveredToolCalls(source),
    );
    const eventType = typeof payload.type === "string" ? payload.type : undefined;
    const responseStatus =
      typeof responsePayload?.status === "string"
        ? responsePayload.status
        : payload.object === "response" && typeof payload.status === "string"
          ? payload.status
          : undefined;
    if (eventType === "response.completed" || responseStatus === "completed") {
      await this.turnLedger.complete(turnToken);
    } else if (
      eventType === "response.failed" ||
      eventType === "response.incomplete" ||
      responseStatus === "failed" ||
      responseStatus === "incomplete"
    ) {
      await this.turnLedger.incomplete(turnToken);
    }
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
      sendBridgeError(response, error.status, error.type, error.message, error.headers);
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
    if (error instanceof TurnLedgerViolationError) {
      sendBridgeError(
        response,
        409,
        "PROTOCOL_ERROR",
        error.message,
        new Headers({ "x-providerdock-turn-block": error.code }),
      );
      return;
    }
    if (error instanceof TurnLedgerPersistenceError) {
      sendBridgeError(
        response,
        503,
        "UNKNOWN",
        "Turn ledger storage is unavailable; the request was blocked for safety.",
      );
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
  readonly headers: Headers;

  constructor(
    readonly status: number,
    readonly type: NormalizedErrorType,
    message: string,
    options: ErrorOptions & { readonly headers?: Headers } = {},
  ) {
    super(message, options);
    this.name = "BridgeRequestError";
    this.headers = options.headers ?? new Headers();
  }
}

class BridgeRequestCancelledError extends Error {
  constructor() {
    super("Bridge client cancelled the request.");
    this.name = "BridgeRequestCancelledError";
  }
}

class UpstreamAttemptError extends Error {
  constructor(
    readonly type: NormalizedErrorType,
    readonly phase: FallbackFailurePhase,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "UpstreamAttemptError";
  }
}

function fallbackFailureFromError(error: unknown): FallbackFailure | undefined {
  if (error instanceof ModelDisabledError) return undefined;
  if (error instanceof UpstreamAttemptError) {
    return { errorType: error.type, phase: error.phase, message: error.message };
  }
  if (error instanceof ProviderRequestError) {
    return {
      errorType: error.type,
      phase: "request-rejected",
      message: error.message,
    };
  }
  return undefined;
}

function runtimeFailureFromError(error: unknown): FallbackFailure | undefined {
  if (error instanceof ModelDisabledError) return undefined;
  if (error instanceof BridgeRequestError) {
    return { errorType: error.type, phase: "unknown", message: error.message };
  }
  if (error instanceof ProviderRequestError) {
    return { errorType: error.type, phase: "unknown", message: error.message };
  }
  if (error instanceof ResponsesStreamProtocolError) {
    return {
      errorType: "STREAM_ERROR",
      phase: "unknown",
      message: error.message,
    };
  }
  return undefined;
}

function responsesProtocolForRoute(route: ResolvedBridgeRoute): UsageProtocol {
  return route.profile.apiType === "openai-chat-completions"
    ? "openai-chat-completions"
    : "openai-responses";
}

function fallbackBlockHeaders(code: string): Headers {
  return new Headers({ "x-providerdock-fallback-block": code });
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
  const guidance = providerErrorGuidance(type);
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
        explanation: guidance.explanation,
        suggested_action: guidance.suggestedAction,
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

function normalizeSessionInstructions(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > 256 * 1024) {
    throw new RangeError("sessionInstructions cannot exceed 262144 characters.");
  }
  return normalized;
}

function providerErrorStatus(type: NormalizedErrorType): number {
  if (type === "INVALID_REQUEST") return 400;
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
  return isLoopbackPortAllowed(port);
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
