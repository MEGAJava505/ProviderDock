import { afterEach, describe, expect, it } from "vitest";
import { ProviderDockApplication } from "../src/application/provider-dock-application.js";
import { ProviderAdapterRegistry } from "../src/core/providers/provider-adapter-registry.js";
import { MemoryProviderProfileRepository } from "../src/core/providers/provider-profile-repository.js";
import { ProviderProbeService } from "../src/core/health/provider-probe-service.js";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { ModelDisabledError, ModelUnavailableError } from "../src/core/providers/model-access.js";
import { ProviderRequestError } from "../src/core/errors/provider-error.js";
import { MemoryPortalRepository, PortalRepositoryCorruptionError } from "../src/core/portals/portal-repository.js";
import { ProviderPortalAdapterRegistry } from "../src/core/portals/portal-types.js";
import { ProviderPortalService } from "../src/core/portals/provider-portal-service.js";
import { ProviderDashboardServer } from "../src/ui/provider-dashboard-server.js";

const servers: ProviderDashboardServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())); });

async function fixture(portals?: ProviderPortalService) {
  const secrets = new MemorySecretStore();
  const application = new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
    secrets,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, portals,
  );
  const profile = await application.setProvider({
    id: "fixture", displayName: "Bearer secret-canary", baseUrl: "https://fixture.invalid/v1",
    manualModelIds: ["example"],
  });
  const server = new ProviderDashboardServer({ application, healthMonitorIntervalMs: 0 });
  servers.push(server);
  const { url } = await server.start();
  const post = (path: string, body = {}) => fetch(url + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { application, profile, secrets, url, post };
}

