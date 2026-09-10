/** Pure policy shared by the launcher and its preview. Model IDs are never rewritten. */
export function automaticClient(profile: { apiType: string; preferredClient: string }, modelId = "",
  diagnostic?: { codexCompatibility: string; claudeCompatibility: string }): "codex" | "claude-code" {
  const claude = /(?:^|[^a-z])(?:claude|opus|sonnet|haiku)(?:[^a-z]|$)/i.test(modelId);
  const openai = /(?:^|[^a-z])(?:gpt|chatgpt|codex|o[134])(?:[^a-z]|$)/i.test(modelId);
  if (!claude && !openai && profile.preferredClient !== "auto") return profile.preferredClient as "codex" | "claude-code";
  const preferred = claude ? "claude-code" : openai ? "codex" : profile.preferredClient !== "auto"
    ? profile.preferredClient as "codex" | "claude-code" : profile.apiType === "anthropic-messages" ? "claude-code" : "codex";
  if (diagnostic) {
    const rank: Record<string, number> = { NATIVE: 3, ADAPTER: 2, UNKNOWN: 1, INCOMPATIBLE: 0 };
    const codex = rank[diagnostic.codexCompatibility] ?? 1;
    const anthropic = rank[diagnostic.claudeCompatibility] ?? 1;
    // Keep the model's natural CLI unless a real check rules it out.
    if (claude && anthropic > 0) return "claude-code";
    if (openai && codex > 0 && profile.apiType !== "anthropic-messages") return "codex";
    if (codex > anthropic) return "codex";
    if (anthropic > codex) return "claude-code";
  }
  // Codex's managed bridge cannot translate a Messages-only upstream.
  return profile.apiType === "anthropic-messages" ? "claude-code" : preferred;
}
