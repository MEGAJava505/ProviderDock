import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assessOmpProviderMappings } from "../src/migration/omp-provider-mapping.js";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";

// Script-only JS helpers: keep their behavior tests in the ordinary test suite.
const helperPath = "../scripts/lib/omp-provider-smoke-policy.mjs";
const { parseSmokeInventory, assertFDriveOutput, hasReadToolResult, hasExpectedRequestShape, containsKey } = await import(helperPath);

function input() {
  return { assessment: assessOmpProviderMappings([parseProviderProfile({
    id: "fixture", displayName: "Fixture", baseUrl: "https://fixture.invalid/v1",
    apiType: "openai-chat-completions", manualModelIds: ["exact-model"],
    auth: { kind: "bearer", secretRef: "fixture.key" },
  })]) };
}

describe("local provider smoke safety policy", () => {
  it("validates the consumed report and strips unconsumed fields before any output", () => {
    const data = input();
    expect(parseSmokeInventory(JSON.stringify({ ...data, privateExtra: "DO_NOT_RETURN" }))).toEqual(data.assessment);
  });

  it.each(["not-json PRIVATE_VALUE", '{"assessment":{"purpose":"PRIVATE_VALUE"}}'])(
    "reports malformed evidence with an input-free error", (text) => {
      expect(() => parseSmokeInventory(text)).toThrow("INVALID_SMOKE_INVENTORY");
      try { parseSmokeInventory(text); } catch (e) { expect(String(e)).not.toContain("PRIVATE_VALUE"); }
    },
  );

  it("rejects arbitrary hashes, diagnostics and false report counts before side effects", () => {
    for (const change of [
      (data: any) => { data.assessment.providers[0].profileSha256 = "PRIVATE_VALUE"; },
      (data: any) => { data.assessment.providers[0].unresolved = ["PRIVATE_VALUE"]; },
      (data: any) => { data.assessment.providers[0].declared.staticHeaderNames = ["Header: PRIVATE_VALUE"]; },
      (data: any) => { data.assessment.counts.total = 3; },
      (data: any) => { data.assessment.providers[0].approvedOrigins = ["https://fixture.invalid"]; },
    ]) {
      const data = input(); change(data);
      expect(() => parseSmokeInventory(JSON.stringify(data))).toThrow("INVALID_SMOKE_INVENTORY");
    }
  });

  it("enforces the F: storage policy before creating artifacts", () => {
    expect(() => assertFDriveOutput("F:\\ProviderDockBuild\\fixture")).not.toThrow();
    expect(() => assertFDriveOutput("F:/ProviderDockBuild/fixture")).not.toThrow();
    for (const path of ["C:\\fixture", "E:\\fixture", "\\\\server\\share", "F:relative", "F:\\"]) {
      expect(() => assertFDriveOutput(path)).toThrow("UNSAFE_SMOKE_OUTPUT_ROOT");
    }
  });

  it("requires the actual structured read result, not a marker in a model or assistant message", () => {
    expect(hasReadToolResult({ model: "OMP_MAPPING_READ_RESULT", messages: [] }, "openai-chat-completions")).toBe(false);
    expect(hasReadToolResult({ messages: [{ role: "assistant", content: "OMP_MAPPING_READ_RESULT" }] }, "openai-chat-completions")).toBe(false);
    expect(hasReadToolResult({ messages: [{
      role: "tool", tool_call_id: "wrong-call", content: "OMP_MAPPING_READ_RESULT",
    }] }, "openai-chat-completions")).toBe(false);
    for (const content of ["OMP_MAPPING_READ_RESULT", [{ type: "text", text: "1: OMP_MAPPING_READ_RESULT" }]]) {
      expect(hasReadToolResult({ messages: [{
        role: "tool", tool_call_id: "call-local-fixture", content,
      }] }, "openai-chat-completions")).toBe(true);
    }
  });

  it("requires a protocol-shaped Responses tool result instead of a marker elsewhere", () => {
    expect(hasReadToolResult({ input: [{
      type: "function_call_output", call_id: "call-local-fixture", output: "OMP_MAPPING_READ_RESULT",
    }] }, "openai-responses")).toBe(true);
    expect(hasReadToolResult({ input: [{
      type: "function_call_output", call_id: "wrong-call", output: "OMP_MAPPING_READ_RESULT",
    }] }, "openai-responses")).toBe(false);
    expect(hasReadToolResult({ input: [{
      type: "message", content: [{ type: "input_text", text: "OMP_MAPPING_READ_RESULT" }],
    }] }, "openai-responses")).toBe(false);
  });

  it("rejects Chat-shaped and nonstreaming requests sent to a Responses endpoint", () => {
    const first = { model: "exact-model", input: "Reply", stream: true };
    const tool = { ...first, tools: [{ type: "function", name: "read", parameters: {} }] };
    const continued = { ...tool, input: [{ type: "function_call_output", call_id: "call-local-fixture", output: "OMP_MAPPING_READ_RESULT" }] };
    expect(hasExpectedRequestShape(first, "openai-responses", false, false)).toBe(true);
    expect(hasExpectedRequestShape(tool, "openai-responses", true, false)).toBe(true);
    expect(hasExpectedRequestShape(continued, "openai-responses", true, true)).toBe(false);
    expect(hasExpectedRequestShape({ ...continued, input: [
      { type: "function_call", call_id: "call-local-fixture", name: "read", arguments: "{}" },
      ...continued.input,
    ] }, "openai-responses", true, true)).toBe(true);
    expect(hasExpectedRequestShape({ ...continued, previous_response_id: "resp-local-fixture" }, "openai-responses", true, true)).toBe(true);
    for (const [invalid, useTool, continuation] of [
      [{ ...first, input: undefined, messages: [{ role: "user", content: "Reply" }] }, false, false],
      [{ ...first, stream: false }, false, false],
      [{ ...tool, tools: [{ type: "function", function: { name: "read" } }] }, true, false],
      [{ ...first, input: [{ type: "function_call_output", call_id: "call-local-fixture", output: "OMP_MAPPING_READ_RESULT" }] }, false, false],
      [{ ...first, previous_response_id: "resp-local-fixture" }, false, false],
      [{ ...continued, input: "OMP_MAPPING_READ_RESULT" }, true, true],
      [{ ...continued, input: [{ type: "function_call_output", call_id: "wrong", output: "OMP_MAPPING_READ_RESULT" }] }, true, true],
    ]) {
      expect(hasExpectedRequestShape(invalid, "openai-responses", useTool, continuation)).toBe(false);
    }
  });

  it("finds fixture keys outside managed homes, including in the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-smoke-policy-"));
    await mkdir(join(root, "project"));
    await mkdir(join(root, "managed"));
    const needle = Buffer.from("FIXTURE_NEEDLE");
    expect(await containsKey(root, needle)).toBe(false);
    await writeFile(join(root, "project", "debug.log"), "prefix FIXTURE_NEEDLE suffix");
    expect(await containsKey(root, needle)).toBe(true);
  });
});
