import { describe, expect, it } from "vitest";
import { projectOmpRpcControlFrame } from "../src/clients/omp/omp-rpc-projection.js";

const expected = { requestId: "ours", providerId: "fixture", modelId: "model" };
const sessionId = "01994b10-aaaa-7000-8000-aaaaaaaaaaaa";

describe("OMP private RPC -> public lifecycle boundary", () => {
  it("keeps only verified lifecycle fields, never model headers or arbitrary text", () => {
    const frame = {
      type: "response", command: "get_state", id: "ours", success: true,
      data: {
        model: { id: "model", provider: "fixture", headers: { Authorization: "Bearer fixture-secret" } },
        sessionId, isStreaming: false, systemPrompt: ["fixture-secret"], sessionName: "fixture-secret",
        dumpTools: [{ description: "fixture-secret" }], sessionFile: "private/path", messageCount: 0,
      },
    };
    expect(projectOmpRpcControlFrame(frame, expected)).toEqual({
      type: "state", sessionId, providerId: "fixture", modelId: "model", isStreaming: false,
    });
  });
  it("does not trust unsolicited, wrong-route, or malformed state", () => {
    const frame = {
      type: "response", command: "get_state", id: "ours", success: true,
      data: { model: { id: "model", provider: "fixture" }, sessionId, isStreaming: false },
    };
    expect(projectOmpRpcControlFrame({ ...frame, id: "another-request" }, expected)).toBeUndefined();
    expect(projectOmpRpcControlFrame({ ...frame, data: { ...frame.data, model: { id: "another-model", provider: "fixture" } } }, expected))
      .toEqual({ type: "failure", code: "OMP_RPC_MODEL_MISMATCH" });
    expect(projectOmpRpcControlFrame({ ...frame, data: { ...frame.data, sessionId: "not-a-session" } }, expected))
      .toEqual({ type: "failure", code: "OMP_RPC_INVALID_FRAME" });
  });
  it("does not expose upstream failure strings and ignores non-control frames", () => {
    expect(projectOmpRpcControlFrame({ type: "response", id: "ours", command: "get_state", success: false, error: "fixture-secret" }, expected))
      .toEqual({ type: "failure", code: "OMP_RPC_COMMAND_FAILED" });
    expect(projectOmpRpcControlFrame({ type: "message_update", data: "fixture-secret" }, expected)).toBeUndefined();
    expect(projectOmpRpcControlFrame(null, expected)).toBeUndefined();
  });
  it("projects readiness and idle abort without echoing extra fields", () => {
    expect(projectOmpRpcControlFrame({ type: "ready", protocolVersion: 1, extra: "secret" }, expected))
      .toEqual({ type: "ready", protocolVersion: 1 });
    expect(projectOmpRpcControlFrame({ type: "ready", protocolVersion: 999 }, expected))
      .toEqual({ type: "failure", code: "OMP_RPC_INVALID_FRAME" });
    expect(projectOmpRpcControlFrame({ type: "response", id: "ours", command: "abort", success: true, extra: "secret" }, expected))
      .toEqual({ type: "aborted" });
  });
});
