// Isolated ConPTY probe; no visible test window and no real provider requests.
import {spawn} from "node:child_process";
import {randomUUID,createHash} from "node:crypto";
import {createReadStream} from "node:fs";
import {mkdir,writeFile} from "node:fs/promises";
import {resolve,join} from "node:path";
import {createServer} from "node:http";
import {parseArgs} from "node:util";
import {OmpRuntime} from "../dist/clients/omp/omp-runtime.js";
import {parseProviderProfile} from "../dist/core/providers/provider-profile.js";
import {ompConfigSchemaCommit} from "../dist/clients/omp/omp-config-compiler.js";
const {values}=parseArgs({options:{executable:{type:"string"},native:{type:"string"}},strict:true});
if(!values.executable||!values.native)throw new Error("Supply --executable <verified omp.exe> --native <verified source-built .node>");
const executable=resolve(values.executable);
const native=resolve(values.native);
const root=resolve(".provider-dock/omp-validation",`tui-${Date.now()}`);
const project=join(root,"проект TUI");
await mkdir(project,{recursive:true});
const hash=createHash("sha256");
for await(const b of createReadStream(executable))hash.update(b);
let requests=0;
const server=createServer((_req,res)=>{requests++;res.writeHead(503);res.end("{}");});
server.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
const runtime=new OmpRuntime({
  rootDirectory:join(root,"managed"),ambientEnvironment:process.env,
  artifact:{executable,sha256:hash.digest("hex"),sourceCommit:ompConfigSchemaCommit},
  secretStore:{get:async()=>"fixture-only-tui-key"},
});
let child;
try {
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
const prepared=await runtime.prepare(randomUUID(),{
  route:{profile:parseProviderProfile({id:"tui-fixture",displayName:"TUI fixture",baseUrl,apiType:"openai-chat-completions",auth:{kind:"bearer",secretRef:"tui.fixture"}}),
  accountId:"test-only",allowedOrigins:[new URL(baseUrl).origin],models:[{id:"tui-fixture-model",contextWindow:8192,maxTokens:256,reasoning:false}]},
  projectDirectory:project,mode:"tui",permissionAcknowledgement:"read-only-pilot-no-sandbox",
});
// Native PTY merges ambient env. Launch the harness itself with the scrubbed env,
// then inherit from it, rather than accidentally adding real parent credentials.
const worker=join(root,"pty-worker.cjs");
await writeFile(worker,`
const fs=require('node:fs');
const native=require(process.argv[2]);
native.__ompInstallTokioRuntime();
const payload=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const pty=new native.PtySession();
let sent=false,output='';
pty.startArgv({...payload,cols:120,rows:35,timeoutMs:20000},(error,chunk)=>{
 if(error){process.stdout.write(JSON.stringify({error:'chunk error'})+'\\n');return;}
 output=(output+chunk).slice(-200000);
 if(!sent&&output.includes('tui-fixture-model')){sent=true;setTimeout(()=>pty.write('\\x04'),500);}
},()=>{}).then(result=>{
 const secretSeen=output.includes('fixture-only-tui-key');
 const onboardingShown=output.includes('Setup step');
 process.stdout.write(JSON.stringify({result,ctrlDSent:sent,secretSeen,onboardingShown,output:output.replaceAll('fixture-only-tui-key','<REDACTED>')})+'\\n');
 process.exitCode=result.exitCode===0&&!result.timedOut&&!result.cancelled&&sent&&!secretSeen&&!onboardingShown?0:1;
}).catch(()=>{process.stdout.write(JSON.stringify({error:'pty failure'})+'\\n');process.exitCode=1;});
`);
const payload=join(root,"pty-command.json");
await writeFile(payload,JSON.stringify({application:prepared.executable,args:[...prepared.args,"--no-session"],cwd:prepared.cwd}));
child=spawn(process.execPath,[worker,native,payload],{env:prepared.environment,cwd:project,stdio:["ignore","pipe","pipe"],windowsHide:true});
let output="",stderr="";child.stdout.on("data",b=>output+=b);child.stderr.on("data",b=>stderr+=b);
const timer=setTimeout(()=>child.kill(),30000);
const exit=await new Promise((r,j)=>{child.once("error",j);child.once("close",(code,signal)=>r({code,signal}));});
clearTimeout(timer);
await writeFile(join(root,"report.json"),JSON.stringify({exit,requests,output,stderr},null,2));
let result;
try{result=JSON.parse(output.trim());}catch{result={error:"invalid fixture-worker output"};}
console.log(JSON.stringify({root,exit,requests,pty:result.result,ctrlDSent:result.ctrlDSent,
  secretInOutput:result.secretSeen===true||stderr.includes("fixture-only-tui-key"),onboardingShown:result.onboardingShown,stderr:stderr.slice(-1200)}));
if(exit.code!==0||requests!==0||result.ctrlDSent!==true||result.secretSeen||stderr.includes("fixture-only-tui-key"))process.exitCode=1;
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
