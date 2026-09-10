import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomaticLaunchResult } from "../src/application/provider-dock-application.js";
import type { ProviderProfile } from "../src/core/providers/provider-profile.js";
import type { ProviderDashboardApplication } from "../src/ui/provider-dashboard-server.js";
import { ProviderDashboardServer } from "../src/ui/provider-dashboard-server.js";
import { providerDashboardJavaScript } from "../src/ui/provider-dashboard-page.js";

const profile: ProviderProfile = {
  id: "provider-a",
  displayName: "Provider A",
  enabled: true,
  baseUrl: "https://provider.example/v1",
  apiType: "openai-responses",
  adapterId: "generic-openai",
  auth: { kind: "bearer", secretRef: "PROVIDER_A_KEY" },
  staticHeaders: {},
  secretHeaders: {},
  queryParameters: {},
  modelsEndpoint: "models",
  manualModelIds: ["model-a"],
  disabledModelIds: [],
  modelPricing: {},
  preferredClient: "auto",
  timeoutMs: 10_000,
  healthCheck: {
    enabled: true,
    metadataTtlMs: 60_000,
    minimalInference: "on-demand",
  },
};

const activeServers: ProviderDashboardServer[] = [];

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.stop()));
});

describe("ProviderDashboardServer", () => {
  it("serves a token-scoped loopback dashboard and a non-secret snapshot", async () => {
    const application = createApplication();
    const server = createServer(application);
    const address = await server.start();

    expect(address.host).toBe("127.0.0.1");
    expect(address.url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/$/,
    );

    const missingToken = await fetch(
      `http://127.0.0.1:${address.port}/api/snapshot`,
    );
    expect(missingToken.status).toBe(404);

    const page = await fetch(address.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const pageBody = await page.text();
    expect(pageBody).toContain("Запустить агента");
    expect(pageBody).toContain("Импорт аккаунта");
    expect(pageBody).toContain("Access Token");
    expect(pageBody.match(/data-open-launch/g)).toHaveLength(1);
    const importDialog = pageBody.slice(
      pageBody.indexOf('id="cookie-import-dialog"'),
      pageBody.indexOf("</form></dialog>", pageBody.indexOf('id="cookie-import-dialog"')),
    );
    expect(importDialog).not.toContain("Дополнительно");
    expect(pageBody).toContain("Цепочки моделей");
    expect(pageBody).toContain('class="workspace-grid"');
    expect(pageBody).toContain('class="provider-head-actions"');
    expect(pageBody).toContain('id="open-cookie-overview"');
    expect(pageBody).toContain('id="cookie-overview-dialog"');
    expect(pageBody).toContain('id="provider-drawer"');
    expect(pageBody).not.toContain('id="view-provider"');
    expect(pageBody).not.toContain('class="topbar"');
    expect(pageBody).toContain('id="logical-model-form"');
    expect(pageBody).toContain('id="chain-routes"');
    expect(pageBody).toContain('id="prompt-profile-form"');
    expect(pageBody).toContain('id="secret-form"');
    expect(pageBody).toContain('type="password"');
    expect(pageBody).toContain("URL API или пример cURL");
    expect(pageBody).toContain("Base URL + API-ключ");
    expect(pageBody).toContain('id="provider-simple-setup"');
    expect(pageBody).toContain('id="detect-provider"');
    expect(pageBody).toContain('name="apiKey"');
    expect(pageBody).toContain('id="pick-launch-project"');
    expect(pageBody).toContain('id="launch-project" name="projectDirectory" required readonly');
    expect(pageBody).toContain('id="model-search"');
    expect(pageBody).toContain('id="pricing-form"');

    const snapshotResponse = await fetch(`${address.url}api/snapshot`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      providers: readonly ProviderProfile[];
      generatedAt: string;
    };
    expect(snapshot.providers).toEqual([profile]);
    expect((snapshot as unknown as { storefront: unknown[] }).storefront).toEqual([
      expect.objectContaining({ providerId: profile.id, modelId: "model-a", pricing: null,
        balance: null, providerLoad: null }),
    ]);
    expect(snapshot.generatedAt).toBe("2026-08-30T12:00:00.000Z");
    expect((snapshot as unknown as { secretVault: unknown }).secretVault).toEqual({
      available: true,
      references: ["PROVIDER_A_KEY"],
    });
    expect(JSON.stringify(snapshot)).toContain("dashboard-session");
    expect(JSON.stringify(snapshot)).not.toContain("actual-provider-secret");
  });

  it("blocks cross-origin mutations before calling the application", async () => {
    const application = createApplication();
    const server = createServer(application);
    const address = await server.start();

    const response = await fetch(`${address.url}api/providers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify(profile),
    });

    expect(response.status).toBe(403);
    expect(application.setProvider).not.toHaveBeenCalled();
  });

  it("routes provider save, probe, and explicit Doctor actions", async () => {
    const application = createApplication();
    const server = createServer(application);
    const address = await server.start();
    const origin = `http://${address.host}:${address.port}`;

    const save = await fetch(`${address.url}api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(profile),
    });
    expect(save.status).toBe(200);
    expect(application.setProvider).toHaveBeenCalledWith(profile);

    const probe = await fetch(`${address.url}api/providers/provider-a/probe`, {
      method: "POST",
      headers: { origin },
    });
    expect(probe.status).toBe(200);
    expect(application.probeProvider).toHaveBeenCalledWith("provider-a");

    const doctor = await fetch(`${address.url}api/providers/provider-a/doctor`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ level: 2, modelId: "model-a" }),
    });
    expect(doctor.status).toBe(200);
    expect(application.diagnoseProvider).toHaveBeenCalledWith("provider-a", {
      level: 2,
      modelId: "model-a",
    });
  });

  it("routes secret and profile configuration without returning secret values", async () => {
    const application = createApplication();
    const server = createServer(application);
    const address = await server.start();

    const secretResponse = await fetch(
      `${address.url}api/secrets/PROVIDER_A_KEY`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "actual-provider-secret" }),
      },
    );
    const secretBody = await secretResponse.text();
    expect(secretResponse.status).toBe(200);
    expect(secretBody).not.toContain("actual-provider-secret");
    expect(application.setSecret).toHaveBeenCalledWith(
      "PROVIDER_A_KEY",
      "actual-provider-secret",
    );

    const logicalModel = {
      id: "coding",
      routes: [
        {
          providerId: "provider-a",
          modelId: "model-a",
          priority: 100,
          enabled: true,
        },
      ],
    };
    const logicalResponse = await fetch(`${address.url}api/logical-models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(logicalModel),
    });
    expect(logicalResponse.status).toBe(200);
    expect(application.setLogicalModel).toHaveBeenCalledWith(logicalModel);

    const promptProfile = {
      id: "practical",
      name: "Practical Coding",
      description: "",
      instructions: "Work practically.",
      preferredLogicalModelId: "coding",
      preferredClient: "auto",
      fallbackPolicy: "logical-model",
      clientFlags: { codex: [], claudeCode: [] },
    };
    const promptResponse = await fetch(`${address.url}api/prompt-profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(promptProfile),
    });
    expect(promptResponse.status).toBe(200);
    expect(application.setPromptProfile).toHaveBeenCalledWith(promptProfile);

    const projectProfile = {
      projectDirectory: "C:\\Projects\\example",
      promptProfileId: "practical",
    };
    const projectResponse = await fetch(`${address.url}api/project-profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(projectProfile),
    });
    expect(projectResponse.status).toBe(200);
    expect(application.setProjectProfile).toHaveBeenCalledWith(projectProfile);

    const deleteProject = await fetch(`${address.url}api/project-profiles`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectDirectory: projectProfile.projectDirectory }),
    });
    expect(deleteProject.status).toBe(200);
    expect(application.removeProjectProfile).toHaveBeenCalledWith(
      projectProfile.projectDirectory,
    );

    const deleteSecret = await fetch(
      `${address.url}api/secrets/PROVIDER_A_KEY`,
      { method: "DELETE" },
    );
    expect(deleteSecret.status).toBe(200);
    expect(application.removeSecret).toHaveBeenCalledWith("PROVIDER_A_KEY");
  });

  it("returns a native folder selection for Launch workspace", async () => {
    const application = createApplication();
    const pickDirectory = vi.fn(async () => "C:\\Projects\\selected");
    const server = new ProviderDashboardServer({
      application,
      sessionToken: "c".repeat(48),
      healthMonitorIntervalMs: 0,
      pickDirectory,
    });
    activeServers.push(server);
    const address = await server.start();

    const response = await fetch(`${address.url}api/directories/pick`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      selected: true,
      projectDirectory: "C:\\Projects\\selected",
    });
    expect(pickDirectory).toHaveBeenCalledOnce();
  });

  it("keeps the dashboard available when the OS secret vault is unavailable", async () => {
    const unavailable = new Error(
      "A writable OS secret vault is not available on this platform.",
    );
    unavailable.name = "SecretVaultUnavailableError";
    const application = createApplication({
      listSecretReferences: vi.fn(() => {
        throw unavailable;
      }),
    });
    const server = createServer(application);
    const address = await server.start();

    const response = await fetch(`${address.url}api/snapshot`);
    const body = (await response.json()) as {
      secretVault: {
        available: boolean;
        references: readonly string[];
        errorMessage: string;
      };
    };
    expect(response.status).toBe(200);
    expect(body.secretVault).toEqual({
      available: false,
      references: [],
      errorMessage:
        "A writable OS secret vault is not available on this platform.",
    });
  });

  it("starts client launches asynchronously and reports terminal status", async () => {
    let resolveLaunch: ((value: AutomaticLaunchResult) => void) | undefined;
    let acknowledgeLaunch: (() => void) | undefined;
    const application = createApplication({
      launchProviderAutomatic: vi.fn(
        (input: Parameters<
          ProviderDashboardApplication["launchProviderAutomatic"]
        >[0]) =>
          new Promise<AutomaticLaunchResult>((resolve) => {
            resolveLaunch = resolve;
            acknowledgeLaunch = () => input.onStarted?.("codex");
          }),
      ),
    });
    const server = createServer(application);
    const address = await server.start();

    const launchResponse = await fetch(`${address.url}api/launches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: "auto",
        projectDirectory: "C:\\Projects\\example",
        providerId: "provider-a",
        modelId: "model-a",
      }),
    });
    expect(launchResponse.status).toBe(202);
    const accepted = (await launchResponse.json()) as {
      launch: { id: string; status: string };
    };
    expect(accepted.launch.status).toBe("STARTING");
    expect(application.launchProviderAutomatic).toHaveBeenCalledWith(
      expect.objectContaining({
        projectDirectory: "C:\\Projects\\example",
        providerId: "provider-a",
        modelId: "model-a",
        onFallback: expect.any(Function),
        onStarted: expect.any(Function),
      }),
    );

    acknowledgeLaunch?.();
    await vi.waitFor(async () => {
      const response = await fetch(address.url + "api/launches");
      const body = (await response.json()) as { launches: readonly { id: string; status: string }[] };
      expect(body.launches).toContainEqual(expect.objectContaining({
        id: accepted.launch.id,
        status: "RUNNING",
      }));
    });

    resolveLaunch?.({ client: "codex", exit: { exitCode: 0, signal: null } });
    await vi.waitFor(async () => {
      const response = await fetch(`${address.url}api/launches`);
      const body = (await response.json()) as {
        launches: readonly {
          id: string;
          status: string;
          resolvedClient?: string;
          exitSummary?: string;
        }[];
      };
      expect(body.launches).toContainEqual(
        expect.objectContaining({
          id: accepted.launch.id,
          status: "EXITED",
          resolvedClient: "codex",
          exitSummary: "Exited with code 0.",
        }),
      );
    });
  });

  it("ships browser JavaScript that parses without external dependencies", () => {
    expect(() => new Function(providerDashboardJavaScript)).not.toThrow();
    expect(providerDashboardJavaScript).toContain("Последний сигнал: запрос через");
    expect(providerDashboardJavaScript).toContain("ошибок протокола");
    expect(providerDashboardJavaScript).toContain("Что сделать:");
    expect(providerDashboardJavaScript).toContain("локальные проверки и реальные запросы");
    expect(providerDashboardJavaScript).toContain("check-busy");
    expect(providerDashboardJavaScript).not.toContain("через мост");
    expect(providerDashboardJavaScript).not.toContain("Выбор папки отменён");
    expect(providerDashboardJavaScript).not.toContain("Открыто системное окно выбора папки");
    expect(providerDashboardJavaScript).not.toContain("Папка выбрана:");
    expect(providerDashboardJavaScript).toContain("Дашборд недоступен");
    expect(providerDashboardJavaScript).toContain("setProviderSetupMode");
    expect(providerDashboardJavaScript).toContain("uniqueProviderIdentity");
    expect(providerDashboardJavaScript).toContain("renderCookieOverview");
    expect(providerDashboardJavaScript).toContain("openCookieOverview");
    expect(providerDashboardJavaScript).toContain("api/portals/import");
    expect(providerDashboardJavaScript).toContain("await refresh();byId('cookie-import-dialog').close()");
  });

  it("starts the TTL-aware metadata health monitor without blocking startup", async () => {
    const application = createApplication();
    const server = new ProviderDashboardServer({
      application,
      sessionToken: "b".repeat(48),
      now: () => new Date("2026-08-30T12:00:00.000Z"),
      healthMonitorIntervalMs: 60_000,
    });
    activeServers.push(server);

    await server.start();
    await vi.waitFor(() => {
      expect(application.probeDueProviders).toHaveBeenCalledWith(
        new Date("2026-08-30T12:00:00.000Z"),
      );
    });
  });
});

function createServer(
  application: ProviderDashboardApplication,
): ProviderDashboardServer {
  const server = new ProviderDashboardServer({
    application,
    sessionToken: "a".repeat(48),
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    healthMonitorIntervalMs: 0,
  });
  activeServers.push(server);
  return server;
}

function createApplication(
  overrides: Partial<ProviderDashboardApplication> = {},
): ProviderDashboardApplication & {
  readonly setProvider: ReturnType<typeof vi.fn>;
  readonly probeProvider: ReturnType<typeof vi.fn>;
  readonly diagnoseProvider: ReturnType<typeof vi.fn>;
  readonly launchProviderAutomatic: ReturnType<typeof vi.fn>;
} {
  const probeResult = {
    health: {
      providerId: profile.id,
      status: "ONLINE" as const,
      checkedAt: "2026-08-30T12:00:00.000Z",
      latencyMs: 15,
      discoveredModelCount: 1,
      appliedFixes: [],
    },
    models: [
      {
        internalId: "provider-a:model-a",
        providerId: "provider-a",
        modelId: "model-a",
        displayName: "Model A",
        source: "discovered" as const,
        healthStatus: "ONLINE" as const,
        codexCompatibility: "UNKNOWN" as const,
        claudeCompatibility: "UNKNOWN" as const,
      },
    ],
  };
  const base = {
    listProviders: vi.fn(async () => [profile]),
    listProviderPortals: vi.fn(async () => []),
    listPortalAdapters: vi.fn(() => []),
    setProviderPortal: vi.fn(),
    refreshProviderPortal: vi.fn(),
    removeProviderPortal: vi.fn(async () => undefined),
    refreshDueProviderPortals: vi.fn(async () => undefined),
    setProvider: vi.fn(async () => profile),
    setProviderModelEnabled: vi.fn(async () => profile),
    removeProvider: vi.fn(async () => undefined),
    probeProvider: vi.fn(async () => probeResult),
    probeDueProviders: vi.fn(async () => []),
    diagnoseProvider: vi.fn(async () => ({
      providerId: profile.id,
      modelId: "model-a",
      level: 1 as const,
      protocol: "openai-responses" as const,
      checks: [],
      verdict: "PASS" as const,
      appliedFixes: [],
    })),
    listProviderHealth: vi.fn(async () => [
      {
        providerId: profile.id,
        latest: probeResult,
        history: [probeResult.health],
        diagnostics: [],
        runtimeSignals: [
          {
            providerId: profile.id,
            modelId: "model-a",
            observedAt: "2026-08-30T11:59:30.000Z",
            client: "codex" as const,
            protocol: "openai-responses" as const,
            sessionId: "dashboard-session",
            requestId: "dashboard-request",
            outcome: "completed" as const,
            healthStatus: "ONLINE" as const,
          },
        ],
      },
    ]),
    listLogicalModels: vi.fn(async () => []),
    listPromptProfiles: vi.fn(async () => []),
    listProjectProfiles: vi.fn(async () => []),
    listProviderPlugins: vi.fn(() => []),
    summarizeUsage: vi.fn(async () => []),
    listUsage: vi.fn(async () => []),
    setSecret: vi.fn(async () => undefined),
    listSecretReferences: vi.fn(async () => ["PROVIDER_A_KEY"]),
    removeSecret: vi.fn(async () => true),
    setLogicalModel: vi.fn(async (input: unknown) => input as never),
    removeLogicalModel: vi.fn(async () => undefined),
    setPromptProfile: vi.fn(async (input: unknown) => input as never),
    removePromptProfile: vi.fn(async () => undefined),
    setProjectProfile: vi.fn(async (input: unknown) => input as never),
    removeProjectProfile: vi.fn(async () => undefined),
    launchCodex: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchCodexLogicalModel: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchCodexPromptProfile: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchCodexProjectProfile: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchClaude: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchClaudeLogicalModel: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchClaudePromptProfile: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchClaudeProjectProfile: vi.fn(async () => ({ exitCode: 0, signal: null })),
    launchProviderAutomatic: vi.fn(async () => ({
      client: "codex" as const,
      exit: { exitCode: 0, signal: null },
    })),
    launchLogicalModelAutomatic: vi.fn(async () => ({
      client: "codex" as const,
      exit: { exitCode: 0, signal: null },
    })),
    launchPromptProfileAutomatic: vi.fn(async () => ({
      client: "codex" as const,
      exit: { exitCode: 0, signal: null },
    })),
    launchProjectProfileAutomatic: vi.fn(async () => ({
      client: "codex" as const,
      exit: { exitCode: 0, signal: null },
    })),
  };
  return Object.assign(base, overrides) as ProviderDashboardApplication & {
    readonly setProvider: ReturnType<typeof vi.fn>;
    readonly probeProvider: ReturnType<typeof vi.fn>;
    readonly diagnoseProvider: ReturnType<typeof vi.fn>;
    readonly launchProviderAutomatic: ReturnType<typeof vi.fn>;
  };
}
