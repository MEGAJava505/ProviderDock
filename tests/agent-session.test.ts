import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSessionHistory } from "../src/index.js";
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

const claudeSessionId = "8fbf0290-d6ae-44a9-85e2-fc36e0915743";
const codexSessionId = "01a08736-06ba-7b92-97a4-0fbdb4e6976c";
const legacyCodexSessionId = "01a08750-06ba-7b92-97a4-0fbdb4e6976c";

describe("AgentSessionHistory", () => {
  it("finds provider-scoped Claude and Codex sessions plus legacy Codex sessions", async () => {
    const { history } = await createFixture();
    const sessions = await history.list();

    expect(sessions).toEqual([
      expect.objectContaining({
        id: codexSessionId,
        client: "codex",
        providerId: "router",
        projectDirectory: "E:\\Projects\\provider-dock",
        modelId: "gpt-5.6-sol",
        title: "Codex title",
        resumable: true,
      }),
      expect.objectContaining({
        id: claudeSessionId,
        client: "claude-code",
        providerId: "agentrouter-2",
        projectDirectory: "E:\\Projects\\provider__switcher",
        modelId: "claude-opus-4.8",
        title: "Claude title",
        resumable: true,
      }),
      expect.objectContaining({
        id: legacyCodexSessionId,
        client: "codex",
        providerId: "legacy",
        projectDirectory: "E:\\Projects\\legacy-project",
        modelId: "gpt-5.6-sol",
        title: "Legacy Codex session",
        resumable: false,
      }),
    ]);
  });

  it("reports precise reasons why sessions cannot be resumed", async () => {
    const { history } = await createBlockedReasonFixture();
    const sessions = await history.list();
    const reasons = new Map(
      sessions.map((session) => [
        session.title,
        (session as { resumeBlockedReason?: string }).resumeBlockedReason,
      ]),
    );

    expect(reasons.get("Missing model session")).toBe("missing-model");
    expect(reasons.get("Missing project session")).toBe("missing-project");
    expect(reasons.get("Invalid id session")).toBe("invalid-session-id");
    expect(reasons.get("Legacy provider session")).toBe("legacy-provider");
  });
  it("deletes only a session discovered in an allowed agent history root", async () => {
    const { history, claudePath, codexPath, legacyPath } = await createFixture();

    expect(
      await history.delete({
        client: "claude-code",
        id: claudeSessionId,
        providerId: "wrong-provider",
      }),
    ).toBe(false);
    expect(await readFile(claudePath, "utf8")).toContain("Claude title");

    expect(
      await history.delete({
        client: "claude-code",
        id: claudeSessionId,
        providerId: "agentrouter-2",
      }),
    ).toBe(true);
    expect(
      await history.delete({
        client: "codex",
        id: codexSessionId,
        providerId: "router",
      }),
    ).toBe(true);
    expect(
      await history.delete({
        client: "codex",
        id: legacyCodexSessionId,
        providerId: "legacy",
      }),
    ).toBe(true);

    await expect(readFile(claudePath, "utf8")).rejects.toThrow();
    await expect(readFile(codexPath, "utf8")).rejects.toThrow();
    await expect(readFile(legacyPath, "utf8")).rejects.toThrow();
  });
});

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

