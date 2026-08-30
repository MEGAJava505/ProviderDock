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
      new ResponsesCodexBridgeFactory({
        secretStore: secrets,
        fetchImpl: upstreamFetch,
        runtimeRoot,
      }),
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
    expect(runner.ledger).toMatchObject({
      version: 1,
      turns: [expect.objectContaining({ state: "COMPLETED" })],
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

  it("automatically routes Chat Completions profiles through the managed bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-dock-chat-lifecycle-"));
    const codexHome = join(root, "codex-home");
    const runtimeRoot = join(root, "runtime");
    const projectDirectory = join(root, "project");
    await Promise.all([mkdir(codexHome), mkdir(projectDirectory)]);
    const secrets = new MemorySecretStore({ CHAT_KEY: "chat-secret" });
    const upstreamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chat-lifecycle",
          model: "chat-model",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "Chat route works." },
            },
          ],
        }),
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
      new ResponsesCodexBridgeFactory({
        secretStore: secrets,
        fetchImpl: upstreamFetch,
        runtimeRoot,
      }),
    );

    await launcher.launch({
      profile: parseProviderProfile({
        id: "chat-router",
        displayName: "Chat Router",
        baseUrl: "https://chat.test/v1",
        apiType: "openai-chat-completions",
        auth: { kind: "bearer", secretRef: "CHAT_KEY" },
      }),
      modelId: "chat-model",
      projectDirectory,
      route: { kind: "auto" },
    });

    expect(runner.providerResponse).toMatchObject({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Chat route works." }] },
      ],
    });
    expect(runner.manifest).toMatchObject({
      route: { kind: "bridge", ownership: "managed", state: "ACTIVE" },
    });
    expect(runner.configContents).not.toContain("chat-secret");
    const [url, init] = upstreamFetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://chat.test/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer chat-secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "chat-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    });
    await expect(fetch(`${runner.bridgeBaseUrl}/health`)).rejects.toThrow();
  });
});

class BridgeUsingCodexRunner implements CodexProcessRunner {
  request: CodexProcessStartRequest | undefined;
  configContents = "";
  bridgeBaseUrl = "";
  selectedModel = "";
  health: Record<string, unknown> | undefined;
  providerResponse: Record<string, unknown> | undefined;
  manifest: Record<string, unknown> | undefined;
  ledger: Record<string, unknown> | undefined;

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
    const modelValue = /^model = (.+)$/m.exec(this.configContents)?.[1];
    if (modelValue === undefined) throw new Error("Codex runtime profile has no model.");
    this.selectedModel = JSON.parse(modelValue) as string;

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
            body: JSON.stringify({ model: this.selectedModel, input: "Hello", stream: false }),
          })
        ).json()) as Record<string, unknown>;
        this.ledger = JSON.parse(
          await readFile(join(this.runtimeRoot, sessionId, "turn-ledger.json"), "utf8"),
        ) as Record<string, unknown>;
        this.manifest = JSON.parse(
          await readFile(join(this.runtimeRoot, sessionId, "manifest.json"), "utf8"),
        ) as Record<string, unknown>;
        return { exitCode: 0, signal: null };
      },
    };
  }
}
