import { access, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CodexLauncher,
  CodexRuntimeSessionManager,
  MemorySecretStore,
  ResponsesCodexBridgeFactory,
  parseProviderProfile,
  type CodexProcessRunner,
  type CodexProcessStartRequest,
} from "../src/index.js";

const sessionId = "22222222222222222222222222222222";

describe("managed Codex bridge lifecycle", () => {
  it("keeps a private bridge alive for Codex and stops it before runtime cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-dock-managed-bridge-"));
    const codexHome = join(root, "codex-home");
    const runtimeRoot = join(root, "runtime");
    const projectDirectory = join(root, "project");
    await Promise.all([mkdir(codexHome), mkdir(projectDirectory)]);
    const secrets = new MemorySecretStore({ QUERY_KEY: "upstream-secret" });
    const upstreamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "resp-upstream", object: "response", status: "completed", output: [] }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const runner = new BridgeUsingCodexRunner(runtimeRoot);
    const launcher = new CodexLauncher(
      new CodexRuntimeSessionManager({
        codexHome,
        runtimeRoot,
        secrets,
        randomId: () => sessionId,
        isProcessAlive: () => false,
      }),
      runner,
      new ResponsesCodexBridgeFactory({ secretStore: secrets, fetchImpl: upstreamFetch }),
    );

    const exit = await launcher.launch({
      profile: parseProviderProfile({
        id: "query-router",
        displayName: "Query Router",
        baseUrl: "https://upstream.test/v1",
        apiType: "openai-responses",
        auth: { kind: "query", parameterName: "key", secretRef: "QUERY_KEY" },
      }),
      modelId: "model-x",
      projectDirectory,
      route: { kind: "auto" },
      parentEnvironment: { PATH: "test-path" },
    });

    expect(exit).toEqual({ exitCode: 0, signal: null });
    expect(runner.health).toMatchObject({ status: "ok", provider_id: "query-router" });
    expect(runner.providerResponse).toMatchObject({ id: "resp-upstream", status: "completed" });
    expect(runner.manifest).toMatchObject({
      state: "ACTIVE",
      route: { kind: "bridge", ownership: "managed", state: "ACTIVE" },
    });
    expect(runner.configContents).not.toContain("upstream-secret");
    expect(Object.values(runner.request?.environment ?? {})).not.toContain("upstream-secret");
    const [upstreamUrl] = upstreamFetch.mock.calls[0] ?? [];
    expect(String(upstreamUrl)).toBe(
      "https://upstream.test/v1/responses?key=upstream-secret",
    );
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    await expect(fetch(`${runner.bridgeBaseUrl}/health`)).rejects.toThrow();
    await expect(access(join(runtimeRoot, sessionId))).rejects.toThrow();
    await expect(access(join(codexHome, `providerdock-${sessionId}.config.toml`))).rejects.toThrow();
  });
});

class BridgeUsingCodexRunner implements CodexProcessRunner {
  request: CodexProcessStartRequest | undefined;
  configContents = "";
  bridgeBaseUrl = "";
  health: Record<string, unknown> | undefined;
  providerResponse: Record<string, unknown> | undefined;
  manifest: Record<string, unknown> | undefined;

  constructor(private readonly runtimeRoot: string) {}

  async start(request: CodexProcessStartRequest) {
    this.request = request;
    const profileName = request.args[2];
    const codexHome = request.environment.CODEX_HOME;
    if (profileName === undefined || codexHome === undefined) {
      throw new Error("Managed bridge test did not receive a Codex runtime profile.");
    }
    this.configContents = await readFile(join(codexHome, `${profileName}.config.toml`), "utf8");
    const baseUrlValue = /^base_url = (.+)$/m.exec(this.configContents)?.[1];
    if (baseUrlValue === undefined) throw new Error("Codex runtime profile has no base_url.");
    this.bridgeBaseUrl = JSON.parse(baseUrlValue) as string;

    return {
      pid: 9876,
      wait: async () => {
        this.health = (await (
          await fetch(`${this.bridgeBaseUrl.replace(/\/v1$/, "")}/health`)
        ).json()) as Record<string, unknown>;
        this.providerResponse = (await (
          await fetch(`${this.bridgeBaseUrl}/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "model-x", input: "Hello", stream: false }),
          })
        ).json()) as Record<string, unknown>;
        this.manifest = JSON.parse(
          await readFile(join(this.runtimeRoot, sessionId, "manifest.json"), "utf8"),
        ) as Record<string, unknown>;
        return { exitCode: 0, signal: null };
      },
    };
  }
}
