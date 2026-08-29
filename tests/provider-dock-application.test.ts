import { describe, expect, it } from "vitest";
import {
  MemoryProviderProfileRepository,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderNotFoundError,
  ProviderProbeService,
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
});

function createApplication(): ProviderDockApplication {
  return new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
  );
}
