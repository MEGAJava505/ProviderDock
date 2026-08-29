import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileProviderProfileRepository,
  parseProviderProfile,
} from "../src/index.js";

describe("provider profiles", () => {
  it("applies safe defaults and keeps only secret references", () => {
    const profile = parseProviderProfile({
      id: "agentrouter",
      displayName: "AgentRouter",
      baseUrl: "https://example.test/v1/",
      auth: { kind: "bearer", secretRef: "AGENTROUTER_API_KEY" },
    });

    expect(profile.baseUrl).toBe("https://example.test/v1");
    expect(profile.modelsEndpoint).toBe("models");
    expect(profile.apiType).toBe("auto");
    expect(profile.healthCheck.minimalInference).toBe("on-demand");
    expect(JSON.stringify(profile)).not.toContain("api-key-value");
  });

  it("rejects a plaintext apiKey field", () => {
    expect(() =>
      parseProviderProfile({
        id: "unsafe",
        displayName: "Unsafe",
        baseUrl: "https://example.test/v1",
        apiKey: "api-key-value",
      }),
    ).toThrow();
  });

  it.each([
    ["staticHeaders", { Authorization: "Bearer actual-secret" }],
    ["staticHeaders", { "x-api-key": "actual-secret" }],
    ["queryParameters", { access_token: "actual-secret" }],
  ])("rejects credential values in %s", (field, value) => {
    expect(() =>
      parseProviderProfile({
        id: "unsafe",
        displayName: "Unsafe",
        baseUrl: "https://example.test/v1",
        [field]: value,
      }),
    ).toThrow(/must use/);
  });

  it("rejects ambiguous duplicate authentication headers", () => {
    expect(() =>
      parseProviderProfile({
        id: "ambiguous",
        displayName: "Ambiguous",
        baseUrl: "https://example.test/v1",
        auth: { kind: "bearer", secretRef: "BEARER_KEY" },
        secretHeaders: { Authorization: "OTHER_KEY" },
      }),
    ).toThrow(/cannot be combined/);
  });

  it("persists CRUD changes as validated JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-profiles-"));
    const filePath = join(directory, "providers.json");
    const repository = new FileProviderProfileRepository(filePath);

    await repository.upsert({
      id: "gorouter",
      displayName: "GoRouter",
      baseUrl: "https://go.example/v1",
    });
    await repository.upsert({
      id: "agentrouter",
      displayName: "AgentRouter",
      baseUrl: "https://agent.example/v1",
    });

    expect((await repository.list()).map((profile) => profile.id)).toEqual([
      "agentrouter",
      "gorouter",
    ]);
    expect(await repository.delete("missing")).toBe(false);
    expect(await repository.delete("gorouter")).toBe(true);
    expect((await repository.list()).map((profile) => profile.id)).toEqual(["agentrouter"]);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toHaveLength(1);
  });
});
