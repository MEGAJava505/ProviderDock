import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, seal, sha, checkIds, redact, files, finalFiles, priorFinalFiles, nextFinalFiles, verifyEvidence } from "./build-evidence.mjs";

test("canonical hash excludes only the top-level integrityHash", () => {
  const value = { z: [{ integrityHash: "keep-me", a: 1 }], integrityHash: "old" };
  const sealed = seal(value);
  assert.equal(sealed.integrityHash.value, sha(canonical(sealed)));
  assert.match(canonical(sealed), /keep-me/);
  assert.doesNotMatch(canonical(sealed), /old/);
});

test("ID preflight rejects a differently named file using a reserved ID", async () => {
  const folder = await mkdtemp(join(tmpdir(), "m11-evidence-"));
  try {
    const reservedId = files[0].match(/-(\d{6})\./)[1];
    await writeFile(join(folder, `other-${reservedId}.json`), "{}");
    await assert.rejects(checkIds(folder), /collision/);
  } finally {
    await rm(folder, { recursive: true });
  }
});

test("capture publication preserves raw bytes when no redaction is needed", () => {
  const bytes = Buffer.from("frame\r\n\xff", "latin1");
  const result = redact(bytes, []);
  assert.equal(result.redactions, 0);
  assert.deepEqual(result.bytes, bytes);
});

test("capture publication removes paths and bearer credentials with counts", () => {
  const result = redact(Buffer.from("C:\\Users\\owner\\private.txt\nBearer SECRET\nowner@example.com\n"), []);
  assert.doesNotMatch(result.bytes.toString(), /SECRET|owner@example|C:\\/);
  assert.equal(result.redactions, 3);
});

test("final A1 reserves independent IDs and rejects a final ID collision", async () => {
  const folder = await mkdtemp(join(tmpdir(), "m11-final-evidence-"));
  try {
    assert.equal(finalFiles.length, 14);
    assert.equal(new Set([...files, ...finalFiles]).size, 28);
    assert.deepEqual(nextFinalFiles.map(name => name.match(/-(\d{6})\./)?.[1]),
      Array.from({ length: 14 }, (_, index) => String(242 + index).padStart(6, "0")));
    assert.equal(new Set([...files, ...finalFiles, ...nextFinalFiles]).size, 42);
    await checkIds(folder, finalFiles);
    await writeFile(join(folder, finalFiles[0]), "{}");
    await assert.rejects(checkIds(folder, finalFiles), /collision/);
    await checkIds(folder, nextFinalFiles);
    await writeFile(join(folder, nextFinalFiles[0]), "{}");
    await assert.rejects(checkIds(folder, nextFinalFiles), /collision/);
  } finally {
    await rm(folder, { recursive: true });
  }
});

test("baseline A1 manifest accepts later append-only artifacts without changing its hash set", async () => {
  const folder = await mkdtemp(join(tmpdir(), "m11-baseline-manifest-"));
  try {
    const manifestLines = [];
    for (const name of finalFiles.slice(0, 13)) {
      const bytes = name.endsWith(".json")
        ? Buffer.from(JSON.stringify(seal({ artifact: name }), null, 2) + "\n")
        : Buffer.from("fixture capture\n");
      await writeFile(join(folder, name), bytes);
      manifestLines.push(`${sha(bytes)}  ${name}`);
    }
    const backfill = Buffer.from('{"artifact":"integrity-correction-backfill-000145"}\n');
    await writeFile(join(folder, "integrity-correction-backfill-000145.json"), backfill);
    manifestLines.push(`${sha(backfill)}  integrity-correction-backfill-000145.json`);
    await writeFile(join(folder, finalFiles[13]), `${manifestLines.join("\n")}\n`);
    await writeFile(join(folder, priorFinalFiles[0]), "{}\n");

    await verifyEvidence(folder, finalFiles, priorFinalFiles);
    await assert.rejects(verifyEvidence(folder, finalFiles), /Manifest omission/);
  } finally {
    await rm(folder, { recursive: true });
  }
});

test("session identity is removed from published ACP frames", () => {
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  const result = redact(Buffer.from(JSON.stringify({result: {sessionId}})), [sessionId]);
  assert.doesNotMatch(result.bytes.toString(), new RegExp(sessionId));
  assert.equal(result.redactions, 1);
});
