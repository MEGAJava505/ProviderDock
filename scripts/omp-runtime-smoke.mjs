// Installed OMP contract smoke, not a Node mock of OMP.
// All upstreams/credentials/projects are test fixtures; no real inference.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { OmpRuntime } from "../dist/clients/omp/omp-runtime.js";
import { ompConfigSchemaCommit } from "../dist/clients/omp/omp-config-compiler.js";
import { parseProviderProfile } from "../dist/core/providers/provider-profile.js";
const {values} = parseArgs({options:{executable:{type:"string"}},strict:true});
if (!values.executable) throw new Error("Usage: node scripts/omp-runtime-smoke.mjs --executable <absolute omp executable>");
const executable = resolve(values.executable);
const root = resolve(".provider-dock/omp-validation", `smoke-${Date.now()}`);
const project = join(root, "проект с пробелами");
await mkdir(project, {recursive:true});
await writeFile(join(project,"read-fixture.txt"),"READ_FIXTURE_CONTENT");
const hash = createHash("sha256");
for await (const chunk of createReadStream(executable)) hash.update(chunk);
const artifact = {executable,sha256:hash.digest("hex"),sourceCommit:ompConfigSchemaCommit};
// This harness self-hashes its explicitly supplied test artifact. Production
// registration must instead use the recorded trusted build checksum.
const runtime = new OmpRuntime({
  rootDirectory:join(root,"managed"),artifact,
  secretStore:{get:async reference=>{assert.equal(reference,"fixture.key");return "fixture-only";}},
  ambientEnvironment:process.env,
});
const event = (data, name) => (name?`event: ${name}\n`:"")+`data: ${JSON.stringify(data)}\n\n`;
let active;
const server = createServer(async(req,res)=>{
  let source="";for await(const part of req)source+=part;
  const body=JSON.parse(source);
  active.requests.push({path:req.url, model:body.model, toolTypes:body.tools?.map(t=>t.type)});
  try {
    assert.equal(body.model,"fixture-model");
    assert.ok(req.headers.authorization==="Bearer fixture-only" || req.headers["x-api-key"]==="fixture-only");
    assert.equal(Boolean(body.tools?.length),active.useTool,"Tool exposure must match the case, not just response text");
    const pathname = new URL(req.url, "http://localhost").pathname;
    assert.equal(pathname,active.endpoint);
    const toolCall = active.useTool && active.requests.length === 1;
    if (active.useTool && !toolCall) assert.ok(source.includes("READ_FIXTURE_CONTENT"), "OMP must return the actual read result");
    res.writeHead(200,{"content-type":"text/event-stream"});
    if(pathname==="/v1/chat/completions"){
      const chunk=(delta,finish_reason=null)=>event({id:"chat-fixture",object:"chat.completion.chunk",created:1,model:body.model,choices:[{index:0,delta,finish_reason}]});
      res.end(toolCall
        ? chunk({role:"assistant",tool_calls:[{index:0,id:"call-fixture",type:"function",function:{name:"read",arguments:'{"path":"read-fixture.txt"}'}}]})+chunk({},"tool_calls")+"data: [DONE]\n\n"
        : chunk({role:"assistant",content:"OMP_FIXTURE_OK"})+chunk({},"stop")+"data: [DONE]\n\n");
    } else if(pathname==="/v1/messages"){
      res.end(event({type:"message_start",message:{id:"msg-fixture",type:"message",role:"assistant",model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}},"message_start")
        +event({type:"content_block_start",index:0,content_block:toolCall?{type:"tool_use",id:"call-fixture",name:"read",input:{}}:{type:"text",text:""}},"content_block_start")
        +event({type:"content_block_delta",index:0,delta:toolCall?{type:"input_json_delta",partial_json:'{"path":"read-fixture.txt"}'}:{type:"text_delta",text:"OMP_FIXTURE_OK"}},"content_block_delta")
        +event({type:"content_block_stop",index:0},"content_block_stop")
        +event({type:"message_delta",delta:{stop_reason:toolCall?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:1}},"message_delta")
        +event({type:"message_stop"},"message_stop"));
    } else {
      const item=toolCall
        ? {id:"out-tool-fixture",type:"function_call",call_id:"call-fixture",name:"read",arguments:'{"path":"read-fixture.txt"}',status:"completed"}
        : {id:"out-fixture",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"OMP_FIXTURE_OK",annotations:[]}]};
      const response={id:"resp-fixture",object:"response",status:"completed",model:body.model,output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
      res.end(event({type:"response.created",sequence_number:0,response:{...response,status:"in_progress",output:[]}})
        +event({type:"response.output_item.added",sequence_number:1,output_index:0,item:toolCall?{...item,arguments:"",status:"in_progress"}:{...item,status:"in_progress",content:[]}})
        +(toolCall
          ? event({type:"response.function_call_arguments.delta",sequence_number:2,output_index:0,item_id:item.id,delta:item.arguments})
          : event({type:"response.content_part.added",sequence_number:2,output_index:0,item_id:item.id,content_index:0,part:{type:"output_text",text:"",annotations:[]}})
            +event({type:"response.output_text.delta",sequence_number:3,output_index:0,item_id:item.id,content_index:0,delta:"OMP_FIXTURE_OK"}))
        +event({type:"response.output_item.done",sequence_number:4,output_index:0,item})
        +event({type:"response.completed",sequence_number:5,response}));
    }
  } catch(error){active.error=error.message;res.writeHead(400);res.end("{}");}
});
server.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
try{
  for (const useTool of [false,true]) for(const [api,endpoint] of [["openai-completions","/v1/chat/completions"],["anthropic-messages","/v1/messages"],["openai-responses","/v1/responses"]]){
    const prepared=await runtime.prepare(randomUUID(),{
      route:{
        profile:parseProviderProfile({
          id:api,displayName:"Smoke fixture",baseUrl,
          apiType:api==="openai-completions"?"openai-chat-completions":api,
          auth:{kind:"bearer",secretRef:"fixture.key"},
        }),
        accountId:"fixture-account",allowedOrigins:[new URL(baseUrl).origin],
        models:[{id:"fixture-model",contextWindow:8192,maxTokens:256,reasoning:false}],
      },
      projectDirectory:project,mode:"tui",permissionAcknowledgement:"read-only-pilot-no-sandbox",
    });
    const home=prepared.homeDirectory;
    active={api,endpoint,useTool,requests:[]};
    // At this pin an explicit --tools list takes precedence over --no-tools.
    const baseArgs=prepared.args.filter((arg,index,list)=>useTool || (arg!=="--tools" && list[index-1]!=="--tools"));
    const args=[...baseArgs,...(useTool?[]:["--no-tools"]),"--no-session","--print",useTool?"Read read-fixture.txt, then reply OMP_FIXTURE_OK":"Reply with OMP_FIXTURE_OK"];
    const child=spawn(prepared.executable,args,{cwd:prepared.cwd,env:prepared.environment,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
    const timer=setTimeout(()=>child.kill(),45000);
    const exit=await new Promise((r,j)=>{child.once("error",j);child.once("close",(code,signal)=>r({code,signal}));});clearTimeout(timer);
    const report={...active,exit,stdout:stdout.slice(-1500),stderr:stderr.slice(-2500)};
    await writeFile(join(home,"probe.json"),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    assert.equal(exit.code,0);
    assert.equal(active.error,undefined);
    assert.equal(active.requests.length,useTool?2:1);
    assert.ok(stdout.includes("OMP_FIXTURE_OK"));
    await assertNoSecret(home);
  }
  console.log(JSON.stringify({result:"passed",cases:6,artifact,root,compilerAndManagedRuntime:true}));
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}

// Includes SQLite WAL/SHM, session files, config and raw HTTP dumps, not just DB.
// Stream large extracted native assets instead of loading them into memory.
async function assertNoSecret(directory) {
  const needle=Buffer.from("fixture-only");
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);
    assert.equal(entry.isSymbolicLink(),false,"Unexpected link in isolated runtime");
    if(entry.isDirectory()){await assertNoSecret(path);continue;}
    let tail=Buffer.alloc(0);
    for await(const chunk of createReadStream(path)){
      const bytes=Buffer.concat([tail,chunk]);
      assert.equal(bytes.includes(needle),false,`Fixture key persisted in ${path}`);
      tail=bytes.subarray(Math.max(0,bytes.length-needle.length+1));
    }
  }
}
