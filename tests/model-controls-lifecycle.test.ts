import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AnthropicBridgeServer, ResponsesBridgeServer, MemorySecretStore, MemoryProviderProfileRepository,
  ProviderAdapterRegistry, ProviderProbeService, ProviderDockApplication, parseProviderProfile,
  FileProviderHealthRepository, MemoryProviderHealthRepository, mergeModelCatalog,
  type CodexLauncher, type ClaudeLauncher, type ProviderProbeResult, type ProviderRuntimeHealthSignal } from "../src/index.js";
import { assertModelEnabled } from "../src/core/providers/model-access.js";
import { buildModelStorefront } from "../src/ui/model-storefront.js";
import { portalRecordSchema } from "../src/core/portals/portal-types.js";

const profile = parseProviderProfile({ id: "one", displayName: "One", baseUrl: "https://one.invalid/v1", manualModelIds: ["old", "live"],
  modelPricing: { old: { inputPerMillion: 1, outputPerMillion: 2 } } });
const probe = (at: string, ids: string[], error?: boolean): ProviderProbeResult => ({
  health: { providerId: profile.id, status: error ? "DEGRADED" : "ONLINE", checkedAt: at, latencyMs: 1, discoveredModelCount: ids.length, appliedFixes: [],
    ...(error ? { errorType: "PROTOCOL_ERROR" as const, errorMessage: "Malformed catalog" } : {}) },
  models: mergeModelCatalog(profile, ids.map(modelId => ({ modelId, displayName: modelId, raw: {} }))),
});

describe("model lifecycle", () => {
  it("retains removed models for 48 hours across restarts, without restarting the clock, and rediscovers them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-presence-"));
    const path = join(directory, "health.json");
    let records = new FileProviderHealthRepository(path);
    await records.record(probe("2026-09-08T09:00:00Z", ["old", "live"]));
    await records.record(probe("2026-09-08T10:00:00Z", ["live"]));
    records = new FileProviderHealthRepository(path);
    await records.record(probe("2026-09-09T10:00:00Z", ["live"]));
    expect(buildModelStorefront([profile], await records.list(), new Date("2026-09-10T09:59:59Z")))
      .toContainEqual(expect.objectContaining({ modelId: "old", lifecycle: "removed", status: "OFFLINE", removedAt: "2026-09-08T10:00:00Z" }));
    expect(buildModelStorefront([profile], await records.list(), new Date("2026-09-10T10:00:00Z")).map(row => row.modelId)).toEqual(["live"]);
    await records.record(probe("2026-09-11T10:00:00Z", ["old", "live"]));
    expect(buildModelStorefront([profile], await records.list(), new Date("2026-09-11T10:00:00Z")))
      .toContainEqual(expect.objectContaining({ modelId: "old", lifecycle: "available", removedAt: null }));
  });

  it("never interprets a failed or malformed catalog as deleting all models", async () => {
    const records = new MemoryProviderHealthRepository();
    await records.record(probe("2026-09-08T09:00:00Z", ["old", "live"]));
    await records.record(probe("2026-09-08T10:00:00Z", [], true));
    const failed = probe("2026-09-08T11:00:00Z", [], true);
    await records.record({ ...failed, health: { ...failed.health, status: "AUTH_ERROR", errorType: "AUTH_ERROR" } });
    expect((await records.get("one"))?.modelRemovals).toEqual({});
    expect(buildModelStorefront([profile], await records.list(), new Date("2026-09-11T10:00:00Z"))).toHaveLength(2);
  });

  it("labels API models absent from a fresh successful site catalog separately from local blocking", async () => {
    const records = new MemoryProviderHealthRepository();
    await records.record(probe("2026-09-08T10:00:00Z", ["old", "live"]));
    const observation = { status: "unsupported", code: "UNSUPPORTED_ENDPOINT", sourceUrl: "https://one.invalid", observedAt: "2026-09-08T10:00:00Z", expiresAt: "2026-09-08T11:00:00Z", value: null };
    const portal = portalRecordSchema.parse({ revision: "11111111-1111-4111-8111-111111111111", connection: { providerId: "one", siteUrl: "https://one.invalid" }, latest: {
      site: observation, wallet: observation, checkIn: observation,
      catalog: { ...observation, status: "ok", code: undefined, value: { models: [] } },
    } });
    const rows = buildModelStorefront([{ ...profile, disabledModelIds: ["old"] }], await records.list(), new Date("2026-09-08T10:00:00Z"), [portal]);
    expect(rows).toContainEqual(expect.objectContaining({ modelId: "live", lifecycle: "site-hidden", locallyDisabled: false, enabled: true }));
    expect(rows).toContainEqual(expect.objectContaining({ modelId: "old", lifecycle: "site-hidden", locallyDisabled: true, enabled: false, status: "DISABLED" }));
    const stale = buildModelStorefront([profile], await records.list(), new Date("2026-09-08T11:00:01Z"), [portal]);
    expect(stale.some(row => row.lifecycle === "site-hidden")).toBe(false);
  });
});

