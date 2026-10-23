import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, seal, sha, checkIds, redact } from "./build-evidence.mjs";

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
    await writeFile(join(folder, "other-000181.json"), "{}");
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
