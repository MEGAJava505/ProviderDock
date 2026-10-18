import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialManager,
  GenericOpenAiAdapter,
  MemoryCredentialMetadataRepository,
  MemoryProviderHealthRepository,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  runProviderDockCli,
  type CredentialSummary,
} from "../src/index.js";
import { ApplicationCredentialBindings } from "../src/core/security/credential-bindings.js";
import {
  FilePortalRepository,
  MemoryPortalRepository,
} from "../src/core/portals/portal-repository.js";
import { runCli } from "./support/cli-harness.js";
import { createServer } from "node:net";
import { openDashboardInBrowser } from "../src/ui/open-dashboard-browser.js";
import type { OmpRouteReadinessPreview } from "../src/migration/omp-route-readiness-preview.js";

/** Minimal safe preview so OMP launcher stubs satisfy the interface; no test asserts on it. */
const ompPreviewStub = async (): Promise<OmpRouteReadinessPreview> => ({
  selection: { providerId: "provider-a", accountId: "account-a", modelId: "model-a" },
  verdict: "unknown",
  reason: "route-preview-stub",
  evidenceTier: "none",
  chain: [],
  autoFallback: "not-offered",
  loopbackSmokeIsUpstreamPass: false,
  recommendedAction: "run-local-smoke-or-paid-doctor",
});
import type { OmpLaunchInput } from "../src/application/omp-launch-service.js"
import type { OperationDiagnostic } from "../src/core/errors/operation-diagnostic.js";

vi.mock("../src/ui/open-dashboard-browser.js", () => ({
  openDashboardInBrowser: vi.fn(async () => undefined),
}));

