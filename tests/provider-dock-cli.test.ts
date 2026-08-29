import { describe, expect, it, vi } from "vitest";
import {
  GenericOpenAiAdapter,
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), { status: 200 }),
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
      models: [{ internalId: "router:gpt-x", healthStatus: "ONLINE" }],
    });
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
