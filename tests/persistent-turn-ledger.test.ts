import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileTurnLedgerStore,
  PersistentTurnLedger,
  TurnLedgerPersistenceError,
  type TurnSignature,
} from "../src/index.js";

function signature(overrides: Partial<TurnSignature> = {}): TurnSignature {
  return {
    fingerprint: "fp-1",
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

async function ledgerPath(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "providerdock-ledger-"));
  return { root, path: join(root, "runtime", "turn-ledger.json") };
}

describe("PersistentTurnLedger", () => {
  it("retains completed turns and resolved tool calls across instances", async () => {
    const fixture = await ledgerPath();
    const first = new PersistentTurnLedger({
      store: new FileTurnLedgerStore({ filePath: fixture.path }),
    });
    const delivered = {
      callId: "call-persisted",
      name: "write_file",
      argumentsHash: "args-hash",
    };

    const initial = await first.admit(signature({ fingerprint: "fp-complete" }));
    if (initial.decision !== "accepted") throw new Error("expected acceptance");
    await first.recordDeliveredToolCalls(initial.token, [delivered]);
    await first.complete(initial.token);

    const continuation = await first.admit(
      signature({
        fingerprint: "fp-result",
        toolCalls: [delivered],
        toolResults: [{ callId: delivered.callId, outputHash: "result-hash" }],
      }),
    );
    if (continuation.decision !== "accepted") throw new Error("expected continuation");
    await first.complete(continuation.token);

    const recovered = new PersistentTurnLedger({
      store: new FileTurnLedgerStore({ filePath: fixture.path }),
    });
    await recovered.initialize();
    await expect(recovered.admit(signature({ fingerprint: "fp-complete" }))).resolves.toMatchObject({
      decision: "blocked",
      code: "TURN_ALREADY_COMPLETED",
    });
    await expect(
      recovered.admit(
        signature({ fingerprint: "fp-loop", toolCalls: [delivered] }),
      ),
    ).resolves.toMatchObject({ decision: "blocked", code: "TOOL_LOOP_DETECTED" });

    const persisted = await readFile(fixture.path, "utf8");
    expect(persisted).toContain('"version": 1');
    expect(persisted).not.toContain("write this raw secret");
    expect((await readdir(join(fixture.root, "runtime"))).sort()).toEqual([
      "turn-ledger.json",
    ]);
  });

  it("recovers an interrupted accepted turn as fail-closed INCOMPLETE", async () => {
    const fixture = await ledgerPath();
    const first = new PersistentTurnLedger({
      store: new FileTurnLedgerStore({ filePath: fixture.path }),
    });
    const admitted = await first.admit(signature({ fingerprint: "fp-crashed" }));
    expect(admitted.decision).toBe("accepted");

    const recovered = new PersistentTurnLedger({
      store: new FileTurnLedgerStore({ filePath: fixture.path }),
    });
    await recovered.initialize();
    expect(recovered.stateOf("fp-crashed")).toBe("INCOMPLETE");
    await expect(
      recovered.admit(signature({ fingerprint: "fp-crashed" })),
    ).resolves.toMatchObject({ decision: "blocked", code: "UNSAFE_REPLAY" });

    const snapshot = JSON.parse(await readFile(fixture.path, "utf8")) as {
      turns: Array<{ fingerprint: string; state: string }>;
    };
    expect(snapshot.turns).toContainEqual(
      expect.objectContaining({ fingerprint: "fp-crashed", state: "INCOMPLETE" }),
    );
  });

  it("refuses a corrupt snapshot without replacing it", async () => {
    const fixture = await ledgerPath();
    await mkdir(join(fixture.root, "runtime"));
    await writeFile(fixture.path, "{not-json", "utf8");
    const ledger = new PersistentTurnLedger({
      store: new FileTurnLedgerStore({ filePath: fixture.path }),
    });

    await expect(ledger.initialize()).rejects.toBeInstanceOf(TurnLedgerPersistenceError);
    expect(await readFile(fixture.path, "utf8")).toBe("{not-json");
    await expect(ledger.admit(signature())).rejects.toBeInstanceOf(
      TurnLedgerPersistenceError,
    );
  });

  it("latches a save failure and rejects every later mutation", async () => {
    const ledger = new PersistentTurnLedger({
      store: {
        load: async () => undefined,
        save: async () => {
          throw new Error("disk unavailable");
        },
      },
    });

    await expect(ledger.admit(signature())).rejects.toBeInstanceOf(
      TurnLedgerPersistenceError,
    );
    await expect(
      ledger.admit(signature({ fingerprint: "another" })),
    ).rejects.toBeInstanceOf(TurnLedgerPersistenceError);
  });
});
