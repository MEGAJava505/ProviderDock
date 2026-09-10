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
const server = new ProviderDashboardServer({ application, healthMonitorIntervalMs: 0 });
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
  const until = async expression => { for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100)}const state=await evaluate("({ready:document.readyState,status:document.getElementById('global-status')?.textContent||'',cards:document.querySelectorAll('.provider-card').length})");throw new Error('UI condition timed out: '+expression+' state='+JSON.stringify(state)+' exceptions='+JSON.stringify(errors.slice(-3))); };
  const shot = async name => { await pause(250);const result=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(output,name+'.png'),Buffer.from(result.data,'base64')); };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:address.url});
  await until("document.querySelectorAll('.provider-card').length===6");
  console.log('Providers rendered');
  assert.equal(await evaluate("document.querySelectorAll('.provider-head-actions .button').length"),3);
  assert.equal(await evaluate("document.querySelectorAll('.provider-head-actions [data-open-launch]').length"),1);
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
  await evaluate("document.getElementById('quick-launch').click()");
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
  await evaluate("(()=>{const f=document.getElementById('cookie-import-form');f.elements.raw.value=JSON.stringify([{domain:'.demo-0.invalid',path:'/',name:'session',value:'manual-cookie'}]);f.requestSubmit()})()");
  await until("document.getElementById('cookie-import-status').textContent.includes('cookies приняты')");
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
  assert.ok(upstream.every(path=>!path.includes('completions')&&!path.includes('responses')));
  console.log(JSON.stringify({ok:true,checks:['navigation','provider header shortcuts','all-provider cookie overview','provider-scoped storefront','group price zero','table and cards','search','model details','Cookie-Editor import','mobile overflow','provider + two isolated credentials','edit preserves keys','partial save retry','token origin bound','125 models pagination','no inference','no browser exceptions'],screenshots:output}));
} catch(error) { console.error(error);process.exitCode=1; }
finally { socket?.close();browser.kill();await Promise.race([server.stop(),pause(2000)]); }
