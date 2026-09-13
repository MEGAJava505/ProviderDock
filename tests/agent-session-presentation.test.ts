import { describe, expect, it } from "vitest";
import * as agentSessionPresentation from "../src/ui/agent-session-presentation.js";
const { agentSessionUnavailableReason, providerAgentSessions } = agentSessionPresentation;

interface AgentSessionHistoryView {
  readonly visible: boolean;
  readonly searchVisible: boolean;
  readonly sessions: readonly { readonly providerId: string; readonly title: string }[];
}
type AgentSessionHistoryViewFn = (
  sessions: readonly { readonly providerId: string; readonly title: string }[],
  providerId: string,
  query: string,
  limit?: number,
) => AgentSessionHistoryView;

describe("agent session presentation", () => {
  it("returns a precise reason for each resume blocker", () => {
    expect(
      agentSessionUnavailableReason({ resumeBlockedReason: "legacy-provider" }),
    ).toBe("старая Codex-сессия без привязки к провайдеру");
    expect(
      agentSessionUnavailableReason({ resumeBlockedReason: "invalid-session-id" }),
    ).toBe("некорректный ID сессии");
    expect(
      agentSessionUnavailableReason({ resumeBlockedReason: "missing-project" }),
    ).toBe("в истории нет проекта");
    expect(
      agentSessionUnavailableReason({ resumeBlockedReason: "missing-model" }),
    ).toBe("в истории нет модели");
  });

  it("filters sessions by provider and keeps the newest first", () => {
    const sessions = [
      { providerId: "router", title: "second" },
      { providerId: "other", title: "other" },
      { providerId: "router", title: "first" },
      { providerId: "router", title: "third" },
    ];

    expect(providerAgentSessions(sessions, "router", 2)).toEqual([
      { providerId: "router", title: "second" },
      { providerId: "router", title: "first" },
    ]);
  });

  it("builds a provider-scoped and bounded launch history view", () => {
    const historyView = (
      agentSessionPresentation as { agentSessionHistoryView?: AgentSessionHistoryViewFn }
    ).agentSessionHistoryView;
    expect(historyView).toBeTypeOf("function");
    if (historyView === undefined) return;

    const sessions = [
      { providerId: "router", title: "router-2" },
      { providerId: "other", title: "other" },
      { providerId: "router", title: "router-1" },
    ];

    expect(historyView(sessions, "router", "", 2)).toEqual({
      visible: true,
      searchVisible: true,
      sessions: [
        { providerId: "router", title: "router-2" },
        { providerId: "router", title: "router-1" },
      ],
    });
    expect(historyView(sessions, "router", "router-1", 2).sessions).toEqual([
      { providerId: "router", title: "router-1" },
    ]);
    expect(historyView(sessions, "missing", "", 2)).toEqual({
      visible: false,
      searchVisible: false,
      sessions: [],
    });
  });
});
