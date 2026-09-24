// Real-process worker for the portal cross-process lock test. Runs in its own
// OS process (spawned via child_process) and hammers a shared accounts.json
// with independent read-modify-write updates through the compiled
// FilePortalRepository. Two of these racing on one file must not lose an update:
// the only thing that can serialize separate processes is the on-disk lock.
//
// Imports the COMPILED build (dist/) because the test toolchain has no TS
// runtime for a child process.
//
// Args: <filePath> <providerIdPrefix> <count> [mode] [rendezvousDir]
//   mode "lock"   (default): perform <count> updates via the production
//                 FilePortalRepository.update (holds the cross-process lock).
//   mode "nolock": negative control. Deterministically reproduces the
//                 last-rename-wins lost update by racing a RAW read-modify-write
//                 (no lock) against a peer, using <rendezvousDir> markers so both
//                 processes read the SAME base before either writes. Proves the
//                 lock — absent here — is what prevents the loss.
import { FilePortalRepository } from "../../dist/core/portals/portal-repository.js";
import { portalConnectionSchema, portalRecordSchema } from "../../dist/core/portals/portal-types.js";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";

const [filePath, prefix, countRaw, mode = "lock", rendezvousDir] = process.argv.slice(2);
const count = Number.parseInt(countRaw, 10);
if (!filePath || !prefix || !Number.isInteger(count)) {
  console.error("usage: portal-writer-process.mjs <filePath> <prefix> <count> [mode] [rendezvousDir]");
  process.exit(2);
}

const record = (providerId) => ({
  connection: portalConnectionSchema.parse({
    providerId,
    siteUrl: "https://race.invalid",
    auth: { kind: "bearer", secretRef: "ACCOUNT_TOKEN" },
  }),
  revision: randomUUID(),
  failures: 0,
});

// Wait until `rendezvousDir` holds at least `expected` files ending in `suffix`.
async function barrier(suffix, expected) {
  await writeFile(join(rendezvousDir, `${prefix}${suffix}`), "");
  for (;;) {
    const present = (await readdir(rendezvousDir)).filter((name) => name.endsWith(suffix)).length;
    if (present >= expected) return;
    await delay(5);
  }
}

try {
  if (mode === "nolock") {
    if (!rendezvousDir) throw new Error("nolock mode needs a rendezvousDir");
    await barrier(".start", 2);           // both processes are running
    const base = await readFile(filePath, "utf8").catch(() => "");
    const records = base ? JSON.parse(base).records : [];
    await barrier(".read", 2);            // both have read the SAME base
    records.push(portalRecordSchema.parse(record(`${prefix}0`)));
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 2, records }) + "\n");
    await rename(temporary, filePath);    // last rename wins → one record lost
    process.exit(0);
  }

  const repository = new FilePortalRepository(filePath);
  for (let index = 0; index < count; index += 1) {
    await repository.update(`${prefix}${index}`, () => record(`${prefix}${index}`));
  }
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
