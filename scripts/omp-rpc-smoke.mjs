// Real OMP RPC handshake/idle abort/EOF smoke. No inference or legacy CLI.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { OmpRuntime } from "../dist/clients/omp/omp-runtime.js";
import { ompConfigSchemaCommit } from "../dist/clients/omp/omp-config-compiler.js";
import { parseProviderProfile } from "../dist/core/providers/provider-profile.js";
import { projectOmpRpcControlFrame } from "../dist/clients/omp/omp-rpc-projection.js";

const {values}=parseArgs({options:{executable:{type:"string"}},strict:true});
if(!values.executable)throw new Error("Supply --executable <absolute OMP executable>");
const executable=resolve(values.executable);
const root=resolve(".provider-dock/omp-validation",`rpc-${Date.now()}`);
const project=join(root,"проект RPC с пробелами");
await mkdir(project,{recursive:true});
const hash=createHash("sha256");
for await(const chunk of createReadStream(executable))hash.update(chunk);
const artifact={executable,sha256:hash.digest("hex"),sourceCommit:ompConfigSchemaCommit};
let requests=0;
const server=createServer((_req,res)=>{requests++;res.writeHead(503);res.end("{}");});
server.listen(0,"127.0.0.1");
await new Promise(resolve=>server.once("listening",resolve));
let child;
let closed;
try{
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  const runtime=new OmpRuntime({
    rootDirectory:join(root,"managed"),artifact,ambientEnvironment:process.env,
    secretStore:{get:async()=>"fixture-only-rpc-key"},
  });
  const prepared=await runtime.prepare(randomUUID(),{
    route:{
      profile:parseProviderProfile({
        id:"rpc-fixture",displayName:"RPC fixture",baseUrl,apiType:"openai-chat-completions",
        auth:{kind:"bearer",secretRef:"rpc.fixture"},
      }),
      accountId:"test-only",allowedOrigins:[new URL(baseUrl).origin],
      models:[{id:"rpc-fixture-model",contextWindow:8192,maxTokens:256,reasoning:false}],
    },
    projectDirectory:project,mode:"rpc",permissionAcknowledgement:"read-only-pilot-no-sandbox",
  });
  child=spawn(prepared.executable,[...prepared.args,"--no-session"],{
    cwd:prepared.cwd,env:prepared.environment,stdio:["pipe","pipe","pipe"],windowsHide:true,
  });
  const frames=[];
  let buffer="",stdout="",stderr="",parseFailure;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data",chunk=>{
    stdout+=chunk;
    buffer+=chunk;
    if(buffer.length>2*1024*1024){parseFailure=new Error("Oversized RPC frame");return;}
    let newline;
    while((newline=buffer.indexOf("\n"))>=0){
      const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
      if(!line)continue;
      try{frames.push(JSON.parse(line));}catch{parseFailure=new Error("Non-JSON output on RPC stdout");}
    }
  });
  child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-4096);});
  closed=new Promise((resolve,reject)=>{
    child.once("error",reject);child.once("close",(code,signal)=>resolve({code,signal}));
  });
  let exited;
  void closed.then(result=>{exited=result;},()=>{});
  const deadline=Date.now()+30_000;
  async function waitFor(predicate){
    while(Date.now()<deadline){
      if(parseFailure)throw parseFailure;
      const frame=frames.find(predicate);if(frame)return frame;
      if(exited)throw new Error(`RPC exited before expected frame: ${exited.code}`);
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    throw new Error("RPC handshake deadline expired");
  }
  const ready=await waitFor(frame=>frame.type==="ready");
  const compiledConfig=JSON.parse(await readFile(join(prepared.agentDirectory,"models.yml"),"utf8"));
  const expected={requestId:"state-fixture",providerId:Object.keys(compiledConfig.providers)[0],modelId:"rpc-fixture-model"};
  const publicReady=projectOmpRpcControlFrame(ready,expected);
  assert.deepEqual(publicReady,{type:"ready",protocolVersion:1});
  child.stdin.write(JSON.stringify({id:"state-fixture",type:"get_state"})+"\n");
  const state=await waitFor(frame=>frame.type==="response" && frame.id==="state-fixture");
  const publicState=projectOmpRpcControlFrame(state,expected);
  assert.equal(publicState?.type,"state");
  assert.equal(publicState.modelId,"rpc-fixture-model");
  assert.equal(publicState.isStreaming,false);
  child.stdin.write(JSON.stringify({id:"abort-fixture",type:"abort"})+"\n");
  const abort=await waitFor(frame=>frame.type==="response" && frame.id==="abort-fixture");
  const publicAbort=projectOmpRpcControlFrame(abort,{...expected,requestId:"abort-fixture"});
  assert.deepEqual(publicAbort,{type:"aborted"});
  child.stdin.end();
  const timer=setTimeout(()=>child.kill(),10_000);
  const exit=await closed;
  clearTimeout(timer);
  assert.equal(exit.code,0,"Idle RPC must shut down cleanly on EOF");
  assert.equal(requests,0,"Handshake/idle abort must not contact inference upstream");
  const secretPaths=[];
  function inspect(value,path){
    if(typeof value==="string" && value.includes("fixture-only-rpc-key"))secretPaths.push(path);
    else if(value && typeof value==="object")for(const [key,item] of Object.entries(value))inspect(item,`${path}.${key}`);
  }
  frames.forEach((frame,index)=>inspect(frame,`frame[${index}]`));
  if(stderr.includes("fixture-only-rpc-key"))secretPaths.push("stderr");
  // Discovered with the first failing real RPC probe: upstream get_state echoes
  // resolved Authorization. Preserve this fact, but keep raw frames memory-only.
  assert.equal(stderr.includes("fixture-only-rpc-key"),false,"Secret in stderr");
  assert.equal(JSON.stringify([publicReady,publicState,publicAbort]).includes("fixture-only-rpc-key"),false,"Public projection leaked key");
  const report={result:"passed",protocolVersion:ready.protocolVersion,model:"rpc-fixture-model",sessionIdPresent:true,upstreamRequests:requests,exit,artifact,root,rawFramesContainSecrets:secretPaths.length>0,privateSecretPaths:secretPaths,publicProjectionSecretFree:true};
  await writeFile(join(root,"report.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
} finally {
  if(child && child.exitCode===null && child.signalCode===null){
    child.kill();
    await closed?.catch(()=>{});
  }
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}
