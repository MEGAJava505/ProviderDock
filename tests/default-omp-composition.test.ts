import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createDefaultProviderDockAsync,
  fingerprintOmpProviderProfile,
  OmpLaunchService,
} from "../src/index.js";

describe("default OMP composition", () => {
  it("routes provider discovery through the manager-backed environment fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-dock-credential-composition-"));
    const calls: string[] = [];
    const composition = await createDefaultProviderDockAsync({
      userHome: root,
      environment: { PROVIDER_DOCK_HOME: root, FIXTURE_API_KEY: "fixture-secret-value" },
      platform: "linux",
      fetchImpl: async (url, init) => {
        calls.push(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-secret-value");
        return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await composition.application.setProvider({
      id: "fixture",
      displayName: "Fixture",
      baseUrl: "https://provider.example/v1",
      auth: { kind: "bearer", secretRef: "FIXTURE_API_KEY" },
    });

    const result = await composition.application.probeProvider("fixture");

    expect(result.health.status).toBe("ONLINE");
    expect(calls).toEqual(["https://provider.example/v1/models"]);
  });

  it("composes a direct OMP launch service without legacy routing", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-dock-omp-default-"));
    const composition = await createDefaultProviderDockAsync({
      userHome: root,
      environment: { PROVIDER_DOCK_HOME: root },
      platform: "linux",
    });

    expect(composition.application).toBeDefined();
    expect(composition.ompLauncher).toBeInstanceOf(OmpLaunchService);

    const preflight = await composition.ompLauncher.preflight({
      providerId: "provider-a",
      modelId: "model-a",
      accountId: "account-a",
      projectDirectory: join(root, "project"),
    });
    expect(preflight).toMatchObject({
      ok: false,
      diagnostic: { code: "OMP_PERMISSION_CONFIRMATION_REQUIRED" },
    });
  });

  it("treats a missing acceptance file as zero accepted routes without creating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-dock-omp-decisions-"));
    const composition = await createDefaultProviderDockAsync({
      userHome: root,
      environment: { PROVIDER_DOCK_HOME: root },
      platform: "linux",
    });
    await composition.application.setProvider({
      id: "provider-a",
      displayName: "Provider A",
      baseUrl: "https://provider.example/v1",
      apiType: "openai-responses",
      auth: { kind: "none" },
      manualModelIds: ["model-a"],
    });

    const result = await composition.ompLauncher.preflight({
      providerId: "provider-a",
      modelId: "model-a",
      accountId: "account-a",
      projectDirectory: join(root, "project"),
      permissionAcknowledgement: "read-only-pilot-no-sandbox",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" },
    });
    await expect(access(join(
      root,
      "migration",
      "omp-route-decisions.json",
    ))).rejects.toBeDefined();
  });

  it("requires a matching read-only evidence snapshot without creating one", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-dock-omp-evidence-"));
    const composition = await createDefaultProviderDockAsync({
      userHome: root,
      environment: { PROVIDER_DOCK_HOME: root },
      platform: "linux",
    });
    await composition.application.setProvider({
      id: "provider-a",
      displayName: "Provider A",
      baseUrl: "https://provider.example/v1",
      apiType: "openai-responses",
      auth: { kind: "none" },
      manualModelIds: ["model-a"],
    });
    const profile = (await composition.application.listProviders())[0]!;
    const migrationDirectory = join(root, "migration");
    await mkdir(migrationDirectory, { recursive: true });
    await writeFile(join(migrationDirectory, "omp-route-decisions.json"), JSON.stringify({
      version: 1,
      decisions: [{
        providerId: profile.id,
        profileSha256: fingerprintOmpProviderProfile(profile),
        accountId: "account-a",
        baseUrl: profile.baseUrl,
        origin: new URL(profile.baseUrl).origin,
        modelId: "model-a",
        protocol: "openai-responses",
        status: "accepted-for-pilot",
        localSmoke: {
          status: "passed",
          inventorySha256: "a".repeat(64),
          smokeReportSha256: "b".repeat(64),
          executableSha256: "1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba",
          sourceCommit: "0c6c981ee5838d97700180383077eb0a3790637c",
        },
      }],
    }));

    const result = await composition.ompLauncher.preflight({
      providerId: "provider-a",
      modelId: "model-a",
      accountId: "account-a",
      projectDirectory: join(root, "project"),
      permissionAcknowledgement: "read-only-pilot-no-sandbox",
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" },
    });
    await expect(access(join(
      migrationDirectory,
      "omp-provider-evidence.json",
    ))).rejects.toBeDefined();
  });
});
