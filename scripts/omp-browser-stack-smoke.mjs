// M10.3-M10.5: browser -> dashboard -> real local OMP launch stack -> fake child -> run store.
// The fake child is intentional: the pinned real OMP binary and OS/network sandbox are out of scope.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderDashboardServer } from "../dist/ui/provider-dashboard-server.js";
import { ProviderDockApplication } from "../dist/application/provider-dock-application.js";
import { ProviderAdapterRegistry } from "../dist/core/providers/provider-adapter-registry.js";
import { MemoryProviderProfileRepository } from "../dist/core/providers/provider-profile-repository.js";
import { ProviderProbeService } from "../dist/core/health/provider-probe-service.js";
import { MemorySecretStore } from "../dist/core/security/secret-store.js";
import { GenericOpenAiAdapter } from "../dist/providers/generic-openai/generic-openai-adapter.js";
import { MemoryProviderHealthRepository, MemoryUsageRepository, providerConfigurationFingerprint } from "../dist/index.js";
import { parseProviderProfile } from "../dist/core/providers/provider-profile.js";
import { providerSecretRevisionFingerprint } from "../dist/core/security/secret-revision.js";
import { OmpRuntime } from "../dist/clients/omp/omp-runtime.js";
import { OmpProcessSupervisor } from "../dist/clients/omp/omp-process-supervisor.js";
import { FileOmpRunRepository } from "../dist/clients/omp/omp-run-repository.js";
import { ompConfigSchemaCommit } from "../dist/clients/omp/omp-config-compiler.js";
import { OmpLaunchService } from "../dist/application/omp-launch-service.js";
import {
  MemoryOmpRouteDecisionSource,
  fingerprintOmpDoctorSnapshot,
  fingerprintOmpProviderProfile,
} from "../dist/migration/omp-route-decisions.js";
import { MemoryOmpProviderLocalSmokeEvidenceSource } from "../dist/migration/omp-provider-evidence.js";

const fakeChild = fileURLToPath(new URL("../tests/support/omp-fake-child.mjs", import.meta.url));
const marker = "m10-browser-loopback-marker-4f91";
const terminalStates = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const faultPhase = process.env.PROVIDERDOCK_OMP_BROWSER_FAULT || "";
if (process.argv.includes("--negative")) {
  await runNegativeCoverage();
  process.exit(0);
}
const root = await mkdtemp(join(tmpdir(), "providerdock-m10-browser-"));
const defaultEvidenceParent = resolve(".scratch");
const requestedEvidenceParent = process.env.PROVIDERDOCK_OMP_BROWSER_EVIDENCE_PARENT
  ? resolve(process.env.PROVIDERDOCK_OMP_BROWSER_EVIDENCE_PARENT) : defaultEvidenceParent;
if (requestedEvidenceParent !== defaultEvidenceParent &&
  (dirname(requestedEvidenceParent) !== defaultEvidenceParent || !basename(requestedEvidenceParent).startsWith("m10-browser-negative-"))) {
  throw new Error("evidence parent must stay under .scratch");
}
const evidenceParent = requestedEvidenceParent;
await mkdir(evidenceParent, { recursive: true });
const evidenceDirectory = await mkdtemp(join(evidenceParent, "m10-browser-stack-evidence-"));
const projectDirectory = join(root, "провайдер dock проект");
const runStoreDirectory = join(root, "run-store");
const controlPath = join(projectDirectory, ".fake-omp-control.json");
const readFixture = join(projectDirectory, "read-fixture.txt");
const sideEffectFile = join(projectDirectory, "side-effect.log");
const screenshots = join(evidenceDirectory, "screenshots");
const evidenceReport = join(evidenceDirectory, "report.json");
const browserExecutable = process.env.PROVIDERDOCK_TEST_BROWSER || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const children = [];
const spawnRecords = [];
const loopbackRequests = [];
const acceptance = { selections: [], latePreflight: [], launches: [], lifecycle: {} };
const browserHttpCapture = `(() => {
  const nativeFetch = window.fetch.bind(window);
  const evidence = window.__m10Http = { responses: [], holdNextPreflight: false, held: false };
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const path = new URL(String(args[0]), location.href).pathname;
    if (/\\/api\\/omp\\//.test(path)) {
      evidence.responses.push({ path: path.slice(path.indexOf('/api/')), status: response.status, body: await response.clone().json() });
      if (path.endsWith('/api/omp/preflight') && evidence.holdNextPreflight) {
        evidence.holdNextPreflight = false;
        await new Promise(resolve => { evidence.release = resolve; evidence.held = true; });
        evidence.held = false;
      }
    }
    return response;
  };
})()`;
let dashboard;
let browser;
let socket;
let browserDirectory;
let currentService;
let currentSupervisor;
let currentRuns;
let loopback;
let smokeResult;
let cdp;
let browserVersion = "unknown";
let primaryError;
let diagnostic;
let cleanupError;
let browserSpawnError;
let cleanupState = { browserProfileRemoved: false, rootRemoved: false };