describe("ProviderDock management CLI", () => {
  it("sets, lists, shows, and removes a provider without storing a secret value", async () => {
    const application = createApplication();

    const set = await runCli(application, [
      "providers",
      "set",
      "--id",
      "agentrouter",
      "--name",
      "AgentRouter",
      "--base-url",
      "https://example.test/v1/",
      "--auth-kind",
      "bearer",
      "--secret-ref",
      "AGENTROUTER_API_KEY",
      "--manual-model",
      "gpt-x",
    ]);
    expect(set.code).toBe(0);
    expect(set.stdout).toEqual(["Saved provider 'agentrouter'."]);

    const list = await runCli(application, ["providers", "list", "--json"]);
    expect(list.code).toBe(0);
    expect(list.stdout.join("\n")).toContain("AGENTROUTER_API_KEY");
    expect(list.stdout.join("\n")).not.toContain("actual-secret-value");

    const show = await runCli(application, ["providers", "show", "agentrouter"]);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.stdout[0] ?? "{}")).toMatchObject({
      id: "agentrouter",
      baseUrl: "https://example.test/v1",
      auth: { kind: "bearer", secretRef: "AGENTROUTER_API_KEY" },
    });

    const remove = await runCli(application, ["providers", "remove", "agentrouter"]);
    expect(remove).toMatchObject({ code: 0, stdout: ["Removed provider 'agentrouter'."] });
    expect((await application.listProviders())).toHaveLength(0);
  });

  it("rejects API key command-line fields", async () => {
    const result = await runCli(createApplication(), [
      "providers",
      "set",
      "--id",
      "unsafe",
      "--name",
      "Unsafe",
      "--base-url",
      "https://example.test",
      "--api-key",
      "actual-secret-value",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("Unknown option");
  });

  it("rejects credential headers passed as static values", async () => {
    const result = await runCli(createApplication(), [
      "providers",
      "set",
      "--id",
      "unsafe",
      "--name",
      "Unsafe",
      "--base-url",
      "https://example.test",
      "--header",
      "Authorization=Bearer actual-secret-value",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("must use auth or secretHeaders");
  });

  it("uses a persisted approval preference when --approval is omitted", async () => {
    const application = createApplication();
    const resolveApprovalLevel = vi
      .spyOn(application, "resolveApprovalLevel")
      .mockResolvedValue("full-auto");
    const launchCodex = vi
      .spyOn(application, "launchCodex")
      .mockResolvedValue({ exitCode: 0, signal: null });

    const result = await runCli(application, [
      "launch",
      "codex",
      "--provider",
      "provider-a",
      "--model",
      "model-a",
      "--project",
      "C:\\Projects\\example",
    ]);

    expect(result.code).toBe(0);
    expect(resolveApprovalLevel).toHaveBeenCalledWith(
      "C:\\Projects\\example",
      undefined,
    );
    expect(launchCodex).toHaveBeenCalledWith(
      expect.objectContaining({ approvalLevel: "full-auto" }),
    );
  });


  it("launches OMP only after explicit preflight and separate acknowledgement", async () => {
    const application = createApplication();
    const preflight = vi.fn(async (input: OmpLaunchInput) => ({
      ok: true as const,
      providerId: input.providerId,
      accountId: input.accountId,
      modelId: input.modelId,
      api: "openai-responses" as const,
    }));
    const launch = vi.fn(async () => ({ ok: true as const, runId: "omp-run-1" }));
    const listRuns = vi.fn(async () => []);
    const cancel = vi.fn(async () => undefined);
    const reconcileAfterRestart = vi.fn(async () => []);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runProviderDockCli(
      [
        "launch",
        "omp",
        "--provider",
        "provider-a",
        "--model",
        "model-a",
        "--omp-account",
        "account-a",
        "--project",
        "C:\\Projects\\example",
        "--omp-read-only-pilot-no-sandbox",
      ],
      {
        application,
        io: { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) },
        environment: {},
        ompLauncher: { preflight, launch, preview: vi.fn(ompPreviewStub), listRuns, cancel, reconcileAfterRestart },
      },
    );

    expect(code).toBe(0);
    expect(stdout).toEqual(["OMP run started: omp-run-1"]);
    expect(stderr).toEqual([]);
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "provider-a",
        modelId: "model-a",
        accountId: "account-a",
        projectDirectory: "C:\\Projects\\example",
        permissionAcknowledgement: "read-only-pilot-no-sandbox",
      }),
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ permissionAcknowledgement: "read-only-pilot-no-sandbox" }),
    );
  });

  it("requires the separate OMP acknowledgement and rejects --approval as a substitute", async () => {
    const application = createApplication();
    const preflight = vi.fn(async (input: OmpLaunchInput) => ({
      ok: true as const,
      providerId: input.providerId,
      accountId: input.accountId,
      modelId: input.modelId,
      api: "openai-responses" as const,
    }));
    const launch = vi.fn(async () => ({ ok: true as const, runId: "omp-run-1" }));
    const listRuns = vi.fn(async () => []);
    const cancel = vi.fn(async () => undefined);
    const reconcileAfterRestart = vi.fn(async () => []);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runProviderDockCli(
      [
        "launch",
        "omp",
        "--provider",
        "provider-a",
        "--model",
        "model-a",
        "--omp-account",
        "account-a",
        "--project",
        "C:\\Projects\\example",
        "--approval",
        "full-auto",
      ],
      {
        application,
        io: { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) },
        environment: {},
        ompLauncher: { preflight, launch, preview: vi.fn(ompPreviewStub), listRuns, cancel, reconcileAfterRestart },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("OMP_PERMISSION_CONFIRMATION_REQUIRED");
    expect(stdout).toEqual([]);
    expect(preflight).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("prints only a safe diagnostic when OMP preflight fails", async () => {
    const application = createApplication();
    const unsafeDiagnostic: OperationDiagnostic = {
      code: "OPERATION_FAILED",
      stage: "validation",
      operationId: "01937d71-7ae7-7abc-8100-000000000003",
      occurredAt: "2026-09-15T00:00:00.000Z",
      retryable: false,
      suggestedAction: "Use a safe fixture",
      message: "Bearer sk-secret",
    };
    const preflight = vi.fn(async () => ({ ok: false as const, diagnostic: unsafeDiagnostic }));
    const launch = vi.fn(async () => ({ ok: true as const, runId: "omp-run-1" }));
    const listRuns = vi.fn(async () => []);
    const cancel = vi.fn(async () => undefined);
    const reconcileAfterRestart = vi.fn(async () => []);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runProviderDockCli(
      [
        "launch",
        "omp",
        "--provider",
        "provider-a",
        "--model",
        "model-a",
        "--omp-account",
        "account-a",
        "--project",
        "C:\\Projects\\example",
        "--omp-read-only-pilot-no-sandbox",
      ],
      {
        application,
        io: { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) },
        environment: {},
        ompLauncher: { preflight, launch, preview: vi.fn(ompPreviewStub), listRuns, cancel, reconcileAfterRestart },
      },
    );

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("OPERATION_FAILED");
    expect([...stdout, ...stderr].join("\n")).not.toContain("sk-secret");
    expect(launch).not.toHaveBeenCalled();
  });

  it("probes models and reports normalized health", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), {
          status: 200,
        }),
    );
    const application = createApplication(fetchMock);
    await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
    });

    const result = await runCli(application, ["probe", "router", "--json"]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout[0] ?? "{}")).toMatchObject({
      health: { providerId: "router", status: "ONLINE", discoveredModelCount: 1 },
      models: [{ internalId: "router:gpt-x", healthStatus: "UNKNOWN" }],
    });

    await runCli(application, ["probe", "router"]);
    const dashboard = await runCli(application, ["health", "show", "router", "--json"]);
    expect(JSON.parse(dashboard.stdout[0] ?? "{}")).toMatchObject({
      providerId: "router",
      latest: {
        health: { status: "ONLINE" },
        models: [{ internalId: "router:gpt-x" }],
      },
      history: [{ status: "ONLINE" }, { status: "ONLINE" }],
    });
    const listed = await runCli(application, ["health", "list"]);
    expect(listed.stdout.join("\n")).toContain("router");
    const history = await runCli(application, ["health", "history", "router"]);
    expect(history.stdout.join("\n")).toContain("ONLINE");

    await application.removeProvider("router");
    expect((await runCli(application, ["health", "list"])).stdout).toEqual([
      "No persisted health snapshots.",
    ]);
  });

  it("returns exit code 2 for an unhealthy probe", async () => {
    const application = createApplication(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
    });

    const result = await runCli(application, ["probe", "router"]);
    expect(result.code).toBe(2);
    expect(result.stdout.join("\n")).toContain("Status: AUTH_ERROR");
    expect(result.stdout.join("\n")).toContain(
      "The provider endpoint is reachable, but authentication was rejected.",
    );
    expect(result.stdout.join("\n")).toContain("Suggested action:");
  });

  it("renders persisted capability diagnostics even before the first probe", async () => {
    const health = new MemoryProviderHealthRepository();
    const application = new ProviderDockApplication(
      new MemoryProviderProfileRepository(),
      new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      health,
    );
    await health.recordDiagnostics({
      providerId: "router",
      modelId: "gpt-x",
      checkedAt: "2026-08-30T10:00:00.000Z",
      doctorLevel: 3,
      verdict: "PASS",
      protocol: "openai-responses",
      capabilities: {
        text: "SUPPORTED",
        streaming: "SUPPORTED",
        tools: "SUPPORTED",
        parallel_tools: "UNKNOWN",
        reasoning: "UNKNOWN",
        images: "UNKNOWN",
        web_search: "UNKNOWN",
        long_context: "UNKNOWN",
        usage: "UNKNOWN",
        cancellation: "UNKNOWN",
        model_discovery: "SUPPORTED",
      },
      codexCompatibility: "NATIVE",
      claudeCompatibility: "INCOMPATIBLE",
    });

    const listed = await runCli(application, ["health", "list"]);
    expect(listed.stdout.join("\n")).toContain("NO_PROBE");
    expect(listed.stdout.join("\n")).toContain("router");

    const shown = await runCli(application, ["health", "show", "router"]);
    expect(shown.stdout.join("\n")).toContain("Capability diagnostics:");
    expect(shown.stdout.join("\n")).toContain("gpt-x");
    expect(shown.stdout.join("\n")).toContain("openai-responses");
    expect(shown.stdout.join("\n")).toContain("NATIVE");

    const history = await runCli(application, ["health", "history", "router"]);
    expect(history.stdout).toEqual([
      "No persisted probe history for provider 'router'.",
    ]);
  });

  it("imports a secret from the environment without printing it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), { status: 200 }),
    );
    const application = createApplication(fetchMock);

    const stored = await runCli(
      application,
      ["secrets", "set", "ROUTER_KEY", "--from-env", "IMPORT_KEY"],
      { IMPORT_KEY: "actual-secret-value" },
    );
    expect(stored.code).toBe(0);
    expect([...stored.stdout, ...stored.stderr].join("\n")).not.toContain("actual-secret-value");

    const listed = await runCli(application, ["secrets", "list"]);
    expect(listed.stdout).toEqual(["ROUTER_KEY"]);

    await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
    });
    const probe = await runCli(application, ["probe", "router"]);
    expect(probe.code).toBe(0);
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("authorization")).toBe("Bearer actual-secret-value");

    const removed = await runCli(application, ["secrets", "remove", "ROUTER_KEY"]);
    expect(removed.code).toBe(0);
    expect((await runCli(application, ["secrets", "list"])).stdout).toEqual([
      "No secrets stored.",
    ]);
  });

  it("manages validated logical-model routes and protects referenced providers", async () => {
    const application = createApplication();
    for (const id of ["primary", "secondary"]) {
      await application.setProvider({
        id,
        displayName: id,
        baseUrl: `https://${id}.example.test/v1`,
      });
    }

    const saved = await runCli(application, [
      "logical-models",
      "set",
      "--id",
      "gpt-x",
      "--route",
      "primary=gpt-x@100",
      "--route",
      "secondary=gpt-x@90",
    ]);
    expect(saved).toMatchObject({ code: 0, stdout: ["Saved logical model 'gpt-x'."] });

    const listed = await runCli(application, ["logical-models", "list", "--json"]);
    expect(JSON.parse(listed.stdout[0] ?? "[]")).toMatchObject([
      {
        id: "gpt-x",
        routes: [
          { providerId: "primary", modelId: "gpt-x", priority: 100, enabled: true },
          { providerId: "secondary", modelId: "gpt-x", priority: 90, enabled: true },
        ],
      },
    ]);
    expect(
      (await runCli(application, ["providers", "remove", "primary"])).stderr.join("\n"),
    ).toContain("used by logical model 'gpt-x'");

    expect(
      await runCli(application, ["logical-models", "remove", "gpt-x"]),
    ).toMatchObject({ code: 0, stdout: ["Removed logical model 'gpt-x'."] });
  });

  it("rejects malformed routes and routes to unknown providers", async () => {
    const application = createApplication();
    const malformed = await runCli(application, [
      "logical-models",
      "set",
      "--id",
      "gpt-x",
      "--route",
      "missing-separator",
    ]);
    expect(malformed).toMatchObject({ code: 1 });
    expect(malformed.stderr.join("\n")).toContain("PROVIDER=MODEL");

    const unknown = await runCli(application, [
      "logical-models",
      "set",
      "--id",
      "gpt-x",
      "--route",
      "missing=gpt-x@100",
    ]);
    expect(unknown).toMatchObject({ code: 1 });
    expect(unknown.stderr.join("\n")).toContain("Provider 'missing' is not configured");
  });

  it("opens the dashboard when no command is provided", async () => {
    const openBrowser = vi.mocked(openDashboardInBrowser);
    openBrowser.mockClear();
    const once = vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT") {
        queueMicrotask(() => {
          listener("SIGINT");
        });
      }
      return process;
    });

    try {
      const result = await runCli(createApplication(), []);

      expect(result).toMatchObject({ code: 0 });
      expect(result.stdout.join("\n")).toContain("ProviderDock dashboard:");
      expect(openBrowser).toHaveBeenCalledTimes(1);
      expect(String(openBrowser.mock.calls[0]?.[0])).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\//,
      );
    } finally {
      once.mockRestore();
    }
  });
  it("passes the direct OMP launcher to the dashboard", async () => {
    const application = createApplication();
    const ompLauncher = {
      preflight: vi.fn(async () => ({
        ok: true as const,
        providerId: "provider-a",
        accountId: "account-a",
        modelId: "model-a",
        api: "openai-responses" as const,
      })),
      launch: vi.fn(async () => ({ ok: true as const, runId: "01937d71-7ae7-7abc-8100-000000000001" })),
      preview: vi.fn(ompPreviewStub),
      listRuns: vi.fn(async () => []),
      cancel: vi.fn(async () => undefined),
      reconcileAfterRestart: vi.fn(async () => []),
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    let finish: (() => void) | undefined;
    const once = vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "SIGINT") {
        finish = () => listener("SIGINT");
      }
      return process;
    });

    try {
      const dashboardPort = await new Promise<number>((resolve, reject) => {
        const listener = createServer();
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", () => {
          const address = listener.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Could not allocate a dashboard test port."));
            return;
          }
          listener.close(() => resolve(address.port));
        });
      });
      let dashboardFailure: unknown;
      const dashboard = runProviderDockCli(["dashboard", "--port", String(dashboardPort)], {
        application,
        io: {
          stdout: (message) => stdout.push(message),
          stderr: (message) => stderr.push(message),
        },
        environment: {},
        ompLauncher,
      });
      dashboard.catch((error: unknown) => {
        dashboardFailure = error;
      });
      const deadline = Date.now() + 5_000;
      while (stdout.length === 0) {
        if (Date.now() >= deadline) {
          if (dashboardFailure !== undefined) throw dashboardFailure;
          throw new Error(`Dashboard did not start. stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const dashboardUrl = /^ProviderDock dashboard: (\S+)/.exec(stdout[0] ?? "")?.[1];
      expect(dashboardUrl).toBeDefined();
      const runsResponse = await fetch(`${dashboardUrl}api/omp/runs`);
      expect(runsResponse.status).toBe(200);
      expect(await runsResponse.json()).toEqual({ runs: [] });
      expect(ompLauncher.reconcileAfterRestart).toHaveBeenCalledTimes(1);
      expect(ompLauncher.listRuns).toHaveBeenCalledTimes(1);

      finish?.();
      expect(await dashboard).toBe(0);
      expect(stderr).toEqual([]);
    } finally {
      finish?.();
      once.mockRestore();
    }
  });
  it("manages prompt profiles from a multiline instructions file with reference integrity", async () => {
    const application = createApplication();
    for (const id of ["primary", "direct"]) {
      await application.setProvider({
        id,
        displayName: id,
        baseUrl: `https://${id}.example.test/v1`,
      });
    }
    await application.setLogicalModel({
      id: "gpt-x",
      routes: [{ providerId: "primary", modelId: "gpt-x", priority: 100 }],
    });
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-prompt-cli-"));
    const instructionsFile = join(directory, "instructions.md");
    await writeFile(
      instructionsFile,
      "Work practically.\nInspect existing implementation first.\n",
      "utf8",
    );

    const saved = await runCli(application, [
      "prompt-profiles",
      "set",
      "--id",
      "practical",
      "--name",
      "Practical Coding",
      "--description",
      "Default implementation profile",
      "--instructions-file",
      instructionsFile,
      "--provider",
      "direct",
      "--logical-model",
      "gpt-x",
      "--client",
      "codex",
      "--reasoning",
      "xhigh",
      "--fallback",
      "logical-model",
      "--codex-flag=--no-alt-screen",
    ]);
    expect(saved).toMatchObject({
      code: 0,
      stdout: ["Saved prompt profile 'practical'."],
    });

    const shown = await runCli(application, [
      "prompt-profiles",
      "show",
      "practical",
    ]);
    expect(JSON.parse(shown.stdout[0] ?? "{}")).toMatchObject({
      id: "practical",
      instructions:
        "Work practically.\nInspect existing implementation first.",
      preferredProviderId: "direct",
      preferredLogicalModelId: "gpt-x",
      preferredClient: "codex",
      reasoningLevel: "xhigh",
      fallbackPolicy: "logical-model",
      clientFlags: { codex: ["--no-alt-screen"] },
    });
    expect(
      (await runCli(application, ["providers", "remove", "direct"])).stderr.join(
        "\n",
      ),
    ).toContain("preferred by prompt profile 'practical'");
    expect(
      (
        await runCli(application, [
          "logical-models",
          "remove",
          "gpt-x",
        ])
      ).stderr.join("\n"),
    ).toContain("preferred by prompt profile 'practical'");

    const projectDirectory = join(directory, "project");
    expect(
      await runCli(application, [
        "project-profiles",
        "set",
        "--project",
        projectDirectory,
        "--prompt-profile",
        "practical",
      ]),
    ).toMatchObject({
      code: 0,
      stdout: [`Saved project profile '${projectDirectory}'.`],
    });
    const projectProfile = await runCli(application, [
      "project-profiles",
      "show",
      "--project",
      projectDirectory,
    ]);
    expect(JSON.parse(projectProfile.stdout[0] ?? "{}")).toMatchObject({
      projectDirectory,
      promptProfileId: "practical",
    });
    expect(
      (
        await runCli(application, [
          "prompt-profiles",
          "remove",
          "practical",
        ])
      ).stderr.join("\n"),
    ).toContain("assigned to project");
    expect(
      await runCli(application, [
        "project-profiles",
        "remove",
        "--project",
        projectDirectory,
      ]),
    ).toMatchObject({
      code: 0,
      stdout: [`Removed project profile '${projectDirectory}'.`],
    });

    expect(
      await runCli(application, [
        "prompt-profiles",
        "remove",
        "practical",
      ]),
    ).toMatchObject({
      code: 0,
      stdout: ["Removed prompt profile 'practical'."],
    });
  });
});

