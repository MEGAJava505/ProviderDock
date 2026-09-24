import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  FileOmpRunRepository,
  type OmpRunCreateInput,
  type OmpRunRepository,
  type OmpRunState,
  type OmpRunTransitionDetails,
} from "../src/clients/omp/omp-run-repository.js";

// Preserve real IO; expose a configurable facade only for narrow disk-fault injection.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

const roots: string[] = [];
const createdAt = "2026-09-15T00:00:00.000Z";
const updatedAt = "2026-09-15T00:00:01.000Z";
const missingId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes("omp-run-repository-")) {
      throw new Error("Unsafe test cleanup");
    }
    await fs.rm(target, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "omp-run-repository-"));
  roots.push(root);
  const directory = join(root, "runs");
  const input: OmpRunCreateInput = {
    providerId: "gateway", accountId: "account-one", modelId: "vendor/model:exact",
    projectDirectory: join(root, "project"), mode: "tui",
  };
  let now = createdAt;
  const repository: OmpRunRepository = new FileOmpRunRepository(directory, () => new Date(now));
  return { root, directory, input, repository, setTime: (time: string) => { now = time; } };
}

describe("OMP run persistence and lifecycle", () => {
  it("persists literal identities and generated UUID/times for a fresh instance", async () => {
    const { directory, input, repository } = await fixture();
    const run = await repository.create(input);
    expect(run).toEqual({
      ...input, runId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      state: "VALIDATING", createdAt, updatedAt: createdAt,
      transitions: [{ state: "VALIDATING", at: createdAt }],
    });
    const reopened = new FileOmpRunRepository(directory);
    expect(await reopened.get(run.runId)).toEqual(run);
    expect(await reopened.list()).toEqual([run]);
    expect(await fs.readdir(directory)).toEqual([`${run.runId}.json`]);
    expect(JSON.parse(await fs.readFile(join(directory, `${run.runId}.json`), "utf8"))).toEqual(run);
    expect((await repository.create({ ...input, mode: "rpc" })).runId).not.toBe(run.runId);
  });

  it("returns undefined/empty only for genuinely missing records/directories", async () => {
    const { repository, directory } = await fixture();
    expect(await repository.get(missingId)).toBeUndefined();
    expect(await repository.list()).toEqual([]);
    await expect(repository.transition(missingId, "FAILED")).rejects.toThrow();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("returns deeply immutable independent snapshots, not writable repository state", async () => {
    const { repository, input } = await fixture();
    const run = await repository.create(input);
    const copy = (await repository.get(run.runId))!;
    expect(copy).not.toBe(run);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.transitions)).toBe(true);
    expect(Object.isFrozen(copy.transitions[0])).toBe(true);
    expect(Reflect.set(copy, "state", "SUCCEEDED")).toBe(false);
    expect(Reflect.set(copy.transitions[0]!, "state", "SUCCEEDED")).toBe(false);
    expect(Object.isFrozen(await repository.list())).toBe(true);
    expect((await repository.get(run.runId))!.state).toBe("VALIDATING");
  });

  it("records terminal-open separately from readiness and retains approved details", async () => {
    const { repository, input, setTime, directory } = await fixture();
    const run = await repository.create(input);
    setTime(updatedAt);
    await repository.transition(run.runId, "STARTING", { pid: 123 });
    expect((await repository.transition(run.runId, "TERMINAL_OPEN")).state).toBe("TERMINAL_OPEN");
    await repository.transition(run.runId, "READY", { sessionId: "session-one" });
    await repository.transition(run.runId, "RUNNING");
    const final = await repository.transition(run.runId, "SUCCEEDED");
    expect(final).toMatchObject({ pid: 123, sessionId: "session-one", createdAt, updatedAt });
    expect(final.transitions).toEqual([
      { state: "VALIDATING", at: createdAt },
      ...["STARTING", "TERMINAL_OPEN", "READY", "RUNNING", "SUCCEEDED"].map((state) => ({ state, at: updatedAt })),
    ]);
    expect(await new FileOmpRunRepository(directory).get(run.runId)).toEqual(final);
    expect(run.state).toBe("VALIDATING");
  });

  it.each([
    ["STARTING", "READY", "RUNNING", "SUCCEEDED"],
    ["STARTING", "TERMINAL_OPEN", "RUNNING", "SUCCEEDED"],
    ["STARTING", "SUCCEEDED"],
    ["STARTING", "TERMINAL_OPEN", "SUCCEEDED"],
    ["STARTING", "READY", "SUCCEEDED"],
  ] as OmpRunState[][])("allows caller-evidenced progress/exit via %j", async (...states) => {
    const { repository, input } = await fixture();
    const run = await repository.create(input);
    for (const state of states) await repository.transition(run.runId, state);
    expect((await repository.get(run.runId))!.state).toBe("SUCCEEDED");
  });

  it.each(["FAILED", "CANCELLED", "INTERRUPTED"] as const)(
    "allows early %s but never resurrects any terminal record", async (state) => {
      const { repository, input } = await fixture();
      const run = await repository.create(input);
      const terminal = await repository.transition(run.runId, state);
      for (const next of ["VALIDATING", "STARTING", "TERMINAL_OPEN", "READY", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const) {
        await expect(repository.transition(run.runId, next)).rejects.toThrow();
      }
      expect(await repository.get(run.runId)).toEqual(terminal);
    },
  );

  it("rejects skipped, backward and duplicate states without modifying bytes", async () => {
    const { repository, input, directory } = await fixture();
    const run = await repository.create(input);
    const file = join(directory, `${run.runId}.json`);
    const initial = await fs.readFile(file);
    for (const state of ["SUCCEEDED", "READY", "RUNNING", "TERMINAL_OPEN", "VALIDATING", "unknown"] as OmpRunState[]) {
      await expect(repository.transition(run.runId, state)).rejects.toThrow();
      expect(await fs.readFile(file)).toEqual(initial);
    }
    await repository.transition(run.runId, "STARTING");
    await repository.transition(run.runId, "READY");
    await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow();
    await repository.transition(run.runId, "SUCCEEDED");
    await expect(repository.transition(run.runId, "RUNNING")).rejects.toThrow();
  });

  it("does not infer child failure, readiness, or interruption when reopened", async () => {
    const { repository, directory, input } = await fixture();
    const run = await repository.create(input);
    await repository.transition(run.runId, "STARTING", { pid: 2147483647 });
    const starting = (await repository.get(run.runId))!;
    expect(await new FileOmpRunRepository(directory).list()).toEqual([starting]);
  });
});

describe("OMP run durable storage boundary", () => {
  it("competing repository instances cannot both overwrite the same prior transition", async () => {
    const { repository, directory, input } = await fixture();
    const run = await repository.create(input);
    const other = new FileOmpRunRepository(directory, () => new Date(updatedAt));
    const results = await Promise.allSettled([
      repository.transition(run.runId, "STARTING", { pid: 111 }),
      other.transition(run.runId, "STARTING", { pid: 222 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("No successful writer");
    expect(await other.get(run.runId)).toEqual(winner.value);
    const next = await other.transition(run.runId, "READY");
    expect(next.pid).toBe(winner.value.pid);
    expect(next.transitions.map((step) => step.state)).toEqual(["VALIDATING", "STARTING", "READY"]);
  });

  it("persists every successful concurrent create without assuming all contenders succeed", async () => {
    const { directory, input } = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      new FileOmpRunRepository(directory).create(input)));
    const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value.runId] : []);
    expect(successful.length).toBeGreaterThan(0);
    expect((await new FileOmpRunRepository(directory).list()).map((run) => run.runId).sort()).toEqual(successful.sort());
    expect(await fs.readdir(directory)).toHaveLength(successful.length);
  });

  it("never steals an existing writer lock, even if old, and keeps reads available", async () => {
    const { repository, directory, input } = await fixture();
    const run = await repository.create(input);
    const lock = join(directory, ".writer.lock");
    await fs.mkdir(lock);
    await fs.utimes(lock, new Date("2000-01-01"), new Date("2000-01-01"));
    await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/OMP_RUN_/);
    await expect(new FileOmpRunRepository(directory).create(input)).rejects.toThrow(/OMP_RUN_/);
    expect(await repository.get(run.runId)).toEqual(run);
    expect(await repository.list()).toEqual([run]);
    expect((await fs.lstat(lock)).isDirectory()).toBe(true);
  });

  it.each(["write", "sync", "rename"] as const)(
    "preserves original good bytes and settles cleanup after a %s failure", async (failure) => {
      const { repository, directory, input } = await fixture();
      const run = await repository.create(input);
      const file = join(directory, `${run.runId}.json`);
      const before = await fs.readFile(file);
      const originalOpen = fs.open;
      let injected = false;
      if (failure === "rename") {
        vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
          injected = true;
          throw new Error("DO-NOT-REPORT filesystem error");
        });
      } else {
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await originalOpen(...args);
          if (String(args[0]).endsWith(".tmp")) {
            if (failure === "sync") {
              vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
                injected = true;
                throw new Error("DO-NOT-REPORT fsync failure");
              });
            } else {
              vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
                await handle.write("partial fixture");
                injected = true;
                throw new Error("DO-NOT-REPORT disk-full failure");
              });
            }
          }
          return handle;
        });
      }
      await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
      expect(injected).toBe(true);
      expect(await fs.readFile(file)).toEqual(before);
      expect(await fs.readdir(directory)).toEqual([`${run.runId}.json`]);
      vi.restoreAllMocks();
      expect((await repository.transition(run.runId, "STARTING")).state).toBe("STARTING");
    },
  );

  it("retries one transient Windows rename sharing failure", async () => {
    const { repository, input } = await fixture();
    const run = await repository.create(input);
    const rename = fs.rename;
    let attempts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      }
      return rename(...args);
    });

    await expect(repository.transition(run.runId, "STARTING"))
      .resolves.toMatchObject({ state: "STARTING" });
    expect(attempts).toBe(2);
  });

  it("fsyncs completed temporary bytes before replacing the original", async () => {
    const { repository, directory, input } = await fixture();
    const run = await repository.create(input);
    const originalOpen = fs.open;
    let flushed = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await sync();
          flushed = true;
        });
      }
      return handle;
    });
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      expect(flushed).toBe(true);
      expect(resolve(String(source), "..")).toBe(resolve(directory));
      expect(JSON.parse(await fs.readFile(source, "utf8")).state).toBe("STARTING");
      expect(JSON.parse(await fs.readFile(destination, "utf8")).state).toBe("VALIDATING");
      await rename(source, destination);
    });
    await repository.transition(run.runId, "STARTING");
    expect(flushed).toBe(true);
    expect((await repository.get(run.runId))!.state).toBe("STARTING");
  });

  it.each(["", "{", "{}", "\0", '{"state":"DO-NOT-REPORT"}'])(
    "rejects corrupt bytes %j on get/list/transition without replacing or backing them up", async (bytes) => {
      const { repository, directory, input } = await fixture();
      const run = await repository.create(input);
      const file = join(directory, `${run.runId}.json`);
      await fs.writeFile(file, bytes);
      await expect(repository.get(run.runId)).rejects.toThrow(/^OMP_RUN_/);
      await expect(repository.list()).rejects.toThrow(/^OMP_RUN_/);
      await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
      expect(await fs.readdir(directory)).toEqual([`${run.runId}.json`]);
    },
  );

  it("refuses oversized otherwise valid JSON and invalid UTF-8 without rewriting either", async () => {
    const { repository, directory, input } = await fixture();
    const run = await repository.create(input);
    const file = join(directory, `${run.runId}.json`);
    for (const bytes of [
      Buffer.from(JSON.stringify(run) + " ".repeat(65537)),
      Buffer.concat([
        Buffer.from(JSON.stringify(run).split("account-one")[0]!),
        Buffer.from([0xff]),
        Buffer.from(JSON.stringify(run).split("account-one")[1]!),
      ]),
    ]) {
      await fs.writeFile(file, bytes);
      await expect(repository.get(run.runId)).rejects.toThrow(/^OMP_RUN_/);
      await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
      expect(await fs.readFile(file)).toEqual(bytes);
    }
  });

  it("rejects schema/history/filename tampering, not just malformed JSON", async () => {
    const { repository, directory, input } = await fixture();
    const run = await repository.create(input);
    const file = join(directory, `${run.runId}.json`);
    for (const patch of [
      { runId: missingId }, { stdout: "DO-NOT-REPORT" },
      { accountId: "DO-NOT-REPORT\0" }, { transitions: [] },
      { updatedAt }, { createdAt: "2026-02-30T00:00:00.000Z" },
      { transitions: [{ state: "VALIDATING", at: createdAt, environment: {} }] },
      { state: "READY", transitions: [{ state: "READY", at: createdAt }] },
      { state: "SUCCEEDED", transitions: [{ state: "VALIDATING", at: createdAt }, { state: "SUCCEEDED", at: createdAt }] },
      { state: "STARTING", updatedAt: "2026-09-14T00:00:00.000Z", transitions: [
        { state: "VALIDATING", at: createdAt }, { state: "STARTING", at: "2026-09-14T00:00:00.000Z" },
      ] },
    ]) {
      const bytes = JSON.stringify({ ...run, ...patch });
      await fs.writeFile(file, bytes);
      await expect(repository.get(run.runId)).rejects.toThrow(/^OMP_RUN_/);
      await expect(repository.list()).rejects.toThrow(/^OMP_RUN_/);
      await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    }
  });

  it("rejects invalid or backwards clocks before a persistent mutation", async () => {
    const { repository, directory, input, setTime } = await fixture();
    const run = await repository.create(input);
    const file = join(directory, `${run.runId}.json`);
    const bytes = await fs.readFile(file);
    for (const time of ["invalid", "2026-09-14T00:00:00.000Z"]) {
      setTime(time);
      await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
      expect(await fs.readFile(file)).toEqual(bytes);
    }
  });

  it("rejects modified staging bytes even when the attacker keeps the temporary inode and length", async () => {
    const { repository, directory, input } = await fixture();
    const run = await repository.create(input);
    const file = join(directory, `${run.runId}.json`);
    const before = await fs.readFile(file);
    const originalOpen = fs.open;
    let injected = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          await sync();
          const bytes = await fs.readFile(args[0]);
          await fs.writeFile(args[0], Buffer.alloc(bytes.length, 0));
          injected = true;
        });
      }
      return handle;
    });
    await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
    expect(injected).toBe(true);
    expect(await fs.readFile(file)).toEqual(before);
    expect(await fs.readdir(directory)).toEqual([`${run.runId}.json`]);
  });

  it("detects a non-cooperating destination writer before replacing its bytes", async () => {
    const { repository, directory, input } = await fixture();
    const run = await repository.create(input);
    const file = join(directory, `${run.runId}.json`);
    const externalBytes = JSON.stringify({ ...run, accountId: "another-fixture-account" });
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith(".tmp")) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
          await sync();
          await fs.writeFile(file, externalBytes);
        });
      }
      return handle;
    });
    await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
    expect(await fs.readFile(file, "utf8")).toBe(externalBytes);
  });

  it("bounds directory enumeration instead of returning a partial list or deleting abandoned staging", async () => {
    const { directory, repository } = await fixture();
    await fs.mkdir(directory);
    const results = await Promise.allSettled(Array.from({ length: 1001 }, () =>
      fs.writeFile(join(directory, `.${randomUUID()}.tmp`), "incomplete")));
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    await expect(repository.list()).rejects.toThrow(/^OMP_RUN_/);
    expect(await fs.readdir(directory)).toHaveLength(1001);
  });
});

