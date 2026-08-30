import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicClaudeBridgeFactory,
  ClaudeLauncher,
  ClaudeRuntimeConfigurationError,
  buildClaudeChildEnvironment,
  MemorySecretStore,
  parseProviderProfile,
  type ClaudeBridgeFactory,
  type ClaudeProcessRunner,
  type ClaudeProcessStartRequest,
} from "../src/index.js";

describe("buildClaudeChildEnvironment", () => {
  it("configures the gateway only inside the child and strips stale variables", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      ANTHROPIC_BASE_URL: "https://stale.example",
      ANTHROPIC_API_KEY: "stale-real-key",
      ANTHROPIC_CUSTOM_HEADERS: "stale: header",
    };
    const child = buildClaudeChildEnvironment({
      parentEnvironment: parent,
      bridgeBaseUrl: "http://127.0.0.1:45678",
      modelId: "claude-x",
      sessionToken: "session-token",
      customHeaders: { "anthropic-beta": "tools-2024" },
    });

    expect(child.PATH).toBe("/usr/bin");
    expect(child.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:45678");
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe("session-token");
    expect(child.ANTHROPIC_MODEL).toBe("claude-x");
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.ANTHROPIC_CUSTOM_HEADERS).toBe("anthropic-beta: tools-2024");
    // The parent environment object must never be mutated.
    expect(parent.ANTHROPIC_BASE_URL).toBe("https://stale.example");
    expect(parent.ANTHROPIC_API_KEY).toBe("stale-real-key");
  });

  it("generates a random per-session loopback token by default", () => {
    const child = buildClaudeChildEnvironment({
      parentEnvironment: {},
      bridgeBaseUrl: "http://127.0.0.1:1",
      modelId: "m",
    });
    expect(child.ANTHROPIC_AUTH_TOKEN).toMatch(/^providerdock-[0-9a-f]{32}$/);
    expect(child.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });
});

describe("ClaudeLauncher", () => {
  it("persists the session ledger while Claude runs and removes it on clean exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "providerdock-claude-runtime-"));
    const runtimeRoot = join(root, "runtime");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg-runtime",
          type: "message",
          role: "assistant",
          model: "claude-x",
          content: [{ type: "text", text: "OK" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    let persistedLedger: Record<string, unknown> | undefined;
    const processes: ClaudeProcessRunner = {
      start: async (request) => ({
        pid: 43,
        wait: async () => {
          const response = await fetch(`${request.environment.ANTHROPIC_BASE_URL}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${request.environment.ANTHROPIC_AUTH_TOKEN}`,
            },
            body: JSON.stringify({
              model: "claude-x",
              max_tokens: 16,
              messages: [{ role: "user", content: "Hi" }],
            }),
          });
          expect(response.status).toBe(200);
          await response.json();
          const sessionDirectories = await readdir(runtimeRoot);
          expect(sessionDirectories).toHaveLength(1);
          persistedLedger = JSON.parse(
            await readFile(
              join(runtimeRoot, sessionDirectories[0] ?? "missing", "turn-ledger.json"),
              "utf8",
            ),
          ) as Record<string, unknown>;
          return { exitCode: 0, signal: null };
        },
      }),
    };
    const launcher = new ClaudeLauncher(
      new AnthropicClaudeBridgeFactory({
        secretStore: new MemorySecretStore(),
        fetchImpl: fetchMock,
        runtimeRoot,
      }),
      processes,
    );

    await launcher.launch({
      profile: testProfile(),
      modelId: "claude-x",
      projectDirectory: root,
      parentEnvironment: {},
    });

    expect(persistedLedger).toMatchObject({
      version: 1,
      turns: [expect.objectContaining({ state: "COMPLETED" })],
    });
    expect(await readdir(runtimeRoot)).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts the bridge, spawns claude with child-only env, then stops the bridge", async () => {
    const order: string[] = [];
    const bridge = {
      start: vi.fn(async () => {
        order.push("bridge-start");
        return { host: "127.0.0.1" as const, port: 45678, url: "http://127.0.0.1:45678" };
      }),
      stop: vi.fn(async () => {
        order.push("bridge-stop");
      }),
    };
    let createInput: Parameters<ClaudeBridgeFactory["create"]>[0] | undefined;
    const bridges: ClaudeBridgeFactory = {
      create: (input) => {
        createInput = input;
        return bridge;
      },
    };
    let startRequest: ClaudeProcessStartRequest | undefined;
    const processes: ClaudeProcessRunner = {
      start: async (request) => {
        order.push("claude-start");
        startRequest = request;
        return { pid: 42, wait: async () => ({ exitCode: 0, signal: null }) };
      },
    };

    const launcher = new ClaudeLauncher(bridges, processes);
    const exit = await launcher.launch({
      profile: testProfile(),
      modelId: "claude-x",
      projectDirectory: "/tmp/project",
      parentEnvironment: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "real" },
    });

    expect(exit).toEqual({ exitCode: 0, signal: null });
    expect(order).toEqual(["bridge-start", "claude-start", "bridge-stop"]);
    expect(startRequest?.executable).toBe("claude");
    expect(startRequest?.cwd).toBe("/tmp/project");
    expect(startRequest?.environment.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:45678");
    expect(startRequest?.environment.ANTHROPIC_MODEL).toBe("claude-x");
    expect(startRequest?.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(createInput?.clientToken).toMatch(/^providerdock-[0-9a-f]{32}$/);
    expect(createInput?.sessionId).toMatch(/^[0-9a-f]{32}$/);
    expect(startRequest?.environment.ANTHROPIC_AUTH_TOKEN).toBe(createInput?.clientToken);
  });

  it("stops the bridge when the launch fails and rejects disabled providers", async () => {
    const bridge = { start: vi.fn(async () => ({ host: "127.0.0.1" as const, port: 1, url: "http://127.0.0.1:1" })), stop: vi.fn(async () => undefined) };
    const bridges: ClaudeBridgeFactory = { create: () => bridge };
    const processes: ClaudeProcessRunner = {
      start: async () => {
        throw new Error("spawn failed");
      },
    };

    const launcher = new ClaudeLauncher(bridges, processes);
    await expect(
      launcher.launch({
        profile: testProfile(),
        modelId: "claude-x",
        projectDirectory: "/tmp/project",
        parentEnvironment: {},
      }),
    ).rejects.toThrow("spawn failed");
    expect(bridge.stop).toHaveBeenCalledTimes(1);

    await expect(
      launcher.launch({
        profile: testProfile({ enabled: false }),
        modelId: "claude-x",
        projectDirectory: "/tmp/project",
      }),
    ).rejects.toThrow(ClaudeRuntimeConfigurationError);
  });
});

function testProfile(overrides: Record<string, unknown> = {}) {
  return parseProviderProfile({
    id: "anthropic",
    displayName: "Anthropic Test",
    baseUrl: "https://anthropic.test/v1",
    apiType: "anthropic-messages",
    timeoutMs: 1_000,
    ...overrides,
  });
}
