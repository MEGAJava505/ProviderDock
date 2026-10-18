import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDashboardApplication } from "../src/ui/provider-dashboard-server.js";
import { ProviderDashboardServer } from "../src/ui/provider-dashboard-server.js";
import type { ProviderDashboardOmpLauncher } from "../src/ui/provider-dashboard-server.js";
import { createOperationDiagnostic, type OperationDiagnostic } from "../src/core/errors/operation-diagnostic.js";
import type { OmpRunRecord } from "../src/clients/omp/omp-run-repository.js";
import {
  buildOmpRouteReadinessPreview,
  type OmpRouteReadinessPreview,
} from "../src/migration/omp-route-readiness-preview.js";
import { makeOmpRouteFixture } from "./support/omp-route-fixtures.js";

const input = {
  providerId: "provider-a",
  modelId: "model-a",
  accountId: "personal",
  projectDirectory: "E:\\Projects\\fixture",
  permissionAcknowledgement: "read-only-pilot-no-sandbox",
} as const;

const diagnostic: OperationDiagnostic = createOperationDiagnostic({
  code: "PROTOCOL_UNRESOLVED",
  stage: "validation",
});

const run: OmpRunRecord = {
  runId: "01937d71-7ae7-7abc-8100-000000000001",
  providerId: "provider-a",
  accountId: "personal",
  modelId: "model-a",
  projectDirectory: "E:\\Projects\\fixture",
  mode: "tui",
  state: "RUNNING",
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:01.000Z",
  transitions: [{ state: "RUNNING", at: "2026-09-15T00:00:01.000Z" }],
};

const previewReady: OmpRouteReadinessPreview = {
  selection: { providerId: "provider-a", accountId: "personal", modelId: "model-a" },
  verdict: "ready",
  reason: "route-accepted-for-pilot",
  evidenceTier: "doctor-l3-ready-for-pilot",
  chain: [
    { node: "provider", state: "ready", reason: "provider-matches-decision" },
    { node: "account", state: "ready", reason: "account-matches-decision" },
    { node: "model", state: "ready", reason: "model-matches-decision" },
    { node: "protocol", state: "ready", reason: "protocol-matches-decision" },
    { node: "origin", state: "ready", reason: "origin-matches-decision" },
    { node: "credential-state", state: "ready", reason: "doctor-credential-fingerprint-current" },
    { node: "evidence-state", state: "ready", reason: "doctor-level-3-and-local-provenance" },
  ],
  autoFallback: "not-offered",
  loopbackSmokeIsUpstreamPass: false,
  recommendedAction: "none",
};

const activeServers: ProviderDashboardServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
});