describe("dashboard failure transparency", () => {
  it.each([
    ["disabled", "MODEL_DISABLED", /отключена/i],
    ["unavailable", "MODEL_NOT_AVAILABLE", /недоступна/i],
  ] as const)("returns a safe, actionable %s-model API failure", async (kind, code, message) => {
    const { application, profile, post } = await fixture();
    // Substitute the external operation, not the HTTP/error-classification boundary.
    application.probeProvider = async () => {
      throw kind === "disabled" ? new ModelDisabledError(profile, "secret-canary")
        : new ModelUnavailableError(profile, "secret-canary", ["secret-canary"]);
    };
    const response = await post("api/providers/fixture/probe");
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.code).toBe(code);
    expect(body.message).toMatch(message);
    expect(body.diagnostic).toMatchObject({ code, stage: "validation", retryable: false });
    expect(body.diagnostic.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.diagnostic.suggestedAction).toMatch(/выберите|обновите/i);
    expect(JSON.stringify(body)).not.toContain("secret-canary");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it.each([
    [1, null, "FAILED", "failed", "PROCESS_EXIT_NONZERO"],
    [null, null, "FAILED", "failed", "PROCESS_EXIT_UNKNOWN"],
    [null, "SIGTERM", "FAILED", "failed", "PROCESS_SIGNALLED"],
    [0, null, "EXITED", "succeeded", undefined],
  ] as const)("maps fulfilled process exit %s/%s honestly", async (exitCode, signal, status, outcome, code) => {
    const { application, post, url } = await fixture();
    application.launchProviderAutomatic = async () => ({ client: "codex", exit: { exitCode, signal } });
    const response = await post("api/launches", {
      projectDirectory: "C:/fixture", providerId: "fixture", modelId: "example",
    });
    expect(response.status).toBe(202);
    await expect.poll(async () => {
      const { launches } = await (await fetch(url + "api/launches")).json();
      return launches[0].status;
    }).toBe(status);
    const { launches: [launch] } = await (await fetch(url + "api/launches")).json();
    expect(launch.outcome).toBe(outcome);
    if (code) {
      expect(launch.diagnostic).toMatchObject({ operationId: launch.id, stage: "shutdown", code });
      if (exitCode !== null) expect(launch.diagnostic.exitCode).toBe(exitCode);
    }
  });

  it.each([
    ["missing binary", Object.assign(new Error("secret-canary"), { code: "ENOENT", syscall: "spawn omp" }), "EXECUTABLE_NOT_FOUND", "process-spawn", "FAILED"],
    ["cancelled", Object.assign(new Error("secret-canary"), { name: "AbortError" }), "OPERATION_CANCELLED", "shutdown", "EXITED"],
    ["provider subclass", new class extends ProviderRequestError {
      constructor() { super("AUTH_ERROR", "secret-canary"); this.name = "CustomAuthError"; }
    }(), "AUTH_ERROR", "upstream", "FAILED"],
  ] as const)("exposes safe %s launch diagnostics", async (_label, error, code, stage, status) => {
    const { application, post, url } = await fixture();
    application.launchProviderAutomatic = async () => { throw error; };
    await post("api/launches", {
      projectDirectory: "C:/fixture", providerId: "fixture", modelId: "example",
    });
    await expect.poll(async () => {
      const { launches } = await (await fetch(url + "api/launches")).json();
      return launches[0].status;
    }).toBe(status);
    const { launches: [launch] } = await (await fetch(url + "api/launches")).json();
    expect(launch.diagnostic).toMatchObject({ operationId: launch.id, code, stage });
    expect(launch.errorMessage).not.toContain("secret-canary");
    expect(launch.diagnostic.suggestedAction.length).toBeGreaterThan(10);
    if (code === "OPERATION_CANCELLED") expect(launch.outcome).toBe("cancelled");
  });

  it("keeps the snapshot usable but blocks secret cleanup when portal links are unknown", async () => {
    const { application, url } = await fixture();
    await application.setSecret("PORTAL_ONLY", "secret-canary");
    application.listProviderPortals = async () => { throw new PortalRepositoryCorruptionError("secret-canary"); };
    application.providerPortalStatus = () => ({ state: "corrupt", message: "secret-canary" });
    const response = await fetch(url + "api/snapshot");
    expect(response.status).toBe(200);
    const snapshot = await response.json();
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.portalStatus.state).toBe("corrupt");
    expect(snapshot.portalDiagnostic).toMatchObject({ stage: "storage", code: "PORTAL_STORAGE_CORRUPT" });
    expect(JSON.stringify(snapshot.portalStatus)).not.toContain("secret-canary");
    const deletion = await fetch(url + "api/secrets/PORTAL_ONLY", { method: "DELETE" });
    expect(deletion.status).toBe(409);
    expect((await deletion.json()).diagnostic.code).toBe("PORTAL_STORAGE_CORRUPT");
    expect(await application.listSecretReferences()).toContain("PORTAL_ONLY");
  });

  it.each(["PORTAL_ONLY", " PORTAL_ONLY "])("rejects overwriting existing reference %j when portal corruption is discovered", async reference => {
    const { application, secrets, url } = await fixture();
    await application.setSecret("PORTAL_ONLY", "original-secret-canary");
    let corrupt = false;
    application.listProviderPortals = async () => {
      corrupt = true;
      throw new PortalRepositoryCorruptionError("private-path-canary");
    };
    application.providerPortalStatus = () => ({ state: corrupt ? "corrupt" : "healthy" });
    const response = await fetch(url + "api/secrets/" + encodeURIComponent(reference), {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "replacement-secret-canary" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.diagnostic).toMatchObject({ stage: "storage", code: "PORTAL_STORAGE_CORRUPT" });
    expect(body.diagnostic.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain("canary");
    expect(await secrets.get("PORTAL_ONLY")).toBe("original-secret-canary");
  });

  it("allows a fresh unique reference despite corrupt post-write portal invalidation, then blocks its replacement", async () => {
    const records = new MemoryPortalRepository();
    records.list = async () => { throw new PortalRepositoryCorruptionError("private-path-canary"); };
    records.status = () => ({ state: "corrupt" });
    const { secrets, url } = await fixture(new ProviderPortalService(records, new ProviderPortalAdapterRegistry()));
    const put = (value: string) => fetch(url + "api/secrets/FRESH_ONLY", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
    });
    const created = await put("new-secret-canary");
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ stored: true, reference: "FRESH_ONLY" });
    expect(await secrets.get("FRESH_ONLY")).toBe("new-secret-canary");
    expect((await put("overwrite-canary")).status).toBe(409);
    expect(await secrets.get("FRESH_ONLY")).toBe("new-secret-canary");
  });

  it("does not let simultaneous fresh-reference requests overwrite each other during corruption", async () => {
    const { application, secrets, url } = await fixture();
    application.providerPortalStatus = () => ({ state: "corrupt" });
    const persist = application.setSecret.bind(application);
    application.setSecret = async (reference, value) => {
      // Model an asynchronous OS-vault write, not a synchronous in-memory set.
      await new Promise(resolve => setTimeout(resolve, 50));
      await persist(reference, value);
    };
    const values = ["first-secret-canary", "second-secret-canary"];
    const responses = await Promise.all(values.map(value => fetch(url + "api/secrets/FRESH_RACE", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
    })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await secrets.get("FRESH_RACE")).toBe(values[responses.findIndex(response => response.status === 200)]);
  });

  it("never claims a fresh key was saved when the vault write fails", async () => {
    const { application, secrets, url } = await fixture();
    application.providerPortalStatus = () => ({ state: "corrupt" });
    application.setSecret = async () => { throw new PortalRepositoryCorruptionError("pre-write-failure-canary"); };
    const response = await fetch(url + "api/secrets/NOT_STORED", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "secret-canary" }),
    });
    expect(response.status).toBe(409);
    expect(await secrets.get("NOT_STORED")).toBeUndefined();
  });

  it("reports a content-free storage diagnostic when session history fails", async () => {
    const { application, url } = await fixture();
    application.listAgentSessions = async () => { throw new Error("secret-canary\nat private stack"); };
    const response = await fetch(url + "api/agent-sessions");
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.diagnostic).toMatchObject({ stage: "storage", code: "OPERATION_FAILED", retryable: false });
    expect(body.diagnostic.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain("secret-canary");
  });

  it("isolates vault failure without exposing raw protection errors", async () => {
    const { application, url } = await fixture();
    application.listSecretReferences = async () => {
      throw Object.assign(new Error("secret-canary"), { name: "SecretProtectionError" });
    };
    const response = await fetch(url + "api/snapshot");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providers).toHaveLength(1);
    expect(body.secretVault.available).toBe(false);
    expect(body.secretVaultDiagnostic).toMatchObject({ stage: "credentials", code: "VAULT_UNAVAILABLE" });
    expect(JSON.stringify(body.secretVault)).not.toContain("secret-canary");
  });
});
