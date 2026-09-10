import { describe, expect, it, vi } from "vitest";
import { GenericOpenAiAdapter, GenericAnthropicAdapter, MemorySecretStore, ProviderAdapterRegistry, ProviderDoctor, parseProviderProfile } from "../src/index.js";
import type { DoctorProtocol } from "../src/diagnostics/provider-doctor.js";

const protocols: DoctorProtocol[] = ["openai-responses", "openai-chat-completions", "anthropic-messages"];
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const call = { type: "function_call", call_id: "call-once", name: "providerdock_echo", arguments: '{"value":"ok"}' };
const reasoning = { type: "reasoning", id: "reasoning", summary: [], encrypted_content: "synthetic-state" };

function textResponse(protocol: DoctorProtocol, text: string, repeat = false): Record<string, unknown> {
  if (protocol === "openai-responses") return { id: "r", status: "completed", output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    ...(repeat ? [{ ...call, call_id: "call-again" }] : []),
  ], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
  if (protocol === "anthropic-messages") return { id: "m", type: "message", role: "assistant", stop_reason: repeat ? "tool_use" : "end_turn",
    content: [{ type: "text", text }, ...(repeat ? [{ type: "tool_use", id: "again", name: call.name, input: { value: "ok" } }] : [])], usage: { input_tokens: 2, output_tokens: 1 } };
  return { id: "c", choices: [{ finish_reason: repeat ? "tool_calls" : "stop", message: { role: "assistant", content: text,
    ...(repeat ? { tool_calls: [{ id: "again", type: "function", function: { name: call.name, arguments: call.arguments } }] } : {}) } }], usage: { prompt_tokens: 2, completion_tokens: 1 } };
}

async function run(protocol: DoctorProtocol, outcome: "correct" | "wrong" | "repeat", terminal = "completed") {
  let firstOutput: unknown;
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/models")) return json({ data: [{ id: "fixture-model" }] });
    const body = JSON.parse(String(init?.body));
    if (body.stream) {
      const streamEvents = protocol === "openai-responses"
        ? [{ type: `response.${terminal}`, response: { ...textResponse(protocol, "OK"), status: terminal } }]
        : protocol === "anthropic-messages"
          ? [{ type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]
          : [{ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }];
      return new Response(streamEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (!body.tools) return json(textResponse(protocol, "OK"));
    const continuation = Array.isArray(body.input) || body.messages?.length > 1;
    if (!continuation) {
      if (protocol === "openai-responses") {
        firstOutput = [reasoning, call];
        return json({ id: "r-first", status: "completed", output: firstOutput });
      }
      if (protocol === "anthropic-messages") {
        firstOutput = [{ type: "thinking", thinking: "Synthetic", signature: "synthetic-signature" },
          { type: "tool_use", id: call.call_id, name: call.name, input: { value: "ok" } }];
        return json({ id: "m-first", content: firstOutput, stop_reason: "tool_use" });
      }
      firstOutput = { role: "assistant", content: null, reasoning_content: "Synthetic reasoning",
        tool_calls: [{ id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } }] };
      return json({ choices: [{ finish_reason: "tool_calls", message: firstOutput }] });
    }
    let result: { receipt: string };
    if (protocol === "openai-responses") {
      expect(body.input.slice(1, -1)).toEqual(firstOutput);
      expect(body.input.at(-1).call_id).toBe(call.call_id);
      result = JSON.parse(body.input.at(-1).output);
      expect(body.tool_choice).toBe("auto");
    } else if (protocol === "anthropic-messages") {
      expect(body.messages[1].content).toEqual(firstOutput);
      expect(body.messages[2].content[0].tool_use_id).toBe(call.call_id);
      result = JSON.parse(body.messages[2].content[0].content);
      expect(body.tool_choice).toEqual({ type: "auto" });
    } else {
      expect(body.messages[1]).toEqual(firstOutput);
      expect(body.messages[2].tool_call_id).toBe(call.call_id);
      result = JSON.parse(body.messages[2].content);
      expect(body.tool_choice).toBe("auto");
    }
    expect(result.receipt).toMatch(/^receipt-/);
    const initialRequest = JSON.parse(String(fetchMock.mock.calls.at(-2)?.[1]?.body));
    expect(JSON.stringify(initialRequest)).not.toContain(result.receipt);
    return json(textResponse(protocol, outcome === "wrong" ? "I did something unrelated" : result.receipt, outcome === "repeat"));
  });
  const secretStore = new MemorySecretStore();
  const adapterRegistry = new ProviderAdapterRegistry()
    .register(new GenericOpenAiAdapter({ secretStore, fetchImpl: fetchMock }))
    .register(new GenericAnthropicAdapter({ secretStore, fetchImpl: fetchMock }));
  const doctor = new ProviderDoctor({ secretStore, adapterRegistry, fetchImpl: fetchMock });
  const report = await doctor.run(parseProviderProfile({ id: "test", displayName: "Test", baseUrl: "https://fixture.invalid/v1", apiType: protocol }), { level: 3 });
  return { report, fetchMock };
}

describe.each(protocols)("Doctor tool history over %s", (protocol) => {
  it("preserves the first response and requires the receipt from the tool result", async () => {
    const { report, fetchMock } = await run(protocol, "correct");
    expect(report.verdict).toBe("PASS");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it.each(["wrong", "repeat"] as const)("rejects a %s continuation even when it contains text", async (outcome) => {
    const { report, fetchMock } = await run(protocol, outcome);
    expect(report.checks.find((check) => check.name === "tools")?.status).toBe("FAIL");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

it.each(["failed", "incomplete"])("Doctor does not pass response.%s streaming", async (terminal) => {
  const { report } = await run("openai-responses", "correct", terminal);
  expect(report.checks.find((check) => check.name === "streaming")?.status).toBe("FAIL");
});