async function startLoopback() {
  loopback = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (path === "/__m10-network-fault") { request.socket.destroy(); return; }
      const auth = request.headers.authorization;
      const accepted = request.method === "POST" && path === "/v1/chat/completions" &&
        request.headers["content-type"]?.split(";")[0]?.trim() === "application/json" &&
        body.model === "exact-model" && auth === `Bearer ${marker}`;
      loopbackRequests.push({ path, method: request.method, turn: body.turn, readMarker: body.readMarker, accepted, authPresent: Boolean(auth) });
      if (!accepted) {
        response.writeHead(auth !== `Bearer ${marker}` ? 401 : 400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "CONTRACT_REJECTED" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "m10-fixture", choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  await new Promise(resolve => loopback.listen(0, "127.0.0.1", resolve));
  return loopback.address().port;
}

function routeFixture(baseUrl, origin, executableSha256, credentialFingerprint) {
  const profile = parseProviderProfile({
    id: "gateway", displayName: "Gateway", baseUrl, apiType: "openai-chat-completions",
    auth: { kind: "bearer", secretRef: "gateway.key" }, manualModelIds: ["exact-model", "alternate-model"],
  });
  const doctorSnapshot = {
    providerId: "gateway", modelId: "exact-model", protocol: "openai-chat-completions",
    checkedAt: "2026-09-22T20:44:45.061Z", doctorLevel: 3, verdict: "PASS",
    configurationFingerprint: providerConfigurationFingerprint(profile), credentialFingerprint,
    capabilities: {
      text: "SUPPORTED", streaming: "SUPPORTED", tools: "SUPPORTED", parallel_tools: "UNKNOWN",
      reasoning: "UNKNOWN", images: "UNKNOWN", web_search: "UNKNOWN", long_context: "UNKNOWN",
      usage: "UNKNOWN", cancellation: "UNKNOWN", model_discovery: "SUPPORTED",
    }, codexCompatibility: "ADAPTER", claudeCompatibility: "ADAPTER",
  };
  const profileSha = fingerprintOmpProviderProfile(profile);
  const decision = {
    providerId: "gateway", profileSha256: profileSha, accountId: "confirmed-account", baseUrl, origin,
    modelId: "exact-model", protocol: "openai-chat-completions",
    capabilities: { text: "supported", streaming: "supported", tools: "supported" },
    realPilot: { status: "passed", doctorLevel: 3, protocol: "openai-chat-completions", checkedAt: doctorSnapshot.checkedAt, doctorSnapshotSha256: fingerprintOmpDoctorSnapshot(doctorSnapshot) },
    status: "accepted-for-pilot",
    localSmoke: { status: "passed", inventorySha256: "a".repeat(64), smokeReportSha256: "b".repeat(64), executableSha256, sourceCommit: ompConfigSchemaCommit },
  };
  return {
    profile, doctorSnapshot, decision,
    evidence: {
      version: 2, purpose: "verified-loopback-wire-shape-not-real-provider-acceptance",
      inventorySha256: decision.localSmoke.inventorySha256, smokeReportSha256: decision.localSmoke.smokeReportSha256,
      executableSha256, sourceCommit: ompConfigSchemaCommit, launchAuthorized: false,
      providers: [{ providerId: "gateway", profileSha256: profileSha, status: "pending", models: [{ modelId: "exact-model", protocols: [{ protocol: "openai-chat-completions", localSmoke: "passed" }] }], remainingUnresolved: ["ACCOUNT_IDENTITY_REQUIRED"] }],
    },
  };
}

async function makeStack(application, fx, secrets, port, previousRuns, serviceOverrides = {}) {
  const fakeSha = createHash("sha256").update(await readFile(fakeChild)).digest("hex");
  const ambientEnvironment = {
    PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, TEMP: process.env.TEMP, TMP: process.env.TMP,
    OPENAI_API_KEY: "ambient-decoy", HTTPS_PROXY: "http://ambient-decoy.invalid", NODE_OPTIONS: "--require=missing-decoy",
  };
  const runtime = new OmpRuntime({
    rootDirectory: join(root, "managed"), artifact: { executable: fakeChild, sha256: fakeSha, sourceCommit: ompConfigSchemaCommit },
    secretStore: secrets, currentProfileFingerprint: async () => fingerprintOmpProviderProfile(fx.profile), ambientEnvironment,
  });
  const runs = previousRuns ?? new FileOmpRunRepository(runStoreDirectory);
  const spawnFake = (command, args, options) => {
    spawnRecords.push({ cwd: options.cwd, args: [...args] });
    const child = spawn(process.execPath, [command, ...args], options);
    children.push(child);
    return child;
  };
  const supervisor = new OmpProcessSupervisor({ runtime, runs, spawn: spawnFake, initializationTimeoutMs: 15_000, cancelGraceMs: 2_000 });
  const service = new OmpLaunchService({
    application: { listProviders: () => application.listProviders() }, runtime, supervisor,
    routeDecisions: serviceOverrides.routeDecisions ?? new MemoryOmpRouteDecisionSource([fx.decision]),
    evidence: serviceOverrides.evidence ?? new MemoryOmpProviderLocalSmokeEvidenceSource(fx.evidence),
    healthRecords: serviceOverrides.healthRecords ?? { get: async () => ({ providerId: fx.profile.id, diagnostics: [fx.doctorSnapshot], history: [], runtimeSignals: [], surfaceChecks: [] }) },
    credentialFingerprint: profile => providerSecretRevisionFingerprint(profile, secrets),
    artifact: { sha256: fakeSha, sourceCommit: ompConfigSchemaCommit },
  });
  return { service, supervisor, runs };
}

async function startDashboard(application, service) {
  dashboard = new ProviderDashboardServer({ application, ompLauncher: service, healthMonitorIntervalMs: 0 });
  return dashboard.start();
}

function cdpClient(targetSocket, { commandTimeoutMs = 10_000 } = {}) {
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const networkFailures = [];
  const httpFailures = [];
  let terminalError;
  const rejectPending = reason => {
    if (terminalError) return;
    terminalError = reason instanceof Error ? reason : new Error(String(reason));
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(terminalError);
    }
    pending.clear();
  };
  targetSocket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")); }
    catch { rejectPending(new Error("CDP malformed message")); return; }
    if (message.id) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (task) {
        clearTimeout(task.timer);
        message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
      }
    }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails?.text ?? "exception");
    if (message.method === "Network.loadingFailed") networkFailures.push({ errorText: message.params.errorText ?? "network failure", url: message.params.requestId });
    if (message.method === "Network.responseReceived" && Number(message.params.response?.status) >= 400) {
      httpFailures.push({ status: Number(message.params.response.status), url: message.params.response.url });
    }
  });
  targetSocket.addEventListener("close", () => rejectPending(new Error("CDP socket closed")), { once: true });
  targetSocket.addEventListener("error", () => rejectPending(new Error("CDP socket error")), { once: true });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (terminalError) { reject(terminalError); return; }
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`CDP timeout: ${method}`));
    }, commandTimeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    try { targetSocket.send(JSON.stringify({ id: requestId, method, params })); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    }
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "browser evaluation failed");
    return result.result?.value;
  };
  return { call, evaluate, exceptions, networkFailures, httpFailures, close: () => rejectPending(new Error("CDP client closed")) };
}

