import { describe, expect, it, vi } from "vitest";
import {
  MemorySecretStore,
  classifyResponsesStructure,
  describeResponsesStructureProbe,
  parseProviderProfile,
  runResponsesStructureProbe,
  type SecretStore,
} from "../src/index.js";

// A synthetic VSLLM-shaped API profile. The API secret is a bearer credential;
// the portal cookie is a SEPARATE decoy that lives outside the ProviderProfile
// and must never appear in the request the probe builds.
const API_SECRET = "API-BEARER-SECRET-do-not-leak";
const DECOY_PORTAL_COOKIE = "PORTAL-COOKIE-16568-should-never-be-sent";
const MODEL_ID = "gpt-5.4-mini";

// The valid fixture uses the canonical VSLLM base with a mocked fetch, so no
// live request is ever sent.
const profile = parseProviderProfile({
  id: "vsllm",
  displayName: "VSLLM Test",
  baseUrl: "https://vsllm.cc/v1",
  apiType: "openai-responses",
  auth: { kind: "bearer", secretRef: "vsllm.api.key" },
  timeoutMs: 2_000,
});

function secrets(): MemorySecretStore {
  return new MemorySecretStore({ "vsllm.api.key": API_SECRET });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const COMPLETED_WITHOUT_TEXT = {
  status: "completed",
  output: [],
  usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
};

describe("runResponsesStructureProbe (M7 one-shot structural path)", () => {
  it("sends exactly one Responses request with the fixed diagnostic contract", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return json(COMPLETED_WITHOUT_TEXT);
    });

    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      ok: true,
      requestCount: 1,
      summary: classifyResponsesStructure(COMPLETED_WITHOUT_TEXT),
    });
    expect(capturedUrl).toBe("https://vsllm.cc/v1/responses");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.redirect).toBe("error");
    const body = JSON.parse(String(capturedInit?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({ model: MODEL_ID, max_output_tokens: 128, stream: false });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(typeof body.input).toBe("string");
  });

  it("uses the profile API auth and never sends the separate portal cookie", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return json(COMPLETED_WITHOUT_TEXT);
    });

    await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: fetchMock,
    });

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_SECRET}`);
    expect(headers.get("cookie")).toBeNull();
    const serializedRequest = `${capturedUrl} ${JSON.stringify([...headers.entries()])} ${String(capturedInit?.body)}`;
    expect(serializedRequest).not.toContain(DECOY_PORTAL_COOKIE);
  });

  it("reads only the profile API secret and no portal-session credential", async () => {
    const reads: string[] = [];
    const spyStore: SecretStore = {
      async get(reference) {
        reads.push(reference);
        return reference === "vsllm.api.key" ? API_SECRET : undefined;
      },
    };
    await runResponsesStructureProbe(profile, {
      secretStore: spyStore,
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json(COMPLETED_WITHOUT_TEXT)),
    });
    expect(reads).toEqual(["vsllm.api.key"]);
  });

  it("classifies a native max_output_tokens exhaustion structurally", async () => {
    const payload = {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "reasoning", content: [] }],
      usage: {
        input_tokens: 9,
        output_tokens: 128,
        total_tokens: 137,
        output_tokens_details: { reasoning_tokens: 128 },
      },
    };
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json(payload)),
    });
    expect(outcome).toEqual({
      ok: true,
      requestCount: 1,
      summary: {
        classification: "native-incomplete",
        statusCode: "incomplete",
        incompleteReason: "max_output_tokens",
        textOutputPresent: false,
        outputElementTypes: ["reasoning"],
        usage: { inputTokens: 9, outputTokens: 128, totalTokens: 137, reasoningTokens: 128 },
      },
    });
  });

  it("classifies a proxy response that never sent a native status field", async () => {
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json({ id: "resp_x", output: [] })),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.summary.classification).toBe("proxy-non-native");
  });

  it.each([
    [401, "AUTH_ERROR"],
    [403, "PERMISSION_ERROR"],
    [429, "RATE_LIMIT"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const)("maps HTTP %s to %s without leaking the error body", async (status, errorType) => {
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(`denied ${API_SECRET}`, { status }),
      ),
    });
    expect(outcome).toEqual({ ok: false, requestCount: 1, errorType });
    expect(JSON.stringify(outcome)).not.toContain(API_SECRET);
  });

  it("normalizes a timeout to TIMEOUT after a single attempt", async () => {
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockImplementation(async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }),
    });
    expect(outcome).toEqual({ ok: false, requestCount: 1, errorType: "TIMEOUT" });
  });

  it("normalizes a transport failure to NETWORK_ERROR after a single attempt", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection reset"));
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: fetchMock,
    });
    expect(outcome).toEqual({ ok: false, requestCount: 1, errorType: "NETWORK_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an oversize response body without buffering it whole", async () => {
    const oversize = json({ status: "completed", filler: "x".repeat(4096) });
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(oversize),
      maxResponseBytes: 64,
    });
    expect(outcome).toEqual({ ok: false, requestCount: 1, errorType: "PROTOCOL_ERROR" });
  });

  it("normalizes invalid JSON to PROTOCOL_ERROR", async () => {
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      ),
    });
    expect(outcome).toEqual({ ok: false, requestCount: 1, errorType: "PROTOCOL_ERROR" });
  });

  it("emits only allowlisted structural fields even when the payload hides a canary", async () => {
    const canary = "CANARY-7f3a-do-not-leak";
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          status: "completed",
          id: canary,
          request_id: canary,
          output_text: canary,
          output: [{ type: "message", content: [{ type: "output_text", text: canary }] }],
          usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
        }),
      ),
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain(API_SECRET);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(Object.keys(outcome.summary).sort()).toEqual([
        "classification", "incompleteReason", "outputElementTypes",
        "statusCode", "textOutputPresent", "usage",
      ]);
    }
  });
});

describe("describeResponsesStructureProbe (M7 dry-run descriptor)", () => {
  it("describes the exact single action without reading a secret or touching the network", () => {
    const throwingStore: SecretStore = {
      async get() {
        throw new Error("dry-run must not read a secret value");
      },
    };
    // The descriptor takes no secret store and no fetch: it cannot perform I/O.
    void throwingStore;
    const plan = describeResponsesStructureProbe(profile, MODEL_ID);
    expect(plan).toEqual({
      origin: "https://vsllm.cc",
      endpoint: "responses",
      modelId: MODEL_ID,
      maxOutputTokens: 128,
      stream: false,
      toolsIncluded: false,
      autoRetry: false,
      maxRequests: 1,
      authKind: "bearer",
      redirect: "error",
      preservedFields: [
        "classification", "statusCode", "incompleteReason",
        "textOutputPresent", "outputElementTypes", "usage",
      ],
      opensPilotGate: false,
      network: "not-sent-in-dry-run",
    });
    expect(JSON.stringify(plan)).not.toContain(API_SECRET);
  });
});

// A secret store that records every read, so we can prove an invalid request is
// refused BEFORE any secret access.
function countingStore(reads: string[]): SecretStore {
  return {
    async get(reference) {
      reads.push(reference);
      return reference === "vsllm.api.key" ? API_SECRET : undefined;
    },
  };
}

const OVERSIZE_BODY = JSON.stringify({ status: "completed", filler: "x".repeat(300_000) });

describe("runResponsesStructureProbe (M7-R validation before secret and network)", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["fractional", 2.5],
    ["above 256 KiB", 262_145],
  ] as const)("refuses maxResponseBytes=%s before reading a secret or fetching", async (_label, bytes) => {
    const reads: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(OVERSIZE_BODY, { status: 200, headers: { "content-type": "application/json" } }),
    );
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: countingStore(reads),
      modelId: MODEL_ID,
      fetchImpl: fetchMock,
      maxResponseBytes: bytes,
    });
    expect(outcome).toEqual({ ok: false, requestCount: 0, errorType: "INVALID_REQUEST" });
    expect(reads).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -1],
    ["above 30000 ms", 30_001],
  ] as const)("refuses maxTimeoutMs=%s before reading a secret or fetching", async (_label, ms) => {
    const reads: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(COMPLETED_WITHOUT_TEXT));
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: countingStore(reads),
      modelId: MODEL_ID,
      fetchImpl: fetchMock,
      maxTimeoutMs: ms,
    });
    expect(outcome).toEqual({ ok: false, requestCount: 0, errorType: "INVALID_REQUEST" });
    expect(reads).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("still honors a valid smaller byte and timeout limit", async () => {
    const outcome = await runResponsesStructureProbe(profile, {
      secretStore: secrets(),
      modelId: MODEL_ID,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(json(COMPLETED_WITHOUT_TEXT)),
      maxResponseBytes: 1_024,
      maxTimeoutMs: 5_000,
    });
    expect(outcome).toEqual({
      ok: true,
      requestCount: 1,
      summary: classifyResponsesStructure(COMPLETED_WITHOUT_TEXT),
    });
  });

  it.each([
    ["wrong id", { id: "other-provider" }, MODEL_ID],
    ["wrong base URL", { baseUrl: "https://evil.cc/v1" }, MODEL_ID],
    ["wrong apiType", { apiType: "openai-chat-completions" }, MODEL_ID],
    ["wrong model", {}, "gpt-4o-mini"],
  ] as const)("refuses a %s target before reading a secret or fetching", async (_label, overrides, modelId) => {
    const reads: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(COMPLETED_WITHOUT_TEXT));
    const wrongProfile = parseProviderProfile({
      id: "vsllm",
      displayName: "VSLLM Test",
      baseUrl: "https://vsllm.cc/v1",
      apiType: "openai-responses",
      auth: { kind: "bearer", secretRef: "vsllm.api.key" },
      timeoutMs: 2_000,
      ...overrides,
    });
    const outcome = await runResponsesStructureProbe(wrongProfile, {
      secretStore: countingStore(reads),
      modelId,
      fetchImpl: fetchMock,
    });
    expect(outcome).toEqual({ ok: false, requestCount: 0, errorType: "INVALID_REQUEST" });
    expect(reads).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["wrong id", { id: "other-provider" }, MODEL_ID],
    ["wrong base URL", { baseUrl: "https://evil.cc/v1" }, MODEL_ID],
    ["wrong apiType", { apiType: "openai-chat-completions" }, MODEL_ID],
    ["wrong model", {}, "gpt-4o-mini"],
  ] as const)("does not emit an allowed-looking dry-run for a %s target", (_label, overrides, modelId) => {
    const wrongProfile = parseProviderProfile({
      id: "vsllm",
      displayName: "VSLLM Test",
      baseUrl: "https://vsllm.cc/v1",
      apiType: "openai-responses",
      auth: { kind: "bearer", secretRef: "vsllm.api.key" },
      timeoutMs: 2_000,
      ...overrides,
    });
    expect(describeResponsesStructureProbe(wrongProfile, modelId)).toBeNull();
  });
});
