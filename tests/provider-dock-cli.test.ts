import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GenericOpenAiAdapter,
  MemoryProviderHealthRepository,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  runProviderDockCli,
  type CliIo,
} from "../src/index.js";

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

async function runCli(
  application: ProviderDockApplication,
  argv: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) };
  const code = await runProviderDockCli(argv, { application, io, environment });
  return { code, stdout, stderr };
}