async function waitFor(evaluate, expression, label, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`browser timeout: ${label}`);
}

async function openOmp(evaluate, { accountId = "confirmed-account", expectedPreview = "READY" } = {}) {
  await evaluate("document.querySelector('.provider-card .pc-actions button:nth-child(2)').click()");
  await waitFor(evaluate, "document.getElementById('launch-dialog').open", "OMP dialog open");
  await evaluate("document.getElementById('launch-provider').value='gateway';document.getElementById('launch-provider').dispatchEvent(new Event('change'))");
  await evaluate(`document.getElementById('launch-client').value='omp';document.getElementById('launch-client').dispatchEvent(new Event('change'));document.getElementById('launch-project').value=${JSON.stringify(projectDirectory)};document.getElementById('launch-project').dispatchEvent(new Event('input'));document.getElementById('launch-omp-account').value=${JSON.stringify(accountId)};document.getElementById('launch-omp-account').dispatchEvent(new Event('input'));document.getElementById('launch-model').value='exact-model';document.getElementById('launch-model').dispatchEvent(new Event('change'))`);
  await waitFor(evaluate, `document.getElementById('omp-preview').textContent.includes(${JSON.stringify(expectedPreview)})`, `${expectedPreview.toLowerCase()} route preview`);
}

async function previewEvidence(verdict) {
  const view = await cdp.evaluate(`(()=>{const root=document.getElementById('omp-preview');return {text:root.textContent,tier:root.querySelector('.omp-preview-tier')?.textContent||'',nodes:[...root.querySelectorAll('.omp-node')].map(row=>row.textContent)}})()`);
  assert.ok(view.text.includes(verdict.toUpperCase()), `${verdict}: visible verdict`);
  assert.equal(view.nodes.length, 7, `${verdict}: all route nodes visible`);
  assert.equal(/пилот (?:пройден|подтверждён)|production-ready|готово к production/i.test(view.text), false, `${verdict}: no false completed-pilot label`);
  return view;
}

async function verifyPreviewStates(application, fx, secrets, regularStack) {
  await openOmp(cdp.evaluate);
  acceptance.previews = { ready: await previewEvidence("ready") };
  await screenshot(cdp, "ready-preview");
  const beforeBlocked = await counters();
  await cdp.evaluate("document.getElementById('launch-omp-account').value='other-account';document.getElementById('launch-omp-account').dispatchEvent(new Event('input'))");
  await waitFor(cdp.evaluate, "document.getElementById('omp-preview').textContent.includes('BLOCKED')", "blocked route preview");
  acceptance.previews.blocked = await previewEvidence("blocked");
  assert.ok(acceptance.previews.blocked.nodes.some(text => text.includes('Аккаунт') && text.includes('аккаунт не совпадает с решением') && text.includes('заблокировано')), "blocked: account reason localized");
  assert.equal(await cdp.evaluate("document.getElementById('launch-submit').disabled"), true);
  assert.deepEqual(await counters(), beforeBlocked, "blocked preview has no launch side effects");
  await screenshot(cdp, "blocked-preview");
  await cdp.evaluate("document.getElementById('launch-dialog').close()");

  await dashboard.stop();
  const unknownStack = await makeStack(application, fx, secrets, undefined, regularStack.runs, {
    evidence: { get: async () => undefined },
    healthRecords: { get: async () => undefined },
  });
  let unknownAddress = await startDashboard(application, unknownStack.service);
  await navigate(cdp, unknownAddress.url, "unknown preview navigation");
  await waitFor(cdp.evaluate, "document.querySelectorAll('.provider-card').length===2", "provider cards for unknown preview");
  const beforeUnknown = await counters();
  await openOmp(cdp.evaluate, { expectedPreview: "UNKNOWN" });
  acceptance.previews.unknown = await previewEvidence("unknown");
  assert.ok(acceptance.previews.unknown.nodes.some(text => text.includes('Доказательство') && text.includes('нет данных')), "unknown: missing evidence reason localized");
  assert.equal(await cdp.evaluate("document.getElementById('launch-submit').disabled"), true);
  assert.deepEqual(await counters(), beforeUnknown, "unknown preview has no launch side effects");
  await screenshot(cdp, "unknown-preview");
  await cdp.evaluate("document.getElementById('launch-dialog').close()");

  await dashboard.stop();
  const restoredAddress = await startDashboard(application, regularStack.service);
  await navigate(cdp, restoredAddress.url, "ready stack restore navigation");
  await waitFor(cdp.evaluate, "document.querySelectorAll('.provider-card').length===2", "provider cards after preview-state checks");
  return restoredAddress;
}

