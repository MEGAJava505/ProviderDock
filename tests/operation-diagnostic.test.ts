import { describe, expect, it } from "vitest";
import {
  createOperationDiagnostic,
  sanitizeOperationDiagnostic,
} from "../src/core/errors/operation-diagnostic.js";

describe("operation diagnostics", () => {
  it("keeps correlation and safe guidance but never trusts supplied messages or extra fields", () => {
    const diagnostic = sanitizeOperationDiagnostic({
      operationId: "16a96b51-c68d-4d6d-91c9-d82a5485a691",
      stage: "validation",
      code: "MODEL_DISABLED",
      message: "Authorization: Bearer secret-canary",
      suggestedAction: "Cookie: session=secret-canary",
      stack: "secret-canary stack",
      cause: { password: "secret-canary" },
      retryable: false,
      occurredAt: "2026-09-15T00:00:00.000Z",
      httpStatus: 400,
    });
    expect(diagnostic).toMatchObject({
      operationId: "16a96b51-c68d-4d6d-91c9-d82a5485a691",
      stage: "validation",
      code: "MODEL_DISABLED",
      retryable: false,
      occurredAt: "2026-09-15T00:00:00.000Z",
      httpStatus: 400,
    });
    expect(diagnostic.message).toMatch(/отключена/i);
    expect(diagnostic.suggestedAction).toMatch(/включите|выберите/i);
    expect(JSON.stringify(diagnostic)).not.toContain("secret-canary");
    expect(diagnostic).not.toHaveProperty("stack");
    expect(diagnostic).not.toHaveProperty("cause");
    expect(createOperationDiagnostic(diagnostic)).toEqual(diagnostic);
  });

  it.each([null, {}, {
    operationId: "secret-canary".repeat(10000), code: "secret-canary".repeat(10000),
    stage: "secret-canary", occurredAt: "secret-canary", retryable: true,
    httpStatus: Infinity, exitCode: 2 ** 40, message: "secret-canary",
  }, { code: "__proto__", stage: "constructor" }])("fails closed for malformed persisted records", input => {
    const diagnostic = sanitizeOperationDiagnostic(input);
    expect(diagnostic.code).toBe("OPERATION_FAILED");
    expect(diagnostic.stage).toBe("validation");
    expect(diagnostic.retryable).toBe(false);
    expect(diagnostic.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isFinite(Date.parse(diagnostic.occurredAt))).toBe(true);
    expect(diagnostic).not.toHaveProperty("httpStatus");
    expect(diagnostic).not.toHaveProperty("exitCode");
    expect(JSON.stringify(diagnostic).length).toBeLessThan(1000);
    expect(JSON.stringify(diagnostic)).not.toContain("secret-canary");
  });
});
