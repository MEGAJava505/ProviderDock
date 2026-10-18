// Run after npm run build. Isolated in-memory fixtures, no provider calls or user browser profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProviderDashboardServer } from '../dist/ui/provider-dashboard-server.js';
import { ProviderDockApplication } from '../dist/application/provider-dock-application.js';
import { ProviderAdapterRegistry } from '../dist/core/providers/provider-adapter-registry.js';
import { MemoryProviderProfileRepository } from '../dist/core/providers/provider-profile-repository.js';
import { ProviderProbeService } from '../dist/core/health/provider-probe-service.js';
import { MemorySecretStore } from '../dist/core/security/secret-store.js';
import { GenericOpenAiAdapter } from '../dist/providers/generic-openai/generic-openai-adapter.js';
import { NewApiPortalAdapter } from '../dist/core/portals/new-api-portal-adapter.js';
import { ProviderPortalService } from '../dist/core/portals/provider-portal-service.js';
import { MemoryPortalRepository } from '../dist/core/portals/portal-repository.js';
import { ProviderPortalAdapterRegistry, PortalConfigurationError } from '../dist/core/portals/portal-types.js';
import { MemoryProviderHealthRepository, MemoryUsageRepository, createUsageTelemetryEvent, createProviderRuntimeHealthSignal, mergeModelCatalog } from '../dist/index.js';

// M4.0 negative coverage: `--negative` makes this process a RUNNER that spawns itself once per fault
// phase. Each child re-enters the normal smoke below but throws a controlled fixture error at a chosen
// point, so the REAL finally runs on a genuine throw. The runner asserts each child exited 1 with its
// original fixture cause, emitted no ok:true and no `cdp is not defined` ReferenceError, did not hang,
// and — for the active-timer phase — that the finally restored native scheduling exactly once (ticks=0,
// reArmed=1). PROVIDERDOCK_SMOKE_FAULT selects the injection point in a child; it is unset in the normal
// smoke, which therefore runs byte-for-byte as before (same 35 checks). No production code is touched.
const faultPhase = process.env.PROVIDERDOCK_SMOKE_FAULT || '';
if (process.argv.includes('--negative')) await runNegativeCoverage();

const output = resolve('.provider-dock/ui-smoke');
await mkdir(output, { recursive: true });
const secrets = new MemorySecretStore({ FIXTURE_API: 'fixture-model-key', FIXTURE_ACCOUNT: 'fixture-account-token' });
const models = ['claude-example', 'gpt-example', 'gemini-example', 'glm-example', 'kimi-example', 'minimax-example', 'qwen-example'];
const catalog = { success: true, group_ratio: { default: 1, premium: 2, free: 0 },
  vendors: [{ id: 1, name: 'Demo vendor' }], data: models.map((model_name, index) => ({ model_name,
    description: 'Демонстрационные данные для проверки интерфейса. Инструменты, текст и рассуждения.',
    quota_type: index===6?1:0, model_price: index===6?0.05:undefined, model_ratio: index ? 0.07 * index : 1.5, completion_ratio: 4,
    cache_ratio: 0.1, enable_groups: ['default', 'premium', 'free'], vendor_id: 1,
    supported_endpoint_types: ['openai', 'openai-response'] })) };
const upstream = [];
const fetchImpl = async (url, init) => {
  assert.equal(init.method, 'GET', 'UI metadata must not cause inference or check-in writes');
  upstream.push(new URL(String(url)).pathname);
  const path = new URL(String(url)).pathname;
  if (path.endsWith('/models')) return Response.json({ data: models.map(id => ({ id })) });
  if (path === '/api/pricing') return Response.json(catalog);
  return Response.json({ success: true, data: path.endsWith('/status')
    ? { checkin_enabled: true, quota_per_unit: 500000, quota_display_type: 'USD' }
    : path.endsWith('/self') ? { id: 7, quota: 42500000, group: 'default' }
    : path.endsWith('/checkin') ? { enabled: true, stats: { checked_in_today: false } }
    : { models: models.map((model_name, index) => ({ model_name, avg_tps: 24+index*7, avg_latency_ms: 5400+index*900, success_rate: 99-index })) } });
};
const portals = new ProviderPortalService(new MemoryPortalRepository(), new ProviderPortalAdapterRegistry()
  .register(new NewApiPortalAdapter(secrets, { fetchImpl })));
const healthRecords=new MemoryProviderHealthRepository();const usageRecords=new MemoryUsageRepository();
const application = new ProviderDockApplication(new MemoryProviderProfileRepository(),
  new ProviderProbeService(new ProviderAdapterRegistry().register(new GenericOpenAiAdapter({ secretStore: secrets, fetchImpl }))),
  secrets, undefined, undefined, undefined, undefined, undefined, undefined, undefined, healthRecords, usageRecords, undefined, undefined, portals);
application.listCredentials = async () => [];
application.listManagedSecretReferences = async () => [];
// Do not discover real user session homes. Exercise an unavailable section on first load.
application.listAgentSessions = async () => { throw new Error('Fixture sessions unavailable'); };
for (const [index, name] of ['SeekAI Demo', 'Orbit Demo', 'Nova Demo', 'Atlas Demo', 'Lumen Demo', 'Vector Demo'].entries()) {
  const id = 'demo-'+index;
  await application.setProvider({ id, displayName: name, baseUrl: 'https://'+id+'.invalid/v1',
    auth: { kind: 'bearer', secretRef: 'FIXTURE_API' }, manualModelIds: models });
  await application.setProviderPortal({ providerId: id, siteUrl: 'https://'+id+'.invalid', auth: { kind: 'bearer', secretRef: 'FIXTURE_ACCOUNT' } });
  await application.refreshProviderPortal(id);
  await application.probeProvider(id);
}
for(let day=0;day<7;day++)for(let i=0;i<day+3;i++){
  const profile=await application.getProvider('demo-'+i%3);const modelId=models[i%3];const at=new Date(Date.now()-day*86400000-3600000-i*60000);const failed=i%4===3;
  await healthRecords.recordRuntimeSignal(createProviderRuntimeHealthSignal({providerId:profile.id,modelId,client:'codex',protocol:'openai-responses',observedAt:at,outcome:failed?'incomplete':'completed'}));
  await usageRecords.record(createUsageTelemetryEvent({profile:{...profile,modelPricing:{[modelId]:{currency:'USD',inputPerMillion:3,outputPerMillion:12}}},modelId,client:'codex',protocol:'openai-responses',sessionId:'smoke-day-'+day,outcome:failed?'incomplete':'completed',recordedAt:at,usage:{uncachedInputTokens:10000+i*2000,cacheReadInputTokens:0,cacheWriteInputTokens:0,outputTokens:1000,reasoningOutputTokens:0,webSearchRequests:0,totalTokens:11000+i*2000}}));
}
const removedProfile=await application.getProvider('demo-0');
await healthRecords.record({health:{providerId:'demo-0',status:'ONLINE',checkedAt:new Date().toISOString(),latencyMs:2,discoveredModelCount:6,appliedFixes:[]},models:mergeModelCatalog(removedProfile,models.filter(id=>id!=='glm-example').map(modelId=>({modelId,displayName:modelId,raw:{}})))});
const ompRun = {
  runId: '01937d71-7ae7-7abc-8100-000000000001',
  providerId: 'demo-0', accountId: 'fixture-account', modelId: 'gpt-example',
  projectDirectory: 'C:/smoke', mode: 'tui', state: 'RUNNING',
  createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:01.000Z',
  transitions: [{ state: 'RUNNING', at: '2026-09-15T00:00:01.000Z' }],
};
// A finished process (exit 0), NOT a confirmed successful model answer: the UI must say so.
const ompRunDone = {
  ...ompRun, runId: '01937d71-7ae7-7abc-8100-000000000009', state: 'SUCCEEDED',
  updatedAt: '2026-09-15T00:00:03.000Z', transitions: [{ state: 'SUCCEEDED', at: '2026-09-15T00:00:03.000Z' }],
};
let ompRunCancelled = false;
const cancelledOmpRun = () => ({
  ...ompRun, state: 'CANCELLED', updatedAt: '2026-09-15T00:00:05.000Z',
  transitions: [...ompRun.transitions, { state: 'CANCELLED', at: '2026-09-15T00:00:05.000Z' }],
});
// M3-R2: an unconfirmed stop. cancel() acknowledges the request but the process death is NOT
// confirmed, so the run stays in non-terminal CANCELLING (OMP_CANCEL_UNCONFIRMED) and remains
// cancellable until a controlled close later settles it to CANCELLED. Mirrors the supervisor
// honesty contract at the UI: a positive PID/readiness is never proof of death, and the stop
// control disappears only after the real terminal close, never on the cancel request alone.
const ompRunUnsure = {
  ...ompRun, runId: '01937d71-7ae7-7abc-8100-00000000000a', modelId: 'gemini-example',
  updatedAt: '2026-09-15T00:00:02.000Z', transitions: [{ state: 'RUNNING', at: '2026-09-15T00:00:02.000Z' }],
};
let ompUnsureState = 'RUNNING';
const unsureRun = () => ompUnsureState === 'CANCELLING'
  ? { ...ompRunUnsure, state: 'CANCELLING', updatedAt: '2026-09-15T00:00:04.000Z',
      // The raw message/action carry an unsafe canary; the server projection must replace them with the code's safe text.
      diagnostic: { operationId: '01937d71-7ae7-7abc-8100-00000000000b', stage: 'shutdown', code: 'OMP_CANCEL_UNCONFIRMED', message: 'sk-cancel-unsafe-canary', retryable: true, suggestedAction: 'sk-cancel-unsafe-canary', occurredAt: '2026-09-15T00:00:04.000Z' },
      transitions: [...ompRunUnsure.transitions, { state: 'CANCELLING', at: '2026-09-15T00:00:04.000Z' }] }
  : ompUnsureState === 'CANCELLED'
  ? { ...ompRunUnsure, state: 'CANCELLED', updatedAt: '2026-09-15T00:00:06.000Z',
      transitions: [...ompRunUnsure.transitions, { state: 'CANCELLING', at: '2026-09-15T00:00:04.000Z' }, { state: 'CANCELLED', at: '2026-09-15T00:00:06.000Z' }] }
  : ompRunUnsure;
// M3-FINAL.3: an EMERGENCY unconfirmed-stop, distinct from a user-initiated cancel. The supervisor began
// stopping this run after an ORIGINAL fault (an RPC initialization timeout) whose child may still be alive,
// so the run carries its original SAFE fault cause (OMP_INITIALIZATION_TIMEOUT) — never OMP_CANCEL_UNCONFIRMED
// — and stays in non-terminal CANCELLING: visible, cause shown, re-stoppable. A retry re-signals the SAME run
// without changing the cause or inventing a terminal; only a controlled close settles it to FAILED with that
// SAME cause and drops the stop control. This fixture models OMP's UI contract; it is NOT the real oh-my-pi binary.
const ompRunFault = {
  ...ompRun, runId: '01937d71-7ae7-7abc-8100-00000000000c', modelId: 'claude-example', mode: 'rpc',
  updatedAt: '2026-09-15T00:00:02.500Z', transitions: [{ state: 'RUNNING', at: '2026-09-15T00:00:02.500Z' }],
};
let ompFaultState = 'CANCELLING';
// The raw message/action carry an unsafe canary; the server projection must replace them with the code's safe text.
const faultDiagnostic = occurredAt => ({
  operationId: '01937d71-7ae7-7abc-8100-00000000000d', stage: 'agent-init', code: 'OMP_INITIALIZATION_TIMEOUT',
  message: 'sk-fault-unsafe-canary', retryable: true, suggestedAction: 'sk-fault-unsafe-canary', occurredAt,
});
const faultRun = () => ompFaultState === 'FAILED'
  ? { ...ompRunFault, state: 'FAILED', updatedAt: '2026-09-15T00:00:07.000Z', diagnostic: faultDiagnostic('2026-09-15T00:00:07.000Z'),
      transitions: [...ompRunFault.transitions, { state: 'CANCELLING', at: '2026-09-15T00:00:03.500Z' }, { state: 'FAILED', at: '2026-09-15T00:00:07.000Z' }] }
  : { ...ompRunFault, state: 'CANCELLING', updatedAt: '2026-09-15T00:00:03.500Z', diagnostic: faultDiagnostic('2026-09-15T00:00:03.500Z'),
      transitions: [...ompRunFault.transitions, { state: 'CANCELLING', at: '2026-09-15T00:00:03.500Z' }] };
