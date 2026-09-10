export const providerDashboardCss = `
:root{
  color-scheme:dark;
  --bg:#101113;--surface:#181a1e;--surface-2:#202227;--surface-3:#292c32;
  --line:#2c2f35;--line-strong:#444851;
  --text:#f1f2f5;--muted:#b0b5bf;--faint:#9198a5;
  --accent:#a5bbff;--accent-hover:#c0ceff;--accent-dim:rgba(165,187,255,.12);
  --ok:#3fb27f;--ok-dim:rgba(63,178,127,.13);
  --warn:#d9a13f;--warn-dim:rgba(217,161,63,.13);
  --err:#e06060;--err-dim:rgba(224,96,96,.12);
  --r:10px;
  font-family:"Segoe UI",Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;
  font-size:14px;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--text)}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer}
[hidden]{display:none!important}
button:disabled{opacity:.45;cursor:not-allowed}
main{width:min(1240px,calc(100% - 40px));margin:0 auto;padding:20px 0 60px}

/* ---------- page head ---------- */
.page-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
.page-head h1{font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0}
.head-state{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--faint);flex:none}
.dot.on{background:var(--ok)}
.dot.off{background:var(--err)}
.link-button{background:none;border:0;color:var(--accent);padding:2px 4px;font-size:12px}
.link-button:hover{text-decoration:underline}
.portal-login-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}

/* ---------- stats strip ---------- */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:var(--r);margin-bottom:12px;overflow:hidden}
.stat{background:var(--surface);padding:10px 14px;display:grid;gap:2px}
.stat span{color:var(--muted);font-size:11px}
.stat strong{font-size:19px;font-weight:650;letter-spacing:-.02em}
.stat small{color:var(--faint);font-size:10px}

/* ---------- panels ---------- */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);margin-bottom:12px;min-width:0}
.panel-head{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.panel-head h2{font-size:13px;font-weight:650;margin:0;letter-spacing:.01em}
.count{font-size:11px;color:var(--muted);border:1px solid var(--line-strong);border-radius:3px;padding:1px 7px}
.spacer{flex:1}
.hint{color:var(--muted);font-size:11px}
.hint.accent{color:var(--accent)}
.hint.padded{margin:0;padding:8px 14px 0}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.two-col .panel{margin-bottom:12px}
.workspace-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;align-items:stretch}
.workspace-grid .panel{margin-bottom:12px}
.providers-panel,.launch-panel{height:100%}
.providers-panel{display:grid;grid-template-rows:auto minmax(0,1fr)}
.launch-panel .panel-head{padding:9px 12px}

/* ---------- help toggle ---------- */
.help{position:relative;margin-left:-4px}
.help>summary{list-style:none;cursor:pointer;width:20px;height:20px;display:grid;place-items:center;border:1px solid var(--line-strong);border-radius:3px;color:var(--muted);font-size:11px;user-select:none}
.help>summary::-webkit-details-marker{display:none}
.help[open]>summary{color:var(--text);border-color:var(--accent);background:var(--accent-dim)}
.help-body{position:absolute;z-index:30;top:26px;left:0;width:min(430px,80vw);background:var(--surface-2);border:1px solid var(--line-strong);border-radius:var(--r);padding:10px 12px;font-size:11.5px;line-height:1.55;color:var(--muted);box-shadow:0 10px 30px rgba(0,0,0,.4)}

/* ---------- buttons ---------- */
.button{border:1px solid var(--line-strong);background:var(--surface-2);border-radius:var(--r);padding:6px 12px;font-size:12px;font-weight:550;white-space:nowrap}
.button:hover{border-color:var(--accent);color:#dbe7fb}
.button.primary{background:var(--accent);border-color:var(--accent);color:#0c1524;font-weight:650}
.button.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover);color:#0c1524}
.button.danger{color:#f0b1b1}
.button.danger:hover{border-color:var(--err)}
.icon-button{background:none;border:0;color:var(--muted);font-size:20px;line-height:1;padding:2px 6px}
.icon-button:hover{color:var(--text)}
.mini{border:1px solid var(--line-strong);background:var(--surface-2);border-radius:3px;padding:3px 8px;font-size:11px;white-space:nowrap}
.mini:hover{border-color:var(--accent)}
.mini.danger{color:#f0b1b1}
.mini.danger:hover{border-color:var(--err)}
.mini.active{border-color:var(--accent);color:#dbe7fb;background:var(--accent-dim)}
.mini.check{position:relative;transition:background-color .15s,border-color .15s,color .15s}
.mini.check.check-busy{border-color:var(--accent);background:var(--accent-dim);color:#cfe0fb}
.mini.check.check-ok{border-color:rgba(63,178,127,.65);background:var(--ok-dim);color:#a9dec5}
.mini.check.check-error{border-color:rgba(224,96,96,.7);background:var(--err-dim);color:#f3b2b2}
.mini.check.check-busy:before{content:"";display:inline-block;width:8px;height:8px;margin-right:5px;border:1px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---------- forms ---------- */
label{display:grid;gap:5px;color:var(--muted);font-size:11.5px;min-width:0}
input,select,textarea{width:100%;border:1px solid var(--line-strong);background:var(--surface-2);border-radius:var(--r);padding:7px 9px;outline:none;color:var(--text)}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-dim)}
textarea{resize:vertical}
small{font-size:10.5px;color:var(--faint);line-height:1.45}
.optional{color:var(--faint);font-weight:400}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.field-label{color:var(--muted);font-size:11.5px;margin-bottom:-2px}
.input-action{display:grid;grid-template-columns:1fr auto;gap:6px;min-width:0}
.checkbox-label{display:flex;align-items:center;gap:8px;align-self:end;min-height:33px}
.checkbox-label input{width:auto}
#launch-form{display:grid;gap:10px;padding:14px}
.launch-row{display:grid;grid-template-columns:minmax(220px,1fr) 170px auto;gap:10px;align-items:end}
.launch-row .grow{min-width:0}
.launch-panel #launch-form{gap:9px;padding:12px}
.launch-panel .route-tabs{width:100%;display:grid;grid-template-columns:1fr 1fr}
.launch-panel .route-tab{border-bottom:1px solid var(--line);text-align:center;padding:6px 7px}
.launch-panel .route-tab:nth-child(2n){border-right:0}
.launch-panel .route-tab:nth-last-child(-n+2){border-bottom:0}
.launch-panel .form-row{grid-template-columns:1fr}
.launch-panel .input-action{grid-template-columns:minmax(0,1fr)}
.launch-panel .launch-submit{width:100%;margin-top:1px}
.launch-panel input[readonly]{color:var(--muted);cursor:default}

/* ---------- route tabs ---------- */
.route-tabs{display:flex;gap:0;border:1px solid var(--line-strong);border-radius:var(--r);overflow:hidden;width:max-content;max-width:100%;flex-wrap:wrap}
.route-tab{border:0;background:var(--surface-2);color:var(--muted);padding:6px 13px;font-size:12px;border-right:1px solid var(--line)}
.route-tab:last-child{border-right:0}
.route-tab:hover{color:var(--text)}
.route-tab.active{background:var(--accent);color:#0c1524;font-weight:650}
.route-fields{margin:0}

/* ---------- status dots & badges ---------- */
.badge{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:650;letter-spacing:.03em;border-radius:3px;padding:2px 8px;white-space:nowrap}
.badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.ONLINE{color:var(--ok);background:var(--ok-dim)}
.badge.DEGRADED,.badge.RATE_LIMITED{color:var(--warn);background:var(--warn-dim)}
.badge.OFFLINE,.badge.AUTH_ERROR,.badge.INCOMPATIBLE,.badge.FAILED{color:var(--err);background:var(--err-dim)}
.badge.DISABLED,.badge.UNKNOWN{color:var(--faint);background:var(--surface-3)}
.badge.STARTING{color:var(--warn);background:var(--warn-dim)}
.badge.RUNNING{color:var(--ok);background:var(--ok-dim)}
.badge.EXITED{color:var(--muted);background:var(--surface-3)}
.badge.plain{background:var(--surface-3);color:var(--muted)}

.chip{display:inline-block;font-size:10px;font-weight:600;border-radius:3px;padding:1px 6px;border:1px solid var(--line-strong);color:var(--muted);white-space:nowrap}
.chip.ok{color:var(--ok);border-color:rgba(63,178,127,.45)}
.chip.warn{color:var(--warn);border-color:rgba(217,161,63,.45)}
.chip.err{color:var(--err);border-color:rgba(224,96,96,.45)}
.chip.info{color:var(--accent);border-color:rgba(77,141,240,.45)}

/* ---------- inline status lines ---------- */
.status-line{display:none;border-radius:var(--r);padding:7px 10px;font-size:11.5px;line-height:1.5;border:1px solid transparent;margin:8px 0 0}
.status-line.busy{display:block;color:var(--muted);background:var(--surface-2);border-color:var(--line)}
.status-line.ok{display:block;color:#9fd4bb;background:var(--ok-dim);border-color:rgba(63,178,127,.4)}
.status-line.err{display:block;color:#f0b1b1;background:var(--err-dim);border-color:rgba(224,96,96,.4)}

/* ---------- providers ---------- */
.provider-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;padding:10px 12px 12px;align-content:start}
.provider-card{border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2);padding:10px 12px;display:grid;gap:8px;align-content:start;cursor:pointer;transition:border-color .12s,background-color .12s}
.provider-card:hover{border-color:var(--line-strong)}
.provider-card.selected{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent-dim)}
.pc-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pc-name{font-size:13px;font-weight:650}
.pc-url{color:var(--faint);font-size:11px;font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px}
.pc-meta{display:flex;gap:14px;color:var(--muted);font-size:11px;flex-wrap:wrap}
.pc-meta b{color:var(--text);font-weight:600}
.pc-actions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;align-items:center}
.provider-card .status-line{margin:0}
.empty{color:var(--faint);font-size:12px;text-align:center;padding:18px 14px}

/* ---------- models ---------- */
.model-groups{display:grid}
.model-group{border-bottom:1px solid var(--line)}
.model-group:last-child{border-bottom:0}
.model-group>summary{list-style:none;display:flex;align-items:center;gap:9px;padding:7px 12px;cursor:pointer;color:var(--text);font-size:12px;font-weight:600}
.model-group>summary::-webkit-details-marker{display:none}
.model-group>summary:after{content:"▾";color:var(--faint);margin-left:auto;font-size:10px}
.model-group:not([open])>summary:after{content:"▸"}
.mg-name{font-weight:650}
.mg-meta{color:var(--faint);font-size:11px;font-weight:400}
.table-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--faint);font-size:10px;letter-spacing:.06em;text-transform:uppercase;padding:5px 10px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-weight:600;white-space:nowrap}
td{padding:5px 10px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle}
tr:last-child td{border-bottom:0}
.model-id{font-weight:600}
.model-sub{display:block;color:var(--faint);font-size:10px;margin-top:1px;max-width:300px;overflow:hidden;text-overflow:ellipsis}
.num{font-variant-numeric:tabular-nums}
.bar{width:64px;height:5px;background:var(--surface-3);border-radius:2px;overflow:hidden;display:inline-block;vertical-align:middle}
.bar i{display:block;height:100%;border-radius:2px}
.bar.ok i{background:var(--ok)}
.bar.warn i{background:var(--warn)}
.bar.err i{background:var(--err)}

/* ---------- chains ---------- */
.chain-list{display:grid;gap:8px;padding:12px 14px 14px}
.chain-item{border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2);padding:9px 12px;display:grid;gap:7px}
.chain-title{display:flex;align-items:center;gap:10px}
.chain-title strong{font-size:12.5px}
.chain-routes{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chain-step{display:inline-flex;align-items:center;gap:5px;font-size:11px;border:1px solid var(--line-strong);border-radius:3px;padding:2px 8px;color:var(--text)}
.chain-step .n{color:var(--accent);font-weight:700}
.chain-step.off{opacity:.45;text-decoration:line-through}
.chain-arrow{color:var(--faint);font-size:11px}
.item-actions{display:flex;gap:6px;margin-left:auto}

/* ---------- generic item lists ---------- */
.item-list{display:grid;padding:8px 14px 12px}
.item-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);min-width:0}
.item-row:last-child{border-bottom:0}
.item-main{min-width:0;flex:1}
.item-title{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-sub{font-size:10.5px;color:var(--faint);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-right{display:flex;align-items:center;gap:8px;flex:none}
.item-right .strong{font-size:12px;font-weight:600}

/* ---------- provider drawer ---------- */
.drawer-backdrop{position:fixed;inset:0;z-index:80;background:rgba(8,9,11,.6);backdrop-filter:blur(1px)}
.provider-drawer{position:fixed;z-index:81;top:0;right:0;width:min(560px,calc(100vw - 18px));height:100vh;background:var(--surface);border-left:1px solid var(--line-strong);box-shadow:-18px 0 50px rgba(0,0,0,.38);transform:translateX(102%);transition:transform .18s ease;display:grid;grid-template-rows:auto minmax(0,1fr)}
.provider-drawer.open{transform:translateX(0)}
.drawer-head{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid var(--line)}
.drawer-head h2{margin:0;font-size:13px}
.drawer-body{min-height:0;overflow:auto}
body.drawer-open{overflow:hidden}
.pd-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--line)}
.pd-title{display:grid;gap:3px;min-width:0}
.pd-title h2{margin:0;font-size:15px}
.pd-title span{color:var(--faint);font-size:11px;font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis}
.pd-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border-bottom:1px solid var(--line)}
.pd-stats .stat{border-radius:0}
.pd-section{padding:11px 14px;border-bottom:1px solid var(--line)}
.pd-section:last-child{border-bottom:0}
.pd-section h3{margin:0 0 8px;font-size:12px;font-weight:650;color:var(--muted);letter-spacing:.02em}
.pd-source{margin:-2px 0 9px;color:var(--faint);font-size:10.5px;line-height:1.45}
.kv-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}
.kv{display:grid;gap:2px;min-width:0}
.kv span{color:var(--faint);font-size:10.5px}
.kv b{font-size:12px;font-weight:550;word-break:break-all}
.kv b.mono{font-family:ui-monospace,Consolas,monospace}
.signal-list{display:grid;gap:0}
.signal-row{display:flex;gap:12px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--line);font-size:11.5px}
.signal-row:last-child{border-bottom:0}
.signal-row .when{color:var(--faint);font-size:10.5px;width:110px;flex:none}
.signal-row .what{color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.signal-row .out{margin-left:auto;flex:none}
.drawer-models{display:grid;gap:5px}
.drawer-model{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;align-items:center;padding:7px 8px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2)}
.drawer-model-main{min-width:0}
.drawer-model-name{display:block;font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drawer-model-meta{display:block;margin-top:2px;color:var(--faint);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.drawer-model-actions{display:flex;gap:5px;grid-row:1 / span 2;grid-column:2}
.drawer-error{padding:6px 0;border-bottom:1px solid var(--line);font-size:11px;line-height:1.4}
.drawer-error:last-child{border-bottom:0}
.drawer-error small{display:block;margin-bottom:2px}

/* ---------- dialogs ---------- */
dialog{border:0;background:transparent;padding:16px;width:min(640px,calc(100% - 32px));max-height:calc(100vh - 32px)}
dialog.wide{width:min(760px,calc(100% - 32px))}
dialog.narrow{width:min(460px,calc(100% - 32px))}
dialog::backdrop{background:rgba(8,9,11,.72)}
.dialog-card{background:var(--surface);border:1px solid var(--line-strong);border-radius:6px;display:grid;grid-template-rows:auto 1fr auto;max-height:calc(100vh - 64px)}
.dialog-head,.dialog-foot{display:flex;align-items:center;justify-content:space-between;padding:12px 16px}
.dialog-head{border-bottom:1px solid var(--line)}
.dialog-head h2{margin:0;font-size:14px}
.dialog-foot{border-top:1px solid var(--line);justify-content:flex-end;gap:8px}
.dialog-body{padding:16px;overflow:auto;display:grid;gap:12px;align-content:start}
.quick-setup-actions{display:flex;align-items:center;gap:12px}
.quick-setup-actions span{color:var(--muted);font-size:11px;line-height:1.4}
.quick-setup-actions span.detected{color:#9fd4bb}
.quick-setup-actions span.error{color:#f0b1b1}
.provider-setup-tabs{width:100%;display:grid;grid-template-columns:1fr 1fr}
.provider-setup-tabs .route-tab{text-align:center}
.provider-setup-pane{display:grid;gap:12px}
.provider-setup-pane[hidden]{display:none}
details>summary{cursor:pointer;color:var(--muted);font-size:11.5px;user-select:none}
details>summary:hover{color:var(--text)}
.advanced-fields{display:grid;gap:10px;margin-top:10px;padding:12px;border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2)}

/* ---------- chain editor ---------- */
.chain-editor{display:grid;gap:6px;min-height:40px;border:1px dashed var(--line-strong);border-radius:var(--r);padding:8px}
.chain-editor-row{display:flex;align-items:center;gap:8px;border:1px solid var(--line-strong);border-radius:var(--r);background:var(--surface-2);padding:6px 8px;font-size:12px}
.chain-editor-row.dragging{opacity:.4}
.chain-editor-row .pos{color:var(--accent);font-weight:700;width:18px;text-align:center;flex:none}
.chain-editor-row .handle{cursor:grab;color:var(--faint);flex:none;letter-spacing:-1px}
.chain-editor-row .route-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chain-editor-row .route-name small{color:var(--faint);margin-left:6px}
.chain-editor-row.off .route-name{text-decoration:line-through;opacity:.55}
.chain-editor-row .ctrl{border:0;background:none;color:var(--muted);padding:2px 5px;border-radius:3px;font-size:13px}
.chain-editor-row .ctrl:hover{color:var(--text);background:var(--surface-3)}
.chain-empty{color:var(--faint);font-size:11.5px;text-align:center;padding:10px}

.storefront-controls{display:flex;flex-wrap:wrap;align-items:end;gap:12px;padding:12px 16px}
.portal-summary{display:flex;flex-wrap:wrap;align-items:center;gap:12px;border-top:1px solid var(--line);padding-top:10px;margin-top:10px}
.portal-values{display:flex;flex-wrap:wrap;gap:6px 16px;flex:1;font-size:12px}
.portal-summary .pc-actions{flex-wrap:wrap}
.storefront-controls label{flex:1;min-width:150px;margin:0}
.storefront-controls label:first-child{flex:2}
.storefront-note{padding:0 16px 12px;margin:0}
#models .mini{margin:2px}
@media(max-width:1000px){
  .two-col{grid-template-columns:1fr}
  .workspace-grid{grid-template-columns:1fr}
  .launch-panel{position:static}
  .launch-panel .input-action{grid-template-columns:1fr auto}
  .launch-panel .form-row{grid-template-columns:1fr 1fr}
  .stats{grid-template-columns:1fr 1fr}
  .pd-stats{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:720px){
  main{width:calc(100% - 20px)}
  .stats{grid-template-columns:1fr 1fr}
  .form-row,.launch-row{grid-template-columns:1fr}
  .route-tabs{width:100%}
  .route-tab{flex:1;text-align:center}
  .launch-panel .form-row,.launch-panel .input-action{grid-template-columns:1fr}
  .pc-url{max-width:180px
  }
}

/* Workspace navigation and catalog. Subtle surfaces and layered shadows inspired by UI Tools. */
.app-sidebar{position:fixed;inset:0 auto 0 0;width:232px;padding:30px 16px 22px;background:#151619;border-right:1px solid var(--line);display:flex;flex-direction:column;z-index:20}
.brand{display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--text);font-size:17px;font-weight:650;padding:0 10px 35px}
.brand-mark{display:grid;place-items:center;background:linear-gradient(140deg,#c4d3ff,#8da7f3);color:#17234a;box-shadow:0 2px 6px #0005,inset 0 1px #fff6;border-radius:11px;width:36px;height:36px;font-size:23px}
.brand small{display:block;font-size:10px;font-weight:400;margin-top:4px;letter-spacing:.02em}
.nav-label{padding:0 12px 12px;color:var(--faint);font-size:10px;text-transform:uppercase;letter-spacing:.13em}
.app-sidebar nav{display:grid;gap:6px}
.nav-item{display:flex;gap:12px;align-items:center;border:1px solid transparent;background:transparent;border-radius:8px;padding:11px 12px;text-align:left;color:var(--muted);font-size:13px;min-height:44px}
.nav-item span{width:20px;font-size:20px;text-align:center;font-weight:400}
.nav-item:hover{color:var(--text);background:var(--surface-2)}
.nav-item.active{background:var(--accent-dim);border-color:#a5bbff25;color:#d3ddff;font-weight:600}
.sidebar-foot{margin-top:auto;padding:18px 10px 0;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
.sidebar-foot .dot{display:inline-block;margin-right:6px;width:6px;height:6px}.sidebar-foot small{display:block;margin:8px 0 0 15px}
main{width:auto;max-width:1900px;margin:0 0 0 232px;padding:36px clamp(20px,3vw,52px) 60px}
.page-head{align-items:flex-start;margin-bottom:30px;gap:24px}.page-head h1{font-size:30px;letter-spacing:-.035em;margin:8px 0 9px;font-weight:650}.page-head p{margin:0;color:var(--muted);font-size:13px;line-height:1.6;max-width:700px}.eyebrow{display:block;font-size:10px;letter-spacing:.1em;color:var(--faint);line-height:1.6}.head-state{padding-top:10px;white-space:nowrap;font-size:11px}
.workspace-grid{display:contents}.stats{gap:16px;background:transparent;border:0;margin-bottom:26px;overflow:visible}.stat{padding:18px 20px;border:1px solid var(--line);border-radius:var(--r);box-shadow:0 2px 3px #0002,inset 0 1px #ffffff03;gap:7px}.stat strong{font-size:27px}.stat span,.stat small{font-size:12px}
.panel{border-radius:12px;box-shadow:0 2px 3px #0002;margin-bottom:22px}.panel-head{padding:18px 20px;min-height:70px}.panel-head h2{font-size:15px}.hint{font-size:12px;line-height:1.6}.count{border:0;border-radius:20px;background:var(--surface-3);padding:3px 10px;font-size:11px}
.button{padding:9px 14px;border-radius:8px;min-height:37px}.mini{padding:6px 10px;font-size:12px;border-radius:7px;min-height:30px}.mini.active{color:#d3ddff;border-color:#a5bbfF60}.icon-button{min-width:32px;min-height:32px;border-radius:6px}.icon-button:hover{background:var(--surface-3)}
label{font-size:12px;gap:7px}input,select,textarea{padding:10px 12px;font-size:13px;border-radius:8px;min-height:39px}input[type=checkbox]{width:16px;min-height:16px;accent-color:var(--accent)}label:has(>input[type=checkbox]){display:flex;align-items:center;gap:9px}.form-row{gap:16px}small{font-size:11px}a:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.provider-filters{display:flex;gap:18px;align-items:end;padding:18px 20px 8px}.provider-filters label{max-width:440px;flex:1}.provider-filters .hint{margin-bottom:10px}
.provider-list{grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:16px;padding:18px 20px 22px}.provider-card{padding:20px;background:linear-gradient(150deg,#202228,#1b1d21);border-radius:12px;gap:14px;box-shadow:0 2px 6px #0002}.provider-card:hover{border-color:#626b7d;background:var(--surface-2)}.pc-top{align-items:center;gap:10px}.pc-name{font-size:17px;order:-2}.pc-top>.badge{margin-left:auto;order:-1}.pc-url{max-width:100%;font-size:11px}.pc-top>.pc-url{width:100%}.pc-top>.pc-actions{width:100%;margin-top:8px;justify-content:flex-start}.pc-meta{gap:8px 18px;font-size:12px}.pc-actions{display:flex;gap:7px;flex-wrap:wrap}.portal-summary{padding-top:15px;margin-top:0;gap:14px}.portal-values{display:grid;gap:7px;font-size:12px;flex-basis:100%}.portal-summary>.pc-actions{margin-left:0}.provider-card .hint{font-size:11px}.provider-card .status-line{margin:0}
.launch-panel{max-width:820px}.launch-panel #launch-form{padding:26px;gap:20px}.launch-panel .form-row{grid-template-columns:1fr 1fr}.launch-panel .input-action{grid-template-columns:minmax(0,1fr) auto}.launch-panel .route-tabs{grid-template-columns:repeat(4,1fr)}.launch-panel .route-tab{border-bottom:0;border-right:1px solid var(--line);padding:10px}.launch-panel .route-tab:nth-child(2){border-right:1px solid var(--line)}.route-tab.active{background:var(--accent-dim);color:#d3ddff}.launch-submit{min-height:46px}
.storefront-scope{padding:18px 22px;background:linear-gradient(120deg,#a5bbff08,transparent);border-bottom:1px solid var(--line)}.storefront-scope:has(>.hint:only-child){padding:8px 22px}.scope-heading{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.scope-heading h2{font-size:18px;margin:0}.scope-heading>.pc-actions{margin-left:auto}.storefront-scope .portal-summary{margin-top:16px}.storefront-scope .portal-values{display:flex;flex-basis:auto;gap:12px 25px}.storefront-scope>.hint{margin:12px 0 0}
.storefront-controls{padding:20px 22px 10px;gap:14px}.storefront-controls label:first-child{flex:1}.storefront-controls label:has(#model-search){flex:2}.secondary-controls{padding-top:4px;padding-bottom:16px}.secondary-controls label{flex:initial;min-width:170px}.secondary-controls label:first-child{flex:initial;min-width:240px}.storefront-note{padding:0 22px 12px;margin:0}.view-switch{display:flex;gap:5px}.storefront-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,310px),1fr));gap:16px;padding:8px 22px 20px}
.model-card{display:flex;flex-direction:column;gap:15px;min-width:0;background:linear-gradient(150deg,#22252b,#1d1f24);border:1px solid var(--line-strong);border-radius:12px;padding:20px;box-shadow:0 2px 4px #0003,inset 0 1px #ffffff04;transition:border-color .15s,box-shadow .15s}.model-card:hover{border-color:#68748e;box-shadow:0 4px 16px #0004}.model-card-heading{display:flex;align-items:flex-start;gap:10px;justify-content:space-between}.model-card-heading>div{min-width:0}.model-card-heading h3{font-size:16px;letter-spacing:-.015em;overflow-wrap:anywhere;margin:5px 0 0;line-height:1.5}.model-card .badge{font-size:9px;flex-shrink:0;margin-top:3px;padding:3px 6px}.model-card .badge:before{width:5px;height:5px}.model-card .eyebrow{letter-spacing:.04em;font-size:10px}.model-description{font-size:12px;color:var(--muted);line-height:1.6;margin:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;min-height:38px}.price-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:15px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-top:auto}.price-grid>div{display:grid;align-content:start;gap:8px}.price-grid strong{font-size:14px;font-weight:600;line-height:1.45;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.price-grid small{font-size:10px}.tariff-caption{font-size:11px;color:var(--muted);margin:-5px 0 0;line-height:1.6}.request-price{margin:0;color:#d3ddff;font-size:14px}.model-perf{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted)}.model-card-footer{border-top:1px solid var(--line);padding-top:14px;display:grid;gap:12px}.model-card-footer .hint{font-size:10px}.model-card-footer .pc-actions{justify-content:space-between}.model-card-footer .mini:last-child{background:var(--accent-dim);color:#d3ddff;border-color:#a5bbff40}.table-scroll{max-width:100%;overflow:auto}th{font-size:11px;padding:13px 16px}td{padding:14px 16px;font-size:12px}.model-id{font-size:13px}.model-sub{font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.dialog-card{border-radius:14px;box-shadow:0 24px 80px #0009,0 0 0 1px #ffffff08}.dialog-head{padding:20px 24px}.dialog-head h2{font-size:17px}.dialog-body{padding:24px;gap:18px}.dialog-foot{padding:18px 24px;gap:10px;background:var(--surface)}dialog::backdrop{background:#05060bc4;backdrop-filter:blur(5px)}.provider-portal-setup{border:1px solid #a5bbff35;border-radius:10px;padding:18px;display:grid;gap:16px;background:#a5bbff05;margin:6px 0}.provider-portal-setup legend{font-size:13px;padding:0 8px;color:#d3ddff}.provider-portal-setup .hint{margin:0}.provider-portal-setup .optional{font-size:11px}#model-detail-body h3{margin:10px 0 0;font-size:15px}#model-detail-body p{margin:0;line-height:1.7}#model-detail-title{overflow-wrap:anywhere}.provider-drawer{width:min(920px,95vw)}.provider-drawer .portal-summary{margin:18px}.drawer-head{padding:20px 24px}.pd-head{padding:24px}.pd-section{padding:18px 24px}.pd-section h3{font-size:13px}.pd-stats{grid-template-columns:repeat(3,1fr)}.drawer-model{padding:14px 0}.drawer-model-name{font-size:14px}
#global-status{position:fixed;bottom:20px;left:auto;right:24px;width:min(550px,calc(100vw - 40px));z-index:100;margin:0;box-shadow:0 6px 24px #0006;background:var(--surface);font-size:13px;padding:12px 16px}
@media(min-width:1800px){main{margin-right:auto}}
@media(max-width:1150px){.app-sidebar{width:204px;padding-left:10px;padding-right:10px}main{margin-left:204px;padding:26px 20px 50px}.head-state{flex-wrap:wrap;white-space:normal;justify-content:flex-end;max-width:210px}.page-head h1{font-size:27px}.stats{gap:10px}.stat{padding:15px}.stat strong{font-size:23px}.storefront-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))}.model-card{padding:16px}.model-card-heading{flex-wrap:wrap}.model-card-heading>.badge{margin-top:0}}
@media(max-width:760px){.app-sidebar{position:static;width:100%;padding:16px;border-right:0;border-bottom:1px solid var(--line)}.brand{padding:0 4px 16px}.nav-label,.sidebar-foot{display:none}.app-sidebar nav{display:flex;overflow-x:auto;padding-bottom:4px;gap:5px}.nav-item{white-space:nowrap;padding:8px 11px;min-height:38px;font-size:12px}.nav-item span{display:none}main{margin:0;padding:22px 16px 50px}.page-head{flex-direction:column;gap:8px;margin-bottom:22px}.head-state{justify-content:flex-start;max-width:none;padding:0}.page-head h1{font-size:26px}.stats{grid-template-columns:repeat(2,1fr)}.provider-list{grid-template-columns:1fr;padding:14px;gap:12px}.provider-card{padding:16px}.provider-filters{padding:14px;align-items:stretch;flex-direction:column;gap:5px}.provider-filters label{max-width:none}.provider-filters .hint{margin:0}.panel-head{padding:16px;gap:8px}.panel-head .spacer{display:none}.panel-head .primary{margin-left:auto}.storefront-grid{padding:6px 14px 14px;grid-template-columns:1fr}.storefront-scope{padding:16px}.scope-heading>.pc-actions{margin-left:0}.storefront-controls{padding:16px 14px 8px;gap:12px}.storefront-controls label,.secondary-controls label,.secondary-controls label:first-child{flex:1;min-width:130px}.storefront-controls label:has(#model-search){min-width:100%}.storefront-note{padding:0 14px 12px}.model-card-heading{flex-wrap:nowrap}.dialog-head,.dialog-body,.dialog-foot{padding:16px}.dialog-card{max-height:92dvh}.form-row{grid-template-columns:1fr}.launch-panel .form-row{grid-template-columns:1fr}.launch-panel #launch-form{padding:18px}.launch-panel .route-tabs{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}.provider-drawer{width:100%}.pd-stats{grid-template-columns:repeat(2,1fr)}.drawer-model-actions{flex-wrap:wrap}.provider-portal-setup{padding:13px}#global-status{bottom:12px;right:12px;width:calc(100vw - 24px)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
.storefront-scope .portal-summary>.pc-actions{display:none}
dialog:has(.dialog-card.wide){width:min(1000px,calc(100% - 32px))}
#model-detail-body>.badge{justify-self:start}
/* Restrained radial light and layered surfaces, inspired by UI Tools' background/shadow tools. */
body[data-current-page=models]{background:radial-gradient(ellipse at 35% 0,#1e303544,transparent 55%),#1b1c1e}
body[data-current-page=models] .page-head{justify-content:center;text-align:center;position:relative;padding:20px 0 14px}
body[data-current-page=models] .page-head h1{font-size:clamp(32px,4vw,52px);font-weight:700}
body[data-current-page=models] .page-head .eyebrow{display:none}
body[data-current-page=models] .head-state{position:absolute;right:0;top:-22px;font-size:10px}
.storefront-panel{background:transparent;border:0;box-shadow:none}
.storefront-panel>.panel-head{border:1px solid var(--line);border-radius:20px;padding:12px 18px;min-height:56px;margin-bottom:12px;background:#ffffff02}
.storefront-panel>.panel-head h2{font-size:13px}
.catalog-toolbar{padding:8px 0 18px;gap:12px}.catalog-toolbar label{min-width:140px}.catalog-toolbar .unit-control{flex:0 0 120px;min-width:110px}
.storefront-scope{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 0 12px;border:0;background:none}.storefront-note{padding:0 0 10px}.storefront-grid{padding:8px 0 20px;grid-template-columns:repeat(auto-fill,minmax(min(100%,285px),1fr));gap:16px}
.provider-accent-0{--provider-color:#84a8ff}.provider-accent-1{--provider-color:#d299e8}.provider-accent-2{--provider-color:#e5ac7e}.provider-accent-3{--provider-color:#75c6b2}.provider-accent-4{--provider-color:#d7c779}.provider-accent-5{--provider-color:#e78da3}
.model-card{background:#202122;border-radius:22px;padding:20px;gap:12px;cursor:pointer;box-shadow:0 1px 3px #0002;min-height:244px}
.model-card:hover{border-color:var(--provider-color);background:#252629;box-shadow:0 4px 18px #0003}.model-card:focus-visible,.model-table-row:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.model-card-heading{gap:12px;flex-wrap:nowrap;align-items:center}.model-mark{display:grid;place-items:center;width:38px;height:38px;flex:0 0 38px;border-radius:50%;background:#ffffff05;color:var(--provider-color);font-weight:650;font-size:18px}.model-identity{flex:1}.model-card-heading h3{font-family:Consolas,monospace;font-size:15px;line-height:1.4;margin:0}.model-provider-name{display:block;font-size:11px;color:var(--provider-color);margin-top:4px}.model-open{color:var(--faint);font-size:18px}.price-grid{display:flex;flex-wrap:wrap;border:0;padding:0;margin:0 0 0 50px;gap:4px 14px}.price-grid>div{display:flex;gap:5px}.price-grid>div:last-child{flex-basis:100%}.price-grid small{font-size:12px}.price-grid strong{font-size:13px}.model-description{margin:3px 0 8px;min-height:38px}.model-card-footer{border:0;padding:0;margin-top:auto;gap:8px}.tariff-caption{margin:0;font-size:12px}.model-perf{align-items:center;justify-content:space-between;gap:6px}.model-table-row{cursor:pointer}.model-table-row:hover{background:var(--surface-2)}
.unavailable{border-color:#e5656966;background:linear-gradient(145deg,#e5656910,transparent),var(--surface)}.availability-alert{color:#ff999e;font-size:13px;font-weight:600;margin:0}.model-card .availability-alert{font-size:11px}
.provider-list{grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:12px;padding:14px}.provider-card{padding:15px;gap:9px;border-radius:14px;border-top:2px solid var(--provider-color)}.pc-name{font-size:16px}.pc-meta{font-size:11px;gap:5px 12px}.pc-top>.pc-actions{margin-top:3px}.provider-card .mini{font-size:11px;padding:4px 8px;min-height:28px}.provider-card .portal-summary{padding-top:10px;gap:9px}.portal-values{gap:5px}.portal-refresh{flex-basis:100%;border-top:1px solid var(--line);padding-top:6px}.mini.quiet{border-color:transparent;background:transparent;color:var(--faint);font-size:11px}.mini.quiet:hover{color:var(--text)}.portal-refresh .mini{padding-left:0}
#provider-setup-tabs{position:sticky;top:0;z-index:2;flex-shrink:0;background:var(--surface-2);min-height:40px}#provider-portal-inline[hidden]{display:none}
dialog#model-detail-dialog{inset:0 0 0 auto;margin:0;width:min(740px,100vw);max-width:100vw;height:100dvh;max-height:100dvh;border:0;border-left:1px solid var(--line);border-radius:0;padding:0;background:var(--surface)}
#model-detail-dialog .dialog-card{border-radius:0;height:100%;max-height:100dvh;width:100%;box-shadow:-12px 0 60px #0005}#model-detail-dialog .dialog-head{flex-shrink:0}#model-detail-dialog::backdrop{background:#0006;backdrop-filter:none}
.usage-timeline-panel .panel-head{flex-wrap:wrap;gap:12px}.usage-timeline-panel label{margin:0;display:flex;align-items:center}.usage-timeline{display:flex;gap:6px;padding:12px 18px;overflow-x:auto}.usage-bar{display:flex;flex:1;min-width:58px;flex-direction:column;gap:8px;align-items:center;padding:10px 5px;background:transparent;border:1px solid transparent;border-radius:8px;color:var(--muted);font-size:10px}.usage-bar.active{background:var(--accent-dim);border-color:#a5bbff50;color:var(--text)}.usage-bar meter{width:100%;height:14px;accent-color:var(--accent)}.usage-selected{padding:0 18px;font-weight:600;font-size:12px}.usage-action{margin:0 18px;padding:12px 0;border-top:1px solid var(--line);font-size:12px}.usage-action summary{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;cursor:pointer}.usage-action summary span{color:var(--muted)}.usage-token-types{display:flex;flex-wrap:wrap;gap:10px 22px;margin-top:12px;color:var(--muted)}
@media(max-width:760px){body[data-current-page=models] .page-head{padding-top:30px;text-align:left}.catalog-toolbar label:has(#model-search){order:-1}.storefront-grid{grid-template-columns:1fr}.model-card{min-height:230px}.usage-timeline-panel .panel-head .spacer{display:none}}
/* State colors and contextual panels. */
[hidden]{display:none!important}
.status-stable{--provider-color:#67b99b}.status-limited{--provider-color:#d9ac60}.status-unavailable{--provider-color:#dd777c}.status-unknown{--provider-color:#626970}
.provider-card{border-top-color:var(--provider-color,#626970)}.provider-card.status-limited{border-color:#d9ac6050;border-top-color:#d9ac60;background:linear-gradient(145deg,#d9ac6009,transparent),var(--surface)}
.token-stat{font:inherit;text-align:left;color:var(--text);cursor:pointer}.token-stat:hover,.token-stat[aria-expanded=true]{border-color:var(--accent);background:var(--accent-dim)}.stats>.usage-timeline-panel{grid-column:1/-1;border-top:1px solid var(--line);padding:8px 0}.cost-panel{margin-bottom:22px}.cost-panel .panel-head{justify-content:space-between}.cost-panel #usage-cost-total{font:600 19px Consolas,monospace}.cost-breakdown{display:flex;flex-wrap:wrap;gap:8px 20px;padding:0 18px 16px}.cost-item{color:var(--muted);font-size:12px}
.settings-shell{display:flex;flex-direction:column}.settings-tabs,.model-detail-tabs{display:flex;gap:4px;padding:4px;background:#ffffff06;border-radius:18px;margin:0 20px 16px}.settings-tabs button,.model-detail-tabs button{flex:1;border:1px solid transparent;border-radius:14px;padding:9px 12px;background:transparent;color:var(--muted);cursor:pointer;font:inherit}.settings-tabs button.active,.model-detail-tabs button.active{background:#ffffff08;border-color:#ffffff22;color:var(--text)}.settings-tabs button:disabled{opacity:.4;cursor:default}.settings-pane{min-height:0;overflow:auto}.settings-pane .dialog-body{overflow:visible}.settings-model-controls{padding:0 20px}.settings-pane .dialog-foot{position:sticky;bottom:0;background:var(--surface);z-index:3}
.catalog-toolbar{grid-template-columns:minmax(140px,1fr) minmax(200px,2fr) minmax(160px,1.4fr) auto}.unit-caption{align-self:end;padding:10px;color:var(--muted);font-size:12px}.catalog-provider{padding:12px 0 24px;border-top:1px solid var(--line)}.catalog-provider-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.catalog-provider-head h2{font-size:20px;margin:0}.catalog-provider-head button{margin-left:auto}.catalog-state-heading{font-weight:500;font-size:12px;color:var(--muted);margin:18px 0 2px}.model-card{min-height:235px;padding:20px;gap:12px;border-color:var(--line)}.model-provider-name{font-size:12px;color:var(--accent);margin:0 0 6px}.model-identity{min-width:0}.model-card-heading h3{overflow-wrap:anywhere;font-size:15px}.price-grid{margin:0;gap:5px 16px}.price-grid strong{font-variant-numeric:tabular-nums}.model-description{font-size:12px;line-height:1.7}.model-card-footer{display:flex;flex-direction:column;align-items:stretch}.site-hidden-note{color:#79bcd2;font-size:12px}.request-price{margin:0;font-weight:600}.disabled-models{margin:18px 0;border:1px solid var(--line);padding:14px;border-radius:12px}.disabled-models summary{cursor:pointer;color:var(--muted)}.disabled-model-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px}.disabled-model-row .model-id{overflow-wrap:anywhere;min-width:0}.disabled-model-row button{flex-shrink:0}
.provider-mini-storefront{grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr))}.provider-mini-storefront .model-card{padding:16px;min-height:205px}.api-history-vertical{display:flex;flex-direction:column;gap:0;border-left:2px solid var(--line);margin-left:8px;padding-left:18px}.api-history-vertical .signal-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;position:relative;padding:10px 0}.api-history-vertical .signal-row:before{content:'';position:absolute;left:-24px;top:17px;width:8px;height:8px;border-radius:50%;background:var(--muted);border:1px solid var(--surface)}
#model-detail-body{padding:24px;display:block}.model-detail-tabs{margin:28px 0 20px}.model-detail-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--line);border-radius:16px;margin-bottom:22px;overflow:hidden}.model-detail-metrics .stat{border-right:1px solid var(--line);padding:14px}.model-detail-metrics .stat:last-child{border:0}.detail-box{border:1px solid var(--line);border-radius:22px;padding:20px;margin:20px 0;background:#ffffff02}.detail-box h3{font-size:13px;text-transform:uppercase;font-weight:500;margin:0 0 18px}.detail-box h4{font-size:12px;text-transform:uppercase;color:var(--muted);font-weight:500;margin:18px 0 12px}.detail-box>.price-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.detail-box>.price-grid>div{border:1px solid var(--line);border-radius:14px;padding:14px;display:flex;flex-direction:column}.detail-box>.price-grid>div:last-child{grid-column:1/-1;flex-direction:row;justify-content:space-between}.detail-box>.price-grid strong{font-size:16px}.detail-box>.hint{margin-top:14px}.detail-box table{font-size:12px}.detail-box th,.detail-box td{padding:12px 8px}.model-detail-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:24px}.model-detail-pane>.kv-item{margin:16px 0}.model-table-row .price-grid{min-width:190px}
@media(max-width:760px){.catalog-toolbar{display:flex;flex-wrap:wrap}.catalog-toolbar>label{flex:1;min-width:140px}.catalog-toolbar>label:has(#model-search){flex-basis:100%}.unit-caption{padding:0}.settings-tabs{margin:0 12px 12px}#model-detail-body{padding:16px}.model-detail-metrics{grid-template-columns:1fr}.model-detail-metrics .stat{border:0;border-bottom:1px solid var(--line)}.model-detail-tabs button{padding:8px 4px;font-size:12px}.detail-box{padding:14px}.provider-mini-storefront{grid-template-columns:1fr}}
.model-card.unavailable{border-color:#e5707970;background:linear-gradient(140deg,#e5707914,transparent),#202122}.model-card.unavailable h3{color:#ffa6ad}.model-quick-launch{align-self:flex-start;margin-top:5px}.model-table-row.unavailable{color:#ffa6ad;background:#e5707910}.head-state{max-width:none!important;flex-wrap:wrap}.launch-dialog-card{width:100%;min-width:0}#launch-dialog{width:min(660px,calc(100% - 20px))}#launch-dialog .route-tabs{display:flex;flex-wrap:wrap}#launch-dialog input,#launch-dialog select{min-width:0}#launch-dialog #launch-form{padding:24px;gap:18px}.launch-preview{border:1px solid #8caeff40;background:#8caeff0a;color:#c5d5ff;padding:14px;border-radius:12px;line-height:1.6;font-size:13px}.launch-home{grid-column:1/-1}.activity-controls{display:flex;gap:16px;margin-bottom:20px}.activity-controls label{min-width:160px}.activity-dashboard>.panel{margin:22px 0}.chart-tabs{display:flex;flex-wrap:wrap;gap:6px;padding:18px;border-bottom:1px solid var(--line)}.chart-tabs button{font:inherit;font-size:13px;color:var(--muted);border:0;border-radius:10px;padding:10px 14px;background:transparent;cursor:pointer}.chart-tabs button.active{color:#b1caff;background:#8caeff20}.activity-chart{padding:24px}.activity-chart h3{font-size:16px;margin:0 0 18px}.activity-chart>svg{width:100%;height:auto;max-height:330px}.chart-source{font-size:11px;color:var(--faint);line-height:1.6;margin:16px 0 0}.donut-layout{display:flex;align-items:center;justify-content:center;gap:40px}.donut-layout svg{width:300px;max-width:60%}.chart-legend{display:grid;gap:14px;font-size:13px}.chart-legend span{display:flex;gap:10px;align-items:center}.chart-legend i{width:9px;height:9px;border-radius:50%}.ranking-row{width:100%;display:grid;grid-template-columns:minmax(130px,1.5fr) 2fr auto;align-items:center;gap:20px;padding:14px 0;border:0;border-bottom:1px solid var(--line);color:var(--text);background:transparent;text-align:left;font:inherit;font-size:12px;cursor:pointer}.ranking-row span{overflow-wrap:anywhere}.ranking-row meter{width:100%;accent-color:#8caeff}.provider-health-summary{border-top:1px solid var(--line);padding:16px 20px}.provider-health-summary>summary{display:flex;gap:18px;align-items:center;cursor:pointer;list-style:none}.provider-health-summary>summary:before{content:'›';color:var(--muted)}.provider-health-summary[open]>summary:before{content:'⌄'}.status-distribution{height:8px;display:flex;gap:2px;width:170px;margin-left:auto;border-radius:4px;overflow:hidden}.status-distribution>span{min-width:2px}.provider-health-detail>input{margin:18px 0 8px;max-width:360px}.model-health-row{display:block;width:100%;padding:13px 0;background:transparent;border:0;border-bottom:1px solid var(--line);color:var(--text);text-align:left;cursor:pointer}.model-health-head{display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:12px}.model-health-head>strong{overflow-wrap:anywhere}.model-health-head>.hint{margin-left:auto}.model-health-timeline{display:flex;gap:3px;height:13px;margin-top:12px}.model-health-timeline span{flex:1;border-radius:2px}.history-pagination{display:flex;justify-content:flex-end;align-items:center;gap:16px;padding-top:14px}.activity-history{margin-top:22px}
/* Provider header shortcuts and the all-provider cookie import overview. */
.provider-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
#cookie-overview-dialog{width:min(1000px,calc(100% - 32px))}
.cookie-overview-card{width:100%;min-width:0}
.cookie-overview-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.cookie-overview-list{display:grid;gap:10px}
.cookie-overview-row{display:grid;gap:13px;padding:15px;border:1px solid var(--line);border-radius:12px;background:linear-gradient(145deg,#22252b,#1c1e22)}
.cookie-overview-heading{display:flex;align-items:center;justify-content:space-between;gap:14px}
.cookie-overview-heading>div:first-child{display:grid;gap:4px;min-width:0}
.cookie-overview-heading strong{font-size:14px;overflow-wrap:anywhere}
.cookie-overview-heading small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cookie-overview-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-wrap:wrap;flex:none}
.cookie-overview-actions .link-button{display:inline-flex;align-items:center;min-height:30px;padding:5px 9px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface-2);text-decoration:none}
.cookie-overview-actions .link-button:hover{border-color:var(--accent);text-decoration:none}
.cookie-overview-states{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.cookie-overview-state{display:grid;align-content:start;gap:4px;min-width:0;padding:10px 11px;border:1px solid var(--line);border-radius:9px;background:#ffffff02}
.cookie-overview-state small{color:var(--faint)}
.cookie-overview-state strong{font-size:12px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.cookie-overview-state.ok{border-color:rgba(63,178,127,.32);background:var(--ok-dim)}
.cookie-overview-state.ok strong{color:#a9dec5}
.cookie-overview-state.warn{border-color:rgba(217,161,63,.38);background:var(--warn-dim)}
.cookie-overview-state.warn strong{color:#efc77d}
.cookie-overview-state.off{color:var(--muted);background:var(--surface-2)}
@media(max-width:760px){.activity-controls{flex-wrap:wrap}.activity-controls label{flex:1;min-width:130px}.activity-chart{padding:14px}.chart-tabs{padding:12px}.chart-tabs button{font-size:11px;padding:9px}.donut-layout{gap:8px;flex-wrap:wrap}.donut-layout svg{max-width:100%;width:220px}.chart-legend{font-size:11px}.provider-health-summary{padding:14px}.provider-health-summary>summary{flex-wrap:wrap;gap:8px}.status-distribution{width:100%;margin:4px 0}.ranking-row{grid-template-columns:1fr auto;gap:8px}.ranking-row meter{grid-row:2;grid-column:1/-1}.model-health-timeline{gap:2px}#launch-dialog #launch-form{padding:16px}.provider-head-actions{width:100%;justify-content:stretch}.provider-head-actions .button{flex:1 1 140px;min-width:0;white-space:normal}.cookie-overview-summary,.cookie-overview-states{grid-template-columns:repeat(2,minmax(0,1fr))}.cookie-overview-heading{align-items:flex-start;flex-direction:column}.cookie-overview-actions{width:100%;justify-content:flex-start}}
@media(max-width:430px){.provider-head-actions .button{flex-basis:100%}.cookie-overview-summary,.cookie-overview-states{grid-template-columns:1fr}}
`;
