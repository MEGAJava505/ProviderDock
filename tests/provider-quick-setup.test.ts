import { describe, expect, it } from "vitest";
import { dashboardBrowserCommand } from "../src/ui/open-dashboard-browser.js";
import { inferProviderQuickSetup } from "../src/ui/provider-quick-setup.js";

describe("provider quick setup", () => {
  it("accepts a bare GoRouter base URL without requiring cURL", () => {
    expect(inferProviderQuickSetup("https://gorouter.app/v1")).toMatchObject({
      requestUrl: "https://gorouter.app/v1",
      baseUrl: "https://gorouter.app/v1",
      id: "gorouter",
      displayName: "Gorouter",
      apiType: "auto",
      adapterId: "gorouter",
      authKind: "bearer",
      secretRef: "GOROUTER_API_KEY",
      manualModelIds: [],
    });
  });

  it("detects an OpenAI chat provider, bearer secret, and model from cURL", () => {
    const detected = inferProviderQuickSetup(`curl https://api.example.test/v1/chat/completions \\
      -H "Authorization: Bearer sk-test-secret" \\
      -H "Content-Type: application/json" \\
      -d '{"model":"coding-model","messages":[]}'`);

    expect(detected).toMatchObject({
      requestUrl: "https://api.example.test/v1/chat/completions",
      baseUrl: "https://api.example.test/v1",
      displayName: "Example",
      id: "example",
      apiType: "openai-chat-completions",
      adapterId: "generic-openai",
      authKind: "bearer",
      secretRef: "EXAMPLE_API_KEY",
      secretValue: "sk-test-secret",
      manualModelIds: ["coding-model"],
    });
    expect(detected.staticHeaders).toEqual({});
  });

  it("detects Anthropic header authentication without treating an env reference as a key", () => {
    const detected = inferProviderQuickSetup(`curl 'https://api.anthropic.com/v1/messages' \\
      --header 'x-api-key: $ANTHROPIC_API_KEY' \\
      --header 'anthropic-version: 2023-06-01' \\
      --data '{"model":"claude-test"}'`);

    expect(detected).toMatchObject({
      baseUrl: "https://api.anthropic.com/v1",
      displayName: "Anthropic",
      apiType: "anthropic-messages",
      adapterId: "generic-anthropic",
      authKind: "header",
      authName: "x-api-key",
      secretRef: "ANTHROPIC_API_KEY",
      staticHeaders: { "anthropic-version": "2023-06-01" },
      manualModelIds: ["claude-test"],
    });
    expect(detected.secretValue).toBeUndefined();
  });

  it("detects a query key while retaining non-secret API parameters", () => {
    const detected = inferProviderQuickSetup(
      "https://provider.example/v1/responses?api-version=2026-01-01&key=secret-value",
    );

    expect(detected).toMatchObject({
      requestUrl:
        "https://provider.example/v1/responses?api-version=2026-01-01",
      baseUrl: "https://provider.example/v1",
      apiType: "openai-responses",
      authKind: "query",
      authName: "key",
      secretValue: "secret-value",
      queryParameters: { "api-version": "2026-01-01" },
    });
  });
});

describe("dashboard browser command", () => {
  it("uses the Windows default-browser command for the token-scoped loopback URL", () => {
    expect(
      dashboardBrowserCommand(
        "http://127.0.0.1:43123/local-token/",
        "win32",
      ),
    ).toEqual({
      executable: "cmd.exe",
      arguments: [
        "/d",
        "/s",
        "/c",
        "start",
        "",
        "http://127.0.0.1:43123/local-token/",
      ],
    });
  });

  it("refuses to open a non-loopback URL", () => {
    expect(() =>
      dashboardBrowserCommand("https://example.test/dashboard", "win32"),
    ).toThrow(/loopback/i);
  });
});
