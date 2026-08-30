import { describe, expect, it } from "vitest";
import {
  MemoryProviderProfileRepository,
  LogicalModelNotFoundError,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderInUseByLogicalModelError,
  ProviderNotFoundError,
  ProviderProbeService,
  SecretVaultUnavailableError,
} from "../src/index.js";

describe("ProviderDockApplication", () => {
  it("supports provider set, get, list, and remove", async () => {
    const application = createApplication();

    await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
    });

    expect((await application.getProvider("router")).displayName).toBe("Router");
    expect(await application.listProviders()).toHaveLength(1);
    await application.removeProvider("router");
    expect(await application.listProviders()).toHaveLength(0);
  });

  it("uses a typed not-found failure", async () => {
    const application = createApplication();
    await expect(application.getProvider("missing")).rejects.toBeInstanceOf(ProviderNotFoundError);
    await expect(application.removeProvider("missing")).rejects.toBeInstanceOf(
      ProviderNotFoundError,
    );
  });

  it("reports when a writable OS vault is unavailable", async () => {
    const application = createApplication();
    await expect(application.setSecret("ROUTER_KEY", "secret")).rejects.toBeInstanceOf(
      SecretVaultUnavailableError,
    );
  });

  it("validates logical-model provider references and protects routes from dangling", async () => {
    const application = createApplication();
    await application.setProvider({
      id: "primary",
      displayName: "Primary",
      baseUrl: "https://primary.example.test/v1",
    });
    await application.setProvider({
      id: "secondary",
      displayName: "Secondary",
      baseUrl: "https://secondary.example.test/v1",
    });

    await expect(
      application.setLogicalModel({
        id: "bad",
        routes: [{ providerId: "missing", modelId: "gpt-x" }],
      }),
    ).rejects.toBeInstanceOf(ProviderNotFoundError);

    await application.setLogicalModel({
      id: "gpt-x",
      routes: [
        { providerId: "primary", modelId: "gpt-x", priority: 100 },
        { providerId: "secondary", modelId: "gpt-x", priority: 90 },
      ],
    });
    expect(await application.getLogicalModel("gpt-x")).toMatchObject({ id: "gpt-x" });
    await expect(application.removeProvider("primary")).rejects.toBeInstanceOf(
      ProviderInUseByLogicalModelError,
    );

    await application.removeLogicalModel("gpt-x");
    await expect(application.getLogicalModel("gpt-x")).rejects.toBeInstanceOf(
      LogicalModelNotFoundError,
    );
    await application.removeProvider("primary");
  });
});

function createApplication(): ProviderDockApplication {
  return new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
  );
}