let ompPreflightCalls = 0;
let ompPreviewBlocked = false;
let ompPreviewEligible = false;
let ompPreviewLegacyTier = false;
const ompLauncher = {
  preflight: async input => ++ompPreflightCalls === 1
    ? { ok: false, diagnostic: { operationId: '01937d71-7ae7-7abc-8100-000000000002', stage: 'validation', code: 'OPERATION_FAILED', message: 'Bearer sk-secret', retryable: false, suggestedAction: 'Fixture unsafe text', occurredAt: '2026-09-15T00:00:00.000Z' } }
    : { ok: true, providerId: input.providerId, accountId: input.accountId, modelId: input.modelId, api: 'openai-responses' },
  // Read-only preview: returns extra unsafe fields to prove the server projection strips them before the DOM.
  preview: async input => ({
    selection: { providerId: input.providerId, accountId: input.accountId, modelId: input.modelId },
    verdict: ompPreviewBlocked ? 'blocked' : ompPreviewEligible ? 'ready' : 'unknown',
    reason: ompPreviewBlocked ? 'route-blocked' : ompPreviewEligible ? 'route-accepted-for-pilot' : 'route-preview-local-smoke-only',
    evidenceTier: !ompPreviewEligible ? 'local-smoke-only'
      : ompPreviewBlocked
        ? ompPreviewLegacyTier ? 'real-pilot-evidence-route-blocked' : 'doctor-l3-evidence-route-blocked'
        : ompPreviewLegacyTier ? 'real-paid-pilot' : 'doctor-l3-ready-for-pilot',
    chain: [
      { node: 'provider', state: 'ready', reason: 'provider-matches-decision' },
      { node: 'account', state: ompPreviewBlocked ? 'blocked' : 'ready', reason: ompPreviewBlocked ? 'account-identity-mismatch' : 'account-matches-decision' },
      { node: 'model', state: 'ready', reason: 'model-matches-decision' },
      { node: 'protocol', state: 'ready', reason: 'protocol-matches-decision' },
      { node: 'origin', state: 'ready', reason: 'origin-matches-decision' },
      { node: 'credential-state', state: ompPreviewEligible ? 'ready' : 'stale', reason: ompPreviewEligible ? 'doctor-credential-fingerprint-current' : 'doctor-credential-fingerprint-stale' },
      { node: 'evidence-state', state: ompPreviewEligible ? 'ready' : 'unknown', reason: ompPreviewEligible ? 'doctor-level-3-and-local-provenance' : 'local-smoke-only-no-doctor-evidence' },
    ],
    autoFallback: 'not-offered', loopbackSmokeIsUpstreamPass: false, recommendedAction: ompPreviewEligible && !ompPreviewBlocked ? 'none' : 'run-paid-doctor-then-preflight',
    leakedSecret: 'sk-omp-preview-canary', sourcePath: 'E:\\Users\\megaj\\.env-key', rawHeaders: { authorization: 'Bearer sk-omp-preview-canary' },
  }),
  launch: async () => ({ ok: true, runId: ompRun.runId }),
  listRuns: async () => [ompRunCancelled ? cancelledOmpRun() : ompRun, unsureRun(), faultRun(), ompRunDone],
  cancel: async runId => {
    if (runId === ompRun.runId) { ompRunCancelled = true; return cancelledOmpRun(); }
    // An undeliverable / unconfirmed stop: acknowledge with a non-terminal CANCELLING, never CANCELLED here.
    if (runId === ompRunUnsure.runId) { if (ompUnsureState === 'RUNNING') ompUnsureState = 'CANCELLING'; return unsureRun(); }
    // Retry of an emergency stop: re-signal the SAME already-stopping run and return its unchanged CANCELLING +
    // original fault cause. Never flip to a terminal here — only a controlled close (ompFaultState) does that.
    if (runId === ompRunFault.runId) { return faultRun(); }
    return undefined;
  },
  reconcileAfterRestart: async () => [],
};
const fixtureServerErrors = [];
const server = new ProviderDashboardServer({ application, ompLauncher, healthMonitorIntervalMs: 0, onUnexpectedError: error => fixtureServerErrors.push(error instanceof Error ? error.name : typeof error) });
const address = await server.start();
console.log('Fixture dashboard started');
const browserDirectory = await mkdtemp(join(tmpdir(), 'providerdock-ui-'));
const browser = spawn(process.env.PROVIDERDOCK_TEST_BROWSER || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new', '--disable-gpu', '--disable-software-rasterizer', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir='+browserDirectory, 'about:blank'],
  { windowsHide: true, stdio: ['ignore','ignore','pipe'] });
