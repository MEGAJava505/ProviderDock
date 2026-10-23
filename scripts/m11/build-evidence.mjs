import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const files = [
  "authorization-fix-000172.json", "controller-fix-audit-000173.json", "config-fix-000174.json",
  "self-test-linked-000175.json", "preflight-fix-000176.json", "process-tree-fix-000177.json",
  "network-counters-fix-000178.json", "stdout-fix-000179.log", "stderr-fix-000180.log",
  "acp-handshake-fix-000181.json", "run-log-fix-000182.txt", "side-effects-fix-000183.json",
  "summary-fix-000184.json", "integrity-hashes-fix-000185.txt",
];
export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b, "en")).map(key => [key, sorted(value[key])])) : value;
export function canonical(value) {
  const copy = { ...value };
  delete copy.integrityHash;
  return JSON.stringify(sorted(copy), null, 2) + "\n";
}
export function seal(value) {
  return sorted({ ...value, integrityHash: { algorithm: "SHA-256",
    canonicalization: "recursive-key-sort-localeCompare-en-arrays-preserved-pretty2-utf8-lf",
    exclude: ["top-level integrityHash"], value: sha(canonical(value)) } });
}
export async function checkIds(evidence) {
  const reserved = new Set(files.map(name => name.match(/-(\d{6})\./)[1]));
  for (const name of await readdir(evidence)) {
    const id = name.match(/-(\d{6})\./)?.[1];
    if (reserved.has(id)) throw new Error(`Evidence ID collision: ${name}`);
  }
}
export function redact(raw, knownPaths) {
  let text = raw.toString("utf8"), redactions = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, () => { redactions++; return replacement; });
  };
  for (const path of knownPaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    replace(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "<REDACTED_PRIVATE_PATH>");
  }
  replace(/\b[A-Za-z]:[\\/][^\r\n"']+/g, "<REDACTED_ABSOLUTE_PATH>");
  replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>");
  replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<REDACTED_EMAIL>");
  replace(/dock-m11-[a-z0-9-]+/gi, "<REDACTED_ROUTE_ID>");
  replace(/(?:api[_-]?key|token|secret|authorization)\s*[=:]\s*["']?[^\s"',}]+/gi, "<REDACTED_CREDENTIAL_FIELD>");
  if (redactions && !Buffer.from(raw.toString("utf8")).equals(raw)) throw new Error("Redaction requires valid UTF-8 capture");
  return { bytes: redactions ? Buffer.from(text) : raw, redactions };
}

async function verify(evidence) {
  const manifest = await readFile(join(evidence, files[13]), "utf8");
  const covered = new Set();
  for (const line of manifest.trimEnd().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/);
    if (!match || covered.has(match[2])) throw new Error("Malformed or duplicate manifest entry");
    if (sha(await readFile(join(evidence, match[2]))) !== match[1]) throw new Error(`Hash mismatch: ${match[2]}`);
    covered.add(match[2]);
  }
  for (const entry of await readdir(evidence, { withFileTypes: true })) {
    if (entry.isFile() && entry.name !== files[13] && !covered.has(entry.name)) throw new Error(`Manifest omission: ${entry.name}`);
  }
  if (!covered.has("integrity-correction-backfill-000145.json")) throw new Error("Backfill 000145 is not covered");
  for (const name of files.filter(name => name.endsWith(".json"))) {
    const value = JSON.parse(await readFile(join(evidence, name), "utf8"));
    if (value.integrityHash?.value !== sha(canonical(value))) throw new Error(`Internal hash mismatch: ${name}`);
  }
  console.log(JSON.stringify({ status: "PASS", filesCovered: covered.size, manifestSha256: sha(manifest) }));
}

async function build(mode, root, evidence) {
  const json = async name => JSON.parse(await readFile(join(root, "private", name), "utf8"));
  const context = await json("run-context.json"), state = await json("state.json"), preflight = await json("preflight.json");
  const helper = await json("helper-report.json"), owner = await json("owner-authorization.json");
  const common = { project: "ProviderDock/omp-integration/M11", phase: "A1-D-controller-fix",
    runId: context.runId, authorizationRef: files[0], artifactLocations: files, recordedAtUtc: new Date().toISOString() };
  const pending = new Map();
  const put = (index, value) => pending.set(files[index], Buffer.from(JSON.stringify(seal({ ...common,
    evidenceId: `M11-FIX-${files[index].match(/-(\d{6})\./)[1]}`, ...value }), null, 2) + "\n"));
  if (mode === "preflight") {
    await checkIds(evidence);
    if (helper.status !== "PASS" || helper.actualOmpLaunches !== 0 || !helper.scenarios.silent30s || !helper.scenarios.noReaderProductionTimeouts) {
      throw new Error("Full no-OMP helpers have not passed");
    }
    if (!owner.ownerApproved || owner.launchCount !== 1 || owner.retries !== 0 || Date.parse(owner.expiresAtUtc) <= Date.now()) {
      throw new Error("Separate diagnostic authorization is missing or expired");
    }
    put(0, { status: "AUTHORIZED", utcTimeWindow: { start: owner.approvedAtUtc, end: owner.expiresAtUtc },
      scope: "One pinned OMP 18.0.4 diagnostic initialize; inert fixture; no provider, credentials, inference or session/new",
      authorizationBasis: owner.basis, responsible: "gateway-owner-MEGAJava505", operator: "codex-executing-assistant",
      launchCount: 1, retries: 0, providerRequestsPermitted: 0, costLimitUsd: 0,
      stopRules: ["helper failure", "pin mismatch", "ETW loss", "unexpected child or egress", "budget breach", "side effect outside fixture"],
      controllerSha256: context.controllerSha256, sourceHashes: context.sourceHashes,
      configSha256: state.configSha256, modelsSha256: state.modelsSha256 });
    put(1, { status: "HELPERS-PASS", changes: { writer: "All pipe write/FlushFileBuffers operations are on a daemon worker",
      timeouts: "write <=2s; flush <=5s; sticky abandonment; main loop continues polling frames",
      timing: "Monotonic setup, protocol and teardown budgets; independent >=90s watchdog",
      linkage: "Self-test and actual share run context, live sessions and decoded source hashes" },
      sourceHashes: context.sourceHashes, helperReportSha256: sha(await readFile(join(root, "private/helper-report.json"))),
      helperChecks: helper, versions: { python: preflight.pythonVersion, node: process.versions.node } });
    put(2, { status: "CONFIGURED", sessions: context.sessions, budgets: preflight.budgets,
      independentParentWatchdogSeconds: preflight.budgets.parentWatchdogSeconds, providerMetadata: preflight.providerMetadata,
      declaredHelpers: ["conhost.exe"], redirects: { stdout: "OWNED/logs/omp-stdout.raw.log", stderr: "OWNED/logs/omp-stderr.raw.log" },
      wer: { dumpType: 1, dumpFolderAlias: "OWNED/dumps", exactRestoreRequired: true, beforeState: preflight.werBeforeState },
      isolation: { mechanism: "fresh zero-capability AppContainer and kill-on-close Job", activeProcessLimit: 1 },
      protocol: { method: "initialize", framing: "newline-delimited-json", encoding: "utf-8", sessionNew: "not-used; separate A1-F authorization required" } });
  } else {
    for (const name of files.slice(0, 3)) {
      const value = JSON.parse(await readFile(join(evidence, name), "utf8"));
      if (value.runId !== context.runId || value.integrityHash.value !== sha(canonical(value))) throw new Error("Preflight evidence integrity mismatch");
    }
    const actual = await json("actual.json"), etw = await json("etw-summary.json"), nativeTest = await json("selftest.json");
    const result = await json("runner-result.json"), cleanup = await json("profile-cleanup.json");
    const effects = await json("fixture-effects.json");
    if (etw.runId !== context.runId || actual.runId !== context.runId) throw new Error("Run linkage mismatch");
    const known = [root, state.workDirectory, state.pinnedSource, process.env.USERPROFILE];
    const capture = {};
    for (const [name, index] of [["stdout", 7], ["stderr", 8]]) {
      const raw = await readFile(join(root, "logs", `omp-${name}.raw.log`));
      const published = redact(raw, known);
      const original = actual[name + "Capture"];
      if (original.bytes !== raw.length || original.sha256 !== sha(raw)) throw new Error(`${name} capture metadata mismatch`);
      pending.set(files[index], published.bytes);
      capture[name] = { ...original, hashSource: "private original bytes", redactions: published.redactions,
        publishedBytes: published.bytes.length, publishedSha256: sha(published.bytes), artifact: files[index] };
    }
    const sources = etw.etlLoss;
    const live = actual.etwLiveLoss ?? [];
    const zeroSnapshot = snapshot => snapshot.length === 5 && snapshot.every(s => s.queryResult === 0 && s.eventsLost === 0 && s.logBuffersLost === 0 && s.realTimeBuffersLost === 0);
    const lossZero = sources.length === 5 && sources.every(s => s.eventsLost === 0 && s.buffersLost === 0)
      && zeroSnapshot(result.finalEtwLoss) && live.length > 0 && live.every(s => zeroSnapshot(s.sessions));
    put(3, { status: etw.selfTestLinkage.status, native: nativeTest, decodedVerification: etw.selfTestLinkage,
      liveSources: context.sessions.map(s => ({ sessionName: s.name, ...sources.find(h => h.kind === s.kind) })),
      sameSourcesAsActual: true });
    put(4, { status: "OBSERVED", binary: { sha256: state.pinnedSourceSha256, copiedSha256: state.copiedOmpSha256,
      packageVersion: "18.0.4", versionInfo: preflight.binaryVersion, versionInfoMeaning: "PE version is Bun runtime, not OMP package version" },
      environment: { profileIdentitySha256: state.profileIdentitySha256, capabilityCount: 0,
        liveCredentialCount: 0, configSha256: state.configSha256, modelsSha256: state.modelsSha256,
        processAttestation: actual.processAttestation }, elevation: preflight.token,
      selfTestRef: files[3], etwLossAfterSelfTest: preflight.etwLossAfterSelfTest, sourceHashes: context.sourceHashes });
    const orphanCount = result.orphanIdentities?.length ?? null;
    put(5, { status: etw.processTreeComplete && orphanCount === 0 ? "OBSERVED" : "NOT PROVEN", controller: etw.controller,
      processes: etw.processes, scopedIdentities: etw.scopedIdentities, declaredHelpers: ["conhost.exe"],
      orphanCount, orphanCheck: { source: "ETW ProcessStop plus native PID and creation-time check after decode", atUtc: result.orphanCheckAtUtc,
        identities: result.orphanIdentities }, controllerExit: actual.controllerExit, observedControllerExit: result.controllerExitCode, ompExit: actual.ompExit });
    put(6, { status: lossZero ? "OBSERVED" : "NOT PROVEN", counters: etw.networkCounters, events: etw.networkEvents,
      filter: "PID and process lifetime; ambiguous AppId events excluded", excludedNetworkEvents: etw.excludedNetworkEvents,
      sources, liveLossSnapshots: live, finalLiveLoss: result.finalEtwLoss, eventsLostAllZero: lossZero });
    put(9, { status: "OBSERVED", initializeIo: actual.initializeIo, framesSent: actual.framesSent, framesReceived: actual.framesReceived,
      frameBoundaries: actual.frameBoundaries, parseResults: actual.parseResults, requestResponseLinkage: actual.requestResponseLinkage,
      stdout: capture.stdout, stderr: capture.stderr, runtimeHeader: actual.runtimeHeader, watchdog: actual.watchdog,
      initializeResponseReceived: actual.initializeResponseReceived, initializeResponseHasError: actual.initializeResponseHasError,
      protocolEndReason: actual.protocolEndReason, controllerExit: actual.controllerExit, ompExit: actual.ompExit,
      parentWatchdog: result.parentWatchdog,
      sessionNew: { status: "not-used", reason: "diagnostic initialize only; requires separate A1-F acceptance and authorization" },
      timeline: actual.handshakeTimeline });
    pending.set(files[10], Buffer.from([...(result.timeline ?? []), ...actual.handshakeTimeline].sort((a, b) => a.atUtc.localeCompare(b.atUtc))
      .map(e => `${e.atUtc} ${JSON.stringify(e)}`).join("\n") + "\n"));
    const keys = [...new Set([...Object.keys(effects.before ?? {}), ...Object.keys(effects.after ?? {})])].sort();
    const dumps = [];
    for (const entry of await readdir(join(root, "dumps"), { withFileTypes: true })) {
      if (entry.isFile()) {
        const raw = await readFile(join(root, "dumps", entry.name));
        dumps.push({ alias: `OWNED_DUMP_${dumps.length + 1}`, bytes: raw.length, sha256: sha(raw) });
      }
    }
    put(11, { status: cleanup.deleted && result.werRestored ? "OBSERVED" : "NOT PROVEN",
      scope: "owned fixture inventory; no claim of host-wide filesystem observation", profileDeleted: cleanup.deleted,
      werRestored: result.werRestored, dumpMetadata: dumps,
      inventory: keys.map((key, i) => ({ alias: `OWNED_FIXTURE_FILE_${i + 1}`, before: effects.before?.[key] ?? null,
        after: effects.after?.[key] ?? null })), cleanupErrors: result.cleanupErrors });
    const unexpectedChildren = etw.processes.filter(p => !["FRESH_PINNED_OMP_BINARY", "WINDOWS_CONSOLE_HOST"].includes(p.imageAlias));
    const noEgress = ["sentBytes", "receivedBytes", "transportAllowedEvents", "connectAcceptEvents", "dnsEvents"]
      .every(key => etw.networkCounters[key]?.delta === 0);
    const checks = { boundedHelpers: helper.status === "PASS", deadlines: Object.values(actual.timing.deadlineSatisfied).every(v => v === true),
      selfTestLinkage: etw.selfTestLinkage.status === "PASS", eventsLostAllZero: lossZero,
      processTreeComplete: etw.processTreeComplete && etw.processes.every(p => p.exactDevicePathMatched),
      orphanZero: orphanCount === 0, streamsComplete: Object.values(capture).every(c => c.complete && c.eof && !c.error),
      teardownComplete: cleanup.deleted && result.werRestored && result.cleanupErrors.length === 0,
      noUnexpectedChildren: unexpectedChildren.length === 0, noObservedEgress: noEgress,
      exitMapping: actual.exitCode === etw.processes.find(p => p.pid === actual.pid)?.exitCode && result.controllerExitCode === actual.controllerExit.code,
      singleLaunch: actual.actualLaunches === 1 && actual.retries === 0 };
    put(12, { status: Object.values(checks).every(Boolean) ? "OBSERVED" : "NOT PROVEN", a1: "NOT PROVEN", opensA4Gate: false,
      actualLaunches: actual.actualLaunches, retries: actual.retries, checks, ...actual.timing,
      initializeResponseReceived: actual.initializeResponseReceived, initializeResponseHasError: actual.initializeResponseHasError,
      runtimeHeader: actual.runtimeHeader, watchdog: actual.watchdog, controllerExit: actual.controllerExit, ompExit: actual.ompExit,
      rootCause: actual.normalizedCause, underlyingOriginalExitOneCause: "not-established by this observation",
      nextRequirement: "Independent acceptance; separate A1-F authorization only after valid initialize response. No automatic retry.",
      runnerTeardownStartedAtUtc: result.runnerTeardownStartedAtUtc, runnerTeardownEndedAtUtc: result.runnerTeardownEndedAtUtc,
      runnerTeardownMs: result.runnerTeardownMs, parentWatchdog: result.parentWatchdog });
  }
  for (const [name, bytes] of pending) await writeFile(join(evidence, name), bytes, { flag: "wx" });
  if (mode === "final") {
    const lines = [];
    for (const entry of (await readdir(evidence, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.isFile() && entry.name !== files[13]) lines.push(`${sha(await readFile(join(evidence, entry.name)))}  ${entry.name}`);
    }
    if (!lines.some(line => line.endsWith("  integrity-correction-backfill-000145.json"))) throw new Error("Required backfill is missing");
    await writeFile(join(evidence, files[13]), lines.join("\n") + "\n", { flag: "wx" });
    await verify(evidence);
  } else console.log(JSON.stringify({ status: "PASS", filesWritten: pending.size }));
}

async function main() {
  const [mode, owned, target] = process.argv.slice(2);
  const evidence = resolve(target ?? join(dirname(fileURLToPath(import.meta.url)), "../../evidence/m11-pilot/A1-actual-binary"));
  if (mode === "check-ids") return checkIds(evidence);
  if (mode === "verify") return verify(evidence);
  if (!["preflight", "final"].includes(mode) || !owned) throw new Error("Usage: build-evidence.mjs preflight|final OWNED EVIDENCE, or check-ids|verify UNUSED EVIDENCE");
  await build(mode, resolve(owned), evidence);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
