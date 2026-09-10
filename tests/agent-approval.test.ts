import { describe, expect, it } from "vitest";
import {
  agentApprovalLevels,
  claudeApprovalArgs,
  codexApprovalArgs,
  defaultAgentApprovalLevel,
  isAgentApprovalLevel,
} from "../src/clients/agent-approval.js";

describe("agent approval levels", () => {
  it("defines the shared launch approval levels with a safe default", () => {
    expect(agentApprovalLevels).toEqual(["ask", "auto", "full-auto"]);
    expect(defaultAgentApprovalLevel).toBe("ask");
  });

  it("validates approval level values", () => {
    for (const level of agentApprovalLevels) {
      expect(isAgentApprovalLevel(level)).toBe(true);
    }
    expect(isAgentApprovalLevel("yolo")).toBe(false);
    expect(isAgentApprovalLevel(undefined)).toBe(false);
  });

  it("maps every level to a sandboxed or explicit Codex flag set", () => {
    expect(codexApprovalArgs("ask")).toEqual([
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "on-request",
    ]);
    expect(codexApprovalArgs("auto")).toEqual([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
    ]);
    expect(codexApprovalArgs("full-auto")).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(codexApprovalArgs()).toEqual(codexApprovalArgs(defaultAgentApprovalLevel));
  });

  it("maps every level to a Claude Code permission mode", () => {
    expect(claudeApprovalArgs("ask")).toEqual(["--permission-mode", "manual"]);
    expect(claudeApprovalArgs("auto")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(claudeApprovalArgs("full-auto")).toEqual(["--dangerously-skip-permissions"]);
    expect(claudeApprovalArgs()).toEqual(claudeApprovalArgs(defaultAgentApprovalLevel));
  });
});