browser.stderr.on('data', data => { const text=data.toString(); if(text.includes('FATAL'))console.error(text.slice(0,1200)); });
browser.on('error', error => console.error('Browser failed:', error.message));
let socket;
// Error-path timer-control cleanup. Declared out here so the finally can reach it whatever
// the try throws; it starts as a no-op so a failure BEFORE CDP is wired up (socket/cdp not
// yet captured) tears down safely with no ReferenceError. Once CDP is live it is reassigned
// to a closure that captures the working socket/cdp, so the finally restores native timer
// scheduling on the error path instead of throwing `cdp is not defined` into an empty catch. It
// returns null (nothing to restore) so a pre-CDP failure records a safe teardown for the M4.0 observer.
let cleanupTimerControl = async () => null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let smokeResult = null;
try {
  // M4.0 fault injection (children only): throw BEFORE any CDP wiring so cleanupTimerControl is still the
  // initial no-op and `socket` is undefined. The finally must tear down safely (no ReferenceError, no hang)
  // and the observer must record "nothing to restore" (timer:null) — proving the pre-CDP path is safe.
  if (faultPhase === 'before-cdp-init') throw new Error('fixture-fault:before-cdp-init');
  let port;
  for (let i=0;i<100;i++) { try { port = (await readFile(join(browserDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await pause(100); } }
  assert.ok(port, 'Chrome debugging port');
  console.log('Browser debugging port ready');
  let pageTarget;
  for (let i=0;i<100 && !pageTarget;i++) {
    try {
      const targets = await (await fetch('http://127.0.0.1:'+port+'/json')).json();
      pageTarget = targets.find(target => target.type === 'page');
    } catch {}
    if (!pageTarget) await pause(100);
  }
  assert.ok(pageTarget?.webSocketDebuggerUrl, 'Chrome page target');
  socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true}); });
  let id=0;
  const pending=new Map(); const errors=[];
  socket.addEventListener('message', event => { const message=JSON.parse(event.data); if(message.id){const waiter=pending.get(message.id);pending.delete(message.id);message.error?waiter.reject(new Error(JSON.stringify(message.error))):waiter.resolve(message.result)}if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails); });
  const cdp = (method,params={}) => new Promise((resolve,reject)=>{ const request=++id;const timer=setTimeout(()=>reject(new Error('CDP timeout: '+method)),15000);pending.set(request,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});socket.send(JSON.stringify({id:request,method,params})); });
  const evaluate = async expression => { const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value; };
  // CDP is now live: bind the error-path cleanup to a closure over the working socket/cdp so the
  // finally can restore native timer scheduling even when the try throws. Guard on a live socket so
  // it is a genuine no-op for an already-closed browser (never a false proof of a completed restore).
  // Returns the post-restore timer state (reArmed count, remaining ticks, released flag, native flag)
  // so the M4.0 fault observer can prove the finally actually restored — null when the page is gone.
  cleanupTimerControl = async () => {
    if(!(socket&&socket.readyState===1)) return null;
    const restored = await cdp('Runtime.evaluate',{expression:`(()=>{
      const reArmed=window.__restoreTimerControl?window.__restoreTimerControl():null;
      return {reArmed,ticks:Array.isArray(window.__ticks)?window.__ticks.length:null,released:window.__timerControlReleased===true,native:window.setInterval===window.__nativeSetInterval};
    })()`,returnByValue:true});
    return restored.result?.value ?? null;
  };
  const until = async expression => { for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100)}const state=await evaluate("({ready:document.readyState,status:document.getElementById('global-status')?.textContent||'',cards:document.querySelectorAll('.provider-card').length,secretStatus:document.querySelector('#secret-dialog .dialog-status')?.textContent||'',invalidSecretFields:[...document.querySelectorAll('#secret-form input')].filter(input=>!input.validity.valid).map(input=>input.name)})");throw new Error('UI condition timed out: '+expression+' state='+JSON.stringify(state)+' exceptions='+JSON.stringify(errors.slice(-3))); };
  const shot = async name => { await pause(250);const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,name+'.png'),Buffer.from(result.data,'base64')); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  // M3-FINAL.4: put the dashboard's 10s background-refresh interval under test control BEFORE the page
  // loads, so it never fires on the wall clock (which would race manual refreshes and make the request
  // queue accounting flaky) and can instead be fired one deterministic tick at a time. This hook is
  // installed only in the smoke's browser via CDP; the production setInterval(...,10000) is preserved
  // verbatim in source and no test-only code ships to production.
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
    if(window.__timerControlInstalled)return;
    window.__timerControlInstalled=true;
    const nativeSetInterval=window.setInterval.bind(window);
    window.__nativeSetInterval=nativeSetInterval;
    window.__ticks=[];
    window.__reArmedTicks=[];
    window.__timerControlReleased=false;
    window.setInterval=function(handler,timeout,...rest){
      if(!window.__timerControlReleased&&timeout===10000&&typeof handler==='function'){window.__ticks.push(handler);return 0;}
      return nativeSetInterval(handler,timeout,...rest);
    };
    window.__bgTick=()=>{if(window.__timerControlReleased)return;for(const tick of window.__ticks.slice())tick();};
    // Restore native scheduling exactly once: reinstate window.setInterval, re-arm each captured background
    // callback a single time at its real 10s cadence, then neutralise the control globals so the remaining
    // page runs on the ordinary production interval (polling is NOT left disabled). Idempotent + safe on error.
    window.__restoreTimerControl=()=>{
      if(window.__timerControlReleased)return window.__reArmedTicks.length;
      window.__timerControlReleased=true;
      window.setInterval=nativeSetInterval;
      window.__reArmedTicks=window.__ticks.map(tick=>nativeSetInterval(tick,10000));
      window.__ticks=[];
      window.__bgTick=()=>{};
      return window.__reArmedTicks.length;
    };
  })()`});
  await cdp('Page.navigate',{url:address.url});
  await until("document.querySelectorAll('.provider-card').length===6");
  await until("document.getElementById('refresh-status').textContent.includes('Сессии')");
  application.listAgentSessions = async () => [];
  await evaluate("document.getElementById('refresh').click()");
  await until("document.getElementById('refresh-status').hidden");
  console.log('Providers rendered');
  // M4.0 fault injection (children only): the page is loaded and the single production 10s background-
  // refresh interval is captured under active timer control (released still false). Throw HERE — before any
  // in-try or normal restore runs — so the ONLY code that can restore native scheduling is the real finally
  // invoking cleanupTimerControl(). The observer then proves ticks=0/reArmed=1/native/released after teardown.
  if (faultPhase === 'before-restore-active-timer') {
    await until("Array.isArray(window.__ticks)&&window.__ticks.length===1&&window.__timerControlReleased===false");
    throw new Error('fixture-fault:before-restore-active-timer');
  }
  await evaluate("document.querySelector('[data-nav=settings]').click()");
  const focusSecretAction = async (reference, label) => evaluate(`(()=>{
    const row=[...document.querySelectorAll('#secrets .item-row')].find(row=>row.querySelector('.item-title')?.textContent===${JSON.stringify(reference)});
    window.focusedSecretAction=[...row.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(label)});
    window.focusedSecretAction.focus();
    if(document.activeElement!==window.focusedSecretAction)throw Error('Secret action was not focusable');
  })()`);
  const focusedSecret = () => evaluate("({reference:document.activeElement.closest('#secrets .item-row')?.querySelector('.item-title')?.textContent||null,action:document.activeElement.textContent})");
  const refreshAfterSecretFocus = async () => {
    await evaluate("document.getElementById('refresh').click()");
    await until("!window.focusedSecretAction.isConnected");
  };
  for (const action of ['Удалить', 'Заменить']) {
    await focusSecretAction('FIXTURE_API', action);
    await refreshAfterSecretFocus();
    assert.deepEqual(await focusedSecret(), {reference:'FIXTURE_API',action}, 'Polling keeps the same secret reference AND action, not the first identically labelled button');
  }
  const listSecretReferences = application.listSecretReferences.bind(application);
  application.listSecretReferences = async () => (await listSecretReferences()).reverse();
  await focusSecretAction('FIXTURE_ACCOUNT', 'Удалить');
  await refreshAfterSecretFocus();
  assert.deepEqual(await focusedSecret(), {reference:'FIXTURE_ACCOUNT',action:'Удалить'}, 'Secret focus survives row reordering');
  application.listSecretReferences = async () => [...await listSecretReferences(), 'FIXTURE_API'];
  await focusSecretAction('FIXTURE_API', 'Заменить');
  await refreshAfterSecretFocus();
  assert.equal((await focusedSecret()).reference, null, 'Ambiguous duplicate reference/action matches do not restore focus');
  application.listSecretReferences = listSecretReferences;
  await application.setSecret('FOCUS_EPHEMERAL', 'fixture-ephemeral');
  await evaluate("document.getElementById('refresh').click()");
  await until("[...document.querySelectorAll('#secrets .item-title')].some(item=>item.textContent==='FOCUS_EPHEMERAL')");
  await focusSecretAction('FOCUS_EPHEMERAL', 'Удалить');
  await application.removeSecret('FOCUS_EPHEMERAL');
  await refreshAfterSecretFocus();
  assert.equal((await focusedSecret()).reference, null, 'A removed secret never transfers focus to another secret action');
  await focusSecretAction('FIXTURE_API', 'Заменить');
  await evaluate("document.activeElement.click();document.getElementById('secret-form').elements.value.value='blocked-overwrite-canary'");
  await until("document.getElementById('secret-dialog').open");
  // Corruption is authoritative even if a last-good account list is still present.
  application.providerPortalStatus = () => ({ state: 'corrupt', message: 'secret-canary' });
  await evaluate("document.getElementById('refresh').click()");
  await until("document.getElementById('portal-recovery-banner')&&!document.getElementById('portal-recovery-banner').hidden");
  assert.ok(await evaluate("document.getElementById('portal-recovery-banner').textContent.includes('PORTAL_STORAGE_CORRUPT')"));
  assert.ok(await evaluate("[...document.querySelectorAll('.portal-summary')].every(row=>row.textContent.includes('неизвестны'))"));
  assert.equal(await evaluate("document.getElementById('open-cookie-overview').disabled"),true);
  await evaluate("document.querySelector('[data-nav=settings]').click()");
  assert.ok(await evaluate("[...document.querySelectorAll('#secrets .item-sub')].every(row=>row.textContent.includes('неизвестно'))"));
  assert.ok(await evaluate("[...document.querySelectorAll('#secrets button.danger')].every(button=>button.disabled)"));
  assert.ok(await evaluate("[...document.querySelectorAll('#secrets button')].filter(button=>button.textContent==='Заменить').every(button=>button.disabled)"), 'Existing credentials cannot be replaced while account links are unknown');
  assert.equal(await evaluate("document.querySelector('#secret-form button[type=submit]').disabled"),true, 'Corruption also blocks a replacement dialog opened before refresh');
  await evaluate(`(()=>{
    window.secretPuts=[];window.secretSafetyFetch=window.fetch.bind(window);
    window.fetch=(path,options)=>{if(String(path).includes('api/secrets/')&&options?.method==='PUT')window.secretPuts.push(String(path));return window.secretSafetyFetch(path,options)};
    document.getElementById('secret-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  })()`);
  await until("document.getElementById('secret-form').elements.value.value===''");
  assert.deepEqual(await evaluate("window.secretPuts"),[], 'Even a forced submit is blocked in the UI, not sent to the API');
  assert.equal(await secrets.get('FIXTURE_API'),'fixture-model-key');
  // Wait for the real close event/reset before opening another form.
  await evaluate("new Promise(resolve=>{const dialog=document.getElementById('secret-dialog');dialog.addEventListener('close',()=>resolve(true),{once:true});dialog.close()})");
  await evaluate("document.getElementById('add-secret').click();(()=>{const input=document.getElementById('secret-form').elements.reference;input.value='FIXTURE_ACCOUNT';input.dispatchEvent(new Event('input'))})()");
  assert.equal(await evaluate("document.querySelector('#secret-form button[type=submit]').disabled"),true, 'Adding a key cannot overwrite an existing reference during corruption');
  await evaluate("(()=>{const f=document.getElementById('secret-form');f.elements.reference.value='CORRUPT_FRESH';f.elements.reference.dispatchEvent(new Event('input'));f.elements.value.value='fresh-key-canary'})()");
  assert.equal(await evaluate("document.querySelector('#secret-form button[type=submit]').disabled"),false, 'Fresh unique references remain available');
  await evaluate("document.getElementById('secret-form').requestSubmit()");
  await until("!document.getElementById('secret-dialog').open");
  assert.deepEqual(await evaluate("window.secretPuts"),['api/secrets/CORRUPT_FRESH']);
  assert.equal(await secrets.get('CORRUPT_FRESH'),'fresh-key-canary');
  assert.equal(await secrets.get('FIXTURE_ACCOUNT'),'fixture-account-token');
  await evaluate("window.fetch=window.secretSafetyFetch");
  assert.ok(await evaluate("!document.body.textContent.includes('secret-canary')"));
  await shot('portal-corruption');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.ok(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"), 'Recovery banner fits mobile');
  await shot('portal-corruption-mobile');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  application.providerPortalStatus = () => ({ state: 'recovered', message: 'secret-canary' });
  await evaluate("refresh()");
  assert.ok(await evaluate("(()=>{const banner=document.getElementById('portal-recovery-banner');return !banner.hidden&&banner.textContent.includes('проверьте связи аккаунтов')&&!document.body.textContent.includes('secret-canary')})()"),'Recovered portal metadata asks to verify account links without exposing repository text');
  assert.equal(await evaluate("document.getElementById('open-cookie-overview').disabled"),false,'Recovered connections remain available for review');
  application.providerPortalStatus = () => ({ state: 'healthy' });
  await evaluate("document.getElementById('refresh').click()");
  await until("document.getElementById('portal-recovery-banner').hidden");
  assert.ok(await evaluate("[...document.querySelectorAll('#secrets .item-row')].find(row=>row.textContent.includes('FIXTURE_ACCOUNT')).textContent.includes('кабинет')"), 'Portal-only keys count as used');
  assert.ok(await evaluate("[...document.querySelectorAll('#secrets button')].every(button=>!button.disabled)"),'Healthy portal recovery re-enables ordinary credential management');
  application.listSecretReferences = async () => { throw Object.assign(new Error('protected-error-canary'), {name:'SecretProtectionError'}); };
  await evaluate(`(()=>{
    window.vaultFetch=window.fetch.bind(window);window.receivedVaultDiagnostic=null;
    window.fetch=async(path,options)=>{
      const response=await window.vaultFetch(path,options);
      if(path==='api/snapshot')window.receivedVaultDiagnostic=(await response.clone().json()).secretVaultDiagnostic;
      return response;
    };
    document.getElementById('refresh').click();
  })()`);
  await until("window.receivedVaultDiagnostic&&document.getElementById('add-secret').disabled");
  const vaultView = await evaluate("({diagnostic:window.receivedVaultDiagnostic,body:document.getElementById('secrets').textContent,heading:document.getElementById('secret-vault-state').textContent})");
  assert.equal(vaultView.diagnostic.code,'VAULT_UNAVAILABLE');
  assert.match(vaultView.diagnostic.operationId,/^[0-9a-f-]{36}$/);
  for(const field of ['message','code','operationId','stage','suggestedAction'])assert.ok(vaultView.body.includes(vaultView.diagnostic[field]), 'Unavailable vault visibly renders safe diagnostic '+field);
  assert.match(vaultView.heading,/недоступно/i);
  assert.ok(!vaultView.heading.includes('platform'), 'A Windows protection failure is not presented as an unsupported platform');
  assert.ok(await evaluate("!document.body.textContent.includes('protected-error-canary')"), 'Raw protection errors never reach the UI');
  await shot('vault-unavailable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.ok(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"), 'Vault diagnostic fits mobile without hiding the code or action');
  await shot('vault-unavailable-mobile');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  application.listSecretReferences = listSecretReferences;
  await evaluate("window.fetch=window.vaultFetch;document.getElementById('refresh').click()");
  await until("!document.getElementById('add-secret').disabled&&document.querySelectorAll('#secrets .item-row').length>=3");
  assert.ok(await evaluate("!document.getElementById('secrets').textContent.includes('VAULT_UNAVAILABLE')"),'Vault recovery clears the old diagnostic');
  const managedId='00000000-0000-4000-8000-000000000001';
  const managedRef='credential-'+managedId;
  await secrets.set(managedRef,'managed-secret-canary');
  application.listCredentials=async()=>[{id:managedId,providerId:'demo-0',purpose:'provider-api',maskedValue:'man…nary',state:'active',createdAt:'2026-09-23T00:00:00.000Z'}];
  application.listManagedSecretReferences=async()=>[managedRef];
  await evaluate("document.getElementById('refresh').click()");
  await until("document.querySelector('#secrets [data-credential-id]')");
  const managedView=await evaluate(`(()=>{const root=document.getElementById('secrets');const row=root.querySelector('[data-credential-id]');return {text:row.textContent,rawRow:[...root.querySelectorAll('[data-secret-reference]')].find(item=>item.dataset.secretReference===${JSON.stringify(managedRef)})?.textContent||null,buttons:[...row.querySelectorAll('button')].map(button=>button.textContent),plaintext:document.body.textContent.includes('managed-secret-canary')}})()`);
  assert.ok(managedView.text.includes('man…nary')&&managedView.text.includes('demo-0'),'Managed credential is shown only as provider-bound mask');
  assert.equal(managedView.rawRow,null,'Managed secret does not expose generic replace/remove actions');
  assert.equal(managedView.plaintext,false,'Managed plaintext never appears in the page');
  const listManagedCredentials=application.listCredentials;
  application.listCredentials=async()=>{throw new Error('private-registry-canary');};
  await evaluate("document.getElementById('refresh').click()");
  await until("document.getElementById('add-secret').disabled&&document.getElementById('secrets').textContent.includes('CREDENTIAL_REGISTRY_UNAVAILABLE')");
  assert.ok(await evaluate("[...document.querySelectorAll('#secrets [data-secret-reference] button')].every(button=>button.disabled)"),'Unknown credential registry blocks generic secret mutation');
  assert.ok(await evaluate("!document.body.textContent.includes('private-registry-canary')"),'Raw registry errors stay private');
  application.listCredentials=listManagedCredentials;
  await evaluate("document.getElementById('refresh').click()");
  await until("!document.getElementById('add-secret').disabled");
  await evaluate("document.querySelector('[data-nav=providers]').click()");
  assert.ok(await evaluate("document.getElementById('launch-approval').options[0].textContent.includes('Сохранённое')"), 'Approval label is readable');
  // OMP pilot launch is independently gated: explicit route, acknowledgement, preflight, and launch.
  await evaluate("[...document.querySelectorAll('.provider-card .pc-actions button')].find(button=>button.textContent==='Запуск')?.click()");
  await until("document.getElementById('launch-dialog').open");
  assert.ok(await evaluate("Boolean(document.querySelector('#launch-client option[value=omp]')?.textContent.includes('OMP (пилот)'))"), 'OMP launch option exists');
  assert.ok(await evaluate("Boolean(document.getElementById('launch-omp-account') && document.getElementById('launch-omp-acknowledgement'))"), 'OMP account and acknowledgement fields exist');
  await evaluate("document.getElementById('launch-client').value='omp';document.getElementById('launch-client').dispatchEvent(new Event('change'))");
  assert.deepEqual(await evaluate("[document.getElementById('launch-omp-preflight').disabled,document.getElementById('launch-submit').disabled,document.getElementById('launch-approval').disabled,document.getElementById('route-tabs').hidden]"), [true,true,true,true], 'OMP blocks preflight, submit, legacy approval, and automatic routes');
  await evaluate("document.getElementById('launch-project').value='C:/smoke';document.getElementById('launch-project').dispatchEvent(new Event('input'));document.getElementById('launch-omp-account').value='fixture-account';document.getElementById('launch-omp-account').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.getElementById('launch-omp-preflight').disabled"),false,'All OMP fields enable preflight');
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'Submit remains disabled before preflight');
  // Read-only route-readiness preview explains each node without enabling launch, and never leaks unsafe fields.
  const previewTierObservations = [];
  const observePreviewTier = async scenario => previewTierObservations.push({
    scenario,
    ...await evaluate("({label:document.querySelector('#omp-preview .omp-preview-tier').textContent,launchDisabled:document.getElementById('launch-submit').disabled})"),
  });
  await until("document.getElementById('omp-preview').querySelectorAll('.omp-node').length===7");
  await observePreviewTier('unknown');
  await shot('omp-preview-unknown');
  assert.equal(await evaluate("document.getElementById('omp-preview').querySelectorAll('.omp-node').length"),7,'Preview shows every route node status next to the OMP form');
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'A rendered preview never enables launch on its own');
  assert.ok(await evaluate("(()=>{const b=document.body.textContent;return !b.includes('sk-omp-preview-canary')&&!b.includes('.env-key')&&!b.includes('Bearer sk-omp')})()"),'Preview never leaks the injected secret, absolute path, or raw header into the DOM');
  assert.ok(await evaluate("(()=>{const t=document.getElementById('omp-preview').textContent;return !t.includes('уже проверен')&&!t.includes('готово к production')&&!t.toLowerCase().includes('production')})()"),'Preview never over-claims real-provider or production readiness');
  assert.ok(await evaluate("document.getElementById('omp-preview').textContent.includes('preflight')"),'Preview states the next step in plain text');
  await evaluate("(()=>{window.ompCalls=[];window.ompFetch=window.fetch.bind(window);window.fetch=(path,options)=>{if(String(path).startsWith('api/omp/'))window.ompCalls.push({path:String(path),method:options?.method||'GET'});return window.ompFetch(path,options)}})()");
  await evaluate("document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('omp-preflight-status').textContent.includes('OPERATION_FAILED')");
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'Failed preflight does not enable submit');
  assert.ok(await evaluate("document.getElementById('omp-preflight-status').textContent.includes('Операция не выполнена.')"), 'Safe preflight diagnostic is rendered');
  assert.ok(await evaluate("!document.body.textContent.includes('sk-secret')"), 'Unsafe diagnostic detail never reaches the DOM');
  // The fake launcher now reports a route eligible for its subsequent successful preflight.
  ompPreviewEligible = true;
  await evaluate("refresh()");
  await until("document.getElementById('omp-preview').textContent.includes('READY')");
  await observePreviewTier('ready-for-pilot');
  await shot('omp-preview-ready');
  // Older API payloads must also render honestly during a client/server transition.
  ompPreviewLegacyTier = true;
  await evaluate("refresh()");
  await until("document.getElementById('omp-preview').textContent.includes('READY')");
  await observePreviewTier('legacy-ready-tier');
  ompPreviewLegacyTier = false;
  await evaluate("document.getElementById('launch-omp-account').value='fixture-account-2';document.getElementById('launch-omp-account').dispatchEvent(new Event('input'));document.getElementById('launch-omp-account').value='fixture-account';document.getElementById('launch-omp-account').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.getElementById('launch-omp-acknowledgement').checked"), false, 'Changing the account revokes the OMP permission acknowledgement');
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"), true, 'Changing the account keeps launch closed until a fresh acknowledgement and preflight');
  await evaluate("document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('launch-submit').disabled===false");
  assert.ok(await evaluate("document.getElementById('omp-preflight-status').textContent.includes('OMP preflight passed')"), 'Successful preflight is visible');
  // M10.3 RED: the approval acknowledgement is evidence bound to the exact
  // project/route selection. Changing the project after preflight must revoke
  // both the preflight and the acknowledgement before launch can be retried.
  await evaluate("document.getElementById('launch-project').value='C:/changed-project';document.getElementById('launch-project').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.getElementById('launch-omp-acknowledgement').checked"), false, 'Changing the project revokes the OMP permission acknowledgement');
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"), true, 'Changing the project keeps launch closed until a fresh acknowledgement and preflight');
  await evaluate("document.getElementById('launch-project').value='C:/smoke';document.getElementById('launch-project').dispatchEvent(new Event('input'));document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('launch-submit').disabled===false");
  await evaluate("(()=>{window.previewFetchBeforeDelay=window.fetch;window.previewDelayed=false;window.fetch=(path,options)=>{if(!window.previewDelayed&&String(path).startsWith('api/omp/preview')){window.previewDelayed=true;return new Promise(resolve=>{window.releasePreview=()=>window.previewFetchBeforeDelay(path,options).then(resolve)})}return window.previewFetchBeforeDelay(path,options)}})()");
  await evaluate("refresh()");
  await until("typeof window.releasePreview==='function'");
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'Pending refreshed preview temporarily disables a previously preflighted launch');
  await evaluate("window.releasePreview();window.fetch=window.previewFetchBeforeDelay");
  await until("document.getElementById('omp-preview').textContent.includes('READY')&&document.getElementById('launch-submit').disabled===false");
  // The same selection can lose its account binding while retaining Doctor/local evidence.
  // A snapshot refresh must replace the old route explanation and revoke its earlier preflight.
  ompPreviewBlocked = true;
  await evaluate("refresh()");
  await until("document.getElementById('omp-preview').textContent.includes('BLOCKED')");
  await observePreviewTier('route-blocked-with-doctor');
  await shot('omp-preview-blocked');
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'A refreshed blocked route invalidates the earlier successful preflight');
  ompPreviewLegacyTier = true;
  await evaluate("refresh()");
  await until("document.getElementById('omp-preview').textContent.includes('BLOCKED')");
  await observePreviewTier('legacy-blocked-tier');
  assert.deepEqual(previewTierObservations, [
    { scenario: 'unknown', label: 'только локальный smoke', launchDisabled: true },
    { scenario: 'ready-for-pilot', label: 'Doctor L3 и локальные проверки: готово к пилоту', launchDisabled: true },
    { scenario: 'legacy-ready-tier', label: 'Doctor L3 и локальные проверки: готово к пилоту', launchDisabled: true },
    { scenario: 'route-blocked-with-doctor', label: 'Doctor L3 и локальные проверки: маршрут закрыт', launchDisabled: true },
    { scenario: 'legacy-blocked-tier', label: 'Doctor L3 и локальные проверки: маршрут закрыт', launchDisabled: true },
  ], 'Doctor and local provenance never claim that an OMP pilot ran, including legacy tier payloads');
  ompPreviewLegacyTier = false;
  ompPreviewBlocked = false;
  await evaluate("refresh()");
  await until("document.getElementById('omp-preview').textContent.includes('READY')");
  await evaluate("document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('launch-submit').disabled===false");
  const reopenedPilot = await evaluate("(()=>{document.getElementById('launch-dialog').close();[...document.querySelectorAll('.provider-card .pc-actions button')].find(button=>button.textContent==='Запуск')?.click();return {open:document.getElementById('launch-dialog').open,submitDisabled:document.getElementById('launch-submit').disabled}})()");
  assert.deepEqual(reopenedPilot,{open:true,submitDisabled:true},'Reopening the OMP dialog never keeps an old successful preflight active');
  await evaluate("document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('launch-submit').disabled===false");
  await until("document.getElementById('omp-preview').querySelectorAll('.omp-node').length===7");
  await evaluate("window.previewFetch=window.fetch;window.fetch=(path,options)=>String(path).startsWith('api/omp/preview')?Promise.resolve(Response.json({message:'fixture preview unavailable'},{status:503})):window.previewFetch(path,options)");
  await evaluate("refresh()");
  await until("document.getElementById('omp-preview').textContent.includes('fixture preview unavailable')");
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'A failed refreshed preview cannot leave an earlier preflight active');
  await evaluate("window.fetch=window.previewFetch");
  await evaluate("refresh()");
  await until("document.getElementById('omp-preview').querySelectorAll('.omp-node').length===7");
  await evaluate("document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('launch-submit').disabled===false");
  await evaluate("document.getElementById('launch-model').value='gemini-example';document.getElementById('launch-model').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'Any OMP input change invalidates preflight');
  await evaluate("document.getElementById('launch-model').value='gpt-example';document.getElementById('launch-model').dispatchEvent(new Event('change'));document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('launch-submit').disabled===false");
  await evaluate("document.getElementById('launch-submit').click()");
  await until(`document.getElementById('launch-status').textContent.includes('${ompRun.runId}')`);
  assert.ok(await evaluate(`document.getElementById('omp-runs').textContent.includes('${ompRun.runId}')&&document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRun.runId}"]')?.dataset.state==='RUNNING'`), 'Safe OMP run history is rendered with its lifecycle state');
  assert.ok(await evaluate("window.ompCalls.some(call=>call.path==='api/omp/preflight'&&call.method==='POST')&&window.ompCalls.some(call=>call.path==='api/omp/launch'&&call.method==='POST')&&window.ompCalls.some(call=>call.path==='api/omp/runs'&&call.method==='GET')"), 'OMP UI uses only OMP API endpoints');
  assert.ok(await evaluate("!window.ompCalls.some(call=>call.path==='api/launches'&&call.method==='POST')"), 'OMP launch never posts through the legacy launcher API');
  // M3.2: run rows carry truthful human lifecycle labels and a cancel control for non-terminal runs only.
  assert.ok(await evaluate(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRun.runId}"]');return Boolean(row)&&row.textContent.includes('выполняется')&&[...row.querySelectorAll('button')].some(b=>b.textContent==='Отменить')})()`), 'A non-terminal OMP run shows a human state and a cancel control');
  assert.ok(await evaluate(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunDone.runId}"]');return Boolean(row)&&row.dataset.state==='SUCCEEDED'&&row.textContent.includes('процесс завершился')&&!/успешн|успех/i.test(row.textContent)&&[...row.querySelectorAll('button')].every(b=>b.textContent!=='Отменить')})()`), 'A finished-process run says the process ended, never claims a successful model answer, and offers no cancel');
  // Cancel travels through the real HTTP endpoint and drives the row to a truthful terminal state.
  await evaluate("window.confirm=()=>true");
  await evaluate(`[...document.querySelectorAll('#omp-runs .omp-run-row[data-run-id="${ompRun.runId}"] button')].find(b=>b.textContent==='Отменить').click()`);
  await until(`document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRun.runId}"]')?.dataset.state==='CANCELLED'`);
  assert.ok(await evaluate(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRun.runId}"]');return row.textContent.includes('отменён')&&[...row.querySelectorAll('button')].every(b=>b.textContent!=='Отменить')})()`), 'Cancelling drives the run to a terminal cancelled state and drops the cancel control');
  assert.ok(await evaluate(`window.ompCalls.some(call=>call.path==='api/omp/runs/${ompRun.runId}/cancel'&&call.method==='POST')`), 'Cancel routes through the real OMP cancel endpoint');
  // M3-R2: an UNCONFIRMED stop stays non-terminal and cancellable. The browser must show
  // «остановка не подтверждена», keep a working retry-cancel control, and drop it ONLY after a
  // controlled close settles the run — never on the strength of the cancel request alone.
  await until(`document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"]')?.dataset.state==='RUNNING'`);
  await evaluate(`[...document.querySelectorAll('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"] button')].find(b=>b.textContent==='Отменить').click()`);
  await until(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"]');return row?.dataset.state==='CANCELLING'&&row.textContent.includes('остановка не подтверждена')&&[...row.querySelectorAll('button')].some(b=>b.textContent==='Отменить'&&!b.disabled)})()`);
  assert.ok(await evaluate(`document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"]').textContent.includes('OMP_CANCEL_UNCONFIRMED')`), 'The unconfirmed stop shows its safe diagnostic code, not a false success');
  assert.ok(await evaluate(`!/успешн|успех|отменён|прерван|сбой/i.test(document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"]').textContent)`), 'A CANCELLING run never claims a terminal outcome');
  assert.ok(await evaluate("!document.body.textContent.includes('sk-cancel-unsafe-canary')"), 'The unconfirmed-cancel diagnostic is sanitized: the raw message/action never reach the DOM');
  await shot('omp-cancel-unconfirmed');
  // Retry-cancel is available: clicking again re-issues exactly one more request to the same run and it stays cancellable.
  const unsureCancelsBefore = await evaluate(`window.ompCalls.filter(call=>call.path==='api/omp/runs/${ompRunUnsure.runId}/cancel'&&call.method==='POST').length`);
  await evaluate(`[...document.querySelectorAll('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"] button')].find(b=>b.textContent==='Отменить').click()`);
  await until(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"]');return row?.dataset.state==='CANCELLING'&&[...row.querySelectorAll('button')].some(b=>b.textContent==='Отменить'&&!b.disabled)})()`);
  assert.equal(await evaluate(`window.ompCalls.filter(call=>call.path==='api/omp/runs/${ompRunUnsure.runId}/cancel'&&call.method==='POST').length`), unsureCancelsBefore + 1, 'Retry-cancel re-issues exactly one more cancel to the same run');
  // Only a controlled close settles the run terminally and removes the stop control.
  ompUnsureState = 'CANCELLED';
  await until(`document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"]')?.dataset.state==='CANCELLED'`);
  assert.ok(await evaluate(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunUnsure.runId}"]');return row.textContent.includes('отменён')&&[...row.querySelectorAll('button')].every(b=>b.textContent!=='Отменить')})()`), 'A controlled close settles the unconfirmed run to CANCELLED and only then drops the cancel control');
  // M3-FINAL.3: a SEPARATE fault-stop line (distinct from the user-cancel above). This run was emergency-stopped
  // by the supervisor after an ORIGINAL RPC fault whose child may still be alive, so it is already CANCELLING and
  // carries its original SAFE cause (OMP_INITIALIZATION_TIMEOUT), NOT OMP_CANCEL_UNCONFIRMED. Through the real
  // HTTP/DOM path: before a confirmed close it stays CANCELLING with the cause visible and a working stop button;
  // a retry re-issues exactly one POST to the same run, the cause does not change, and no false terminal appears.
  await until(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunFault.runId}"]');return row?.dataset.state==='CANCELLING'&&row.textContent.includes('остановка не подтверждена')&&[...row.querySelectorAll('button')].some(b=>b.textContent==='Отменить'&&!b.disabled)})()`);
  assert.ok(await evaluate(`document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunFault.runId}"]').textContent.includes('OMP_INITIALIZATION_TIMEOUT')`), 'The emergency-stopped run shows its ORIGINAL safe fault cause while stopping, not a cancel-specific code');
  assert.ok(await evaluate(`!/успешн|успех|отменён|прерван|сбой/i.test(document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunFault.runId}"]').textContent)`), 'A fault run mid-stop never claims a terminal outcome');
  assert.ok(await evaluate("!document.body.textContent.includes('sk-fault-unsafe-canary')"), 'The fault diagnostic is sanitized: its raw message/action never reach the DOM');
  await shot('omp-fault-stopping');
  const faultCancelsBefore = await evaluate(`window.ompCalls.filter(call=>call.path==='api/omp/runs/${ompRunFault.runId}/cancel'&&call.method==='POST').length`);
  await evaluate(`[...document.querySelectorAll('#omp-runs .omp-run-row[data-run-id="${ompRunFault.runId}"] button')].find(b=>b.textContent==='Отменить').click()`);
  await until(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunFault.runId}"]');return row?.dataset.state==='CANCELLING'&&[...row.querySelectorAll('button')].some(b=>b.textContent==='Отменить'&&!b.disabled)})()`);
  assert.equal(await evaluate(`window.ompCalls.filter(call=>call.path==='api/omp/runs/${ompRunFault.runId}/cancel'&&call.method==='POST').length`), faultCancelsBefore + 1, 'Retrying the stop on the fault run re-issues exactly one more request to the same run');
  assert.ok(await evaluate(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunFault.runId}"]');return row.dataset.state==='CANCELLING'&&row.textContent.includes('OMP_INITIALIZATION_TIMEOUT')})()`), 'The retry leaves the fault run non-terminal with its cause unchanged — no false terminal from the request alone');
  // Only a controlled close settles the fault run — to FAILED, carrying the SAME original cause, and drops the stop control.
  ompFaultState = 'FAILED';
  await until(`document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunFault.runId}"]')?.dataset.state==='FAILED'`);
  assert.ok(await evaluate(`(()=>{const row=document.querySelector('#omp-runs .omp-run-row[data-run-id="${ompRunFault.runId}"]');return row.textContent.includes('сбой')&&row.textContent.includes('OMP_INITIALIZATION_TIMEOUT')&&[...row.querySelectorAll('button')].every(b=>b.textContent!=='Отменить')})()`), 'A confirmed close settles the fault run to FAILED with the same original cause and drops the stop control');
  assert.ok(await evaluate("!document.body.textContent.includes('sk-fault-unsafe-canary')"), 'The failed fault run still never leaks its raw diagnostic text');
  await shot('omp-fault-failed');
  // Let any bounded settle tick that raced the cancel fire once and stop (the run is terminal now), so the quiet check is deterministic.
  await pause(1800);
  // Closing the launch surface releases any remaining bounded run-settle timer: no infinite polling.
  await evaluate("document.getElementById('launch-dialog').close()");
  await until("!document.getElementById('launch-dialog').open");
  const ompCallsAfterClose = await evaluate("window.ompCalls.length");
  await pause(2000);
  assert.equal(await evaluate("window.ompCalls.length"), ompCallsAfterClose, 'Closing the launch surface releases the bounded OMP run timer');
  await evaluate("window.fetch=window.ompFetch;delete window.ompFetch;delete window.ompCalls");
  // M3-FINAL.4: control only the HTTP boundary and the background-tick clock; assertions observe
  // rendered DOM and the request queue, never the app's refresh-revision or internal state. Each
  // queued section request is stamped with the trigger round that issued it, so a late response is
  // matched to its own round by identity — never by array position or a total-length barrier.
  await evaluate(`(async()=>{
    window.fixtureFetch=window.fetch.bind(window);
    window.fixtureSnapshot=await (await window.fixtureFetch('api/snapshot')).json();
    window.fixturePending=[];
    window.__triggerRound=0;
    window.fetch=(path,options)=>['api/snapshot','api/launches','api/agent-sessions'].includes(path)
      ?new Promise(resolve=>window.fixturePending.push({path,resolve,round:window.__triggerRound,done:false}))
      :window.fixtureFetch(path,options);
  })()`);
  // The production 10s background refresh was captured before navigation (not scheduled on the wall
  // clock); guard that exactly it is under control and that the page is visible so a tick truly refreshes.
  assert.equal(await evaluate("window.__ticks.length"),1,'Exactly the production background-refresh interval is under test control');
  assert.equal(await evaluate("document.hidden"),false,'The fixture page is visible, so a background tick actually refreshes');
  const resolveRound = async (round, snapshotName, sessionTitle, launchId, failed = '') => evaluate(`(()=>{
    const batch=window.fixturePending.filter(request=>request.round===${round}&&!request.done);
    if(batch.length!==3)throw Error('Round ${round} expected 3 pending section requests, saw '+batch.length);
    for(const request of batch){
      request.done=true;
      const snapshot=structuredClone(window.fixtureSnapshot);snapshot.providers[0].displayName=${JSON.stringify(snapshotName)};
      const body=request.path==='api/snapshot'?snapshot:request.path==='api/launches'
        ?{launches:[{id:${JSON.stringify(launchId)},status:'RUNNING',request:{client:'codex',projectDirectory:${JSON.stringify(launchId)}},resolvedApprovalLevel:'ask',startedAt:'2026-09-15T00:00:00.000Z',fallbacks:[]}]}
        :{sessions:[{id:'16a96b51-c68d-4d6d-91c9-d82a5485a691',client:'codex',providerId:'demo-0',projectDirectory:'C:/smoke',modelId:'gpt-example',title:${JSON.stringify(sessionTitle)},updatedAt:'2026-09-15T00:00:00.000Z',resumable:true}]};
      if(request.path===${JSON.stringify(failed)})request.resolve(Response.json({message:'Fixture section unavailable'},{status:503}));
      else request.resolve(Response.json(body));
    }
  })()`);
  // Fire one trigger — a manual #refresh click or one deterministic background-interval tick — and wait
  // only for ITS three section requests to enqueue, identified by round with no dependence on queue length.
  let roundSeq=0;
  const triggerRound = async (mode, prep = '') => {
    const round=++roundSeq;
    const fire=mode==='background'?'window.__bgTick()':"document.getElementById('refresh').click()";
    await evaluate(`${prep};window.__triggerRound=${round};${fire}`);
    await until(`window.fixturePending.filter(request=>request.round===${round}).length===3`);
    return round;
  };
  const rNewest = await triggerRound('manual', "document.querySelector('.provider-card .mini.active').focus()");
  await resolveRound(rNewest, 'Newest fixture', 'Session newest', 'newest-launch');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Newest fixture'");
  assert.ok(await evaluate("document.activeElement?.textContent==='Модели и цены'&&document.activeElement.closest('[data-provider-id]')?.dataset.providerId==='demo-0'"), 'Polling preserves keyboard focus on provider actions');
  // Cross one explicit background-interval tick with a manual refresh. The manual round starts first and
  // the background tick second, so the background round is newer. Resolving the newer background round
  // first must win; resolving the older manual round late must be rejected by the production per-section
  // revision guard — proving a response lands on the round that issued it, whatever its trigger type and
  // whatever order responses arrive. The manual round also opens the launch dialog and focuses a field so
  // the crossing proves the winning render preserves the launch selection and keyboard focus.
  const rManualStale = await triggerRound('manual', "[...document.querySelectorAll('.provider-card .pc-top button')].find(b=>b.textContent==='Запуск').click();document.getElementById('launch-client').value='auto';document.getElementById('launch-client').dispatchEvent(new Event('change'));document.getElementById('launch-model').value='gpt-example';document.getElementById('launch-approval').value='ask';document.getElementById('launch-model').focus()");
  const rBackgroundFresh = await triggerRound('background');
  await resolveRound(rBackgroundFresh, 'Fresh fixture', 'Session fresh', 'fresh-launch');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Fresh fixture'");
  await resolveRound(rManualStale, 'Stale fixture', 'Session stale', 'stale-launch');
  await pause(100);
  assert.equal(await evaluate("document.querySelector('.provider-card .pc-name').textContent"),'Fresh fixture','A newer background tick supersedes an older manual refresh; the late manual response is rejected');
  assert.ok(await evaluate("document.getElementById('launch-agent-sessions').textContent.includes('Session fresh')&&!document.getElementById('launch-agent-sessions').textContent.includes('Session stale')"));
  assert.deepEqual(await evaluate("[document.getElementById('launch-provider').value,document.getElementById('launch-model').value,document.getElementById('launch-approval').value,document.activeElement.id]"),['demo-0','gpt-example','ask','launch-model']);
  // Reverse the crossing: a background tick starts first, a manual refresh second. Now the manual round
  // is newer and must win; the late background response must be rejected. Neither trigger type is
  // privileged — only the round that started last owns each section.
  const rBackgroundStale = await triggerRound('background');
  const rManualFresh = await triggerRound('manual');
  await resolveRound(rManualFresh, 'Manual fresh', 'Session manual', 'manual-launch');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Manual fresh'");
  await resolveRound(rBackgroundStale, 'Background stale', 'Session background', 'background-launch');
  await pause(100);
  assert.equal(await evaluate("document.querySelector('.provider-card .pc-name').textContent"),'Manual fresh','A newer manual refresh supersedes an older background tick; the late background response is rejected');
  assert.ok(await evaluate("document.getElementById('launches').textContent.includes('manual-launch')&&!document.getElementById('launches').textContent.includes('background-launch')"),'Launches show the winning manual round, not the stale background round');
  // Per-section isolation: one failed section keeps its last good data while the others update.
  const rSessionsFail = await triggerRound('manual');
  await resolveRound(rSessionsFail, 'Snapshot survived', 'Session lost', 'updated-launch', 'api/agent-sessions');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Snapshot survived'");
  assert.ok(await evaluate("document.getElementById('launch-agent-sessions').textContent.includes('Session manual')"),'Failed sessions retain last good history');
  assert.ok(await evaluate("document.getElementById('refresh-status').textContent.includes('Сессии')"));
  assert.ok(await evaluate("document.getElementById('launches').textContent.includes('updated-launch')"),'Launches update independently of failed sessions');
  const rSnapshotFail = await triggerRound('manual');
  await resolveRound(rSnapshotFail, 'Lost snapshot', 'Session independent', 'independent-launch', 'api/snapshot');
  await until("document.getElementById('launch-agent-sessions').textContent.includes('Session independent')");
  assert.equal(await evaluate("document.querySelector('.provider-card .pc-name').textContent"),'Snapshot survived', 'Failed snapshot retains providers');
  const rLaunchesFail = await triggerRound('manual');
  await resolveRound(rLaunchesFail, 'Launch failure isolated', 'Sessions still update', 'lost-launch', 'api/launches');
  await until("document.getElementById('launch-agent-sessions').textContent.includes('Sessions still update')");
  assert.ok(await evaluate("document.getElementById('launches').textContent.includes('independent-launch')&&!document.getElementById('launches').textContent.includes('lost-launch')"), 'Failed launches retain last good data');
  const rDisabled = await triggerRound('manual', "window.fixtureSnapshot.providers[0].disabledModelIds=['gpt-example']");
  await resolveRound(rDisabled, 'Model disabled remotely', 'Sessions still update', 'independent-launch');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Model disabled remotely'");
  assert.deepEqual(await evaluate("[document.getElementById('launch-model').value,document.getElementById('launch-model').selectedOptions[0].disabled]"),['gpt-example',true], 'Polling never silently switches an unavailable selection to a different model');
  await evaluate("document.getElementById('launch-project').value='C:/smoke';document.getElementById('launch-submit').click()");
  assert.ok(await evaluate("document.getElementById('launch-status').textContent.includes('недоступен')"),'Unavailable selection cannot submit');
  // M3-FINAL.4: the crossing rounds are done — every intercepted section request was resolved (nothing left
  // pending) and each of the roundSeq rounds enqueued exactly its three sections. Now restore the real network
  // boundary AND the native background clock exactly once, re-arming the single captured production refresh
  // callback, so the remaining page runs under ordinary 10s polling (NOT left disabled) with no test hook on
  // window.setInterval. __restoreTimerControl is idempotent and is also invoked best-effort in the finally.
  assert.equal(await evaluate("window.fixturePending.filter(request=>!request.done).length"),0,'Every intercepted section request from the crossing rounds was resolved — none left hanging');
  assert.equal(await evaluate("window.fixturePending.length"),roundSeq*3,'Each crossing round enqueued exactly its three section requests and all were accounted for');
  // M3-RACE.2: prove the ERROR-PATH timer-control cleanup actually restores native scheduling. On a thrown
  // error the finally calls cleanupTimerControl() — the exact closure exercised here — while timer control is
  // still active (released=false, one captured background tick: the before-forced-failure state). The old code
  // referenced the try-scoped `cdp` from the finally and threw `ReferenceError: cdp is not defined` into an
  // empty catch, so the restore silently never ran on the error path. Invoking the real closure here at that
  // state and asserting it both completes AND restores locks the regression in an executable check.
  assert.ok(await evaluate("window.__timerControlReleased===false&&window.__ticks.length===1"),'Error-path precondition: timer control still active with exactly one captured background tick (before-forced-failure state)');
  let errorPathCleanupThrew=null;
  try { await cleanupTimerControl(); } catch(cleanupError){ errorPathCleanupThrew=cleanupError instanceof Error?cleanupError.constructor.name+': '+cleanupError.message:String(cleanupError); }
  assert.equal(errorPathCleanupThrew,null,'Error-path cleanup runs without throwing (no out-of-scope `cdp is not defined` ReferenceError from the finally)');
  assert.ok(await evaluate("window.setInterval===window.__nativeSetInterval&&window.__timerControlReleased===true&&window.__ticks.length===0&&window.__reArmedTicks.length===1"),'Error-path cleanup restored native scheduling exactly once and neutralised the captured tick');
  await evaluate("document.getElementById('launch-dialog').close();window.fetch=window.fixtureFetch");
  assert.equal(await evaluate("window.__restoreTimerControl()"),1,'The normal restore is idempotent after the error-path cleanup already ran: it reports the same single re-armed background-refresh callback without double-arming');
  assert.ok(await evaluate("window.setInterval===window.__nativeSetInterval&&window.__timerControlReleased===true&&window.__ticks.length===0&&window.__reArmedTicks.length===1&&typeof window.__bgTick==='function'"),'Native setInterval is restored, the control globals are neutralised, and the captured tick is re-armed exactly once');
  await evaluate("document.getElementById('refresh').click()");
  await until("document.querySelector('.provider-card .pc-name').textContent==='SeekAI Demo'&&document.getElementById('refresh-status').hidden");
  application.launchProviderAutomatic = async () => { throw Object.assign(new Error('secret-canary'), { code: 'ENOENT', syscall: 'spawn fixture-agent' }); };
  const failedLaunch = await (await fetch(address.url+'api/launches', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectDirectory:'C:/smoke',providerId:'demo-0',modelId:'gpt-example'})})).json();
  await evaluate("document.getElementById('refresh').click()");
  await until("document.getElementById('launches').textContent.includes('EXECUTABLE_NOT_FOUND')");
  assert.ok(await evaluate(`document.getElementById('launches').textContent.includes(${JSON.stringify(failedLaunch.launch.id)})`), 'Visible launch error includes correlation ID');
  assert.ok(await evaluate("!document.getElementById('launches').textContent.includes('secret-canary')"));
  application.launchProviderAutomatic = async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  await fetch(address.url+'api/launches', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectDirectory:'C:/smoke',providerId:'demo-0',modelId:'gpt-example'})});
  await evaluate("document.getElementById('refresh').click()");
  await until("document.querySelector('#launches .CANCELLED')?.textContent==='ОТМЕНЕНО'");
  assert.equal(await evaluate("document.querySelectorAll('.provider-head-actions .button').length"),2);
  assert.equal(await evaluate("[...document.querySelectorAll('.provider-card .pc-top button')].filter(b=>b.textContent==='Запуск').length"),6, 'Each provider has a launch shortcut');
  await evaluate("document.getElementById('open-cookie-overview').click()");
  await until("document.getElementById('cookie-overview-dialog').open&&document.querySelectorAll('.cookie-overview-row').length===6");
  assert.equal(await evaluate("document.querySelectorAll('.cookie-overview-summary .cookie-overview-state').length"),4);
  assert.ok(await evaluate("[...document.querySelectorAll('.cookie-overview-row')].every(row=>{const values=[...row.querySelectorAll('.cookie-overview-state strong')].map(item=>item.textContent);return values.length===4&&values[0]==='Access token'&&values[2].startsWith('7 ')&&values.every(Boolean)})"),'Overview exposes account status text for every provider');
  assert.equal(await evaluate("document.querySelectorAll('.cookie-overview-row .cookie-overview-state.ok').length"),24);
  await evaluate("document.querySelector('.cookie-overview-actions .mini.active').click()");
  await until("document.getElementById('cookie-import-dialog').open");
  assert.equal(await evaluate("document.getElementById('cookie-import-form').elements.providerId.value"),'demo-0');
  assert.equal(await evaluate("document.getElementById('cookie-import-form').elements.siteUrl.value"),'https://demo-0.invalid');
  await evaluate("document.getElementById('cookie-import-dialog').close()");
  await until("document.getElementById('cookie-overview-dialog').open");
  await shot('cookie-overview');
  await evaluate("document.getElementById('cookie-overview-dialog').close()");
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate("document.getElementById('open-cookie-overview').click()");
  await until("document.getElementById('cookie-overview-dialog').open");
  assert.ok(await evaluate("document.documentElement.scrollWidth<=window.innerWidth&&document.getElementById('cookie-overview-dialog').scrollWidth<=document.getElementById('cookie-overview-dialog').clientWidth"),'Cookie overview fits on mobile');
  await shot('cookie-overview-mobile');
  await evaluate("document.getElementById('cookie-overview-dialog').close()");
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  assert.equal(await evaluate("document.getElementById('page-title').textContent"),'Провайдеры');
  assert.equal(await evaluate("document.querySelectorAll('.usage-bar').length"),14);
  await evaluate("document.getElementById('usage-period').value='week';document.getElementById('usage-period').dispatchEvent(new Event('change'))");
  assert.ok(await evaluate("document.querySelector('.usage-selected').textContent.includes('Неделя')"));

  assert.equal(await evaluate("document.getElementById('usage-history').hidden"),true);
  await evaluate("document.getElementById('open-usage-timeline').click()");
  assert.equal(await evaluate("document.getElementById('usage-history').hidden"),false);
  await shot('usage-expanded');
  await evaluate("document.getElementById('open-usage-timeline').click()");
  assert.equal(await evaluate("document.getElementById('usage-history').hidden"),true);
  assert.equal(await evaluate("new Set([...document.querySelectorAll('.provider-card')].map(card=>getComputedStyle(card).borderTopColor)).size"),1);
  await shot('providers-desktop');
  await evaluate("document.querySelector('.provider-card').click()");
  await until("document.querySelectorAll('.provider-mini-storefront .model-card').length===7");
  assert.equal(await evaluate("document.querySelector('.api-history-vertical')!==null"),true);
  await shot('provider-details');
  assert.ok(await evaluate("document.getElementById('provider-detail').scrollWidth<=document.getElementById('provider-detail').clientWidth"),'Provider drawer fits its width');
  await evaluate("document.getElementById('close-provider-drawer').click()");

  await evaluate("document.querySelector('.provider-card .mini.active').click()");
  await until("document.querySelectorAll('#models .model-card').length===7");
  console.log('Storefront rendered');
  assert.equal(await evaluate("document.getElementById('model-provider').value"),'demo-0');
  assert.equal(await evaluate("document.querySelectorAll('[data-page]:not([hidden])').length"),1);
  await shot('storefront-desktop');
  assert.ok(await evaluate("document.querySelector('#models [data-model-id=glm-example]').textContent.includes('исчезнет через')"));
  assert.equal(await evaluate("document.querySelectorAll('.catalog-state-heading').length"),0);
  await evaluate("document.querySelector('#models [data-model-id=claude-example] .model-quick-launch').click()");
  assert.equal(await evaluate("document.getElementById('launch-dialog').open"),true);
  assert.ok(await evaluate("document.getElementById('launch-preview').textContent.includes('Claude Code')"));
  assert.ok(await evaluate("(()=>{const d=document.getElementById('launch-dialog');return d.scrollWidth<=d.clientWidth})()"),'Launch dialog fits horizontally');
  await shot('quick-launch');
  await evaluate("document.getElementById('launch-model').value='gpt-example';document.getElementById('launch-model').dispatchEvent(new Event('change'))");
  assert.ok(await evaluate("document.getElementById('launch-preview').textContent.includes('Codex')"));
  await evaluate("document.getElementById('launch-dialog').close();document.querySelector('[data-nav=activity]').click()");
  assert.equal(await evaluate("document.querySelectorAll('#activity-chart svg').length"),1);
  assert.ok(await evaluate("!document.getElementById('activity-metrics').textContent.includes('USD 0.0000')"),'Cost keeps its monetary units');
  assert.equal(await evaluate("document.querySelectorAll('.model-health-row').length"),0);
  await shot('activity-tokens');
  await evaluate("document.querySelector('[data-chart=requests]').click()");
  await shot('activity-requests');
  await evaluate("document.querySelector('[data-chart=statuses]').click();document.querySelector('.provider-health-summary').open=true");
  await until("document.querySelectorAll('.model-health-row').length===7");
  await shot('activity-statuses');
  await evaluate("document.querySelector('[data-chart=ranking]').click()");
  assert.ok(await evaluate("document.querySelectorAll('.ranking-row').length>0"));
  await evaluate("[...document.querySelectorAll('.provider-card .pc-top button')].find(b=>b.textContent==='Запуск').click()");
  assert.equal(await evaluate("document.getElementById('launch-dialog').open"),true);
  await evaluate("document.getElementById('launch-dialog').close();document.querySelector('[data-nav=models]').click()");
  await evaluate("document.getElementById('model-provider').value='';document.getElementById('model-provider').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.querySelectorAll('.catalog-provider').length"),6);
  assert.ok(await evaluate("[...document.querySelectorAll('.catalog-provider')].every(section=>[...section.querySelectorAll('.model-provider-name')].every(name=>name.textContent===section.querySelector('h2').textContent))"));
  assert.equal(await evaluate("document.querySelectorAll('#model-group optgroup').length"),6);
  await shot('storefront-grouped');
  await evaluate("document.getElementById('model-provider').value='demo-0';document.getElementById('model-provider').dispatchEvent(new Event('change'))");
  await evaluate("document.querySelector('#models .model-card').click()");
  await until("document.getElementById('model-detail-dialog').open");
  assert.ok(await evaluate("document.getElementById('model-detail-body').textContent.includes('premium')"));
  assert.ok(await evaluate("Math.abs(document.getElementById('model-detail-dialog').getBoundingClientRect().right-window.innerWidth)<20"),'Details dock at the right edge');

  await shot('model-details');
  await evaluate("document.querySelector('[data-detail-tab=api]').click()");
  assert.equal(await evaluate("document.getElementById('detail-pane-api').hidden"),false);
  assert.equal(await evaluate("document.getElementById('detail-pane-overview').hidden"),true);
  await evaluate("document.querySelector('[data-detail-tab=performance]').click()");
  assert.equal(await evaluate("document.getElementById('detail-pane-performance').hidden"),false);
  await evaluate("document.querySelector('[data-detail-tab=overview]').click()");

  await evaluate("document.getElementById('model-detail-dialog').close();document.getElementById('model-group').value=JSON.stringify(['demo-0','free']);document.getElementById('model-group').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.querySelector('#models .price-grid strong').textContent"),'0 USD');
  await evaluate("document.getElementById('model-group').value=JSON.stringify(['demo-0','default']);document.getElementById('model-group').dispatchEvent(new Event('change'));document.querySelector('[data-model-view=table]').click()");
  assert.equal(await evaluate("document.querySelectorAll('#models tbody tr').length"),7);
  await evaluate("document.querySelector('[data-model-view=cards]').click();document.getElementById('model-search').value='gpt';document.getElementById('model-search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('#models .model-card').length"),1);
  await evaluate("document.getElementById('model-search').value='';document.getElementById('model-search').dispatchEvent(new Event('input'))");

  assert.equal(await evaluate("document.querySelectorAll('.model-mark').length"),0);
  assert.equal(await evaluate("document.querySelector('#models [data-model-id=qwen-example] .price-grid')"),null);
  assert.ok(await evaluate("document.querySelector('#models [data-model-id=qwen-example] .request-price').textContent.includes('запрос')"));
  await evaluate("document.querySelector('#models [data-model-id=qwen-example]').click()");
  assert.equal(await evaluate("document.querySelector('#model-detail-body .price-grid')"),null);
  assert.equal(await evaluate("[...document.querySelectorAll('#model-detail-body th')].some(th=>th.textContent==='Вход')"),false);
  await evaluate("[...document.querySelectorAll('#model-detail-body button')].find(b=>b.textContent==='Отключить модель').click()");
  await until("!document.getElementById('model-detail-dialog').open&&document.querySelectorAll('#models .model-card').length===6");
  assert.ok((await application.getProvider('demo-0')).disabledModelIds.includes('qwen-example'));
  await evaluate("document.querySelector('.catalog-provider-head button').click()");
  await until("document.getElementById('provider-dialog').open");
  await evaluate("document.getElementById('provider-form').elements.displayName.value='Unsubmitted draft';document.querySelector('[data-settings-tab=account]').click()");
  assert.equal(await evaluate("document.getElementById('portal-form').hidden"),false);
  await shot('combined-settings');
  await evaluate("document.getElementById('portal-cookie-import').click()");
  await until("document.getElementById('cookie-import-dialog').open");
  assert.equal(await evaluate("document.getElementById('cookie-import-form').elements.siteUrl.value"),'https://demo-0.invalid');
  await shot('cookie-editor-import');
  await evaluate("(()=>{const f=document.getElementById('cookie-import-form');f.elements.authKind.value='cookie';f.elements.authKind.dispatchEvent(new Event('change'));f.elements.raw.value=JSON.stringify([{domain:'.demo-0.invalid',path:'/',name:'session',value:'manual-cookie'}]);f.requestSubmit()})()");
  await until("!document.getElementById('cookie-import-dialog').open");
  assert.equal(await evaluate("document.getElementById('cookie-import-form').elements.raw.value"),'', 'Successful import clears raw credentials');
  const cookiePortal=(await application.listProviderPortals()).find(p=>p.connection.providerId==='demo-0');
  assert.equal(cookiePortal.connection.auth.kind,'cookie');
  assert.equal(await secrets.get(cookiePortal.connection.auth.secretRef),'session=manual-cookie');
  await evaluate("document.getElementById('cookie-import-dialog').close()");
  await evaluate("document.querySelector('[data-settings-tab=provider]').click()");
  assert.equal(await evaluate("document.getElementById('provider-form').elements.displayName.value"),'Unsubmitted draft');
  await evaluate("document.querySelector('#provider-model-controls details').open=true;document.querySelector('#provider-model-controls button').click()");
  await until("document.querySelectorAll('#models .model-card').length===7");
  assert.deepEqual((await application.getProvider('demo-0')).disabledModelIds,[]);
  await evaluate("document.getElementById('close-provider-dialog').click()");
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.ok(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"),'No mobile horizontal overflow');
  await shot('storefront-mobile');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await evaluate("document.querySelector('[data-nav=providers]').click();document.getElementById('add-provider').click()");
  await until("document.getElementById('provider-dialog').open");
  await evaluate("(()=>{const f=document.getElementById('provider-form');f.elements.displayName.value='My custom provider';f.elements.simpleBaseUrl.value='https://newfixture.invalid/v1';f.elements.simpleApiKey.value='new-model-key';document.querySelector('[data-provider-setup=auto]').click()})()");
  assert.equal(await evaluate("document.getElementById('provider-dialog').open"),true);
  assert.equal(await evaluate("document.getElementById('provider-form').elements.apiKey.value"),'new-model-key');
  await shot('add-provider-auto');
  await evaluate("document.querySelector('[data-provider-setup=simple]').click()");
  assert.equal(await evaluate("document.getElementById('provider-simple-setup').hidden"),false);
  assert.ok(await evaluate("document.querySelector('[data-provider-setup=auto]').getBoundingClientRect().height>=30"));
  assert.equal(await evaluate("document.getElementById('provider-form').elements.displayName.value"),'My custom provider');
  await shot('add-provider');
  await evaluate("(()=>{const f=document.getElementById('provider-form');f.elements.simpleBaseUrl.value='https://newfixture.invalid/v1';f.elements.simpleApiKey.value='new-model-key';f.elements.portalSiteUrl.value='https://newportal.invalid/profile';f.elements.portalToken.value='new-account-token';f.requestSubmit()})()");
  await until("!document.getElementById('provider-dialog').open&&document.querySelectorAll('.provider-card').length===7");
  const created = (await application.listProviders()).find(p=>p.baseUrl.includes('newfixture'));
  assert.ok(created);
  assert.equal(created.displayName,'My custom provider');
  const portal = (await application.listProviderPortals()).find(p=>p.connection.providerId===created.id);
  assert.equal(await secrets.get(created.auth.secretRef),'new-model-key');
  assert.equal(await secrets.get(portal.connection.auth.secretRef),'new-account-token');
  assert.notEqual(created.auth.secretRef,portal.connection.auth.secretRef);
  assert.equal(await secrets.get('FIXTURE_API'),'fixture-model-key');
  assert.equal(await evaluate("document.getElementById('provider-form').elements.portalToken.value"),'');
  // Re-edit without either key; keep both references and existing wallet.
  await evaluate(`[...document.querySelectorAll('[data-provider-id="${created.id}"] button')].find(b=>b.textContent==='Настройки').click()`);
  await until("document.getElementById('provider-dialog').open");
  await evaluate("document.getElementById('provider-form').elements.displayName.value='Renamed provider';document.getElementById('provider-form').requestSubmit()");
  await until("!document.getElementById('provider-dialog').open");
  assert.equal((await application.getProvider(created.id)).displayName,'Renamed provider');
  assert.equal((await application.getProvider(created.id)).auth.secretRef,created.auth.secretRef);
  assert.equal((await application.listProviderPortals()).find(p=>p.connection.providerId===created.id).connection.auth.secretRef,portal.connection.auth.secretRef);
  // A partial save must be retryable without resending the token or creating a duplicate API profile.
  const configure = application.setProviderPortal.bind(application);
  let failOnce=true;
  application.setProviderPortal=async input=>{if(failOnce){failOnce=false;throw new PortalConfigurationError('Fixture configuration failure')}return configure(input)};
  await evaluate("document.getElementById('add-provider').click();(()=>{const f=document.getElementById('provider-form');f.elements.simpleBaseUrl.value='https://partial.invalid/v1';f.elements.simpleApiKey.value='partial-api';f.elements.portalToken.value='partial-account';f.requestSubmit()})()");
  await until("document.querySelector('#provider-dialog .dialog-status')?.textContent.includes('Fixture configuration failure')");
  assert.equal((await application.listProviders()).length,8);
  assert.equal(await evaluate("document.getElementById('provider-form').elements.portalToken.value"),'');
  assert.equal(await evaluate("document.getElementById('provider-form').elements.portalSiteUrl.value"),'https://partial.invalid');
  await evaluate("(()=>{const f=document.getElementById('provider-form');f.elements.portalSiteUrl.value='https://different.invalid';f.requestSubmit()})()");
  await until("document.querySelector('#provider-dialog .dialog-status')?.textContent.includes('другому сайту')");
  await evaluate("(()=>{const f=document.getElementById('provider-form');f.elements.portalSiteUrl.value='https://partial.invalid';f.requestSubmit()})()");
  await until("!document.getElementById('provider-dialog').open");
  assert.equal((await application.listProviders()).length,8);
  const partialProvider=(await application.listProviders()).find(p=>p.baseUrl.includes('partial.invalid'));
  const partialPortal=(await application.listProviderPortals()).find(p=>p.connection.providerId===partialProvider.id);
  assert.equal(await secrets.get(partialPortal.connection.auth.secretRef),'partial-account');
  await application.setProvider({ id:'scale',displayName:'Scale Demo',baseUrl:'https://scale.invalid/v1',
    manualModelIds:Array.from({length:125},(_,i)=>'scale-model-'+String(i).padStart(3,'0')) });
  await evaluate("document.getElementById('refresh').click()");
  await until("document.querySelectorAll('.provider-card').length===9");
  await evaluate("document.querySelector('[data-nav=models]').click();document.getElementById('model-provider').value='scale';document.getElementById('model-provider').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.querySelectorAll('#models .model-card').length"),50);
  await evaluate("document.getElementById('models-next').click();document.getElementById('models-next').click()");
  assert.equal(await evaluate("document.querySelectorAll('#models .model-card').length"),25);
  assert.equal(await evaluate("document.getElementById('model-page').textContent"),'3 / 3');
  assert.deepEqual(errors,[], 'No browser exceptions');
  assert.deepEqual(fixtureServerErrors,['Error'], 'Only the deliberately unavailable initial sessions request failed');
  assert.ok(upstream.every(path=>!path.includes('completions')&&!path.includes('responses')));
  smokeResult={ok:true,checks:['navigation','provider header shortcuts','all-provider cookie overview','provider-scoped storefront','group price zero','table and cards','search','model details','Cookie-Editor import','mobile overflow','provider + two isolated credentials','edit preserves keys','partial save retry','token origin bound','125 models pagination','initial sessions failure isolation','three independent refresh sections','late response rejection','deterministic background tick vs manual refresh routing','background polling restored after crossing rounds (native interval re-armed once, no hook left)','error-path timer cleanup restores native scheduling once (finally reaches cdp, no ReferenceError)','keyboard focus + route selection','secret reference/action focus + reorder/removal/ambiguity','unavailable selection blocks launch','portal corruption banner desktop/mobile','recovered portal review banner','unknown secret usage + portal-only references','corruption blocks overwrite + permits fresh reference','safe vault diagnostic desktop/mobile + recovery','safe launch code + ID + cancellation','unconfirmed cancel stays non-terminal + retry-cancel + sanitized + controlled close','emergency fault-stop stays CANCELLING with original cause + retry gives one POST + controlled close to FAILED + sanitized','omp route readiness preview (nodes + no leak + no over-claim)','omp preview pending, refresh, reopen and failure gate stale preflight','readable approval label','no inference','no browser exceptions'],screenshots:output};
  smokeResult.checks.push('Doctor L3 readiness labels (accepted, blocked, unknown, legacy aliases) never assert a completed OMP pilot');
  smokeResult.ompPreviewLabels = previewTierObservations;
} catch(error) { console.error(error);process.exitCode=1; }
finally {
  // Cleanup on the error path too: deactivate the timer-control globals if the page is still reachable
  // (idempotent — a no-op when the normal restore already ran). cleanupTimerControl closes over the live
  // socket/cdp, so this reaches CDP from finally without the old out-of-scope `cdp is not defined`. Never
  // let cleanup mask the real failure: any residual error here is captured (name only) and the primary
  // error still stands. In a fault child the captured timer state is emitted on one allowlisted line so
  // the negative runner can prove the finally genuinely CALLED cleanup AND that it restored — a finally
  // that skips the call (state null) or throws (state {error}) is caught, never silently swallowed.
  let faultCleanupState = null;
  try { faultCleanupState = await cleanupTimerControl(); }
  catch (cleanupError) { faultCleanupState = { error: cleanupError instanceof Error ? cleanupError.constructor.name : 'unknown' }; }
  if (faultPhase) console.log('SMOKE_FAULT_CLEANUP ' + JSON.stringify({ phase: faultPhase, timer: faultCleanupState }));
  socket?.close();browser.kill();
  if(browser.exitCode===null&&browser.signalCode===null)await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),pause(2000)]);
  await Promise.race([server.stop(),pause(2000)]);
  try {
    const tempRoot=resolve(tmpdir());
    const ownedBrowserDirectory=resolve(browserDirectory);
    if(dirname(ownedBrowserDirectory)!==tempRoot||!/^providerdock-ui-[A-Za-z0-9]{6}$/.test(basename(ownedBrowserDirectory)))throw Error('Browser fixture path escaped the temporary directory');
    const item=await lstat(ownedBrowserDirectory);
    if(!item.isDirectory()||item.isSymbolicLink())throw Error('Browser fixture path is not an owned directory');
    await rm(ownedBrowserDirectory,{recursive:true,force:true,maxRetries:20,retryDelay:200});
  } catch(cleanupError) {
    console.error('Browser fixture cleanup failed: '+(cleanupError?.code||cleanupError?.name||'unknown'));
    process.exitCode=1;
  }
}
if(process.exitCode!==1&&smokeResult)console.log(JSON.stringify(smokeResult));

