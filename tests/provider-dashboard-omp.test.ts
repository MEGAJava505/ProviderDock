import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDashboardApplication } from "../src/ui/provider-dashboard-server.js";
import { ProviderDashboardServer } from "../src/ui/provider-dashboard-server.js";
import type { ProviderDashboardOmpLauncher } from "../src/ui/provider-dashboard-server.js";
import { createOperationDiagnostic, type OperationDiagnostic } from "../src/core/errors/operation-diagnostic.js";
import type { OmpRunRecord } from "../src/clients/omp/omp-run-repository.js";

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
  const listRuns = vi.fn(overrides.listRuns ?? (async () => [] as readonly OmpRunRecord[]));
  const cancel = vi.fn(overrides.cancel ?? (async () => undefined));
  const reconcileAfterRestart = vi.fn(overrides.reconcileAfterRestart ?? (async () => [] as readonly OmpRunRecord[]));
  return {
    preflight, launch, listRuns, cancel, reconcileAfterRestart,
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