describe("credential maintenance CLI", () => {
  it("reconciles legacy references without printing secret values", async () => {
    const application = createApplication();
    const summaries: CredentialSummary[] = [{
      id: "00000000-0000-4000-8000-000000000000",
      providerId: "vsllm",
      purpose: "provider-api",
      maskedValue: "leg…cret",
      state: "unavailable",
      createdAt: "2026-09-21T00:00:00.000Z",
    }];
    vi.spyOn(application, "reconcileCredentials").mockResolvedValue(summaries);
    const result = await runCli(application, ["credentials", "reconcile", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout[0] ?? "[]")).toEqual(summaries);
    expect(result.stdout.join("\n")).not.toContain("legacy-provider-secret");
  });

  it("lists only masked credential summaries", async () => {
    const application = createApplication();
    const summary: CredentialSummary = {
      id: "00000000-0000-4000-8000-000000000001",
      providerId: "vsllm",
      purpose: "provider-api",
      maskedValue: "abc…WXYZ",
      state: "active",
      createdAt: "2026-09-21T00:00:00.000Z",
    };
    vi.spyOn(application, "listCredentials").mockResolvedValue([summary]);

    const result = await runCli(application, [
      "credentials",
      "list",
      "--provider",
      "vsllm",
      "--purpose",
      "provider-api",
      "--json",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout[0] ?? "[]")).toEqual([summary]);
    expect(result.stdout.join("\n")).not.toContain("actual-secret-value");
  });

  it("imports a single raw file without echoing its value", async () => {
    const application = createApplication();
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-credential-cli-"));
    const source = join(directory, ".env-key");
    await writeFile(source, "actual-secret-value\n", "utf8");
    const add = vi.spyOn(application, "addCredential").mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000002",
      providerId: "vsllm",
      purpose: "provider-api",
      maskedValue: "act…alue",
      state: "active",
      createdAt: "2026-09-21T00:00:00.000Z",
    });

    const result = await runCli(application, [
      "credentials",
      "import",
      "--provider",
      "vsllm",
      "--purpose",
      "provider-api",
      "--file",
      source,
      "--activate",
    ]);

    expect(result.code).toBe(0);
    expect(add).toHaveBeenCalledWith({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "actual-secret-value",
      activate: true,
    });
    expect(result.stdout.join("\n")).not.toContain("actual-secret-value");
  });

  it("uses the injected hidden-passphrase reader for backup and restore", async () => {
    const application = createApplication();
    const backup = join(await mkdtemp(join(tmpdir(), "provider-dock-credential-backup-")), "backup.pdv");
    const create = vi.spyOn(application, "createCredentialBackup").mockResolvedValue({
      included: 1,
      skipped: 0,
    });
    const restore = vi.spyOn(application, "restoreCredentialBackup").mockResolvedValue({
      restored: 1,
      skipped: 0,
      credentialIds: ["00000000-0000-4000-8000-000000000003"],
    });
    const passphraseReader = vi.fn(async () => "operator-passphrase");

    expect((await runCli(application, ["credentials", "backup", "--file", backup], {}, passphraseReader)).code).toBe(0);
    expect((await runCli(application, ["credentials", "restore", "--file", backup], {}, passphraseReader)).code).toBe(0);
    expect(create).toHaveBeenCalledWith(backup, "operator-passphrase");
    expect(restore).toHaveBeenCalledWith(backup, "operator-passphrase");
    expect(passphraseReader).toHaveBeenCalledTimes(2);
  });

  it("reports hidden-passphrase input failures without a stack trace", async () => {
    const application = createApplication();
    const backup = join(await mkdtemp(join(tmpdir(), "provider-dock-credential-backup-")), "backup.pdv");
    const passphraseReader = vi.fn(async () => {
      throw new Error("Hidden passphrase input requires an interactive TTY.");
    });

    const result = await runCli(
      application,
      ["credentials", "backup", "--file", backup],
      {},
      passphraseReader,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      "Error: Hidden passphrase input requires an interactive TTY.",
    ]);
    expect(result.stderr.join("\n")).not.toContain("at readHiddenSecret");
  });
});

