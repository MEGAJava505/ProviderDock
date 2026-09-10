/**
 * Pre-launch action-confirmation levels shared by every managed client.
 *
 * The dashboard and CLI let the user choose how much autonomy the agent gets
 * before the terminal window is opened. Levels map onto client-native flags:
 *
 * - ask       - confirm before changes (read-only sandbox / manual approvals);
 * - auto      - automatic edits inside the project directory only;
 * - full-auto - no approval prompts and no sandbox (explicitly dangerous).
 */
export const agentApprovalLevels = ["ask", "auto", "full-auto"] as const;

export type AgentApprovalLevel = (typeof agentApprovalLevels)[number];

export const defaultAgentApprovalLevel: AgentApprovalLevel = "ask";

export function isAgentApprovalLevel(value: unknown): value is AgentApprovalLevel {
  return (
    typeof value === "string" &&
    (agentApprovalLevels as readonly string[]).includes(value)
  );
}

export function codexApprovalArgs(
  level: AgentApprovalLevel = defaultAgentApprovalLevel,
): readonly string[] {
  switch (level) {
    case "ask":
      return ["--sandbox", "read-only", "--ask-for-approval", "on-request"];
    case "auto":
      return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
    case "full-auto":
      return ["--dangerously-bypass-approvals-and-sandbox"];
  }
}

export function claudeApprovalArgs(
  level: AgentApprovalLevel = defaultAgentApprovalLevel,
): readonly string[] {
  switch (level) {
    case "ask":
      return ["--permission-mode", "manual"];
    case "auto":
      return ["--permission-mode", "acceptEdits"];
    case "full-auto":
      return ["--dangerously-skip-permissions"];
  }
}