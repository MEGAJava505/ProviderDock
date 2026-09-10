import { describe, expect, it } from "vitest";
import {
  MemoryLogicalModelRepository,
  MemoryProjectProfileRepository,
  MemoryPromptProfileRepository,
  MemoryProviderHealthRepository,
  MemoryProviderProfileRepository,
  MemoryUsageRepository,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  createUsageTelemetryEvent,
  runProviderDockCli,
  type CliIo,
} from "../src/index.js";

describe("usage dashboard CLI", () => {
  it("configures model pricing and renders event and summary dashboards", async () => {
    const usage = new MemoryUsageRepository();
    const application = createApplication(usage);
    const configured = await runCli(application, [
      "providers",
      "set",
      "--id",
      "router",
      "--name",
      "Router",
      "--base-url",
      "https://router.example.test/v1",
      "--api-type",
      "openai-responses",
      "--manual-model",
      "gpt-x",
      "--pricing",
      "gpt-x=2,10,1@USD",
    ]);
    expect(configured).toMatchObject({ code: 0, stderr: [] });
    const profile = await application.getProvider("router");
    expect(profile.modelPricing).toEqual({
      "gpt-x": {
        currency: "USD",
        inputPerMillion: 2,
        outputPerMillion: 10,
        cacheReadInputPerMillion: 1,
      },
    });
    await usage.record(
      createUsageTelemetryEvent({
        profile,
        modelId: "gpt-x",
        client: "codex",
        protocol: "openai-responses",
        sessionId: "session",
        requestId: "request",
        outcome: "completed",
        usage: {
          uncachedInputTokens: 80,
          cacheReadInputTokens: 20,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          webSearchRequests: 0,
          totalTokens: 110,
        },
        recordedAt: new Date("2026-08-30T10:00:00.000Z"),
      }),
    );

    const listed = await runCli(application, ["usage", "list"]);
    expect(listed.stdout.join("\n")).toContain("openai-responses");
    expect(listed.stdout.join("\n")).toContain("USD 0.000280");

    const summarized = await runCli(application, [
      "usage",
      "summary",
      "--provider",
      "router",
    ]);
    expect(summarized.stdout.join("\n")).toContain("gpt-x");
    expect(summarized.stdout.join("\n")).toContain("110");
    expect(summarized.stdout.join("\n")).toContain("USD 0.000280");

    const json = await runCli(application, [
      "usage",
      "summary",
      "--json",
    ]);
    expect(JSON.parse(json.stdout[0] ?? "[]")).toEqual([
      expect.objectContaining({
        providerId: "router",
        requestCount: 1,
        costs: { USD: 280 },
      }),
    ]);
  });
});

function createApplication(
  usage: MemoryUsageRepository,
): ProviderDockApplication {
  return new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new MemoryLogicalModelRepository(),
    new MemoryPromptProfileRepository(),
    new MemoryProjectProfileRepository(),
    new MemoryProviderHealthRepository(),
    usage,
  );
}

async function runCli(
  application: ProviderDockApplication,
  argv: string[],
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  const code = await runProviderDockCli(argv, {
    application,
    io,
    environment: {},
  });
  return { code, stdout, stderr };
}
