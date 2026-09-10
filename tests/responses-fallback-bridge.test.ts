import { describe, expect, it, vi } from "vitest";
import {
  MemorySecretStore,
  ResponsesBridgeServer,
  encodeSseEvent,
  parseLogicalModelGroup,
  parseProviderProfile,
  type FallbackNotification,
  type ProviderProfile,
  type ProviderRuntimeHealthSignal,
  type UsageTelemetryEvent,
} from "../src/index.js";

describe("Responses bridge safe fallback", () => {
  it("switches after a proven connection failure, notifies, and keeps the route sticky", async () => {
    const notifications: FallbackNotification[] = [];
    const usageEvents: UsageTelemetryEvent[] = [];
    const healthSignals: ProviderRuntimeHealthSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith("https://primary.test/")) {
        throw connectionRefused();
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "secondary-model", stream: false });
      return chatResponse("Secondary answer");
    });
    const bridge = fallbackBridge(fetchMock, {
      onFallback: (notification) => notifications.push(notification),
      secondaryApiType: "openai-chat-completions",
      usageSink: (event) => usageEvents.push(event),
      healthSignalSink: (signal) => healthSignals.push(signal),
    });
    const address = await bridge.start();

    try {
      const first = await post(address.baseUrl, "first turn");
      expect(first.status).toBe(200);
      expect(first.headers.get("x-providerdock-fallback")).toBe("true");
      expect(first.headers.get("x-providerdock-fallback-from")).toBe("primary");
      expect(first.headers.get("x-providerdock-fallback-to")).toBe("secondary");
      expect(first.headers.get("x-providerdock-provider-id")).toBe("secondary");
      expect(await first.json()).toMatchObject({
        status: "completed",
        output: [{ type: "message", content: [{ text: "Secondary answer" }] }],
      });
      expect(notifications).toEqual([
        expect.objectContaining({
          logicalModelId: "logical-x",
          from: { providerId: "primary", modelId: "primary-model", priority: 100, enabled: true },
          to: { providerId: "secondary", modelId: "secondary-model", priority: 90, enabled: true },
          errorType: "NETWORK_ERROR",
          phase: "connection-failed",
        }),
      ]);
      expect(usageEvents).toEqual([
        expect.objectContaining({
          providerId: "secondary",
          modelId: "secondary-model",
          logicalModelId: "logical-x",
          protocol: "openai-chat-completions",
          usage: expect.objectContaining({ totalTokens: 12 }),
        }),
      ]);
      expect(healthSignals).toEqual([
        expect.objectContaining({
          providerId: "primary",
          logicalModelId: "logical-x",
          outcome: "failed",
          errorType: "NETWORK_ERROR",
        }),
        expect.objectContaining({
          providerId: "secondary",
          logicalModelId: "logical-x",
          outcome: "completed",
        }),
      ]);
      expect(new Set(healthSignals.map((signal) => signal.requestId)).size).toBe(1);

      const health = await (await fetch(`${address.url}/health`)).json();
      expect(health).toMatchObject({
        provider_id: "primary",
        active_provider_id: "secondary",
        logical_model_id: "logical-x",
        fallback: { stickyRouteKey: "secondary:secondary-model", fallbackCount: 1 },
      });

      const second = await post(address.baseUrl, "second turn");
      expect(second.status).toBe(200);
      await second.json();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(String(fetchMock.mock.calls[2]?.[0]).startsWith("https://secondary.test/")).toBe(
        true,
      );
    } finally {
      await bridge.stop();
    }
  });

  it("falls back for an explicit 503 rejection but blocks an ambiguous 502", async () => {
    const safeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(nativeResponse("secondary-ok"));
    const safeBridge = fallbackBridge(safeFetch);
    const safeAddress = await safeBridge.start();
    try {
      const response = await post(safeAddress.baseUrl, "safe rejection");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-providerdock-fallback-reason")).toBe(
        "PROVIDER_UNAVAILABLE",
      );
      expect(safeFetch).toHaveBeenCalledTimes(2);
    } finally {
      await safeBridge.stop();
    }

    const ambiguousFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("bad gateway", { status: 502 }));
    const ambiguousBridge = fallbackBridge(ambiguousFetch);
    const ambiguousAddress = await ambiguousBridge.start();
    try {
      const response = await post(ambiguousAddress.baseUrl, "ambiguous gateway");
      expect(response.status).toBe(502);
      expect(response.headers.get("x-providerdock-fallback-block")).toBe(
        "FALLBACK_STATE_AMBIGUOUS",
      );
      expect(ambiguousFetch).toHaveBeenCalledTimes(1);
    } finally {
      await ambiguousBridge.stop();
    }
  });

  it("continues with complete tool history but blocks ambiguous side-effect history", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(toolCallResponse())
      .mockRejectedValueOnce(connectionRefused())
      .mockResolvedValueOnce(nativeResponse("continued safely"));
    const bridge = fallbackBridge(fetchMock);
    const address = await bridge.start();

    try {
      const first = await post(address.baseUrl, "call a tool");
      const firstBody = (await first.json()) as { output: Array<Record<string, unknown>> };
      const call = firstBody.output[0];
      const continuation = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "logical-x",
          input: [
            call,
            { type: "function_call_output", call_id: "call-1", output: "done" },
          ],
          stream: false,
        }),
      });
      expect(continuation.status).toBe(200);
      expect(continuation.headers.get("x-providerdock-fallback")).toBe("true");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await bridge.stop();
    }

    const ambiguousFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(toolCallResponse())
      .mockRejectedValueOnce(connectionRefused());
    const ambiguousBridge = fallbackBridge(ambiguousFetch);
    const ambiguousAddress = await ambiguousBridge.start();
    try {
      const first = await post(ambiguousAddress.baseUrl, "call another tool");
      const firstBody = (await first.json()) as { output: Array<Record<string, unknown>> };
      const response = await fetch(`${ambiguousAddress.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "logical-x",
          input: firstBody.output,
          stream: false,
        }),
      });
      expect(response.status).toBe(502);
      expect(response.headers.get("x-providerdock-fallback-block")).toBe(
        "FALLBACK_STATE_AMBIGUOUS",
      );
      expect(ambiguousFetch).toHaveBeenCalledTimes(2);
    } finally {
      await ambiguousBridge.stop();
    }
  });

  it("never replays a route after upstream output has started", async () => {
    const pendingItem = {
      id: "message-1",
      type: "message",
      status: "in_progress",
      content: [],
    };
    const brokenStream = [
      encodeSseEvent({
        event: "response.output_item.added",
        data: JSON.stringify({
          type: "response.output_item.added",
          sequence_number: 0,
          output_index: 0,
          item: pendingItem,
        }),
        comments: [],
      }),
      encodeSseEvent({
        event: "response.output_text.delta",
        data: JSON.stringify({
          type: "response.output_text.delta",
          sequence_number: 1,
          output_index: 0,
          content_index: 0,
          delta: "partial",
        }),
        comments: [],
      }),
      // EOF deliberately arrives without output_item.done or a terminal event.
    ].join("");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(brokenStream, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const bridge = fallbackBridge(fetchMock);
    const address = await bridge.start();

    try {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "logical-x", input: "stream", stream: true }),
      });
      expect(response.status).toBe(200);
      const source = await response.text();
      expect(source).toContain("response.output_text.delta");
      expect(source).toContain("response.failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });

  it("rejects a model outside the configured logical-model boundary", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const bridge = fallbackBridge(fetchMock);
    const address = await bridge.start();

    try {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "unrelated-model", input: "hello", stream: false }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        providerdock: { normalized_type: "INVALID_REQUEST" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await bridge.stop();
    }
  });
});

function fallbackBridge(
  fetchImpl: typeof fetch,
  options: {
    readonly onFallback?: (notification: FallbackNotification) => void;
    readonly secondaryApiType?: "openai-responses" | "openai-chat-completions";
    readonly usageSink?: (event: UsageTelemetryEvent) => void;
    readonly healthSignalSink?: (signal: ProviderRuntimeHealthSignal) => void;
  } = {},
): ResponsesBridgeServer {
  const primary = provider("primary", "openai-responses");
  const secondary = provider(
    "secondary",
    options.secondaryApiType ?? "openai-responses",
  );
  return new ResponsesBridgeServer({
    profile: primary,
    secretStore: new MemorySecretStore(),
    fetchImpl,
    models: [{ modelId: "logical-x" }],
    fallback: {
      logicalModel: parseLogicalModelGroup({
        id: "logical-x",
        routes: [
          { providerId: "primary", modelId: "primary-model", priority: 100 },
          { providerId: "secondary", modelId: "secondary-model", priority: 90 },
        ],
      }),
      profiles: [primary, secondary],
    },
    heartbeatIntervalMs: 0,
    sessionId: "55555555555555555555555555555555",
    ...(options.onFallback === undefined ? {} : { onFallback: options.onFallback }),
    ...(options.usageSink === undefined ? {} : { usageSink: options.usageSink }),
    ...(options.healthSignalSink === undefined
      ? {}
      : { healthSignalSink: options.healthSignalSink }),
  });
}

function provider(
  id: string,
  apiType: "openai-responses" | "openai-chat-completions",
): ProviderProfile {
  return parseProviderProfile({
    id,
    displayName: id,
    baseUrl: `https://${id}.test/v1`,
    apiType,
    timeoutMs: 1_000,
  });
}

function connectionRefused(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
  });
}

function nativeResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: `response-${text}`,
      object: "response",
      status: "completed",
      output: [
        {
          id: "message-1",
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function chatResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "chat-response",
      model: "secondary-model",
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: text } },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function toolCallResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "response-tool",
      object: "response",
      status: "completed",
      output: [
        {
          id: "item-call-1",
          type: "function_call",
          status: "completed",
          call_id: "call-1",
          name: "diagnostic",
          arguments: "{}",
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function post(baseUrl: string, input: string): Promise<Response> {
  return fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "logical-x", input, stream: false }),
  });
}