async function createBlockedReasonFixture() {
  const root = await mkdtemp(join(tmpdir(), "providerdock-agent-blockers-"));
  const claudeHome = join(root, "claude-home");
  const codexHome = join(root, "codex-home");
  const claudeProject = join(
    claudeHome,
    "providers",
    "router",
    "projects",
    "E--Projects-Antigravity-Projects-provider--switcher",
  );
  await mkdir(claudeProject, { recursive: true });

  const missingModelId = "8fbf0290-d6ae-44a9-85e2-fc36e0915743";
  await writeFile(
    join(claudeProject, `${missingModelId}.jsonl`),
    [
      JSON.stringify({
        type: "ai-title",
        aiTitle: "Missing model session",
        sessionId: missingModelId,
      }),
      JSON.stringify({ cwd: "E:\\Projects\\missing-model" }),
      "",
    ].join("\n"),
    "utf8",
  );

  const missingProjectId = "2627e09f-4bc6-4703-9731-7d2f794b7636";
  await writeFile(
    join(claudeProject, `${missingProjectId}.jsonl`),
    [
      JSON.stringify({
        type: "ai-title",
        aiTitle: "Missing project session",
        sessionId: missingProjectId,
      }),
      JSON.stringify({ message: { role: "assistant", model: "claude-opus-5" } }),
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    join(claudeProject, "not-a-session-id.jsonl"),
    [
      JSON.stringify({
        type: "ai-title",
        aiTitle: "Invalid id session",
        sessionId: "not-a-session-id",
      }),
      JSON.stringify({ cwd: "E:\\Projects\\invalid-id" }),
      JSON.stringify({ model: "claude-opus-5" }),
      "",
    ].join("\n"),
    "utf8",
  );

  const legacyId = "01a08736-06ba-7b92-97a4-0fbdb4e6976c";
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await writeFile(
    join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: legacyId, thread_name: "Legacy provider session" })}\n`,
    "utf8",
  );
  await writeFile(
    join(codexHome, "sessions", `rollout-${legacyId}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: legacyId,
        session_id: legacyId,
        cwd: "E:\\Projects\\legacy",
        model: "gpt-5.6-sol",
      },
    })}\n`,
    "utf8",
  );

  return {
    history: new AgentSessionHistory({ claudeHome, codexHome }),
  };
}
async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "providerdock-agent-history-"));
  const claudeHome = join(root, "claude-home");
  const codexHome = join(root, "codex-home");

  const claudePath = join(
    claudeHome,
    "providers",
    "agentrouter-2",
    "projects",
    "E--Projects-Antigravity-Projects-provider--switcher",
    `${claudeSessionId}.jsonl`,
  );
  await mkdir(join(claudePath, ".."), { recursive: true });
  await writeFile(
    claudePath,
    [
      JSON.stringify({ type: "ai-title", aiTitle: "Claude title", sessionId: claudeSessionId }),
      JSON.stringify({ cwd: "E:\\Projects\\provider__switcher" }),
      JSON.stringify({ message: { role: "assistant", model: "claude-opus-4.8" } }),
      "",
    ].join("\n"),
    "utf8",
  );

  const codexPath = join(
    codexHome,
    "providers",
    "router",
    "sessions",
    "2026",
    "09",
    "10",
    `rollout-${codexSessionId}.jsonl`,
  );
  await mkdir(join(codexPath, ".."), { recursive: true });
  await writeFile(
    codexPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: codexSessionId,
          session_id: codexSessionId,
          cwd: "E:\\Projects\\provider-dock",
          model_provider: "providerdock-router",
        },
      }),
      JSON.stringify({
        type: "thread_settings_applied",
        payload: { model: "gpt-5.6-sol" },
      }),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(codexHome, "providers", "router", "session_index.jsonl"),
    `${JSON.stringify({ id: codexSessionId, thread_name: "Codex title", updated_at: "2026-09-10T10:00:00Z" })}\n`,
    "utf8",
  );

  await writeFile(
    join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: legacyCodexSessionId, thread_name: "Legacy Codex session", updated_at: "2026-09-09T10:00:00Z" })}\n`,
    "utf8",
  );

  const legacyPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "09",
    `rollout-${legacyCodexSessionId}.jsonl`,
  );
  await mkdir(join(legacyPath, ".."), { recursive: true });
  await writeFile(
    legacyPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: legacyCodexSessionId,
        session_id: legacyCodexSessionId,
        cwd: "E:\\Projects\\legacy-project",
        model: "gpt-5.6-sol",
      },
    })}\n`,
    "utf8",
  );

  await touch(claudePath, "2026-09-10T09:00:00Z");
  await touch(codexPath, "2026-09-10T10:00:00Z");
  await touch(legacyPath, "2026-09-09T10:00:00Z");

  return {
    root,
    claudeHome,
    codexHome,
    claudePath,
    codexPath,
    legacyPath,
    history: new AgentSessionHistory({ claudeHome, codexHome }),
  };
}

async function touch(path: string, isoTimestamp: string): Promise<void> {
  const time = new Date(isoTimestamp);
  await utimes(path, time, time);
}
