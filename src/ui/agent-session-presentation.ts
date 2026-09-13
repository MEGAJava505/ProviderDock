import type { AgentSessionResumeBlockReason } from "../clients/agent-session-history.js";

export interface AgentSessionUnavailableView {
  readonly resumeBlockedReason?: AgentSessionResumeBlockReason;
}

export function agentSessionUnavailableReason(
  session: AgentSessionUnavailableView,
): string {
  switch (session.resumeBlockedReason) {
    case "legacy-provider":
      return "старая Codex-сессия без привязки к провайдеру";
    case "invalid-session-id":
      return "некорректный ID сессии";
    case "missing-project":
      return "в истории нет проекта";
    case "missing-model":
      return "в истории нет модели";
    default:
      return "недостаточно данных для безопасного продолжения";
  }
}

export interface AgentSessionHistoryView<T> {
  readonly visible: boolean;
  readonly searchVisible: boolean;
  readonly sessions: readonly T[];
}

export function agentSessionHistoryView<
  T extends { readonly providerId: string },
>(
  sessions: readonly T[],
  providerId: string,
  query = "",
  limit = 8,
): AgentSessionHistoryView<T> {
  const providerSessions = sessions.filter(
    (session) => session.providerId === providerId,
  );
  const normalizedQuery = query.trim().toLowerCase();
  const matchingSessions = normalizedQuery
    ? providerSessions.filter((session) =>
        agentSessionSearchText(session).includes(normalizedQuery),
      )
    : providerSessions;
  return {
    visible: providerSessions.length > 0,
    searchVisible: providerSessions.length >= limit,
    sessions: matchingSessions.slice(0, limit),
  };
}

export function providerAgentSessions<
  T extends { readonly providerId: string },
>(sessions: readonly T[], providerId: string, limit = 8): readonly T[] {
  return sessions.filter((session) => session.providerId === providerId).slice(0, limit);
}
function agentSessionSearchText(
  session: { readonly providerId: string },
): string {
  const record = session as Record<string, unknown>;
  return ["title", "projectDirectory", "providerId", "modelId", "client"]
    .map((field) => String(record[field] ?? ""))
    .join(" ")
    .toLowerCase();
}