describe("OMP run path containment", () => {
  it("rejects traversal/NUL/ADS run IDs before IO and never exposes rejected values", async () => {
    const { repository } = await fixture();
    for (const runId of ["../DO-NOT-REPORT", "..\\DO-NOT-REPORT", `${missingId}:secret`, `${missingId}\0`, ""]) {
      for (const operation of [
        () => repository.get(runId), () => repository.transition(runId, "FAILED"),
      ]) {
        const error = await operation().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain("DO-NOT-REPORT");
      }
    }
  });

  it("rejects ambiguous/traversing/relative storage and project paths", async () => {
    const { root, input } = await fixture();
    for (const path of [
      "DO-NOT-REPORT", `${root}${sep}..${sep}DO-NOT-REPORT`,
      `${root}${sep}DO-NOT-REPORT\0`, `${root}${sep}DO-NOT-REPORT:stream`,
      `${root}${sep}DO-NOT-REPORT.`, `${root}${sep}NUL`,
    ]) {
      const repo = new FileOmpRunRepository(path);
      await expect(repo.list()).rejects.toThrow(/^OMP_RUN_/);
      await expect(repo.get(missingId)).rejects.toThrow(/^OMP_RUN_/);
      await expect(repo.create(input)).rejects.toThrow(/^OMP_RUN_/);
      await expect(new FileOmpRunRepository(join(root, "safe")).create({ ...input, projectDirectory: path }))
        .rejects.toThrow(/^OMP_RUN_/);
    }
  });

  it("refuses linked storage directories and linked ancestors, without writing through them", async () => {
    const { root, input } = await fixture();
    const target = join(root, "target");
    await fs.mkdir(target);
    await fs.symlink(target, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    for (const directory of [join(root, "alias"), join(root, "alias", "nested", "runs")]) {
      const repository = new FileOmpRunRepository(directory);
      await expect(repository.create(input)).rejects.toThrow(/^OMP_RUN_/);
      await expect(repository.list()).rejects.toThrow(/^OMP_RUN_/);
      await expect(repository.get(missingId)).rejects.toThrow(/^OMP_RUN_/);
    }
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("refuses linked record paths, including dangling links, and never replaces a target", async () => {
    const { root, input, repository, directory } = await fixture();
    const run = await repository.create(input);
    const file = join(directory, `${run.runId}.json`);
    const original = await fs.readFile(file);
    const outside = join(root, "outside.json");
    await fs.writeFile(outside, original);
    await fs.unlink(file);
    // Junctions work without Windows symlink privileges and must also be rejected.
    await fs.symlink(root, file, process.platform === "win32" ? "junction" : "dir");
    await expect(repository.get(run.runId)).rejects.toThrow(/^OMP_RUN_/);
    await expect(repository.list()).rejects.toThrow(/^OMP_RUN_/);
    await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
    expect(await fs.readFile(outside)).toEqual(original);
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    await fs.unlink(file);
    await fs.symlink(join(root, "missing-target"), file, process.platform === "win32" ? "junction" : "dir");
    await expect(repository.get(run.runId)).rejects.toThrow(/^OMP_RUN_/);
  });

  it("refuses hard-linked and non-regular records instead of reading/modifying them", async () => {
    const { root, input, repository, directory } = await fixture();
    const run = await repository.create(input);
    const file = join(directory, `${run.runId}.json`);
    const bytes = await fs.readFile(file);
    await fs.link(file, join(root, "alias.json"));
    await expect(repository.get(run.runId)).rejects.toThrow(/^OMP_RUN_/);
    await expect(repository.transition(run.runId, "STARTING")).rejects.toThrow(/^OMP_RUN_/);
    expect(await fs.readFile(file)).toEqual(bytes);
    await fs.unlink(file);
    await fs.mkdir(file);
    await expect(repository.get(run.runId)).rejects.toThrow(/^OMP_RUN_/);
    await expect(repository.list()).rejects.toThrow(/^OMP_RUN_/);
  });
});

describe("OMP run input boundary", () => {
  it("rejects invalid identities/mode/path and unapproved create fields without echoing values", async () => {
    const { repository, input } = await fixture();
    for (const patch of [
      { providerId: "" }, { providerId: "../DO-NOT-REPORT" },
      { accountId: " \t" }, { modelId: "DO-NOT-REPORT\0" }, { modelId: "x".repeat(1025) },
      { projectDirectory: "relative/DO-NOT-REPORT" }, { mode: "DO-NOT-REPORT" },
      { argv: ["DO-NOT-REPORT"] }, { environment: { TOKEN: "DO-NOT-REPORT" } },
      { stdout: "DO-NOT-REPORT" }, { runId: missingId }, { state: "READY" },
    ]) {
      await expect(repository.create({ ...input, ...patch } as OmpRunCreateInput))
        .rejects.toThrow(/OMP_RUN_/);
    }
    expect(await repository.list()).toEqual([]);
  });

  it("rejects invalid details without silently storing or dropping arbitrary fields", async () => {
    const { repository, input } = await fixture();
    const run = await repository.create(input);
    for (const details of [
      { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: Number.MAX_SAFE_INTEGER + 1 },
      { sessionId: "" }, { sessionId: "DO-NOT-REPORT\0" }, { diagnostic: null },
      { stderr: "DO-NOT-REPORT" }, { metadata: {} }, { modelId: "replacement" },
    ]) {
      const error = await repository.transition(run.runId, "STARTING", details as OmpRunTransitionDetails).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("DO-NOT-REPORT");
    }
    expect(await repository.get(run.runId)).toEqual(run);
  });

  it("sanitizes diagnostics on write and read, discarding all free-form payloads", async () => {
    const { repository, input, directory } = await fixture();
    const run = await repository.create(input);
    const diagnostic = {
      operationId: missingId, stage: "process-spawn", code: "EXECUTABLE_NOT_FOUND",
      occurredAt: createdAt, retryable: true, message: "DO-NOT-REPORT", suggestedAction: "DO-NOT-REPORT",
      stack: "DO-NOT-REPORT", environment: { TOKEN: "DO-NOT-REPORT" }, stdout: "DO-NOT-REPORT",
    };
    const result = await repository.transition(run.runId, "FAILED", { diagnostic } as unknown as OmpRunTransitionDetails);
    const file = join(directory, `${run.runId}.json`);
    expect(JSON.stringify(result)).not.toContain("DO-NOT-REPORT");
    expect(Object.keys(result.diagnostic!).sort()).toEqual([
      "code", "message", "occurredAt", "operationId", "retryable", "stage", "suggestedAction",
    ]);
    expect(Object.isFrozen(result.diagnostic)).toBe(true);
    expect(await fs.readFile(file, "utf8")).not.toContain("DO-NOT-REPORT");
    await fs.writeFile(file, JSON.stringify({ ...result, diagnostic }));
    expect(await new FileOmpRunRepository(directory).get(run.runId)).toEqual(result);
  });
});