async function acknowledgeAndPreflight(evaluate) {
  await evaluate("document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await waitFor(evaluate, "document.getElementById('omp-preflight-status').textContent.includes('OMP preflight passed')", "successful preflight");
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"), false);
}

async function launchFromUi(evaluate, label) {
  await evaluate("document.getElementById('launch-status').textContent=''");
  await evaluate("document.getElementById('launch-submit').click()");
  await waitFor(evaluate, "document.getElementById('launch-status').textContent.includes('ID ')", `${label} launch result`);
  const status = await evaluate("document.getElementById('launch-status').textContent");
  const runId = /ID ([0-9a-f-]{36})/i.exec(status)?.[1];
  assert.ok(runId, `${label} launch did not expose run id`);
  const reply = await evaluate(`window.__m10Http.responses.find(item=>item.path==='/api/omp/launch'&&item.body.result?.runId===${JSON.stringify(runId)})`);
  assert.equal(reply?.status, 202, `${label} actual launch HTTP reply`);
  assert.equal(reply.body.result.ok, true);
  acceptance.launches.push({ label, http: reply });
  return runId;
}

async function counters() {
  return { spawns: spawnRecords.length, requests: loopbackRequests.length, records: (await currentRuns.list()).length };
}

async function assertDeniedWithoutEffects(label) {
  const before = await counters();
  assert.equal(await cdp.evaluate("document.getElementById('launch-submit').disabled"), true, `${label}: launch disabled`);
  await cdp.evaluate("document.getElementById('launch-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))");
  await waitFor(cdp.evaluate, "document.getElementById('launch-status').textContent.includes('Сначала выполните')", `${label}: denied submit`);
  assert.deepEqual(await counters(), before, `${label}: no launch side effects`);
  return before;
}

async function verifySelections() {
  const variants = [
    { field: "provider", id: "launch-provider", event: "change", value: "alternate-provider" },
    { field: "account", id: "launch-omp-account", event: "input", value: "other-account" },
    { field: "model", id: "launch-model", event: "change", value: "alternate-model" },
    { field: "project", id: "launch-project", event: "input", value: join(root, "другой проект") },
  ];
  for (const variant of variants) {
    await openOmp(cdp.evaluate);
    await acknowledgeAndPreflight(cdp.evaluate);
    await cdp.evaluate("document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'))");
    assert.equal(await cdp.evaluate("document.getElementById('launch-omp-acknowledgement').checked"), true, `${variant.field}: checkbox remains checked on its own change`);
    assert.equal(await cdp.evaluate("document.getElementById('omp-preflight-status').textContent.includes('OMP preflight passed')"), true, `${variant.field}: checkbox change preserves preflight`);
    assert.equal(await cdp.evaluate("document.getElementById('launch-submit').disabled"), false, `${variant.field}: checkbox change preserves launch gate`);
    await cdp.evaluate(`document.getElementById(${JSON.stringify(variant.id)}).value=${JSON.stringify(variant.value)};document.getElementById(${JSON.stringify(variant.id)}).dispatchEvent(new Event(${JSON.stringify(variant.event)}))`);
    assert.equal(await cdp.evaluate("document.getElementById('launch-omp-acknowledgement').checked"), false, `${variant.field}: acknowledgement revoked`);
    assert.equal(await cdp.evaluate("document.getElementById('omp-preflight-status').textContent"), "", `${variant.field}: preflight revoked`);
    const counts = await assertDeniedWithoutEffects(variant.field);
    await cdp.evaluate("document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'))");
    assert.equal(await cdp.evaluate("document.getElementById('launch-omp-acknowledgement').checked"), true, `${variant.field}: checkbox preserves new acknowledgement`);
    await assertDeniedWithoutEffects(`${variant.field}: acknowledgement alone`);
    acceptance.selections.push({ field: variant.field, counts, acknowledgementRevoked: true, preflightRevoked: true });
  }
}

async function verifyLatePreflight() {
  for (const action of ["selection", "reopen"]) {
    await openOmp(cdp.evaluate);
    await cdp.evaluate("window.__m10Http.holdNextPreflight=true;document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
    await waitFor(cdp.evaluate, "window.__m10Http.held", `${action}: real preflight response held`);
    if (action === "selection") {
      await cdp.evaluate("document.getElementById('launch-omp-account').value='other-account';document.getElementById('launch-omp-account').dispatchEvent(new Event('input'));document.getElementById('launch-omp-account').value='confirmed-account';document.getElementById('launch-omp-account').dispatchEvent(new Event('input'))");
      await waitFor(cdp.evaluate, "document.getElementById('omp-preview').textContent.includes('READY')", "restored selection preview");
    } else {
      await cdp.evaluate("document.getElementById('launch-dialog').close()");
      await openOmp(cdp.evaluate);
    }
    await cdp.evaluate("document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));window.__m10Http.release()");
    await waitFor(cdp.evaluate, "!window.__m10Http.held&&!document.getElementById('launch-omp-preflight').disabled", `${action}: old handler settled`);
    assert.equal(await cdp.evaluate("document.getElementById('launch-submit').disabled"), true, `${action}: late preflight must not restore launch`);
    assert.equal(await cdp.evaluate("document.getElementById('omp-preflight-status').textContent.includes('OMP preflight passed')"), false, `${action}: no stale success label`);
    const counts = await assertDeniedWithoutEffects(`late preflight ${action}`);
    acceptance.latePreflight.push({ action, denied: true, counts });
  }
}

async function waitStoreTerminal(runId) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const record = await currentRuns.get(runId);
    if (record && terminalStates.has(record.state)) return record;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} did not become terminal`);
}

async function screenshot(cdp, name) {
  const result = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(screenshots, `${name}.png`), Buffer.from(result.data, "base64"));
}

async function waitForFile(path, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await lstat(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error(`missing evidence: ${label}`);
}

async function fetchWithDeadline(url, label, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timeout`)), timeoutMs);
  try { return await fetch(url, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function jsonWithDeadline(response, label, timeoutMs = 2_000) {
  let timer;
  try {
    return await Promise.race([
      response.json(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} body timeout`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function withDeadline(task, label, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function waitForDebugPort(directory, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (browserSpawnError) throw new Error(`fixture-fault:spawn: ${browserSpawnError.code ?? browserSpawnError.message}`);
    try { return (await readFile(join(directory, "DevToolsActivePort"), "utf8")).split(/\r?\n/)[0]; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error("browser debugging port timeout");
}

async function discoverPageTarget(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchWithDeadline(`http://127.0.0.1:${port}/json`, "CDP target discovery", 2_000);
      if (response.status === 200) {
        const targets = await jsonWithDeadline(response, "CDP target discovery");
        const pageTarget = targets.find(target => target.type === "page");
        if (pageTarget?.webSocketDebuggerUrl) return pageTarget;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("CDP page target timeout");
}

async function openWebSocket(url, label, timeoutMs = 10_000) {
  const target = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.close();
      reject(new Error(`${label} timeout`));
    }, timeoutMs);
    target.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    target.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`${label} failed`)); }, { once: true });
  });
  return target;
}

