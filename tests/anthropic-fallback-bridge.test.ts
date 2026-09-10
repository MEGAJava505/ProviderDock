import { describe, expect, it, vi } from "vitest";
import {
  AnthropicBridgeServer,
  MemorySecretStore,
  parseLogicalModelGroup,
  parseProviderProfile,
  type FallbackNotification,
  type ProviderProfile,
  type ProviderRuntimeHealthSignal,
} from "../src/index.js";

describe("Anthropic bridge safe fallback", () => {
  it("switches from native Anthropic to Chat after connection refusal and stays sticky", async () => {
    const notifications: FallbackNotification[] = [];
    const healthSignals: ProviderRuntimeHealthSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith("https://primary.test/")) {
        throw connectionRefused();
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "secondary-model", stream: false });
      expect(Array.isArray(body.messages)).toBe(true);
      return chatResponse("secondary answer");
    });
    const bridge = fallbackBridge(fetchMock, {
      onFallback: (notification) => notifications.push(notification),
      healthSignalSink: (signal) => healthSignals.push(signal),
    });
    const address = await bridge.start();

    try {
      const first = await post(address.url, "first turn");
      expect(first.status).toBe(200);
      expect(first.headers.get("x-providerdock-fallback")).toBe("true");
      expect(first.headers.get("x-providerdock-fallback-from")).toBe("primary");
      expect(first.headers.get("x-providerdock-fallback-to")).toBe("secondary");
      expect(first.headers.get("x-providerdock-provider-id")).toBe("secondary");
      expect(await first.json()).toMatchObject({
        type: "message",
        model: "secondary-model",
        content: [{ type: "text", text: "secondary answer" }],
      });
      expect(notifications).toEqual([
        expect.objectContaining({
          logicalModelId: "logical-claude",
          from: {
            providerId: "primary",
            modelId: "primary-model",
            priority: 100,
            enabled: true,
          },
          to: {
            providerId: "secondary",
            modelId: "secondary-model",
            priority: 90,
            enabled: true,
          },
          errorType: "NETWORK_ERROR",
          phase: "connection-failed",
        }),
      ]);
      expect(healthSignals).toEqual([
        expect.objectContaining({
          providerId: "primary",
          logicalModelId: "logical-claude",
          outcome: "failed",
          errorType: "NETWORK_ERROR",
        }),
        expect.objectContaining({
          providerId: "secondary",
          logicalModelId: "logical-claude",
          outcome: "completed",
        }),
      ]);
      expect(new Set(healthSignals.map((signal) => signal.requestId)).size).toBe(1);

      const health = await (await fetch(`${address.url}/health`)).json();
      expect(health).toMatchObject({
        provider_id: "primary",
        active_provider_id: "secondary",
        logical_model_id: "logical-claude",
        mode: "openai-chat",
        fallback: {
          stickyRouteKey: "secondary:secondary-model",
          fallbackCount: 1,
        },
      });

      const second = await post(address.url, "second turn");
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
      .mockResolvedValueOnce(chatResponse("safe fallback"));
    const safeBridge = fallbackBridge(safeFetch);
    const safeAddress = await safeBridge.start();
    try {
      const response = await post(safeAddress.url, "safe rejection");
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
      const response = await post(ambiguousAddress.url, "ambiguous gateway");
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
    const toolUse = {
      type: "tool_use",
      id: "toolu-1",
      name: "write_file",
      input: { path: "a.txt" },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(nativeMessage([toolUse], "tool_use"))
      .mockRejectedValueOnce(connectionRefused())
      .mockResolvedValueOnce(chatResponse("continued safely"));
    const bridge = fallbackBridge(fetchMock);
    const address = await bridge.start();

    try {
      const first = await post(address.url, "call a tool");
      expect(first.status).toBe(200);
      await first.json();

      const continuation = await postMessages(address.url, {
        model: "logical-claude",
        max_tokens: 16,
        messages: [
          { role: "user", content: "call a tool" },
          { role: "assistant", content: [toolUse] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu-1", content: "written" },
            ],
          },
        ],
      });
      expect(continuation.status).toBe(200);
      expect(continuation.headers.get("x-providerdock-fallback")).toBe("true");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await bridge.stop();
    }

    const ambiguousFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(nativeMessage([toolUse], "tool_use"))
      .mockRejectedValueOnce(connectionRefused());
    const ambiguousBridge = fallbackBridge(ambiguousFetch);
    const ambiguousAddress = await ambiguousBridge.start();
    try {
      const first = await post(ambiguousAddress.url, "call another tool");
      expect(first.status).toBe(200);
      await first.json();

      const response = await postMessages(ambiguousAddress.url, {
        model: "logical-claude",
        max_tokens: 16,
        messages: [
          { role: "user", content: "call another tool" },
          { role: "assistant", content: [toolUse] },
        ],
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

  it("never tries another route after a native stream has started", async () => {
    const source = [
      anthropicEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg-partial",
          type: "message",
          role: "assistant",
          model: "primary-model",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }),
      anthropicEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      anthropicEvent("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      }),
      // EOF deliberately arrives without content_block_stop/message_stop.
    ].join("");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const bridge = fallbackBridge(fetchMock);
    const address = await bridge.start();

    try {
      const response = await postMessages(address.url, {
        model: "logical-claude",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "stream" }],
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"text":"partial"');
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
      const response = await postMessages(address.url, {
        model: "unrelated-model",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
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
    readonly healthSignalSink?: (signal: ProviderRuntimeHealthSignal) => void;
  } = {},
): AnthropicBridgeServer {
  const primary = provider("primary", "anthropic-messages");
  const secondary = provider("secondary", "openai-chat-completions");
  return new AnthropicBridgeServer({
    profile: primary,
    secretStore: new MemorySecretStore(),
    fetchImpl,
    sessionId: "66666666666666666666666666666666",
    fallback: {
      logicalModel: parseLogicalModelGroup({
        id: "logical-claude",
        routes: [
          { providerId: "primary", modelId: "primary-model", priority: 100 },
          { providerId: "secondary", modelId: "secondary-model", priority: 90 },
        ],
      }),
      profiles: [primary, secondary],
    },
    ...(options.onFallback === undefined ? {} : { onFallback: options.onFallback }),
    ...(options.healthSignalSink === undefined
      ? {}
      : { healthSignalSink: options.healthSignalSink }),
  });
}

function provider(
  id: string,
  apiType: "anthropic-messages" | "openai-chat-completions",
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

function nativeMessage(content: readonly unknown[], stopReason = "end_turn"): Response {
  return new Response(
    JSON.stringify({
      id: "msg-native",
      type: "message",
      role: "assistant",
      model: "primary-model",
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
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
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function post(baseUrl: string, content: string): Promise<Response> {
  return postMessages(baseUrl, {
    model: "logical-claude",
    max_tokens: 16,
    messages: [{ role: "user", content }],
  });
}

function postMessages(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function anthropicEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