describe("ProviderDashboardServer OMP API", () => {
  it("prevalidates an explicit OMP route and returns only safe fields", async () => {
    const omp = createOmpLauncher();
    const server = createServer(omp);
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      result: {
        ok: true,
        providerId: "provider-a",
        accountId: "personal",
        modelId: "model-a",
        api: "openai-responses",
      },
    });
    expect(omp.preflight).toHaveBeenCalledWith(input);
  });

  it("requires the separate OMP acknowledgement before preflight", async () => {
    const omp = createOmpLauncher();
    const server = createServer(omp);
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, permissionAcknowledgement: undefined }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("INVALID_REQUEST");
    expect(body.message).toContain("read-only-pilot-no-sandbox");
    expect(omp.preflight).not.toHaveBeenCalled();
  });

  it("launches through OMP without calling legacy launchers", async () => {
    const omp = createOmpLauncher();
    const application = createApplication();
    const server = createServer(omp, application);
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      result: { ok: true, runId: "01937d71-7ae7-7abc-8100-000000000001" },
    });
    expect(omp.launch).toHaveBeenCalledWith(input);
    expect(application.launchCodex).not.toHaveBeenCalled();
    expect(application.launchClaude).not.toHaveBeenCalled();
    expect(application.launchProviderAutomatic).not.toHaveBeenCalled();
  });

  it("returns a safe diagnostic when OMP launch fails", async () => {
    const unsafe = createOperationDiagnostic({ code: "OPERATION_FAILED", stage: "validation" }) as unknown as Record<string, unknown>;
    unsafe.message = "Bearer sk-secret";
    const omp = createOmpLauncher({
      launch: async () => ({
        ok: false,
        runId: "01937d71-7ae7-7abc-8100-000000000002",
        diagnostic: unsafe as never as OperationDiagnostic,
      }),
    });
    const server = createServer(omp);
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/launch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("OPERATION_FAILED");
    expect(text).toContain("Операция не выполнена.");
    expect(text).not.toContain("sk-secret");
  });

  it("lists and cancels safe OMP run records", async () => {
    const omp = createOmpLauncher({
      listRuns: async () => [run],
      cancel: async () => ({ ...run, state: "CANCELLED" }),
    });
    const server = createServer(omp);
    const address = await server.start();

    const listResponse = await fetch(`${address.url}api/omp/runs`);
    await expect(listResponse.json()).resolves.toEqual({ runs: [run] });

    const cancelResponse = await fetch(
      `${address.url}api/omp/runs/${run.runId}/cancel`,
      { method: "POST" },
    );
    await expect(cancelResponse.json()).resolves.toEqual({
      run: { ...run, state: "CANCELLED" },
    });
    expect(omp.cancel).toHaveBeenCalledWith(run.runId);
  });

  it("returns 404 when cancelling an unknown OMP run so the UI cannot show a false success", async () => {
    const omp = createOmpLauncher({ cancel: async () => undefined });
    const server = createServer(omp);
    const address = await server.start();

    const unknownRunId = "01937d71-7ae7-7abc-8100-0000000000ff";
    const response = await fetch(`${address.url}api/omp/runs/${unknownRunId}/cancel`, {
      method: "POST",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "OMP_RUN_NOT_FOUND" });
    expect(omp.cancel).toHaveBeenCalledWith(unknownRunId);
  });

  it("surfaces an unconfirmed cancel as a non-terminal CANCELLING record, never a false success", async () => {
    // When a stop cannot be confirmed the supervisor records the non-terminal
    // CANCELLING state (never CANCELLED, never a terminal FAILED that would hide a
    // possibly-live child). The dashboard boundary must forward that honestly so the
    // run stays visible and cancellable rather than looking finished.
    const unconfirmed: OmpRunRecord = {
      ...run,
      state: "CANCELLING",
      updatedAt: "2026-09-15T00:00:05.000Z",
      transitions: [...run.transitions, { state: "CANCELLING", at: "2026-09-15T00:00:05.000Z" }],
      diagnostic: createOperationDiagnostic({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" }),
    };
    const omp = createOmpLauncher({ cancel: async () => unconfirmed });
    const server = createServer(omp);
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/runs/${run.runId}/cancel`, {
      method: "POST",
    });
    const body = (await response.json()) as { run: OmpRunRecord };

    expect(response.status).toBe(200);
    expect(body.run.state).toBe("CANCELLING");
    expect(body.run.state).not.toBe("CANCELLED");
    expect(body.run.diagnostic?.code).toBe("OMP_CANCEL_UNCONFIRMED");
  });

  it("reconciles OMP ownership when the dashboard starts", async () => {
    const omp = createOmpLauncher();
    const server = createServer(omp);
    await server.start();

    expect(omp.reconcileAfterRestart).toHaveBeenCalledOnce();
  });

  it("rejects OMP requests when no OMP launcher is configured", async () => {
    const server = createServer();
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      code: "OMP_LAUNCHER_UNAVAILABLE",
    });
  });

  it("explains an OMP route without an acknowledgement and returns only the allowlisted view", async () => {
    const omp = createOmpLauncher();
    const server = createServer(omp);
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "provider-a", accountId: "personal", modelId: "model-a" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preview: previewReady });
    expect(omp.preview).toHaveBeenCalledWith({
      providerId: "provider-a", accountId: "personal", modelId: "model-a",
    });
    // Preview must never trigger preflight or a launch.
    expect(omp.preflight).not.toHaveBeenCalled();
    expect(omp.launch).not.toHaveBeenCalled();
  });

  it.each([
    { accountId: "confirmed-account", verdict: "ready", tier: "doctor-l3-ready-for-pilot" },
    { accountId: "other-account", verdict: "blocked", tier: "doctor-l3-evidence-route-blocked" },
  ] as const)("returns honest $verdict Doctor evidence over HTTP without an OMP run", async ({
    accountId, verdict, tier,
  }) => {
    // The legacy realPilot record attests Doctor L3, not an OMP process run.
    const fixture = makeOmpRouteFixture();
    const selection = { providerId: "gateway", accountId, modelId: "exact-model" };
    const omp = createOmpLauncher({
      preview: async (input) => buildOmpRouteReadinessPreview({
        profile: fixture.profile,
        decision: fixture.decision,
        evidence: fixture.evidence,
        doctorSnapshot: fixture.doctorSnapshot,
        currentCredentialFingerprint: fixture.credentialFingerprint,
        artifact: {
          sha256: fixture.decision.localSmoke.executableSha256,
          sourceCommit: fixture.decision.localSmoke.sourceCommit,
        },
        selection: input,
      }),
    });
    const server = createServer(omp);
    const address = await server.start();
    const response = await fetch(`${address.url}api/omp/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(selection),
    });
    const body = await response.json() as { preview: OmpRouteReadinessPreview };

    expect(response.status).toBe(200);
    expect(body.preview).toMatchObject({
      verdict,
      evidenceTier: tier,
      autoFallback: "not-offered",
      loopbackSmokeIsUpstreamPass: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/real-paid-pilot|real-pilot-evidence|pilot-passed|production-ready/);
    expect(omp.preflight).not.toHaveBeenCalled();
    expect(omp.launch).not.toHaveBeenCalled();
  });

  it("rejects a preview that smuggles a project path, credential, or acknowledgement", async () => {
    const omp = createOmpLauncher();
    const server = createServer(omp);
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId: "provider-a", accountId: "personal", modelId: "model-a",
        projectDirectory: "E:\\Projects\\fixture",
        permissionAcknowledgement: "read-only-pilot-no-sandbox",
        decision: { status: "accepted-for-pilot" },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_REQUEST" });
    expect(omp.preview).not.toHaveBeenCalled();
  });

  it("drops any non-allowlisted preview field so a secret or absolute path cannot leak", async () => {
    const leaky = {
      ...previewReady,
      leakedSecret: "sk-secret-should-never-ship",
      sourcePath: "E:\\Users\\megaj\\.env-key",
      rawHeaders: { authorization: "Bearer sk-secret-should-never-ship" },
    } as unknown as OmpRouteReadinessPreview;
    const omp = createOmpLauncher({ preview: async () => leaky });
    const server = createServer(omp);
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "provider-a", accountId: "personal", modelId: "model-a" }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("route-accepted-for-pilot");
    expect(text).not.toContain("sk-secret-should-never-ship");
    expect(text).not.toContain(".env-key");
    expect(text).not.toContain("authorization");
    expect(text).not.toContain("E:\\Users");
  });

  it("requires an OMP launcher before it will preview a route", async () => {
    const server = createServer();
    const address = await server.start();

    const response = await fetch(`${address.url}api/omp/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "provider-a", accountId: "personal", modelId: "model-a" }),
    });

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({ code: "OMP_LAUNCHER_UNAVAILABLE" });
  });
});

function createServer(
  omp?: ProviderDashboardOmpLauncher,
  application = createApplication(),
): ProviderDashboardServer {
  const server = new ProviderDashboardServer({
    application,
    ...(omp === undefined ? {} : { ompLauncher: omp }),
    sessionToken: "a".repeat(48),
    healthMonitorIntervalMs: 0,
  });
  activeServers.push(server);
  return server;
}

function createOmpLauncher(
  overrides: Partial<ProviderDashboardOmpLauncher> = {},
): ProviderDashboardOmpLauncher & {
  readonly preflight: ReturnType<typeof vi.fn>;
  readonly launch: ReturnType<typeof vi.fn>;
  readonly preview: ReturnType<typeof vi.fn>;
  readonly listRuns: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly reconcileAfterRestart: ReturnType<typeof vi.fn>;
} {
  const preflight = vi.fn(overrides.preflight ?? (async () => ({
    ok: true as const,
    providerId: "provider-a",
    accountId: "personal",
    modelId: "model-a",
    api: "openai-responses" as const,
  })));
  const launch = vi.fn(overrides.launch ?? (async () => ({
    ok: true as const,
    runId: "01937d71-7ae7-7abc-8100-000000000001",
  })));
  const preview = vi.fn(overrides.preview ?? (async () => previewReady));
  const listRuns = vi.fn(overrides.listRuns ?? (async () => [] as readonly OmpRunRecord[]));
  const cancel = vi.fn(overrides.cancel ?? (async () => undefined));
  const reconcileAfterRestart = vi.fn(overrides.reconcileAfterRestart ?? (async () => [] as readonly OmpRunRecord[]));
  return {
    preflight, launch, preview, listRuns, cancel, reconcileAfterRestart,
  };
}

function createApplication(): ProviderDashboardApplication {
  return {
    listProviders: vi.fn(async () => []),
    launchCodex: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchClaude: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchProviderAutomatic: vi.fn(async () => ({
      client: "codex" as const,
      exit: { exitCode: 0, signal: null },
    })),
  } as unknown as ProviderDashboardApplication;
}