async function closeChild(child, label, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) {
    await Promise.race([
      new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} spawn/exit timeout`)), timeoutMs)),
    ]).catch(error => { if (child.exitCode === null && child.signalCode === null) throw error; });
    return;
  }
  let exitTimer;
  const exited = new Promise((resolveExit, rejectExit) => {
    exitTimer = setTimeout(() => rejectExit(new Error(`${label} exit timeout`)), timeoutMs);
    child.once("exit", () => { clearTimeout(exitTimer); resolveExit(); });
  });
  if (process.platform === "win32" && child.pid) {
    const treeScript = `$root=${Number(child.pid)}; $all=@(Get-CimInstance Win32_Process); $front=@($root); $ids=@(); while($front.Count -gt 0){ $kids=@($all | Where-Object { $front -contains $_.ParentProcessId }); $ids += $front; $front=@($kids.ProcessId | Where-Object { $_ -and ($ids -notcontains $_) } | Sort-Object -Unique) }; [array]::Reverse($ids); foreach($id in $ids){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`;
    const treeKiller = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", treeScript], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { treeKiller.kill(); } catch {} reject(new Error(`${label} process-tree timeout`)); }, timeoutMs);
      treeKiller.once("error", error => { clearTimeout(timer); reject(error); });
      treeKiller.once("exit", code => { clearTimeout(timer); if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve(); else reject(new Error(`${label} process-tree exit ${code}`)); });
    });
    if (child.exitCode === null && child.signalCode === null) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { try { killer.kill(); } catch {} reject(new Error(`${label} taskkill timeout`)); }, timeoutMs);
        killer.once("error", error => { clearTimeout(timer); reject(error); });
        killer.once("exit", code => { clearTimeout(timer); if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve(); else reject(new Error(`${label} taskkill exit ${code}`)); });
      });
    }
  } else {
    child.kill("SIGKILL");
  }
  await exited;
}

async function removeOwnedDirectory(directory, parent, prefix, injectFailure = false) {
  const resolvedParent = resolve(parent);
  const resolvedDirectory = resolve(directory);
  if (dirname(resolvedDirectory) !== resolvedParent || !basename(resolvedDirectory).startsWith(prefix)) {
    throw new Error(`refusing cleanup outside owned directory: ${resolvedDirectory}`);
  }
  const item = await lstat(resolvedDirectory);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error(`owned cleanup target invalid: ${resolvedDirectory}`);
  if (injectFailure) throw new Error("fixture-fault:cleanup");
  await rm(resolvedDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

async function pathMissing(path) {
  try { await lstat(path); return false; } catch (error) { if (error?.code === "ENOENT") return true; throw error; }
}

async function verifyCdpCloseFault() {
  for (const event of ["close", "error"]) {
    const faultSocket = new EventTarget();
    faultSocket.readyState = WebSocket.OPEN;
    faultSocket.send = () => undefined;
    const fault = cdpClient(faultSocket, { commandTimeoutMs: 1_000 });
    const pending = fault.call("Runtime.evaluate");
    faultSocket.dispatchEvent(new Event(event));
    await assert.rejects(pending, new RegExp(`CDP socket ${event === "close" ? "closed" : "error"}`));
  }
}

async function navigate(cdp, url, label) {
  const result = await cdp.call("Page.navigate", { url });
  if (result.errorText) throw new Error(`${label}: fixture-fault:unexpected-network: ${result.errorText}`);
}

function detectBrowserVersion(executable) {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:PROVIDERDOCK_BROWSER_EXE).VersionInfo.ProductVersion"], {
        windowsHide: true, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, PROVIDERDOCK_BROWSER_EXE: executable },
      }).trim();
    }
    return execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim();
  } catch { return "unknown"; }
}

try {
  const port = await startLoopback();
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const origin = `http://127.0.0.1:${port}`;
  const secrets = new MemorySecretStore({ "gateway.key": marker });
  const fakeSha = createHash("sha256").update(await readFile(fakeChild)).digest("hex");
  const credentialFingerprint = await providerSecretRevisionFingerprint({ auth: { kind: "bearer", secretRef: "gateway.key" }, secretHeaders: {} }, secrets);
  assert.ok(credentialFingerprint);
  const fx = routeFixture(baseUrl, origin, fakeSha, credentialFingerprint);
  const healthRecords = new MemoryProviderHealthRepository();
  const usageRecords = new MemoryUsageRepository();
  const application = new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry().register(new GenericOpenAiAdapter({ secretStore: secrets, fetchImpl: async () => Response.json({ data: [] }) }))),
    secrets, undefined, undefined, undefined, undefined, undefined, undefined, undefined, healthRecords, usageRecords,
  );
  application.listAgentSessions = async () => [];
  await application.setProvider(fx.profile);
  await application.setProvider(parseProviderProfile({ ...fx.profile, id: "alternate-provider", displayName: "Alternate provider" }));
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(screenshots, { recursive: true });
  await writeFile(join(root, "README.txt"), "selected-project");
  await writeFile(join(projectDirectory, "read-fixture.txt"), "m10-real-fixture-bytes", "utf8");
  await writeFile(controlPath, JSON.stringify({ scenario: "happy", readFixture }), "utf8");
  const previewRouteSource = {
    list: async () => [fx.decision],
    get: async () => structuredClone(fx.decision),
  };
  const first = await makeStack(application, fx, secrets, undefined, undefined, { routeDecisions: previewRouteSource });
  currentService = first.service; currentSupervisor = first.supervisor; currentRuns = first.runs;
  const initialRuns = currentRuns;
  let address = await startDashboard(application, currentService);

  browserDirectory = await mkdtemp(join(root, "browser-"));
  const launchedBrowser = faultPhase === "spawn" ? join(root, "missing-browser.exe") : browserExecutable;
  browser = spawn(launchedBrowser, ["--headless=new", "--disable-gpu", "--disable-software-rasterizer", "--disable-cache", "--disk-cache-size=1", "--media-cache-size=1", "--disable-application-cache", "--disable-component-update", "--disable-background-networking", "--disable-crash-reporter", "--disable-breakpad", "--disable-features=NoVarySearch,OptimizationHints,Translate,MediaRouter", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${browserDirectory}`, "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  browser.once("error", error => {
    browserSpawnError ??= error;
    primaryError ??= faultPhase === "spawn"
      ? new Error(`fixture-fault:spawn: ${error.code ?? error.message}`)
      : error;
  });
  browserVersion = detectBrowserVersion(browserExecutable);
  const activePort = await waitForDebugPort(browserDirectory);
  const pageTarget = await discoverPageTarget(activePort);
  socket = await openWebSocket(pageTarget.webSocketDebuggerUrl, "CDP connection");
  cdp = cdpClient(socket);
  await cdp.call("Runtime.enable"); await cdp.call("Network.enable"); await cdp.call("Page.enable"); await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: browserHttpCapture });
  if (faultPhase === "cdp-close") {
    await verifyCdpCloseFault();
    throw new Error("fixture-fault:cdp-close");
  }
  if (faultPhase === "network") {
    await navigate(cdp, `http://127.0.0.1:${port}/__m10-network-fault`, "network fault navigation");
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assertUnexpectedBrowserFailures();
  }
  await navigate(cdp, address.url, "dashboard navigation");
  await waitFor(cdp.evaluate, "document.querySelectorAll('.provider-card').length===2", "provider cards");
  address = await verifyPreviewStates(application, fx, secrets, first);
  await verifySelections();
  await verifyLatePreflight();
  await openOmp(cdp.evaluate);
  assert.equal(await cdp.evaluate("document.getElementById('launch-submit').disabled"), true, "acknowledgement gates launch");
  const beforeRuns = await currentService.listRuns();
  await acknowledgeAndPreflight(cdp.evaluate);
  await screenshot(cdp, "ready-preflight");
  const happyRunId = await launchFromUi(cdp.evaluate, "happy");
  const happy = await waitStoreTerminal(happyRunId);
  assert.equal(happy.state, "SUCCEEDED");
  assert.equal(spawnRecords.at(-1)?.cwd, projectDirectory);
  const expectedMarker = createHash("sha256").update("m10-real-fixture-bytes").digest("hex").slice(0, 16);
  assert.ok(loopbackRequests.some(request => request.accepted && request.turn === "tool" && request.readMarker === expectedMarker));
  assert.ok((await currentService.listRuns()).some(run => run.runId === happyRunId));
  await waitFor(cdp.evaluate, `document.querySelector('#omp-runs .omp-run-row[data-run-id="${happyRunId}"]')?.dataset.state==='SUCCEEDED'`, "happy run in UI");
  assert.equal(beforeRuns.length, 0);

  // Evidence is selection-bound: a project change revokes acknowledgement and preflight before spawn.
  await cdp.evaluate(`document.getElementById('launch-project').value=${JSON.stringify(join(root, "другой проект"))};document.getElementById('launch-project').dispatchEvent(new Event('input'))`);
  assert.equal(await cdp.evaluate("document.getElementById('launch-omp-acknowledgement').checked"), false);
  assert.equal(await cdp.evaluate("document.getElementById('launch-submit').disabled"), true);

  // One post-launch side effect followed by failure: no automatic retry/fallback is allowed.
  await writeFile(controlPath, JSON.stringify({ scenario: "tool-side-effect-then-error", sideEffectFile }), "utf8");
  await openOmp(cdp.evaluate); await acknowledgeAndPreflight(cdp.evaluate);
  const failedRunId = await launchFromUi(cdp.evaluate, "side-effect failure");
  const failed = await waitStoreTerminal(failedRunId);
  assert.equal(failed.state, "FAILED");
  assert.equal((await readFile(sideEffectFile, "utf8")).split(/\r?\n/).filter(Boolean).length, 1);
  await waitFor(cdp.evaluate, `document.querySelector('#omp-runs .omp-run-row[data-run-id="${failedRunId}"]')?.dataset.state==='FAILED'`, "failed run in UI");
  assert.equal(loopbackRequests.filter(request => request.turn === "tool").length, 2);

  // Restart the server and supervisor over the same FileOmpRunRepository; terminal records persist.
  await dashboard.stop();
  const restarted = await makeStack(application, fx, secrets, port);
  currentService = restarted.service; currentSupervisor = restarted.supervisor; currentRuns = restarted.runs;
  assert.notEqual(currentRuns, initialRuns, "restart uses a new repository instance");
  address = await startDashboard(application, currentService);
  await navigate(cdp, address.url, "dashboard restart navigation");
  await waitFor(cdp.evaluate, "document.querySelectorAll('.provider-card').length===2", "provider cards after restart");
  await waitFor(cdp.evaluate, `document.querySelector('#omp-runs .omp-run-row[data-run-id="${happyRunId}"]')?.dataset.state==='SUCCEEDED'`, "persisted happy record after restart");
  await waitFor(cdp.evaluate, `document.querySelector('#omp-runs .omp-run-row[data-run-id="${failedRunId}"]')?.dataset.state==='FAILED'`, "persisted failed record after restart");
  assert.equal((await readFile(sideEffectFile, "utf8")).split(/\r?\n/).filter(Boolean).length, 1);

  // Browser cancellation through the real dashboard. The child never self-terminates until supervisor cancel.
  await writeFile(controlPath, JSON.stringify({ scenario: "wait-for-cancel" }), "utf8");
  await openOmp(cdp.evaluate); await acknowledgeAndPreflight(cdp.evaluate);
  const cancelledRunId = await launchFromUi(cdp.evaluate, "cancel");
  // TUI launches use stdio:"inherit" and never receive an RPC ready/get_state round-trip, so the
  // supervisor's documented contract caps them at TERMINAL_OPEN, not RUNNING (see
  // docs/omp-runtime-runbook-ru.md "Контракт supervisора процесса" and
  // omp-process-supervisor.ts:467, where only the RPC branch transitions to RUNNING). Waiting for
  // RUNNING here would time out on every real dashboard-originated (TUI) launch.
  await waitFor(cdp.evaluate, `document.querySelector('#omp-runs .omp-run-row[data-run-id="${cancelledRunId}"]')?.dataset.state==='TERMINAL_OPEN'`, "live run in UI");
  await cdp.evaluate("window.confirm=()=>true;document.querySelector('.omp-run-row[data-state=TERMINAL_OPEN] button').click()");
  await waitFor(cdp.evaluate, `document.querySelector('#omp-runs .omp-run-row[data-run-id="${cancelledRunId}"]')?.dataset.state==='CANCELLED'`, "cancelled run in UI");
  assert.equal((await currentRuns.get(cancelledRunId)).state, "CANCELLED");
  const cancelReply = await cdp.evaluate(`window.__m10Http.responses.find(item=>item.path.endsWith('/api/omp/runs/${cancelledRunId}/cancel'))`);
  assert.equal(cancelReply?.status, 200);
  assert.equal(cancelReply.body.run.state, "CANCELLED");
  const terminalCounts = await counters();
  await cdp.evaluate(`fetch('api/omp/runs/${cancelledRunId}/cancel',{method:'POST'}).then(response=>response.json())`);
  assert.deepEqual(await counters(), terminalCounts, "repeat terminal cancel has no launch/request/store-count side effects");
  assert.equal((await currentRuns.get(cancelledRunId)).transitions.length, cancelReply.body.run.transitions.length, "repeat terminal cancel adds no transition");
  acceptance.lifecycle.cancel = { httpState: cancelReply.body.run.state, diskState: (await currentRuns.get(cancelledRunId)).state, terminalCounts };
  acceptance.lifecycle.sideEffect = { afterFailure: 1, afterRestart: (await readFile(sideEffectFile, "utf8")).split(/\r?\n/).filter(Boolean).length };
  await screenshot(cdp, "cancelled");
  assert.ok(loopbackRequests.every(request => request.accepted));
  assertUnexpectedBrowserFailures();
  await verifyCdpCloseFault();
  smokeResult = { ok: true, checks: ["real dashboard stack", "preflight acknowledgement gate", "selection-bound stale evidence", "run id HTTP/store/UI", "fake-child cwd", "read-marker fixture bytes", "side-effect failure without retry", "restart preserves terminal records", "browser cancel", "browser exceptions", "browser network and HTTP failures", "CDP close rejects pending command"], runs: { happyRunId, failedRunId, cancelledRunId }, evidence: { directory: evidenceDirectory, screenshots, report: evidenceReport }, browser: { executable: browserExecutable, version: browserVersion } };
} catch (error) {
  primaryError ??= error;
  console.error(error);
  if (cdp) {
    try {
      diagnostic = {
        browserLaunchStatus: await cdp.evaluate("document.getElementById('launch-status')?.textContent"),
        browserRuns: await cdp.evaluate("[...document.querySelectorAll('.omp-run-row')].map(row => ({ runId: row.dataset.runId, state: row.dataset.state, text: row.textContent }))"),
        storeRuns: await currentRuns?.list(),
        spawnRecords,
        loopbackRequests,
        browserExceptions: cdp.exceptions,
        browserNetworkFailures: cdp.networkFailures,
        browserHttpFailures: cdp.httpFailures.map(({ status, url }) => ({ status, path: new URL(url).pathname.replace(/^\/[a-f0-9]{32,128}/, "/<session>") })),
      };
      console.error(JSON.stringify(diagnostic));
    } catch (diagnosticError) {
      console.error(`M10 browser diagnostic failed: ${diagnosticError?.message ?? diagnosticError}`);
    }
  }
  process.exitCode = 1;
} finally {
  try { cdp?.close(); } catch (error) { cleanupError ??= error; }
  try { socket?.close(); } catch (error) { cleanupError ??= error; }
  try { await closeChild(browser, "browser"); } catch (error) { cleanupError ??= error; }
  for (const child of children) {
    try { await closeChild(child, "fake child"); } catch (error) { cleanupError ??= error; }
  }
  try { await withDeadline(dashboard?.stop(), "dashboard stop"); } catch (error) { cleanupError ??= error; }
  try {
    if (loopback) await withDeadline(new Promise((resolve, reject) => loopback.close(error => error ? reject(error) : resolve())), "loopback stop");
  } catch (error) { cleanupError ??= error; }
  try {
    if (browserDirectory) {
      await withDeadline(removeOwnedDirectory(browserDirectory, root, "browser-"), "browser profile cleanup");
      cleanupState.browserProfileRemoved = await pathMissing(browserDirectory);
      if (!cleanupState.browserProfileRemoved) throw new Error("browser profile remained after cleanup");
    }
  } catch (error) { cleanupError ??= error; }
  if (faultPhase === "cleanup") {
    try { await removeOwnedDirectory(root, tmpdir(), "providerdock-m10-browser-", true); }
    catch (error) {
      cleanupError ??= error;
      try { await withDeadline(removeOwnedDirectory(root, tmpdir(), "providerdock-m10-browser-"), "root cleanup fallback"); } catch (fallbackError) { cleanupError = new AggregateError([cleanupError, fallbackError], "mandatory cleanup and fallback failed"); }
    }
  } else {
    try { await withDeadline(removeOwnedDirectory(root, tmpdir(), "providerdock-m10-browser-"), "root cleanup"); } catch (error) { cleanupError ??= error; }
  }
  try { cleanupState.rootRemoved = await pathMissing(root); if (!cleanupState.rootRemoved) throw new Error("owned root remained after cleanup"); } catch (error) { cleanupError ??= error; }
  const report = {
    ok: Boolean(smokeResult?.ok) && !primaryError && !cleanupError,
    result: primaryError || cleanupError ? undefined : smokeResult,
    error: primaryError ? { name: primaryError.constructor?.name ?? "Error", message: primaryError.message ?? String(primaryError) } : undefined,
    cleanupError: cleanupError ? { name: cleanupError.constructor?.name ?? "Error", message: cleanupError.message ?? String(cleanupError) } : undefined,
    cleanup: cleanupState,
    diagnostic,
    acceptance,
  };
  try {
    await writeFile(evidenceReport, JSON.stringify(report, null, 2) + "\n", "utf8");
    await waitForFile(evidenceReport, "structural report");
    if (smokeResult) {
      for (const name of ["ready-preview.png", "blocked-preview.png", "unknown-preview.png", "ready-preflight.png", "cancelled.png"]) await waitForFile(join(screenshots, name), name);
    }
  } catch (error) { cleanupError ??= error; }
  if (primaryError || cleanupError) process.exitCode = 1;
  if (cleanupError) console.error(`M10 browser fixture cleanup failed: ${cleanupError?.code ?? cleanupError?.name ?? "unknown"} ${cleanupError?.message ?? ""}`.trim());
}
if (process.exitCode !== 1 && smokeResult) console.log(JSON.stringify(smokeResult));

function assertUnexpectedBrowserFailures() {
  assert.deepEqual(cdp.exceptions, [], "unexpected browser JS exceptions");
  if (cdp.networkFailures.length > 0) throw new Error(`fixture-fault:unexpected-network: ${cdp.networkFailures[0].errorText}`);
  const unexpectedHttpFailures = cdp.httpFailures.filter(({ status, url }) => !(status === 404 && new URL(url).pathname === "/favicon.ico"));
  if (unexpectedHttpFailures.length > 0) throw new Error(`unexpected browser HTTP failure: ${unexpectedHttpFailures[0].status} ${new URL(unexpectedHttpFailures[0].url).pathname}`);
}

async function runNegativeCoverage() {
  const scriptPath = fileURLToPath(import.meta.url);
  const phases = ["spawn", "cdp-close", "network", "cleanup"];
  const results = [];
  for (const phase of phases) {
    const startedAt = Date.now();
    const faultEvidenceParent = await mkdtemp(join(resolve(".scratch"), `m10-browser-negative-${phase}-`));
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, PROVIDERDOCK_OMP_BROWSER_FAULT: phase, PROVIDERDOCK_OMP_BROWSER_EVIDENCE_PARENT: faultEvidenceParent },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data.toString(); });
    child.stderr.on("data", data => { stderr += data.toString(); });
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ timedOut: true, exitCode: null }), 60_000);
      child.once("error", error => { clearTimeout(timer); resolve({ timedOut: false, exitCode: null, error }); });
      child.once("exit", exitCode => { clearTimeout(timer); resolve({ timedOut: false, exitCode }); });
    });
    if (outcome.timedOut) {
      try { await closeChild(child, `negative ${phase}`, 10_000); } catch {}
      throw new Error(`negative fault child timed out: ${phase}`);
    }
    assert.equal(outcome.exitCode, 1, `negative ${phase} must exit 1`);
    assert.equal(stdout.includes('"ok":true'), false, `negative ${phase} must not print ok:true`);
    const combined = stdout + "\n" + stderr;
    assert.ok(combined.includes(`fixture-fault:${phase === "network" ? "unexpected-network" : phase}`), `negative ${phase} must preserve its fixture cause`);
    const entries = (await readdir(faultEvidenceParent, { withFileTypes: true })).filter(entry => entry.isDirectory());
    assert.equal(entries.length, 1, `negative ${phase} must preserve one structural evidence directory`);
    const evidenceDirectory = join(faultEvidenceParent, entries[0].name);
    const report = JSON.parse(await readFile(join(evidenceDirectory, "report.json"), "utf8"));
    assert.equal(report.ok, false, `negative ${phase} report must not claim success`);
    assert.equal(report.result, undefined, `negative ${phase} report must not retain nested success`);
    assert.equal(report.cleanup?.rootRemoved, true, `negative ${phase} owned root must be removed`);
    if (phase === "cleanup") assert.match(report.cleanupError?.message ?? "", /fixture-fault:cleanup/);
    else assert.match(report.error?.message ?? "", new RegExp(`fixture-fault:${phase === "network" ? "unexpected-network" : phase}`));
    results.push({ phase, exitCode: outcome.exitCode, elapsedMs: Date.now() - startedAt, evidenceDirectory });
  }
  console.log(JSON.stringify({ ok: true, negative: results }));
}