describe("manual model controls", () => {
  it("persists concurrent toggles, blocks both direct launchers and excludes models from both fallback chains", async () => {
    const codex = vi.fn().mockResolvedValue({ exitCode: 0 });
    const claude = vi.fn().mockResolvedValue({ exitCode: 0 });
    const app = new ProviderDockApplication(new MemoryProviderProfileRepository(), new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined, { launch: codex } as unknown as CodexLauncher, undefined, undefined, { launch: claude } as unknown as ClaudeLauncher);
    await app.setProvider(profile);
    await Promise.all([app.setProviderModelEnabled("one", "old", false), app.setProviderModelEnabled("one", "other", false)]);
    expect((await app.getProvider("one")).disabledModelIds.sort()).toEqual(["old", "other"]);
    const direct = { providerId: "one", modelId: "old", projectDirectory: tmpdir(), route: { kind: "auto" as const } };
    await expect(app.launchCodex(direct)).rejects.toThrow("отключена");
    await expect(app.launchClaude(direct)).rejects.toThrow("отключена");
    expect(codex).not.toHaveBeenCalled();expect(claude).not.toHaveBeenCalled();
    await app.setLogicalModel({ id: "chain", routes: [{ providerId: "one", modelId: "old", priority: 100 }, { providerId: "one", modelId: "live", priority: 90 }] });
    await app.launchCodexLogicalModel({ logicalModelId: "chain", projectDirectory: tmpdir(), route: { kind: "auto" } });
    await app.launchClaudeLogicalModel({ logicalModelId: "chain", projectDirectory: tmpdir() });
    for (const launch of [codex, claude]) expect(launch.mock.calls[0]?.[0].fallback.logicalModel.routes.map((route: { modelId: string }) => route.modelId)).toEqual(["live"]);
    await app.setProviderModelEnabled("one", "old", true);
    await app.launchCodex(direct);await app.launchClaude(direct);
    expect(codex).toHaveBeenCalledTimes(2);expect(claude).toHaveBeenCalledTimes(2);
  });

  it.each(["responses", "anthropic"] as const)("checks current controls before a running %s bridge can contact upstream", async kind => {
    let current = parseProviderProfile({ ...profile, apiType: kind === "responses" ? "openai-responses" : "anthropic-messages" });
    const upstream = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(kind === "responses"
      ? { id: "resp_allowed", object: "response", status: "completed", output: [] }
      : { id: "msg_allowed", type: "message", role: "assistant", model: "live", content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    const signals: ProviderRuntimeHealthSignal[] = [];
    const options = { profile: current, secretStore: new MemorySecretStore(), fetchImpl: upstream,
      healthSignalSink: (signal: ProviderRuntimeHealthSignal) => { signals.push(signal); },
      modelAccessCheck: async (_providerId: string, modelId: string) => assertModelEnabled(current, modelId) };
    const bridge = kind === "responses" ? new ResponsesBridgeServer(options) : new AnthropicBridgeServer(options);
    const address = await bridge.start();
    try {
      current = { ...current, disabledModelIds: ["live"] };
      const body = kind === "responses" ? { model: "live", input: "hello" } : { model: "live", max_tokens: 10, messages: [{ role: "user", content: "hello" }] };
      const url = "baseUrl" in address ? address.baseUrl + "/responses" : address.url + "/v1/messages";
      const request = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const rejected = await request();await rejected.text();
      expect(rejected.status).toBe(400);expect(upstream).not.toHaveBeenCalled();
      expect(signals).toEqual([]); // Local blocking must not make a stable provider look broken.
      current = { ...current, disabledModelIds: [] };
      const allowed = await request();await allowed.text();
      expect(allowed.status).toBe(200);expect(upstream).toHaveBeenCalledTimes(1);
    } finally { await bridge.stop(); }
  });
});
