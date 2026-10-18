import { describe, expect, it, vi } from "vitest";
import {
  GenericAnthropicAdapter,
  GenericOpenAiAdapter,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderDoctor,
  classifyResponsesStructure,
  doctorReportToCapabilitySnapshot,
  parseProviderProfile,
  type DoctorReport,
} from "../src/index.js";

function doctorWith(fetchImpl: typeof fetch): ProviderDoctor {
  const secrets = new MemorySecretStore();
  const registry = new ProviderAdapterRegistry().register(
    new GenericOpenAiAdapter({ secretStore: secrets, fetchImpl }),
  ).register(new GenericAnthropicAdapter({ secretStore: secrets, fetchImpl }));
  return new ProviderDoctor({ secretStore: secrets, adapterRegistry: registry, fetchImpl });
}

const profile = parseProviderProfile({
  id: "router",
  displayName: "Test Router",
  baseUrl: "https://upstream.test/v1",
  apiType: "openai-responses",
  timeoutMs: 2_000,
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ProviderDoctor", () => {
  it("records the configuration and credential reference used for a Doctor run", async () => {
    const doctor = doctorWith(async () => json({ data: [{ id: "gpt-x" }] }));
    const first = await doctor.run(profile, { level: 0 });
    const changed = await doctor.run({
      ...profile, auth: { kind: "bearer", secretRef: "different-key" },
    }, { level: 0 });
    expect(first.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(changed.configurationFingerprint).not.toBe(first.configurationFingerprint);
  });

  it("does not certify a run whose secret changed during inference", async () => {
    const secrets = new MemorySecretStore({ "api.key": "old-secret" });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (String(input).includes("/models")) return json({ data: [{ id: "gpt-x" }] });
      await secrets.set("api.key", "new-secret");
      return json({ id: "r", status: "completed", output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
      ] });
    });
    const registry = new ProviderAdapterRegistry().register(new GenericOpenAiAdapter({ secretStore: secrets, fetchImpl: fetchMock }));
    const report = await new ProviderDoctor({ secretStore: secrets, adapterRegistry: registry, fetchImpl: fetchMock })
      .run({ ...profile, auth: { kind: "bearer", secretRef: "api.key" } }, { level: 1 });
    expect(report.verdict).toBe("FAIL");
    expect(report.credentialFingerprint).toBeUndefined();
  });

  it("runs level 3 diagnostics against a healthy Responses provider", async () => {
    const completedText = {
      id: "resp-1",
      object: "response",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
      ],
      usage: { input_tokens: 4, output_tokens: 1 },
    };
    const toolCallResponse = {
      id: "resp-2",
      object: "response",
      status: "completed",
      output: [
        { type: "function_call", call_id: "call-1", name: "providerdock_echo", arguments: '{"value":"ok"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const streamSource = [
      'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"resp-3"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"delta":"OK"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":2,"response":{"id":"resp-3","status":"completed","output":[]}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/models")) return json({ data: [{ id: "gpt-x" }] });
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.stream === true) {
        return new Response(streamSource, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (Array.isArray(body.tools)) {
        // First tool request returns the call; the continuation has input history.
        if (!Array.isArray(body.input)) return json(toolCallResponse);
        const result = body.input.find((item: { type: string }) => item.type === "function_call_output") as { output: string };
        return json({ ...completedText, output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.parse(result.output).receipt }] },
        ] });
      }
      return json(completedText);
    });

    const doctor = doctorWith(fetchMock);
    const report = await doctor.run(profile, { level: 3 });

    expect(report.verdict).toBe("PASS");
    expect(report.modelId).toBe("gpt-x");
    expect(report.protocol).toBe("openai-responses");
    expect(report.checks.map((check) => [check.name, check.status])).toEqual([
      ["connectivity+models", "PASS"],
      ["inference", "PASS"],
      ["streaming", "PASS"],
      ["tools", "PASS"],
    ]);
  });

  it("does not certify streaming when Responses emits only a terminal event", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input).includes("/models")) return json({ data: [{ id: "gpt-x" }] });
      const body = JSON.parse(String(init?.body ?? "{}")) as { stream?: boolean };
      if (body.stream) return new Response(
        'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
      return json({ id: "r", status: "completed", output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
      ] });
    });
    const report = await doctorWith(fetchMock).run(profile, { level: 2 });
    expect(report.checks.find((check) => check.name === "streaming")?.status).toBe("DEGRADED");
    expect(report.verdict).toBe("DEGRADED");
  });

  it("stops at level 0 for auth failures and never sends inference", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("denied", { status: 401 }));
    const doctor = doctorWith(fetchMock);
    const report = await doctor.run(profile, { level: 3 });

    expect(report.verdict).toBe("FAIL");
    expect(report.checks[0]).toMatchObject({
      name: "connectivity+models",
      status: "FAIL",
      errorType: "AUTH_ERROR",
    });
    // Only the /models call happened; no paid inference was attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(report.checks.slice(1).every((check) => check.status === "SKIPPED")).toBe(true);
  });

  it("classifies a successful-HTTP provider error envelope without retaining its message", async () => {
    const secretMarker = "provider-secret-marker";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/models")) return json({ data: [{ id: "gpt-x" }] });
      return json({
        code: "Throttling.AllocationQuota",
        message: `quota exhausted ${secretMarker}`,
        request_id: "request-1",
      });
    });

    const report = await doctorWith(fetchMock).run(profile, { level: 1 });
    const inference = report.checks.find((check) => check.name === "inference");
    expect(inference).toMatchObject({
      status: "FAIL",
      errorType: "QUOTA_EXCEEDED",
      details: expect.stringContaining("Throttling.AllocationQuota"),
    });
    expect(inference?.details).not.toContain(secretMarker);
  });

  it("marks streaming FAIL when the stream ends without a terminal event", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/models")) return json({ data: [{ id: "gpt-x" }] });
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.stream === true) {
        return new Response(
          'event: response.created\ndata: {"type":"response.created","sequence_number":0,"response":{"id":"r"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return json({
        id: "resp-1",
        object: "response",
        status: "completed",
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] },
        ],
        usage: {},
      });
    });

    const doctor = doctorWith(fetchMock);
    const report = await doctor.run(profile, { level: 2 });
    const streaming = report.checks.find((check) => check.name === "streaming");
    expect(streaming).toMatchObject({ status: "FAIL" });
    expect(report.verdict).toBe("FAIL");
  });

  it("runs native Anthropic inference, streaming, and tool continuation diagnostics", async () => {
    const anthropicProfile = parseProviderProfile({
      id: "anthropic",
      displayName: "Anthropic Test",
      baseUrl: "https://anthropic.test/v1",
      apiType: "anthropic-messages",
      timeoutMs: 2_000,
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return json({ data: [{ id: "claude-x", display_name: "Claude X" }] });
      }
      expect(url).toBe("https://anthropic.test/v1/messages");
      expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.stream === true) {
        return new Response(
          [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-stream","type":"message","role":"assistant","content":[]}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (Array.isArray(body.tools)) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const hasToolResult = messages.some(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            Array.isArray((message as { content?: unknown }).content) &&
            ((message as { content: unknown[] }).content).some(
              (block) =>
                typeof block === "object" &&
                block !== null &&
                (block as { type?: unknown }).type === "tool_result",
            ),
        );
        if (hasToolResult) {
          const result = (messages as { content: { type: string; content: string }[] }[])
            .flatMap((message) => Array.isArray(message.content) ? message.content : [])
            .find((block) => block.type === "tool_result");
          return json({
            id: "msg-final",
            type: "message",
            role: "assistant",
            model: "claude-x",
            content: [{ type: "text", text: JSON.parse(result!.content).receipt }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        }
        expect(body.tool_choice).toEqual({
          type: "tool",
          name: "providerdock_echo",
        });
        return json({
          id: "msg-tool",
          type: "message",
          role: "assistant",
          model: "claude-x",
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "providerdock_echo",
              input: { value: "ok" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 8, output_tokens: 3 },
        });
      }
      return json({
        id: "msg-inference",
        type: "message",
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 1 },
      });
    });

    const report = await doctorWith(fetchMock).run(anthropicProfile, { level: 3 });

    expect(report).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-x",
      protocol: "anthropic-messages",
      level: 3,
      verdict: "PASS",
    });
    expect(report.checkedAt).toMatch(/Z$/);
    expect(report.checks.map((check) => [check.name, check.status])).toEqual([
      ["connectivity+models", "PASS"],
      ["inference", "PASS"],
      ["streaming", "PASS"],
      ["tools", "PASS"],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["openai-responses", "anthropic-messages", "/v1/responses"],
    ["anthropic-messages", "openai-responses", "/v1/messages"],
  ] as const)("forces %s instead of the configured %s protocol", async (
    forcedProtocol,
    configuredApiType,
    expectedPath,
  ) => {
    const forcedProfile = parseProviderProfile({
      id: `forced-${forcedProtocol}`,
      displayName: "Forced protocol",
      baseUrl: "https://forced.test/v1",
      apiType: configuredApiType,
      timeoutMs: 2_000,
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/models") return json({ data: [{ id: "model-x" }] });
      expect(path).toBe(expectedPath);
      return forcedProtocol === "openai-responses"
        ? json({
            id: "resp",
            status: "completed",
            output: [{
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "OK" }],
            }],
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        : json({
            id: "msg",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "OK" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          });
    });

    const report = await doctorWith(fetchMock).run(forcedProfile, {
      level: 1,
      protocol: forcedProtocol,
    });

    expect(report).toMatchObject({ protocol: forcedProtocol, verdict: "PASS" });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname))
      .toEqual(["/v1/models", expectedPath]);
  });

  it("does not fall back after a forced protocol is rejected", async () => {
    const autoProfile = parseProviderProfile({
      id: "forced-failure",
      displayName: "Forced failure",
      baseUrl: "https://forced.test/v1",
      apiType: "auto",
      timeoutMs: 2_000,
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/models") return json({ data: [{ id: "model-x" }] });
      if (path === "/v1/responses") {
        return new Response(JSON.stringify({ error: { message: "unsupported endpoint" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fallback request to ${path}`);
    });

    const report = await doctorWith(fetchMock).run(autoProfile, {
      level: 1,
      protocol: "openai-responses",
    });

    expect(report.protocol).toBeUndefined();
    expect(report.verdict).toBe("FAIL");
    expect(report.checks.at(-1)).toMatchObject({
      name: "inference",
      status: "FAIL",
      errorType: "INVALID_REQUEST",
    });
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname))
      .toEqual(["/v1/models", "/v1/responses"]);
  });
});

describe("doctorReportToCapabilitySnapshot", () => {
  it("maps measured checks and protocol-specific client compatibility", () => {
    const snapshot = doctorReportToCapabilitySnapshot({
      providerId: "router",
      modelId: "gpt-x",
      protocol: "openai-chat-completions",
      level: 3,
      configurationFingerprint: "a".repeat(64),
      checkedAt: "2026-08-30T10:00:00.000Z",
      verdict: "DEGRADED",
      checks: [
        { name: "connectivity+models", status: "PASS" },
        { name: "inference", status: "PASS" },
        { name: "streaming", status: "DEGRADED" },
        { name: "tools", status: "PASS" },
      ],
    });

    expect(snapshot).toMatchObject({
      providerId: "router",
      modelId: "gpt-x",
      doctorLevel: 3,
      configurationFingerprint: "a".repeat(64),
      capabilities: {
        model_discovery: "SUPPORTED",
        text: "SUPPORTED",
        streaming: "DEGRADED",
        tools: "SUPPORTED",
        reasoning: "UNKNOWN",
      },
      codexCompatibility: "ADAPTER",
      claudeCompatibility: "ADAPTER",
    });
  });

  it("keeps transient failures unknown and stores only the final normalized error", () => {
    const report: DoctorReport = {
      providerId: "router",
      modelId: "gpt-x",
      level: 2,
      checkedAt: "2026-08-30T10:00:00.000Z",
      verdict: "FAIL",
      checks: [
        {
          name: "connectivity+models",
          status: "FAIL",
          errorType: "AUTH_ERROR",
          details: "Provider returned HTTP 401.",
        },
        { name: "inference", status: "SKIPPED" },
        { name: "streaming", status: "SKIPPED" },
      ],
    };

    expect(doctorReportToCapabilitySnapshot(report)).toMatchObject({
      capabilities: {
        model_discovery: "UNKNOWN",
        text: "UNKNOWN",
        streaming: "UNKNOWN",
      },
      codexCompatibility: "UNKNOWN",
      claudeCompatibility: "UNKNOWN",
      lastErrorType: "AUTH_ERROR",
      lastErrorMessage: "Provider returned HTTP 401.",
    });
  });

  it("does not create a per-model snapshot when Doctor resolved no model", () => {
    expect(
      doctorReportToCapabilitySnapshot({
        providerId: "router",
        level: 0,
        checkedAt: "2026-08-30T10:00:00.000Z",
        verdict: "DEGRADED",
        checks: [{ name: "connectivity+models", status: "DEGRADED" }],
      }),
    ).toBeUndefined();
  });
});

describe("classifyResponsesStructure (M6.2 structural, secret-free)", () => {
  it("names the native max_output_tokens exhaustion without leaking text", () => {
    const summary = classifyResponsesStructure({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", content: [] }],
      usage: {
        input_tokens: 9, output_tokens: 16, total_tokens: 25,
        output_tokens_details: { reasoning_tokens: 16 },
      },
    });
    expect(summary.classification).toBe("native-incomplete");
    expect(summary.statusCode).toBe("incomplete");
    expect(summary.incompleteReason).toBe("max_output_tokens");
    expect(summary.textOutputPresent).toBe(false);
    expect(summary.outputElementTypes).toEqual(["reasoning"]);
    expect(summary.usage).toEqual({
      inputTokens: 9, outputTokens: 16, totalTokens: 25, reasoningTokens: 16,
    });
  });

  it("distinguishes a completed response that carried no text", () => {
    const summary = classifyResponsesStructure({
      status: "completed", output: [],
      usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
    });
    expect(summary.classification).toBe("completed-without-text");
    expect(summary.statusCode).toBe("completed");
    expect(summary.incompleteReason).toBe("absent");
    expect(summary.textOutputPresent).toBe(false);
    expect(summary.outputElementTypes).toEqual([]);
    expect(summary.usage).toEqual({
      inputTokens: 5, outputTokens: 0, totalTokens: 5, reasoningTokens: null,
    });
  });
  it("flags a proxy response that never sent a native status field", () => {
    const summary = classifyResponsesStructure({ id: "resp_x", model: "m", output: [] });
    expect(summary.classification).toBe("proxy-non-native");
    expect(summary.statusCode).toBe("absent");
    expect(summary.textOutputPresent).toBe(false);
    expect(summary.usage).toEqual({
      inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null,
    });
  });

  it("keeps a completed-with-text response distinct", () => {
    const summary = classifyResponsesStructure({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    });
    expect(summary.classification).toBe("completed-with-text");
    expect(summary.textOutputPresent).toBe(true);
    expect(summary.outputElementTypes).toEqual(["message"]);
  });

  it("reports error envelopes and non-native inputs structurally", () => {
    expect(classifyResponsesStructure({ code: "insufficient_quota", message: "x" }).classification)
      .toBe("error-envelope");
    expect(classifyResponsesStructure({ error: { message: "bad" } }).classification)
      .toBe("error-envelope");
    expect(classifyResponsesStructure({ status: "failed", output: [] }).classification)
      .toBe("native-failed");
    expect(classifyResponsesStructure({ status: "in_progress" }).classification)
      .toBe("in-progress");
    const nonObject = classifyResponsesStructure("nope");
    expect(nonObject.classification).toBe("non-object");
    expect(nonObject.statusCode).toBe("absent");
    expect(nonObject.usage.inputTokens).toBeNull();
  });
  it("emits only sanitized structural fields even when the payload hides a secret", () => {
    const canary = "CANARY-SECRET-7f3a-do-not-leak";
    const summary = classifyResponsesStructure({
      status: canary,
      incomplete_details: { reason: canary },
      id: canary,
      request_id: canary,
      output_text: canary,
      output: [
        { type: canary, content: [] },
        { type: "message", content: [{ type: "output_text", text: canary }] },
      ],
      usage: {
        input_tokens: canary,
        output_tokens: -5,
        total_tokens: Number.NaN,
        output_tokens_details: { reasoning_tokens: "9" },
      },
    });
    expect(JSON.stringify(summary)).not.toContain(canary);
    expect(summary.classification).toBe("proxy-non-native");
    expect(summary.statusCode).toBe("other");
    expect(summary.incompleteReason).toBe("other");
    expect(summary.outputElementTypes).toEqual(["message", "other"]);
    expect(summary.textOutputPresent).toBe(true);
    expect(summary.usage).toEqual({
      inputTokens: null, outputTokens: null, totalTokens: null, reasoningTokens: null,
    });
  });

  it("coerces non-integer, non-finite, negative, and out-of-safe-range usage counts to null", () => {
    const summary = classifyResponsesStructure({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 3.9,
        output_tokens: Number.POSITIVE_INFINITY,
        total_tokens: -1,
        output_tokens_details: { reasoning_tokens: 2.5 },
      },
    });
    expect(summary.usage.inputTokens).toBeNull();
    expect(summary.usage.outputTokens).toBeNull();
    expect(summary.usage.totalTokens).toBeNull();
    expect(summary.usage.reasoningTokens).toBeNull();

    const overflow = classifyResponsesStructure({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: Number.NaN },
    });
    expect(overflow.usage.inputTokens).toBeNull();
    expect(overflow.usage.outputTokens).toBeNull();
  });

  it("preserves safe non-negative integer usage counts, including zero", () => {
    const summary = classifyResponsesStructure({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
      usage: {
        input_tokens: 0,
        output_tokens: 7,
        total_tokens: 7,
        output_tokens_details: { reasoning_tokens: 4 },
      },
    });
    expect(summary.usage.inputTokens).toBe(0);
    expect(summary.usage.outputTokens).toBe(7);
    expect(summary.usage.totalTokens).toBe(7);
    expect(summary.usage.reasoningTokens).toBe(4);
  });
});
