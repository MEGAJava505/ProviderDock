// Run after npm run build. Isolated in-memory fixtures, no provider calls or user browser profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
let ompPreflightCalls = 0;
const ompLauncher = {
  preflight: async input => ++ompPreflightCalls === 1
    ? { ok: false, diagnostic: { operationId: '01937d71-7ae7-7abc-8100-000000000002', stage: 'validation', code: 'OPERATION_FAILED', message: 'Bearer sk-secret', retryable: false, suggestedAction: 'Fixture unsafe text', occurredAt: '2026-09-15T00:00:00.000Z' } }
    : { ok: true, providerId: input.providerId, accountId: input.accountId, modelId: input.modelId, api: 'openai-responses' },
  launch: async () => ({ ok: true, runId: ompRun.runId }),
  listRuns: async () => [ompRun],
  cancel: async () => undefined,
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
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let port;
  for (let i=0;i<100;i++) { try { port = (await readFile(join(browserDirectory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await pause(100); } }
  assert.ok(port, 'Chrome debugging port');
  console.log('Browser debugging port ready');
  const targets = await (await fetch('http://127.0.0.1:'+port+'/json')).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true}); });
  let id=0;
  const pending=new Map(); const errors=[];
  socket.addEventListener('message', event => { const message=JSON.parse(event.data); if(message.id){const waiter=pending.get(message.id);pending.delete(message.id);message.error?waiter.reject(new Error(JSON.stringify(message.error))):waiter.resolve(message.result)}if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails); });
  const cdp = (method,params={}) => new Promise((resolve,reject)=>{ const request=++id;const timer=setTimeout(()=>reject(new Error('CDP timeout: '+method)),15000);pending.set(request,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}});socket.send(JSON.stringify({id:request,method,params})); });
  const evaluate = async expression => { const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value; };
  const until = async expression => { for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100)}const state=await evaluate("({ready:document.readyState,status:document.getElementById('global-status')?.textContent||'',cards:document.querySelectorAll('.provider-card').length,secretStatus:document.querySelector('#secret-dialog .dialog-status')?.textContent||'',invalidSecretFields:[...document.querySelectorAll('#secret-form input')].filter(input=>!input.validity.valid).map(input=>input.name)})");throw new Error('UI condition timed out: '+expression+' state='+JSON.stringify(state)+' exceptions='+JSON.stringify(errors.slice(-3))); };
  const shot = async name => { await pause(250);const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,name+'.png'),Buffer.from(result.data,'base64')); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:address.url});
  await until("document.querySelectorAll('.provider-card').length===6");
  await until("document.getElementById('refresh-status').textContent.includes('Сессии')");
  application.listAgentSessions = async () => [];
  await evaluate("document.getElementById('refresh').click()");
  await until("document.getElementById('refresh-status').hidden");
  console.log('Providers rendered');
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
  await evaluate("(()=>{window.ompCalls=[];window.ompFetch=window.fetch.bind(window);window.fetch=(path,options)=>{if(String(path).startsWith('api/omp/'))window.ompCalls.push({path:String(path),method:options?.method||'GET'});return window.ompFetch(path,options)}})()");
  await evaluate("document.getElementById('launch-omp-acknowledgement').checked=true;document.getElementById('launch-omp-acknowledgement').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('omp-preflight-status').textContent.includes('OPERATION_FAILED')");
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'Failed preflight does not enable submit');
  assert.ok(await evaluate("document.getElementById('omp-preflight-status').textContent.includes('Операция не выполнена.')"), 'Safe preflight diagnostic is rendered');
  assert.ok(await evaluate("!document.body.textContent.includes('sk-secret')"), 'Unsafe diagnostic detail never reaches the DOM');
  await evaluate("document.getElementById('launch-omp-account').value='fixture-account-2';document.getElementById('launch-omp-account').dispatchEvent(new Event('input'));document.getElementById('launch-omp-account').value='fixture-account';document.getElementById('launch-omp-account').dispatchEvent(new Event('input'))");
  await evaluate("document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('launch-submit').disabled===false");
  assert.ok(await evaluate("document.getElementById('omp-preflight-status').textContent.includes('OMP preflight passed')"), 'Successful preflight is visible');
  await evaluate("document.getElementById('launch-model').value='gemini-example';document.getElementById('launch-model').dispatchEvent(new Event('change'))");
  assert.equal(await evaluate("document.getElementById('launch-submit').disabled"),true,'Any OMP input change invalidates preflight');
  await evaluate("document.getElementById('launch-model').value='gpt-example';document.getElementById('launch-model').dispatchEvent(new Event('change'));document.getElementById('launch-omp-preflight').click()");
  await until("document.getElementById('launch-submit').disabled===false");
  await evaluate("document.getElementById('launch-submit').click()");
  await until(`document.getElementById('launch-status').textContent.includes('${ompRun.runId}')`);
  assert.ok(await evaluate(`document.getElementById('omp-runs').textContent.includes('${ompRun.runId}')&&document.getElementById('omp-runs').textContent.includes('RUNNING')`), 'Safe OMP run history is rendered');
  assert.ok(await evaluate("window.ompCalls.some(call=>call.path==='api/omp/preflight'&&call.method==='POST')&&window.ompCalls.some(call=>call.path==='api/omp/launch'&&call.method==='POST')&&window.ompCalls.some(call=>call.path==='api/omp/runs'&&call.method==='GET')"), 'OMP UI uses only OMP API endpoints');
  assert.ok(await evaluate("!window.ompCalls.some(call=>call.path==='api/launches'&&call.method==='POST')"), 'OMP launch never posts through the legacy launcher API');
  await evaluate("window.fetch=window.ompFetch;delete window.ompFetch;delete window.ompCalls;document.getElementById('launch-dialog').close()");
  await until("!document.getElementById('launch-dialog').open");
  // Control only the HTTP boundary; assertions observe rendered state, not JS internals.
  await evaluate(`(async()=>{
    window.fixtureFetch=window.fetch.bind(window);
    window.fixtureSnapshot=await (await window.fixtureFetch('api/snapshot')).json();
    window.fixturePending=[];
    window.fetch=(path,options)=>['api/snapshot','api/launches','api/agent-sessions'].includes(path)
      ?new Promise(resolve=>window.fixturePending.push({path,resolve}))
      :window.fixtureFetch(path,options);
  })()`);
  const resolveRefresh = async (round, snapshotName, sessionTitle, launchId, failed = '') => evaluate(`(()=>{
    const batch=window.fixturePending.slice(${round * 3},${round * 3 + 3});
    if(batch.length!==3)throw Error('Missing refresh requests');
    for(const request of batch){
      const snapshot=structuredClone(window.fixtureSnapshot);snapshot.providers[0].displayName=${JSON.stringify(snapshotName)};
      const body=request.path==='api/snapshot'?snapshot:request.path==='api/launches'
        ?{launches:[{id:${JSON.stringify(launchId)},status:'RUNNING',request:{client:'codex',projectDirectory:${JSON.stringify(launchId)}},resolvedApprovalLevel:'ask',startedAt:'2026-09-15T00:00:00.000Z',fallbacks:[]}]}
        :{sessions:[{id:'16a96b51-c68d-4d6d-91c9-d82a5485a691',client:'codex',providerId:'demo-0',projectDirectory:'C:/smoke',modelId:'gpt-example',title:${JSON.stringify(sessionTitle)},updatedAt:'2026-09-15T00:00:00.000Z',resumable:true}]};
      if(request.path===${JSON.stringify(failed)})request.resolve(Response.json({message:'Fixture section unavailable'},{status:503}));
      else request.resolve(Response.json(body));
    }
  })()`);
  await evaluate("document.querySelector('.provider-card .mini.active').focus();document.getElementById('refresh').click()");
  await until("window.fixturePending.length===3");
  await resolveRefresh(0, 'Newest fixture', 'Session newest', 'newest-launch');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Newest fixture'");
  assert.ok(await evaluate("document.activeElement?.textContent==='Модели и цены'&&document.activeElement.closest('[data-provider-id]')?.dataset.providerId==='demo-0'"), 'Polling preserves keyboard focus on provider actions');
  await evaluate("[...document.querySelectorAll('.provider-card .pc-top button')].find(b=>b.textContent==='Запуск').click();document.getElementById('launch-client').value='auto';document.getElementById('launch-client').dispatchEvent(new Event('change'));document.getElementById('launch-model').value='gpt-example';document.getElementById('launch-approval').value='ask';document.getElementById('launch-model').focus();document.getElementById('refresh').click()");
  await until("window.fixturePending.length===6");
  // The older round stays pending while a newer one succeeds.
  await evaluate("document.getElementById('refresh').click()");
  await until("window.fixturePending.length===9");
  await resolveRefresh(2, 'Fresh fixture', 'Session fresh', 'fresh-launch');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Fresh fixture'");
  await resolveRefresh(1, 'Stale fixture', 'Session stale', 'stale-launch');
  await pause(100);
  assert.equal(await evaluate("document.querySelector('.provider-card .pc-name').textContent"),'Fresh fixture');
  assert.ok(await evaluate("document.getElementById('launch-agent-sessions').textContent.includes('Session fresh')&&!document.getElementById('launch-agent-sessions').textContent.includes('Session stale')"));
  assert.deepEqual(await evaluate("[document.getElementById('launch-provider').value,document.getElementById('launch-model').value,document.getElementById('launch-approval').value,document.activeElement.id]"),['demo-0','gpt-example','ask','launch-model']);
  await evaluate("document.getElementById('refresh').click()");
  await until("window.fixturePending.length===12");
  await resolveRefresh(3, 'Snapshot survived', 'Session lost', 'updated-launch', 'api/agent-sessions');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Snapshot survived'");
  assert.ok(await evaluate("document.getElementById('launch-agent-sessions').textContent.includes('Session fresh')"),'Failed sessions retain last good history');
  assert.ok(await evaluate("document.getElementById('refresh-status').textContent.includes('Сессии')"));
  assert.ok(await evaluate("document.getElementById('launches').textContent.includes('updated-launch')"),'Launches update independently of failed sessions');
  await evaluate("document.getElementById('refresh').click()");
  await until("window.fixturePending.length===15");
  await resolveRefresh(4, 'Lost snapshot', 'Session independent', 'independent-launch', 'api/snapshot');
  await until("document.getElementById('launch-agent-sessions').textContent.includes('Session independent')");
  assert.equal(await evaluate("document.querySelector('.provider-card .pc-name').textContent"),'Snapshot survived', 'Failed snapshot retains providers');
  await evaluate("document.getElementById('refresh').click()");
  await until("window.fixturePending.length===18");
  await resolveRefresh(5, 'Launch failure isolated', 'Sessions still update', 'lost-launch', 'api/launches');
  await until("document.getElementById('launch-agent-sessions').textContent.includes('Sessions still update')");
  assert.ok(await evaluate("document.getElementById('launches').textContent.includes('independent-launch')&&!document.getElementById('launches').textContent.includes('lost-launch')"), 'Failed launches retain last good data');
  await evaluate("window.fixtureSnapshot.providers[0].disabledModelIds=['gpt-example'];document.getElementById('refresh').click()");
  await until("window.fixturePending.length===21");
  await resolveRefresh(6, 'Model disabled remotely', 'Sessions still update', 'independent-launch');
  await until("document.querySelector('.provider-card .pc-name').textContent==='Model disabled remotely'");
  assert.deepEqual(await evaluate("[document.getElementById('launch-model').value,document.getElementById('launch-model').selectedOptions[0].disabled]"),['gpt-example',true], 'Polling never silently switches an unavailable selection to a different model');
  await evaluate("document.getElementById('launch-project').value='C:/smoke';document.getElementById('launch-submit').click()");
  assert.ok(await evaluate("document.getElementById('launch-status').textContent.includes('недоступен')"),'Unavailable selection cannot submit');
  await evaluate("document.getElementById('launch-dialog').close();window.fetch=window.fixtureFetch;document.getElementById('refresh').click()");
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
  console.log(JSON.stringify({ok:true,checks:['navigation','provider header shortcuts','all-provider cookie overview','provider-scoped storefront','group price zero','table and cards','search','model details','Cookie-Editor import','mobile overflow','provider + two isolated credentials','edit preserves keys','partial save retry','token origin bound','125 models pagination','initial sessions failure isolation','three independent refresh sections','late response rejection','keyboard focus + route selection','secret reference/action focus + reorder/removal/ambiguity','unavailable selection blocks launch','portal corruption banner desktop/mobile','unknown secret usage + portal-only references','corruption blocks overwrite + permits fresh reference','safe vault diagnostic desktop/mobile + recovery','safe launch code + ID + cancellation','readable approval label','no inference','no browser exceptions'],screenshots:output}));
} catch(error) { console.error(error);process.exitCode=1; }
finally { socket?.close();browser.kill();await Promise.race([server.stop(),pause(2000)]); }