// M4.0 negative runner: spawn this same script once per fault phase and assert each child exercised the
// REAL finally. Output stays allowlisted (exit code, timer-state, the fixture cause) — never page content
// or secrets. Wrapped so a failed assertion produces a clean structured RED and a non-zero exit.
async function runNegativeCoverage() {
  const scriptPath = fileURLToPath(import.meta.url);
  const phases = [
    { phase: 'before-restore-active-timer', expectTimer: { native: true, released: true, ticks: 0, reArmed: 1 } },
    { phase: 'before-cdp-init', expectTimer: null },
  ];
  const results = [];
  try {
    for (const { phase, expectTimer } of phases) {
      const child = spawn(process.execPath, [scriptPath], {
        env: { ...process.env, PROVIDERDOCK_SMOKE_FAULT: phase }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      child.stdout.on('data', data => { out += data.toString(); });
      child.stderr.on('data', data => { err += data.toString(); });
      const exitCode = await new Promise((res, rej) => {
        const killTimer = setTimeout(() => { child.kill(); rej(new Error('Fault child hung (no exit within 120s): ' + phase)); }, 120000);
        child.on('exit', code => { clearTimeout(killTimer); res(code); });
        child.on('error', rej);
      });
      const combined = out + '\n' + err;
      assert.equal(exitCode, 1, `Fault child ${phase} must exit 1 after the thrown fixture cause (got ${exitCode})`);
      assert.ok(!out.includes('"ok":true'), `Fault child ${phase} must NOT report ok:true (the fault preceded any success)`);
      assert.ok(!combined.includes('ReferenceError') && !combined.includes('is not defined'), `Fault child ${phase} must not throw a scoping ReferenceError from the finally`);
      assert.ok(combined.includes('fixture-fault:' + phase), `Fault child ${phase} must surface its original fixture cause`);
      const line = out.split('\n').find(l => l.startsWith('SMOKE_FAULT_CLEANUP '));
      assert.ok(line, `Fault child ${phase} must emit the finally's timer-cleanup state`);
      const state = JSON.parse(line.slice('SMOKE_FAULT_CLEANUP '.length));
      if (expectTimer === null) {
        assert.equal(state.timer, null, `Fault child ${phase}: no CDP was wired up, so the finally has nothing to restore (safe teardown)`);
      } else {
        assert.ok(state.timer && typeof state.timer === 'object' && !('error' in state.timer), `Fault child ${phase}: finally cleanup must run and return an observable timer state without throwing`);
        assert.deepEqual({ native: state.timer.native, released: state.timer.released, ticks: state.timer.ticks, reArmed: state.timer.reArmed }, expectTimer, `Fault child ${phase}: finally restored native scheduling exactly once (ticks=0, reArmed=1)`);
      }
      results.push({ phase, exitCode, timer: state.timer });
    }
    console.log(JSON.stringify({ ok: true, negative: results }));
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, negative: 'FAILED', reason: error instanceof Error ? error.message : String(error), results }));
    process.exit(1);
  }
}
