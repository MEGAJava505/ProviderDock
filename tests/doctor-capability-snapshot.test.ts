import { describe, expect, it } from "vitest";
import {
  doctorReportToCapabilitySnapshot,
  type DoctorReport,
} from "../src/index.js";

describe("doctorReportToCapabilitySnapshot", () => {
  it("maps measured checks and protocol-specific client compatibility", () => {
    const snapshot = doctorReportToCapabilitySnapshot({
      providerId: "router",
      modelId: "gpt-x",
      protocol: "openai-chat-completions",
      level: 3,
      checkedAt: "2026-08-30T10:00:00.000Z",
      verdict: "DEGRADED",
      checks: [
        { name: "connectivity+models", status: "PASS" },
        { name: "inference", status: "PASS" },
        { name: "streaming", status: "DEGRADED" },
        { name: "tools", status: "PASS" },
      ],
    });

    expect(snapshot).toMatchObject({
      providerId: "router",
      modelId: "gpt-x",
      doctorLevel: 3,
      capabilities: {
        model_discovery: "SUPPORTED",
        text: "SUPPORTED",
        streaming: "DEGRADED",
        tools: "SUPPORTED",
        reasoning: "UNKNOWN",
      },
      codexCompatibility: "ADAPTER",
      claudeCompatibility: "ADAPTER",
    });
  });

  it("keeps transient failures unknown and stores only the final normalized error", () => {
    const report: DoctorReport = {
      providerId: "router",
      modelId: "gpt-x",
      level: 2,
      checkedAt: "2026-08-30T10:00:00.000Z",
      verdict: "FAIL",
      checks: [
        {
          name: "connectivity+models",
          status: "FAIL",
          errorType: "AUTH_ERROR",
          details: "Provider returned HTTP 401.",
        },
        { name: "inference", status: "SKIPPED" },
        { name: "streaming", status: "SKIPPED" },
      ],
    };

    expect(doctorReportToCapabilitySnapshot(report)).toMatchObject({
      capabilities: {
        model_discovery: "UNKNOWN",
        text: "UNKNOWN",
        streaming: "UNKNOWN",
      },
      codexCompatibility: "UNKNOWN",
      claudeCompatibility: "UNKNOWN",
      lastErrorType: "AUTH_ERROR",
      lastErrorMessage: "Provider returned HTTP 401.",
    });
  });

  it("does not create a per-model snapshot when Doctor resolved no model", () => {
    expect(
      doctorReportToCapabilitySnapshot({
        providerId: "router",
        level: 0,
        checkedAt: "2026-08-30T10:00:00.000Z",
        verdict: "DEGRADED",
        checks: [{ name: "connectivity+models", status: "DEGRADED" }],
      }),
    ).toBeUndefined();
  });
});
