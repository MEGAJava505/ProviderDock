import type { ModelProtocolResolver } from "../../core/providers/model-protocol.js";
import { assertModelEnabled, ModelDisabledError, type ModelAccessCheck } from "../../core/providers/model-access.js";
import { chatRequestToResponses, responsesTransportToChat } from "./responses-transport.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  normalizeHttpStatus,
  providerErrorGuidance,
  ProviderRequestError,
  type NormalizedErrorType,
} from "../../core/errors/provider-error.js";
import {
  fallbackFailurePhaseForHttpStatus,
  isConnectionEstablishmentFailure,
} from "../../core/fallback/fallback-failure-policy.js";
import {
  FallbackSessionRouter,
  type FallbackFailure,
  type FallbackFailurePhase,
  type FallbackNotification,
} from "../../core/fallback/fallback-session-router.js";
import {
  logicalRouteKey,
  type LogicalModelRoute,
} from "../../core/fallback/logical-model.js";
import type { ProviderFallbackConfiguration } from "../../core/fallback/provider-fallback-configuration.js";
import { ProviderHttpRequestBuilder } from "../../core/providers/provider-http-request.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import { sanitizeProviderErrorBody } from "../../core/security/provider-error-redaction.js";
import {
  TurnLedgerViolationError,
  extractAnthropicDeliveredToolCalls,
  extractAnthropicTurnSignature,
  type TurnSignature,
  type TurnToken,
} from "../../core/state-machine/turn-ledger.js";
import {
  PersistentTurnLedger,
  TurnLedgerPersistenceError,
  type TurnLedgerStore,
} from "../../core/state-machine/persistent-turn-ledger.js";
import { SseDecodeError, SseDecoder, encodeSseEvent } from "../sse/sse-decoder.js";
import { isLoopbackPortAllowed as isBridgePortAllowed } from "../../core/http/loopback-port.js";
import {
  AnthropicTranslationError,
  translateAnthropicRequestToChat,
  isRecord,
  type AnthropicToChatTranslation,
} from "../../protocols/anthropic-messages/anthropic-to-chat-request.js";
import { translateChatResponseToAnthropic } from "../../protocols/anthropic-messages/chat-to-anthropic-response.js";
import {
  ChatToAnthropicStreamTranslator,
  type AnthropicStreamEvent,
} from "../../protocols/anthropic-messages/chat-to-anthropic-stream.js";
import {
  TokenUsageAccumulator,
  createUsageTelemetryEvent,
  extractAnthropicTokenUsage,
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

export interface AnthropicBridgeServerOptions {
  readonly profile: ProviderProfile;
  readonly secretStore: SecretStore;
  readonly modelAccessCheck?: ModelAccessCheck;
  readonly protocolResolver?: ModelProtocolResolver;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly fallback?: ProviderFallbackConfiguration;
  readonly onFallback?: (notification: FallbackNotification) => void;
  /** Session-scoped prompt-profile instructions prepended to every turn. */
  readonly sessionInstructions?: string;
  readonly messagesEndpoint?: string;
  readonly chatCompletionsEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestBodyLimitBytes?: number;
  readonly responseBodyLimitBytes?: number;
  readonly streamIdleTimeoutMs?: number;
  /** Optional bearer/x-api-key required from the loopback Claude client. */
  readonly clientToken?: string;
  readonly turnLedgerStore?: TurnLedgerStore;
  readonly sessionId?: string;
  readonly usageSink?: UsageEventSink;
  readonly healthSignalSink?: ProviderRuntimeHealthSignalSink;
}

export interface AnthropicBridgeAddress {
  readonly host: typeof loopbackHost;
  readonly port: number;
  readonly url: string;
}

type BridgeMode = "native-anthropic" | "openai-chat";

interface ResolvedAnthropicRoute {
  readonly route: LogicalModelRoute;
  readonly profile: ProviderProfile;
  readonly mode: BridgeMode;
}

interface OpenedAnthropicUpstream {
  readonly upstream: Response;
  readonly redactionValues: readonly string[];
  readonly effectiveMode: BridgeMode;
  readonly translation?: AnthropicToChatTranslation;
}

interface AnthropicRouteSelectionMetadata {
  readonly route: ResolvedAnthropicRoute;
  readonly notification?: FallbackNotification;
}

interface SelectedAnthropicUpstream
  extends OpenedAnthropicUpstream,
    AnthropicRouteSelectionMetadata {
  readonly fallbackBlock?: {
    readonly code: string;
    readonly message: string;
  };
}

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
  private readonly turnLedger: PersistentTurnLedger;
  private readonly fallbackSession: FallbackSessionRouter | undefined;
  private readonly fallbackRoutes = new Map<string, ResolvedAnthropicRoute>();
  private readonly onFallback: ((notification: FallbackNotification) => void) | undefined;
  private readonly sessionInstructions: string | undefined;
  private readonly sessionId: string;
  private readonly usageSink: UsageEventSink | undefined;
  private readonly healthSignalSink: ProviderRuntimeHealthSignalSink | undefined;
  private readonly pendingHealthSignals = new Set<Promise<void>>();
  private readonly nativeMessagesSupport = new Map<string, boolean>();
  private lastFallback: FallbackNotification | undefined;
  private readonly activeUpstreamRequests = new Set<AbortController>();
  private server: Server | undefined;
  private startTask: Promise<AnthropicBridgeAddress> | undefined;
  private stopTask: Promise<void> | undefined;

  private readonly modelAccessCheck: ModelAccessCheck | undefined;
  private readonly protocolResolver: ModelProtocolResolver | undefined;
  private readonly resolvedProtocols = new Map<string, UsageProtocol>();

  constructor(options: AnthropicBridgeServerOptions) {
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
        this.fallbackRoutes.set(logicalRouteKey(route), {
          route,
          profile,
          mode: resolveBridgeMode(profile),
        });
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
    this.requests = new ProviderHttpRequestBuilder(options.secretStore);
    this.mode = resolveBridgeMode(this.profile);
    this.onFallback = options.onFallback;
    this.sessionInstructions = normalizeSessionInstructions(options.sessionInstructions);
    this.sessionId = options.sessionId ?? `bridge-${randomUUID()}`;
    this.usageSink = options.usageSink;
    this.healthSignalSink = options.healthSignalSink;
    this.messagesEndpoint = options.messagesEndpoint ?? "messages";
    this.chatCompletionsEndpoint = options.chatCompletionsEndpoint ?? "chat/completions";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestBodyLimitBytes = options.requestBodyLimitBytes ?? defaultBodyLimitBytes;
    this.responseBodyLimitBytes = options.responseBodyLimitBytes ?? defaultBodyLimitBytes;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 1_800_000;
    this.clientToken = options.clientToken;
    this.turnLedger = new PersistentTurnLedger({
      ...(options.turnLedgerStore === undefined ? {} : { store: options.turnLedgerStore }),
    });
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
    if (server === undefined) {
      await this.flushHealthSignals();
      return;
    }
    for (const controller of this.activeUpstreamRequests) {
      controller.abort(new Error("ProviderDock Anthropic bridge is stopping."));
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
      const activeRoute = this.activeRoute();
      sendJson(response, 200, {
        status: "ok",
        // Keep the primary identity stable for managed runtime ownership checks.
        provider_id: this.profile.id,
        mode: activeRoute.mode,
        ...(this.fallbackSession === undefined
          ? {}
          : {
              logical_model_id: this.fallbackSession.group.id,
              active_provider_id: activeRoute.profile.id,
              fallback: this.fallbackSession.snapshot(),
              ...(this.lastFallback === undefined
                ? {}
                : { last_fallback: this.lastFallback }),
            }),
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
    const usageRequestId = randomUUID();
    try {
      const body = this.applySessionInstructions(
        await readJsonObject(request, this.requestBodyLimitBytes),
      );
      const turnSignature = extractAnthropicTurnSignature(body);
      const admission = await this.turnLedger.admit(turnSignature);
      if (admission.decision === "blocked") {
        const headers = new Headers({ "x-providerdock-turn-block": admission.code });
        sendAnthropicError(response, 409, "INVALID_REQUEST", admission.message, headers);
        turnOutcome = "cancel";
        return;
      }
      turnToken = admission.token;
      const wantsStream = body.stream === true;

      let selectedForHealth: SelectedAnthropicUpstream | undefined;
      try {
        const selected = await this.openUpstream(
          body,
          wantsStream,
          controller,
          turnSignature,
          request,
          usageRequestId,
        );
        selectedForHealth = selected;
        const { upstream, translation } = selected;

        if (!upstream.ok) {
          const errorBody = await readUpstreamText(upstream, 64 * 1024);
          const sanitizedDetail = sanitizeProviderErrorBody(errorBody, {
            sensitiveValues: selected.redactionValues,
          });
          const headers = this.routeHeaders(safeHeaders(upstream), selected);
          if (selected.fallbackBlock !== undefined) {
            headers.set("x-providerdock-fallback-block", selected.fallbackBlock.code);
          }
          sendAnthropicError(
            response,
            upstream.status,
            normalizeHttpStatus(upstream.status),
            `Provider '${selected.route.profile.displayName}' returned HTTP ${upstream.status}.${sanitizedDetail === undefined ? "" : ` ${sanitizedDetail}`}`,
            headers,
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
            { headers: this.routeHeaders(new Headers(), selected) },
          );
        }

        if (translation === undefined) {
          turnOutcome = await this.relayNative(
            response,
            upstream,
            wantsStream,
            isEventStream,
            turnToken,
            selected,
            usageRequestId,
          );
        } else {
          turnOutcome = await this.relayTranslated(
            response,
            upstream,
            wantsStream,
            isEventStream,
            translation.model,
            translation.toolNames,
            turnToken,
            selected,
            usageRequestId,
          );
        }
      } catch (error) {
        if (error instanceof BridgeRequestCancelledError) {
          turnOutcome = "cancel";
          return;
        }
        const failure = runtimeFailureFromError(error);
        if (selectedForHealth !== undefined && failure !== undefined) {
          await this.recordRuntimeHealth(
            selectedForHealth.route,
            anthropicProtocolForRoute(selectedForHealth.route),
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
        if (!response.writableEnded) response.end(encodeAnthropicEvent({
          event: "error",
          data: { type: "error", error: { type: "api_error", message: "Provider stream was interrupted or invalid; the request was not replayed." } },
        }));
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
      response.off("close", onResponseClosed);
      this.activeUpstreamRequests.delete(controller);
    }
  }

  private async openUpstream(
    body: Readonly<Record<string, unknown>>,
    wantsStream: boolean,
    controller: AbortController,
    signature: TurnSignature,
    request: IncomingMessage,
    requestId: string,
  ): Promise<SelectedAnthropicUpstream> {
    if (this.fallbackSession === undefined) {
      const route: ResolvedAnthropicRoute = {
        profile: this.profile,
        mode: this.mode,
        route: {
          providerId: this.profile.id,
          modelId: typeof body.model === "string" ? body.model : "unknown",
          priority: 0,
          enabled: true,
        },
      };
      try {
        const opened = await this.fetchRoute(
          body,
          wantsStream,
          controller,
          request,
          route,
        );
        const effectiveRoute: ResolvedAnthropicRoute = {
          ...route,
          mode: opened.effectiveMode,
        };
        if (!opened.upstream.ok) {
          const errorType = normalizeHttpStatus(opened.upstream.status);
          await this.recordRuntimeHealth(
            effectiveRoute,
            anthropicProtocolForRoute(effectiveRoute),
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
        return { ...opened, route: effectiveRoute };
      } catch (error) {
        const failure = fallbackFailureFromError(error);
        if (failure !== undefined) {
          await this.recordRuntimeHealth(
            route,
            anthropicProtocolForRoute(route),
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
      throw new BridgeRequestError(503, "PROVIDER_UNAVAILABLE", selection.message, {
        headers: fallbackBlockHeaders(selection.code),
      });
    }

    let latestNotification = this.publishFallback(selection.notification);
    while (selection.decision === "selected") {
      const attempt = selection.attempt;
      const route = this.requireFallbackRoute(attempt.route);
      try {
        const opened = await this.fetchRoute(
          body,
          wantsStream,
          controller,
          request,
          route,
        );
        const effectiveRoute: ResolvedAnthropicRoute = {
          ...route,
          mode: opened.effectiveMode,
        };
        if (opened.upstream.ok) {
          turn.reportSuccess(attempt);
          return {
            ...opened,
            route: effectiveRoute,
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
          effectiveRoute,
          anthropicProtocolForRoute(effectiveRoute),
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
          route: effectiveRoute,
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
          anthropicProtocolForRoute(route),
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
    const existing = body.system;
    if (existing === undefined || existing === null || existing === "") {
      return { ...body, system: this.sessionInstructions };
    }
    if (typeof existing === "string") {
      return {
        ...body,
        system: `${this.sessionInstructions}\n\n${existing}`,
      };
    }
    if (Array.isArray(existing)) {
      return {
        ...body,
        system: [
          { type: "text", text: this.sessionInstructions },
          ...existing,
        ],
      };
    }
    throw new BridgeRequestError(
      400,
      "INVALID_REQUEST",
      "Anthropic system prompt must be a string or block array when a prompt profile is active.",
    );
  }

  private async fetchRoute(
    body: Readonly<Record<string, unknown>>,
    wantsStream: boolean,
    controller: AbortController,
    request: IncomingMessage,
    route: ResolvedAnthropicRoute,
  ): Promise<OpenedAnthropicUpstream> {
    const automatic = route.profile.apiType === "auto";
    if (route.profile.apiType === "auto" && this.protocolResolver && !this.resolvedProtocols.has(logicalRouteKey(route.route))) {
      const modelId = this.fallbackSession ? route.route.modelId : typeof body.model === "string" ? body.model : route.route.modelId;
      const protocol = await this.protocolResolver(route.profile, modelId, "claude-code");
      if (protocol) this.resolvedProtocols.set(logicalRouteKey(route.route), protocol);
    }
    const known = route.profile.apiType === "auto" ? this.resolvedProtocols.get(logicalRouteKey(route.route)) : undefined;
    if (known) route = { ...route, profile: { ...route.profile, apiType: known }, mode: known === "anthropic-messages" ? "native-anthropic" : "openai-chat" };

    const routedBody =
      this.fallbackSession === undefined ? body : { ...body, model: route.route.modelId };
    if (route.mode === "native-anthropic") {
      const native = await this.fetchRouteAttempt(
        routedBody,
        wantsStream,
        controller,
        request,
        route,
      );
      if (!automatic || !isDefinitiveNativeRouteRejection(native.upstream.status)) return native;
      await native.upstream.body?.cancel().catch(() => undefined);
      this.nativeMessagesSupport.set(logicalRouteKey(route.route), false);
      route = { ...route, profile: { ...route.profile, apiType: "openai-chat-completions" }, mode: "openai-chat" };
    }

    if (this.shouldTryNativeMessages(route, routedBody)) {
      const native = await this.fetchRouteAttempt(
        routedBody,
        wantsStream,
        controller,
        request,
        route,
      );
      if (native.upstream.ok || !isDefinitiveNativeRouteRejection(native.upstream.status)) {
        this.nativeMessagesSupport.set(logicalRouteKey(route.route), true);
        return native;
      }
      await native.upstream.body?.cancel().catch(() => undefined);
      this.nativeMessagesSupport.set(logicalRouteKey(route.route), false);
    }

    const translation = translateAnthropicRequestToChat(routedBody);
    const translated = await this.fetchRouteAttempt(
      translation.chatRequest,
      wantsStream,
      controller,
      request,
      route,
      translation,
    );
    if (automatic && isDefinitiveNativeRouteRejection(translated.upstream.status)) {
      await translated.upstream.body?.cancel().catch(() => undefined);
      const apiType = route.profile.apiType === "openai-responses" ? "openai-chat-completions" : "openai-responses";
      return this.fetchRouteAttempt(translation.chatRequest, wantsStream, controller, request,
        { ...route, profile: { ...route.profile, apiType } }, translation);
    }
    return translated;
  }

  private shouldTryNativeMessages(
    route: ResolvedAnthropicRoute,
    body: Readonly<Record<string, unknown>>,
  ): boolean {
    if (route.profile.apiType !== "auto") return false;
    const cached = this.nativeMessagesSupport.get(logicalRouteKey(route.route));
    if (cached !== undefined) return cached;
    const model = typeof body.model === "string" ? body.model : route.route.modelId;
    return (
      isClaudeModelId(model) ||
      route.profile.manualModelIds.some((candidate) => isClaudeModelId(candidate))
    );
  }

  private async fetchRouteAttempt(
    upstreamPayload: Readonly<Record<string, unknown>>,
    wantsStream: boolean,
    controller: AbortController,
    request: IncomingMessage,
    route: ResolvedAnthropicRoute,
    translation?: AnthropicToChatTranslation,
  ): Promise<OpenedAnthropicUpstream> {
    const useResponses = translation !== undefined && route.profile.apiType === "openai-responses";
    const endpoint = useResponses ? "responses" : translation === undefined ? this.messagesEndpoint : this.chatCompletionsEndpoint;
    this.resolvedProtocols.set(logicalRouteKey(route.route), useResponses ? "openai-responses" : translation === undefined ? "anthropic-messages" : "openai-chat-completions");
    const requestedModel = typeof upstreamPayload.model === "string" ? upstreamPayload.model : route.route.modelId;
    if (this.modelAccessCheck) await this.modelAccessCheck(route.profile.id, requestedModel);
    else assertModelEnabled(route.profile, requestedModel);
    const built = await this.requests.build(route.profile, endpoint, {
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
    }, route.profile.timeoutMs);
    headerTimer.unref?.();
    try {
      const upstream = await this.fetchImpl(built.url, {
        method: "POST",
        headers: built.headers,
        body: JSON.stringify(useResponses ? chatRequestToResponses(upstreamPayload) : upstreamPayload),
        signal: controller.signal,
      });
      clearTimeout(headerTimer);
      return {
        upstream: useResponses ? await responsesTransportToChat(upstream, controller.signal) : upstream,
        redactionValues: built.redactionValues,
        effectiveMode:
          translation === undefined ? "native-anthropic" : "openai-chat",
        ...(translation === undefined ? {} : { translation }),
      };
    } catch (error) {
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
      if (error instanceof ProviderRequestError) throw error;
      const connectionFailed = isConnectionEstablishmentFailure(error);
      throw new UpstreamAttemptError(
        "NETWORK_ERROR",
        connectionFailed ? "connection-failed" : "unknown",
        connectionFailed
          ? "Provider connection failed before the request was accepted."
          : "Provider connection failed with an unknown execution state.",
        { cause: error },
      );
    } finally {
      clearTimeout(headerTimer);
    }
  }

  private requireFallbackRoute(route: LogicalModelRoute): ResolvedAnthropicRoute {
    const resolved = this.fallbackRoutes.get(logicalRouteKey(route));
    if (resolved === undefined) {
      throw new TypeError(`Fallback route '${logicalRouteKey(route)}' is not configured.`);
    }
    return resolved;
  }

  private activeRoute(): ResolvedAnthropicRoute {
    const sticky = this.fallbackSession?.stickyRoute();
    if (sticky !== undefined) return this.requireFallbackRoute(sticky);
    if (this.fallbackSession !== undefined) {
      const preferred = this.fallbackSession.routes[0];
      if (preferred !== undefined) return this.requireFallbackRoute(preferred);
    }
    return {
      profile: this.profile,
      mode: this.mode,
      route: {
        providerId: this.profile.id,
        modelId: this.profile.manualModelIds[0] ?? "unknown",
        priority: 0,
        enabled: true,
      },
    };
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

  private routeHeaders(
    headers: Headers,
    selected: AnthropicRouteSelectionMetadata,
  ): Headers {
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

  private async relayNative(
    response: ServerResponse,
    upstream: Response,
    wantsStream: boolean,
    isEventStream: boolean,
    turnToken: TurnToken,
    selected: SelectedAnthropicUpstream,
    usageRequestId: string,
  ): Promise<"complete" | "incomplete"> {
    if (wantsStream && isEventStream) {
      if (upstream.body === null) {
        throw new BridgeRequestError(502, "STREAM_ERROR", "Provider returned an empty stream body.");
      }
      response.writeHead(
        200,
        Object.fromEntries(
          this.routeHeaders(
            new Headers(sseHeaders("native-anthropic")),
            selected,
          ).entries(),
        ),
      );
      response.flushHeaders();
      await this.turnLedger.markStreamStarted(turnToken);
      const tracker = new NativeAnthropicStreamTracker();
      const usage = new TokenUsageAccumulator();
      let terminalError = false;
      const ok = await this.pipeSse(response, upstream.body, async (event) => {
        if (event.data === undefined) return false;
        usage.observe(extractAnthropicSseUsage(event.data));
        const observation = tracker.observe(event.data);
        if (observation.completedToolUse !== undefined) {
          await this.turnLedger.recordDeliveredToolCalls(
            turnToken,
            extractAnthropicDeliveredToolCalls({
              content: [observation.completedToolUse],
            }),
          );
        }
        if (observation.terminalError) terminalError = true;
        if (observation.terminal) {
          if (observation.terminalError) await this.turnLedger.incomplete(turnToken);
          else await this.turnLedger.complete(turnToken);
        }
        return observation.terminal;
      });
      if (!response.destroyed && !response.writableEnded) response.end();
      const outcome = ok && !terminalError ? "complete" : "incomplete";
      await this.recordUsage(
        selected,
        usageRequestId,
        "anthropic-messages",
        usage.snapshot(),
        outcome === "complete" ? "completed" : "incomplete",
      );
      return outcome;
    }

    const payload = await readUpstreamJson(upstream, this.responseBodyLimitBytes);
    if (!isRecord(payload) || payload.type !== "message") {
      throw new BridgeRequestError(
        502,
        "PROTOCOL_ERROR",
        "Provider returned an invalid Anthropic Messages payload.",
      );
    }
    const outcome = nativeMessageOutcome(payload);
    await this.turnLedger.recordDeliveredToolCalls(
      turnToken,
      extractAnthropicDeliveredToolCalls(payload),
    );
    if (outcome === "complete") await this.turnLedger.complete(turnToken); else await this.turnLedger.incomplete(turnToken);
    if (wantsStream) {
      response.writeHead(
        200,
        Object.fromEntries(
          this.routeHeaders(
            new Headers(sseHeaders("native-anthropic-json")),
            selected,
          ).entries(),
        ),
      );
      response.flushHeaders();
      for (const event of synthesizeAnthropicStream(payload)) {
        response.write(encodeAnthropicEvent(event));
      }
      response.end();
    } else {
      sendJson(
        response,
        200,
        payload,
        this.routeHeaders(safeHeaders(upstream), selected),
      );
    }
    await this.recordUsage(
      selected,
      usageRequestId,
      "anthropic-messages",
      extractAnthropicTokenUsage(payload),
      outcome === "complete" ? "completed" : "incomplete",
    );
    return outcome;
  }

  private async relayTranslated(
    response: ServerResponse,
    upstream: Response,
    wantsStream: boolean,
    isEventStream: boolean,
    model: string,
    allowedToolNames: readonly string[],
    turnToken: TurnToken,
    selected: SelectedAnthropicUpstream,
    usageRequestId: string,
  ): Promise<"complete" | "incomplete"> {
    if (wantsStream && isEventStream) {
      if (upstream.body === null) {
        throw new BridgeRequestError(
          502,
          "STREAM_ERROR",
          "Chat provider returned an empty stream body.",
        );
      }
      response.writeHead(
        200,
        Object.fromEntries(
          this.routeHeaders(new Headers(sseHeaders("openai-chat")), selected).entries(),
        ),
      );
      response.flushHeaders();
      await this.turnLedger.markStreamStarted(turnToken);
      const translator = new ChatToAnthropicStreamTranslator({ model, allowedToolNames });
      const usage = new TokenUsageAccumulator();
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
          const translated = translator.feed(parsed);
          for (const item of translated) {
            usage.observe(extractAnthropicTokenUsage(item.data));
          }
          return translated;
        },
        () => translator.generationFinished,
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
        for (const item of terminalEvents) {
          usage.observe(extractAnthropicTokenUsage(item.data));
        }
        if (translator.terminalSucceeded) {
          try {
            await this.turnLedger.recordDeliveredToolCalls(
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
        if (translator.terminalSucceeded) await this.turnLedger.complete(turnToken);
        else await this.turnLedger.incomplete(turnToken);
        for (const event of terminalEvents) {
          response.write(encodeAnthropicEvent(event));
        }
        response.end();
      }
      const outcome = ok && !protocolFailure && translator.terminalSucceeded
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

    const payload = await readUpstreamJson(upstream, this.responseBodyLimitBytes);
    if (wantsStream) {
      // Chat provider ignored stream=true; synthesize a full Anthropic stream.
      const translated = translateChatResponseToAnthropic(payload, {
        model,
        allowedToolNames,
      });
      await this.turnLedger.recordDeliveredToolCalls(
        turnToken,
        extractAnthropicDeliveredToolCalls(translated),
      );
      const outcome = nativeMessageOutcome(translated);
      if (outcome === "complete") await this.turnLedger.complete(turnToken); else await this.turnLedger.incomplete(turnToken);
      response.writeHead(
        200,
        Object.fromEntries(
          this.routeHeaders(new Headers(sseHeaders("openai-chat")), selected).entries(),
        ),
      );
      response.flushHeaders();
      for (const event of synthesizeAnthropicStream(translated)) {
        response.write(encodeAnthropicEvent(event));
      }
      response.end();
      await this.recordUsage(
        selected,
        usageRequestId,
        "openai-chat-completions",
        extractAnthropicTokenUsage(translated),
        outcome === "complete" ? "completed" : "incomplete",
      );
      return outcome;
    }
    const translated = translateChatResponseToAnthropic(payload, {
      model,
      allowedToolNames,
    });
    await this.turnLedger.recordDeliveredToolCalls(
      turnToken,
      extractAnthropicDeliveredToolCalls(translated),
    );
    const outcome = nativeMessageOutcome(translated);
    if (outcome === "complete") await this.turnLedger.complete(turnToken); else await this.turnLedger.incomplete(turnToken);
    sendJson(
      response,
      200,
      translated,
      this.routeHeaders(safeHeaders(upstream), selected),
    );
    await this.recordUsage(
      selected,
      usageRequestId,
      "openai-chat-completions",
      extractAnthropicTokenUsage(translated),
      outcome === "complete" ? "completed" : "incomplete",
    );
    return outcome;
  }

  private async recordUsage(
    selected: SelectedAnthropicUpstream,
    requestId: string,
    protocol: UsageProtocol,
    usage: NormalizedTokenUsage | undefined,
    outcome: UsageOutcome,
  ): Promise<void> {
    protocol = this.resolvedProtocols.get(logicalRouteKey(selected.route.route)) ?? protocol;
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
          client: "claude-code",
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
    route: ResolvedAnthropicRoute,
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
          client: "claude-code",
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

  /**
   * Streams upstream SSE to the client. `isTerminal` detects the logical end;
   * `translate` (optional) maps upstream frames to Anthropic frames.
   * Returns true when a terminal frame was seen.
   */
  private async pipeSse(
    response: ServerResponse,
    body: ReadableStream<Uint8Array>,
    isTerminal: (event: { readonly data?: string }) => boolean | Promise<boolean>,
    translate?: (event: { readonly data?: string }) => readonly AnthropicStreamEvent[],
    generationFinished?: () => boolean,
  ): Promise<boolean> {
    const decoder = new SseDecoder();
    const reader = body.getReader();
    let terminalSeen = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
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
          const terminal = await isTerminal(event);
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
          if (generationFinished?.() === true && completionTimer === undefined) {
            completionTimer = setTimeout(() => {
              void reader.cancel().catch(() => undefined);
            }, 1_000);
            completionTimer.unref?.();
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
      if (completionTimer !== undefined) clearTimeout(completionTimer);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!terminalSeen && translate === undefined && !response.destroyed && !response.writableEnded) response.write(encodeAnthropicEvent({
      event: "error",
      data: { type: "error", error: { type: "api_error", message: "Provider stream ended before a complete answer; the request was not replayed." } },
    }));
    return terminalSeen;
  }

  private handleUnexpectedError(response: ServerResponse, error: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof BridgeRequestError) {
      sendAnthropicError(
        response,
        error.status,
        error.type,
        error.message,
        error.headers,
      );
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
    if (error instanceof TurnLedgerPersistenceError) {
      sendAnthropicError(
        response,
        503,
        "UNKNOWN",
        "Turn ledger storage is unavailable; the request was blocked for safety.",
      );
      return;
    }
    if (error instanceof ProviderRequestError) {
      sendAnthropicError(
        response,
        providerErrorStatus(error.type),
        error.type,
        error.message,
      );
      return;
    }
    sendAnthropicError(response, 500, "UNKNOWN", "ProviderDock Anthropic bridge request failed.");
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
  if (error instanceof AnthropicTranslationError || error instanceof SseDecodeError) {
    return {
      errorType:
        error instanceof AnthropicTranslationError
          ? error.type
          : "STREAM_ERROR",
      phase: "unknown",
      message: error.message,
    };
  }
  return undefined;
}

function anthropicProtocolForRoute(route: ResolvedAnthropicRoute): UsageProtocol {
  return route.mode === "openai-chat"
    ? "openai-chat-completions"
    : "anthropic-messages";
}

function fallbackBlockHeaders(code: string): Headers {
  return new Headers({ "x-providerdock-fallback-block": code });
}

function resolveBridgeMode(profile: ProviderProfile): BridgeMode {
  // GoRouter exposes both OpenAI Chat Completions and the native Claude
  // Messages endpoint. Claude Code must use the native route so thinking,
  // signatures and new Anthropic fields are preserved without lossy mapping.
  if (profile.apiType === "anthropic-messages" ||
    (profile.apiType === "auto" && profile.adapterId === "gorouter")) {
    return "native-anthropic";
  }
  if (["auto", "openai-chat-completions", "openai-responses"].includes(profile.apiType)) {
    return "openai-chat";
  }
  throw new ProviderRequestError(
    "UNSUPPORTED_FEATURE",
    `Anthropic bridge cannot serve provider API type '${profile.apiType}'.`,
  );
}

function isClaudeModelId(model: string): boolean {
  return /(^|[/_.:-])claude([/_.:-]|$)/i.test(model);
}

/** Statuses that prove the native request was rejected before generation. */
function isDefinitiveNativeRouteRejection(status: number): boolean {
  return [400, 401, 403, 404, 405, 415, 422, 501].includes(status);
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
  private stopReason: string | undefined;

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

    if (parsed.type === "message_delta") {
      const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
      if (typeof delta?.stop_reason === "string") this.stopReason = delta.stop_reason;
    } else if (parsed.type === "content_block_start") {
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
          let deltaInput: unknown;
          try {
            deltaInput = JSON.parse(state.partialJson);
          } catch (error) {
            throw new AnthropicTranslationError(
              "PROTOCOL_ERROR",
              `Native Anthropic tool block ${index} ended with malformed JSON input.`,
              { cause: error },
            );
          }
          if (!isRecord(deltaInput)) {
            throw new AnthropicTranslationError(
              "PROTOCOL_ERROR",
              `Native Anthropic tool block ${index} input delta must be a JSON object.`,
            );
          }
          // Anthropic normally starts tool input with {} and streams the full
          // object as input_json_delta. Some compatible providers (including
          // GoRouter/Bedrock routes) put defaulted fields in content_block_start
          // and stream the remaining fields. Claude Code merges both pieces,
          // so the anti-replay hash must be built from the same merged object.
          input = { ...state.initialInput, ...deltaInput };
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
      if (!this.stopReason || !["end_turn", "stop_sequence", "tool_use", "max_tokens", "pause_turn", "refusal"].includes(this.stopReason)) {
        throw new AnthropicTranslationError("PROTOCOL_ERROR", "Native Anthropic stream ended without a valid stop reason.");
      }
      return { terminal: true, terminalError: this.stopReason === "max_tokens" || this.stopReason === "pause_turn" };
    } else if (parsed.type === "error") {
      return { terminal: true, terminalError: true };
    }
    return { terminal: false, terminalError: false };
  }
}

function extractAnthropicSseUsage(
  data: string,
): NormalizedTokenUsage | undefined {
  try {
    return extractAnthropicTokenUsage(JSON.parse(data));
  } catch {
    return undefined;
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
): void {
  const guidance = providerErrorGuidance(type);
  const errorPayload: Record<string, unknown> = {
    type: anthropicErrorType(status),
    message,
  };
  sendJson(
    response,
    status,
    {
      type: "error",
      error: errorPayload,
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
  if (type === "INVALID_REQUEST" || type === "UNSUPPORTED_FEATURE") return 400;
  if (type === "AUTH_ERROR") return 401;
  if (type === "PERMISSION_ERROR") return 403;
  if (type === "TIMEOUT") return 504;
  return 502;
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

function nativeMessageOutcome(payload: Record<string, unknown>): "complete" | "incomplete" {
  if (payload.role !== "assistant" || !Array.isArray(payload.content) || !payload.content.length ||
      !["end_turn", "stop_sequence", "tool_use", "max_tokens", "pause_turn", "refusal"].includes(String(payload.stop_reason))) {
    throw new ProviderRequestError("INCOMPLETE_RESPONSE", "Native Messages response is missing assistant content or a terminal stop_reason.");
  }
  if (payload.stop_reason === "tool_use" && !payload.content.some(item => isRecord(item) && item.type === "tool_use")) {
    throw new ProviderRequestError("PROTOCOL_ERROR", "Native Messages response finished for tools without a tool call.");
  }
  return payload.stop_reason === "max_tokens" || payload.stop_reason === "pause_turn" ? "incomplete" : "complete";
}
