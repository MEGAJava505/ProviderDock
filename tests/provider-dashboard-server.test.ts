import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomaticLaunchResult } from "../src/application/provider-dock-application.js";
import type { ProviderProfile } from "../src/core/providers/provider-profile.js";
import type { ProviderDashboardApplication } from "../src/ui/provider-dashboard-server.js";
import { ProviderDashboardServer } from "../src/ui/provider-dashboard-server.js";
import { PortalRepositoryCorruptionError } from "../src/core/portals/portal-repository.js";
import { CredentialManagerError } from "../src/core/security/credential-manager.js";
import {
  providerDashboardCss,
  providerDashboardHtml,
  providerDashboardJavaScript,
} from "../src/ui/provider-dashboard-page.js";
import { providerConfigurationFingerprint } from "../src/core/health/provider-health-repository.js";

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
    expect(pageBody).not.toContain("data-open-launch");
    expect(pageBody).toContain('id="launch-approval"');
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
      portalStatus: { state: string; message?: string; backupPath?: string };
    };
    expect(snapshot.providers).toEqual([profile]);
    expect((snapshot as unknown as { storefront: unknown[] }).storefront).toEqual([
      expect.objectContaining({ providerId: profile.id, modelId: "model-a", pricing: null,
        balance: null, providerLoad: null }),
    ]);
    expect(snapshot.generatedAt).toBe("2026-08-30T12:00:00.000Z");
    expect(snapshot.portalStatus).toEqual({ state: "healthy" });
    expect(snapshot.portalStatus).not.toHaveProperty("backupPath");
    expect((snapshot as unknown as { secretVault: unknown }).secretVault).toEqual({
      available: true,
      references: ["PROVIDER_A_KEY"],
    });
    expect(JSON.stringify(snapshot)).toContain("dashboard-session");
    expect(JSON.stringify(snapshot)).not.toContain("actual-provider-secret");
  });

  it("exposes the four compatibility surfaces in the provider snapshot and dashboard asset", async () => {
    const server = createServer(createApplication());
    const address = await server.start();

    const response = await fetch(`${address.url}api/snapshot`);
    const snapshot = (await response.json()) as {
      health: readonly [{
        surfaceOverview: {
          surfaces: readonly { surface: string; outcome: string }[];
          recommendedSurface?: string;
        };
      }];
    };

    expect(snapshot.health[0]?.surfaceOverview).toMatchObject({
      recommendedSurface: "openai-api",
      surfaces: [
        { surface: "openai-api", outcome: "passed" },
        { surface: "anthropic-api", outcome: "passed" },
        { surface: "codex-cli", outcome: "passed" },
        { surface: "claude-code", outcome: "passed" },
      ],
    });
    expect(providerDashboardJavaScript).toContain("openai-api");
    expect(providerDashboardJavaScript).toContain("anthropic-api");
    expect(providerDashboardJavaScript).toContain("codex-cli");
    expect(providerDashboardJavaScript).toContain("claude-code");
  });

  it("shows managed credential masks in the snapshot without exposing their values", async () => {
    const application = createApplication({
      listCredentials: vi.fn(async () => [{
        id: "00000000-0000-4000-8000-000000000001",
        providerId: "provider-a",
        purpose: "provider-api" as const,
        maskedValue: "fix…cret",
        state: "active" as const,
        createdAt: "2026-08-30T12:00:00.000Z",
      }]),
      listManagedSecretReferences: vi.fn(async () => ["credential-00000000-0000-4000-8000-000000000001"]),
      listSecretReferences: vi.fn(async () => ["credential-00000000-0000-4000-8000-000000000001"]),
    });
    const server = createServer(application);
    const response = await fetch(`${(await server.start()).url}api/snapshot`);
    const snapshot = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(snapshot.credentials).toEqual([expect.objectContaining({
      providerId: "provider-a",
      maskedValue: "fix…cret",
      state: "active",
    })]);
    expect(snapshot.managedSecretReferences).toEqual([
      "credential-00000000-0000-4000-8000-000000000001",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("fixture-api-secret");
  });

  it("keeps the dashboard snapshot usable when credential metadata cannot be read", async () => {
    const application = createApplication({
      listCredentials: vi.fn(async () => { throw new Error("private-registry-canary"); }),
      listManagedSecretReferences: vi.fn(async () => ["credential-private"]),
    });
    const server = createServer(application);
    const response = await fetch(`${(await server.start()).url}api/snapshot`);
    const snapshot = await response.json();

    expect(response.status).toBe(200);
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.credentials).toEqual([]);
    expect(snapshot.managedSecretReferences).toEqual([]);
    expect(snapshot.credentialDiagnostic).toMatchObject({
      stage: "credentials", code: "CREDENTIAL_REGISTRY_UNAVAILABLE",
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-registry-canary");
  });

  it("does not expose the local portal recovery backup path", async () => {
    const application = createApplication({
      providerPortalStatus: vi.fn(() => ({
        state: "corrupt" as const,
        message: "Portal state needs recovery.",
        backupPath: "C:\\Users\\operator\\private\\portals.json.bak",
      })),
    });
    const server = createServer(application);
    const address = await server.start();

    const response = await fetch(`${address.url}api/snapshot`);
    const source = await response.text();

    expect(response.status).toBe(200);
    expect(source).toContain("Portal state needs recovery.");
    expect(source).not.toContain("backupPath");
    expect(source).not.toContain("Users\\\\operator");
  });

  it("keeps the snapshot available when the portal store is corrupt", async () => {
    const application = createApplication({
      listProviderPortals: vi.fn(async () => {
        throw new PortalRepositoryCorruptionError("Portal account store is corrupt.");
      }),
      providerPortalStatus: vi.fn(() => ({
        state: "corrupt" as const,
        message: "Portal account store is corrupt.",
      })),
    });
    const server = createServer(application);
    const address = await server.start();

    const response = await fetch(`${address.url}api/snapshot`);
    const snapshot = (await response.json()) as {
      portals: readonly unknown[];
      portalStatus: { state: string; message?: string };
    };

    expect(response.status).toBe(200);
    expect(snapshot.portals).toEqual([]);
    expect(snapshot.portalStatus).toEqual({
      state: "corrupt",
      message: "Portal account store is corrupt.",
    });
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

  it("reports managed-secret write and delete conflicts without exposing a submitted key", async () => {
    const conflict = new CredentialManagerError(
      "CONFLICT",
      "Managed credentials must be rotated or removed with credential commands.",
    );
    const application = createApplication({
      setSecret: vi.fn(async () => { throw conflict; }),
      removeSecret: vi.fn(async () => { throw conflict; }),
    });
    const server = createServer(application);
    const address = await server.start();

    const put = await fetch(`${address.url}api/secrets/credential-managed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "secret-submit-canary" }),
    });
    const remove = await fetch(`${address.url}api/secrets/credential-managed`, {
      method: "DELETE",
    });

    expect(put.status).toBe(409);
    expect(remove.status).toBe(409);
    const putBody = await put.json();
    expect(putBody.code).toBe("CREDENTIAL_CONFLICT");
    expect(JSON.stringify(putBody)).not.toContain("secret-submit-canary");
    expect((await remove.json()).code).toBe("CREDENTIAL_CONFLICT");
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
        approvalLevel: "ask",
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

  it("resolves an omitted launch approval from the stored preference", async () => {
    const application = createApplication({
      resolveApprovalLevel: vi.fn(async () => "full-auto" as const),
      launchProviderAutomatic: vi.fn(async () => ({
        client: "codex" as const,
        exit: { exitCode: 0, signal: null },
      })),
    });
    const server = createServer(application);
    const address = await server.start();

    const response = await fetch(`${address.url}api/launches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: "auto",
        projectDirectory: "C:\\Projects\\example",
        providerId: "provider-a",
        modelId: "model-a",
      }),
    });
    const accepted = (await response.json()) as {
      launch: { resolvedApprovalLevel?: string };
    };

    expect(response.status).toBe(202);
    expect(application.resolveApprovalLevel).toHaveBeenCalledWith(
      "C:\\Projects\\example",
      undefined,
    );
    expect(application.launchProviderAutomatic).toHaveBeenCalledWith(
      expect.objectContaining({ approvalLevel: "full-auto" }),
    );
    expect(accepted.launch.resolvedApprovalLevel).toBe("full-auto");
  });

  it("serves agent session history without exposing filesystem paths and deletes safely", async () => {
    const sessions = [
      {
        id: "8fbf0290-d6ae-44a9-85e2-fc36e0915743",
        client: "claude-code" as const,
        providerId: "agentrouter-2",
        projectDirectory: "E:\\Projects\\provider__switcher",
        modelId: "claude-opus-4.8",
        title: "Claude title",
        updatedAt: "2026-09-10T10:00:00.000Z",
        resumable: true,
      },
      {
        id: "01a08736-06ba-7b92-97a4-0fbdb4e6976c",
        client: "codex" as const,
        providerId: "legacy",
        projectDirectory: "E:\\Projects\\legacy",
        modelId: "gpt-5.6-sol",
        title: "Legacy Codex session",
        updatedAt: "2026-09-09T10:00:00.000Z",
        resumable: false,
        resumeBlockedReason: "legacy-provider" as const,
      },
    ];
    const application = createApplication({
      listAgentSessions: vi.fn(async () => sessions),
      deleteAgentSession: vi.fn(async () => true),
    });
    const server = createServer(application);
    const address = await server.start();

    const list = await fetch(`${address.url}api/agent-sessions`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: readonly unknown[] };
    expect(body.sessions).toEqual(sessions);
    expect(JSON.stringify(body)).not.toContain("path");

    const deleted = await fetch(
      `${address.url}api/agent-sessions/claude-code/8fbf0290-d6ae-44a9-85e2-fc36e0915743?providerId=agentrouter-2`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(application.deleteAgentSession).toHaveBeenCalledWith(
      "claude-code",
      "8fbf0290-d6ae-44a9-85e2-fc36e0915743",
      "agentrouter-2",
    );

    const page = await fetch(address.url);
    const pageBody = await page.text();
    expect(pageBody).toContain("Прошлые сессии");
    expect(pageBody).toContain('id="agent-sessions"');
    expect(pageBody).toContain('id="agent-session-search"');
    expect(pageBody).toContain('id="launch-agent-sessions"');
    expect(pageBody).toContain('id="launch-agent-session-search"');
    expect(providerDashboardJavaScript).toContain("providerSessionList.id='provider-agent-sessions'");
    expect(providerDashboardCss).toContain(".agent-session-list.compact");
    expect(providerDashboardJavaScript).toContain("agentSessionUnavailableReason");
    expect(providerDashboardJavaScript).toContain("providerAgentSessions");
    expect(providerDashboardJavaScript).toContain("старая Codex-сессия без привязки к провайдеру");
    expect(providerDashboardJavaScript).toContain("в истории нет модели");
    expect(providerDashboardJavaScript).toContain("в истории нет проекта");
    expect(providerDashboardJavaScript).toContain("некорректный ID сессии");
  });

  it("starts a resume launch from selected agent history", async () => {
    const application = createApplication({
      launchClaude: vi.fn(async () => ({ exitCode: 0, signal: null })),
    });
    const server = createServer(application);
    const address = await server.start();

    const response = await fetch(`${address.url}api/launches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: "claude-code",
        projectDirectory: "E:\\Projects\\provider__switcher",
        providerId: "agentrouter-2",
        modelId: "claude-opus-4.8",
        resumeSessionId: "8fbf0290-d6ae-44a9-85e2-fc36e0915743",
      }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(application.launchClaude).toHaveBeenCalledWith(
        expect.objectContaining({
          projectDirectory: "E:\\Projects\\provider__switcher",
          providerId: "agentrouter-2",
          modelId: "claude-opus-4.8",
          resumeSessionId: "8fbf0290-d6ae-44a9-85e2-fc36e0915743",
          approvalLevel: "ask",
          onFallback: expect.any(Function),
          onStarted: expect.any(Function),
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
    expect(providerDashboardJavaScript).toContain("renderAgentSessions");
    expect(providerDashboardJavaScript).toContain("renderAgentSessionList('launch-agent-sessions'");
    expect(providerDashboardJavaScript).toContain("resumeAgentSession");
    expect(providerDashboardJavaScript).toContain("deleteAgentSession");
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
  const configurationFingerprint = providerConfigurationFingerprint(profile);
  const base = {
    listProviders: vi.fn(async () => [profile]),
    listProviderPortals: vi.fn(async () => []),
    providerPortalStatus: vi.fn(() => ({ state: "healthy" as const })),
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
        surfaceChecks: [
          {
            providerId: profile.id,
            modelId: "model-a",
            surface: "openai-api" as const,
            configurationFingerprint,
            checkedAt: "2026-08-30T11:55:00.000Z",
            durationMs: 15,
            outcome: "passed" as const,
            client: "providerdock" as const,
            protocol: "openai-responses" as const,
          },
          {
            providerId: profile.id,
            modelId: "model-a",
            surface: "anthropic-api" as const,
            configurationFingerprint,
            checkedAt: "2026-08-30T11:56:00.000Z",
            durationMs: 16,
            outcome: "passed" as const,
            client: "providerdock" as const,
            protocol: "anthropic-messages" as const,
          },
          {
            providerId: profile.id,
            modelId: "model-a",
            surface: "codex-cli" as const,
            configurationFingerprint,
            checkedAt: "2026-08-30T11:57:00.000Z",
            durationMs: 17,
            outcome: "passed" as const,
            client: "codex" as const,
            protocol: "openai-responses" as const,
          },
          {
            providerId: profile.id,
            modelId: "model-a",
            surface: "claude-code" as const,
            configurationFingerprint,
            checkedAt: "2026-08-30T11:58:00.000Z",
            durationMs: 18,
            outcome: "passed" as const,
            client: "claude-code" as const,
            protocol: "anthropic-messages" as const,
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
    listAgentSessions: vi.fn(async () => []),
    deleteAgentSession: vi.fn(async () => false),
    resolveApprovalLevel: vi.fn(async () => "ask"),
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

describe("dashboard launch history layout", () => {
  it("renders launch route tabs as a readable two-column grid", () => {
    expect(providerDashboardCss).toMatch(
      /#launch-dialog \.route-tabs\{[^}]*display:grid;[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
    );
    expect(providerDashboardCss).not.toMatch(
      /#launch-dialog \.route-tabs\{[^}]*display:flex/,
    );
    expect(providerDashboardCss).toMatch(
      /#launch-dialog \.route-tab\{[^}]*min-width:0;[^}]*padding:[^}]*\}/,
    );
  });

  it("wires launch history to the selected provider", () => {
    expect(providerDashboardHtml).toContain('id="launch-history"');
    expect(providerDashboardJavaScript).toContain("agentSessionHistoryView");
    expect(providerDashboardJavaScript).toContain(
      "byId('launch-provider').addEventListener('change',()=>{renderModelOptions();renderAgentSessions()})",
    );
    expect(providerDashboardJavaScript).toMatch(
      /function setRouteKind\([\s\S]*?renderAgentSessions\(\)/,
    );
  });
});