describe("credential removal guard through the real CLI", () => {
  it("exits 1 with a stable, path-free cause when a corrupt catalog makes usage unverifiable", async () => {
    const catalogPath = await makeCorruptPortalCatalog();
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "cli-portal-ciphertext-canary" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "portal-session",
      secretRef, maskedValue: "cli…sess", state: "unavailable",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const application = buildCredentialApplication({ secrets, metadata, catalogPath });
    const before = await readFile(catalogPath, "utf8");

    const result = await runCli(application, [
      "credentials", "remove", "--provider", "fixture",
      "--credential", record.id, "--purpose", "portal-session",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      "Error: Использование ключа невозможно проверить, пока каталог кабинетов недоступен; сначала восстановите каталог.",
    ]);
    const emitted = [...result.stdout, ...result.stderr].join("\n");
    expect(emitted).not.toContain(catalogPath);
    expect(emitted).not.toContain("cli-portal-ciphertext-canary");
    // Nothing was deleted by the refused remove.
    expect(await secrets.get(secretRef)).toBe("cli-portal-ciphertext-canary");
    expect(await metadata.get(record.id)).toBeDefined();
    expect(await readFile(catalogPath, "utf8")).toBe(before);
  });

  it("still lists the unavailable key and keeps API distinct from portal-session while the catalog is corrupt", async () => {
    const catalogPath = await makeCorruptPortalCatalog();
    const portalRef = `credential-${randomUUID()}`;
    const apiRef = `credential-${randomUUID()}`;
    // The portal key has no ciphertext (state resolves to "unavailable"); the API key has one ("available").
    const secrets = new MemorySecretStore({ [apiRef]: "cli-list-api-canary" });
    const metadata = new MemoryCredentialMetadataRepository();
    await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "portal-session",
      secretRef: portalRef, maskedValue: "por…sess", state: "unavailable",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "provider-api",
      secretRef: apiRef, maskedValue: "api…akey", state: "available",
      createdAt: "2026-09-27T00:00:01.000Z",
    });
    const application = buildCredentialApplication({ secrets, metadata, catalogPath });

    const result = await runCli(application, [
      "credentials", "list", "--provider", "fixture", "--json",
    ]);

    expect(result.code).toBe(0);
    const listed = JSON.parse(result.stdout.join("\n")) as CredentialSummary[];
    expect(listed).toHaveLength(2);
    // The unavailable credential is still surfaced (never passed off as deleted/empty).
    expect(listed.find((entry) => entry.purpose === "portal-session")?.state).toBe("unavailable");
    expect(listed.find((entry) => entry.purpose === "provider-api")?.state).toBe("available");
    expect(result.stdout.join("\n")).not.toContain("cli-list-api-canary");
  });

  it("maps a known active reference to exit 1 / ACTIVE_REFERENCE, never masking it as CONFLICT", async () => {
    const catalogPath = await makeCorruptPortalCatalog();
    const profiles = new MemoryProviderProfileRepository();
    await profiles.upsert({
      id: "fixture", displayName: "Fixture",
      baseUrl: "https://inference.invalid/v1",
      auth: { kind: "bearer", secretRef: "PROFILE_REF" },
    });
    const secrets = new MemorySecretStore({ PROFILE_REF: "cli-active-ciphertext-canary" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "provider-api",
      secretRef: "PROFILE_REF", maskedValue: "act…ref", state: "available",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const application = buildCredentialApplication({ secrets, metadata, catalogPath, profiles });

    const result = await runCli(application, [
      "credentials", "remove", "--provider", "fixture",
      "--credential", record.id, "--purpose", "provider-api",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual(["Error: Credential is still referenced by an active binding."]);
    expect(await secrets.get("PROFILE_REF")).toBe("cli-active-ciphertext-canary");
  });

  it("removes a healthy, unreferenced credential (exit 0) once the catalog is readable", async () => {
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "cli-healthy-ciphertext" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "provider-api",
      secretRef, maskedValue: "hea…thy", state: "available",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const application = buildCredentialApplication({ secrets, metadata });

    const result = await runCli(application, [
      "credentials", "remove", "--provider", "fixture",
      "--credential", record.id, "--purpose", "provider-api",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([`Removed credential '${record.id}'.`]);
    expect(await secrets.get(secretRef)).toBeUndefined();
    expect(await metadata.get(record.id)).toBeUndefined();
  });

  it("exits 1 with the catalog cause when the portal store path is an unreadable directory (EISDIR)", async () => {
    const catalogPath = await makeUnreadableStorePath("portals.json");
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "cli-eisdir-ciphertext-canary" });
    const metadata = new MemoryCredentialMetadataRepository();
    // Even a provider-api key must fail closed: while the catalog is unreadable it MIGHT be portal-referenced.
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "provider-api",
      secretRef, maskedValue: "eis…dir", state: "available",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const application = buildCredentialApplication({ secrets, metadata, catalogPath });

    const result = await runCli(application, [
      "credentials", "remove", "--provider", "fixture",
      "--credential", record.id, "--purpose", "provider-api",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      "Error: Использование ключа невозможно проверить, пока каталог кабинетов недоступен; сначала восстановите каталог.",
    ]);
    const emitted = [...result.stdout, ...result.stderr].join("\n");
    expect(emitted).not.toContain(catalogPath);
    expect(emitted).not.toContain("EISDIR");
    expect(emitted).not.toContain("cli-eisdir-ciphertext-canary");
    // A read we could not finish must delete nothing.
    expect(await secrets.get(secretRef)).toBe("cli-eisdir-ciphertext-canary");
    expect(await metadata.get(record.id)).toBeDefined();
  });

  it("projects an EACCES portal-seam fault to the fixed cause, leaking neither its path nor a canary", async () => {
    const seamCanary = `seam-canary-${randomUUID()}`;
    const rawPath = `/var/secret/${seamCanary}/portals.json`;
    const portals = throwingPortalRepository(
      Object.assign(new Error(`EACCES: permission denied, open '${rawPath}'`), { code: "EACCES" }),
    );
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "cli-eacces-ciphertext" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "provider-api",
      secretRef, maskedValue: "eac…ces", state: "available",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const application = buildCredentialApplication({ secrets, metadata, portals });

    const result = await runCli(application, [
      "credentials", "remove", "--provider", "fixture",
      "--credential", record.id, "--purpose", "provider-api",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      "Error: Использование ключа невозможно проверить, пока каталог кабинетов недоступен; сначала восстановите каталог.",
    ]);
    const emitted = [...result.stdout, ...result.stderr].join("\n");
    expect(emitted).not.toContain(seamCanary);
    expect(emitted).not.toContain(rawPath);
    expect(emitted).not.toContain("EACCES");
    expect(await secrets.get(secretRef)).toBe("cli-eacces-ciphertext");
    expect(await metadata.get(record.id)).toBeDefined();
  });
});

function buildCredentialApplication(options: {
  readonly secrets: MemorySecretStore;
  readonly metadata: MemoryCredentialMetadataRepository;
  readonly catalogPath?: string;
  readonly profiles?: MemoryProviderProfileRepository;
  readonly portals?: MemoryPortalRepository;
}): ProviderDockApplication {
  const profiles = options.profiles ?? new MemoryProviderProfileRepository();
  const portals = options.portals ?? (options.catalogPath === undefined
    ? new MemoryPortalRepository()
    : new FilePortalRepository(options.catalogPath));
  const manager = new CredentialManager({
    secrets: options.secrets,
    metadata: options.metadata,
    bindings: new ApplicationCredentialBindings(profiles, portals),
  });
  return new ProviderDockApplication(
    profiles,
    new ProviderProbeService(new ProviderAdapterRegistry()),
    options.secrets,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    manager,
  );
}

async function makeCorruptPortalCatalog(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "provider-dock-cli-portal-corrupt-")), "portals.json");
  await writeFile(path, "\u0000\u0000\u0000", { encoding: "utf8" });
  return path;
}

// A store path that is actually a directory; reading it as a file raises a raw EISDIR.
async function makeUnreadableStorePath(basename: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "provider-dock-cli-unreadable-")), basename);
  await mkdir(path);
  return path;
}

// A portal repository whose read rejects with the given raw error (its message may carry a path/canary).
function throwingPortalRepository(failure: Error): MemoryPortalRepository {
  const portals = new MemoryPortalRepository();
  portals.list = async () => { throw failure; };
  return portals;
}

function createApplication(fetchImpl: typeof fetch = vi.fn<typeof fetch>()): ProviderDockApplication {
  const secrets = new MemorySecretStore();
  const adapters = new ProviderAdapterRegistry().register(
    new GenericOpenAiAdapter({ secretStore: secrets, fetchImpl }),
  );
  return new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(adapters),
    secrets,
  );
}
