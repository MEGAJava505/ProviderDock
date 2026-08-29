import { describe, expect, it, vi } from "vitest";
import {
  GenericOpenAiAdapter,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderDoctor,
  parseProviderProfile,
} from "../src/index.js";

function doctorWith(fetchImpl: typeof fetch): ProviderDoctor {
  const secrets = new MemorySecretStore();
  const registry = new ProviderAdapterRegistry().register(
    new GenericOpenAiAdapter({ secretStore: secrets, fetchImpl }),
  );
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
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":1,"response":{"id":"resp-3","status":"completed","output":[]}}\n\n',
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
        return Array.isArray(body.input) ? json(completedText) : json(toolCallResponse);
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
});
