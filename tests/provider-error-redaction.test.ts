import { describe, expect, it } from "vitest";
import {
  readSanitizedProviderErrorBody,
  sanitizeProviderErrorBody,
} from "../src/index.js";

describe("provider error redaction", () => {
  it("keeps known diagnostics while dropping unknown fields and credential material", () => {
    const detail = sanitizeProviderErrorBody(
      JSON.stringify({
        error: {
          message: "Authorization: Bearer sk-supersecret123 was rejected",
          type: "authentication_error",
          code: "invalid_api_key",
          echoed_request: { api_key: "actual-provider-secret" },
        },
      }),
      { sensitiveValues: ["actual-provider-secret"] },
    );

    expect(detail).toContain("authentication_error");
    expect(detail).toContain("invalid_api_key");
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain("sk-supersecret123");
    expect(detail).not.toContain("actual-provider-secret");
    expect(detail).not.toContain("echoed_request");
  });

  it("reads only a bounded prefix and returns a bounded single-line detail", async () => {
    const detail = await readSanitizedProviderErrorBody(
      new Response(JSON.stringify({ error: { message: `failure\n${"x".repeat(10_000)}` } })),
      { maximumBytes: 256, maximumCharacters: 80, allowPlainText: true },
    );

    expect(detail).toHaveLength(80);
    expect(detail).not.toContain("\n");
    expect(detail?.endsWith("…")).toBe(true);
  });
});
