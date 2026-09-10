import { describe, expect, it, vi } from "vitest";
import { AnthropicBridgeServer, ResponsesBridgeServer, MemorySecretStore, parseProviderProfile,
  createProviderRuntimeHealthSignal, createUsageTelemetryEvent, type ProviderRuntimeHealthSignal } from "../src/index.js";
import { automaticClient } from "../src/core/providers/automatic-client.js";
import { knownModelProtocol } from "../src/core/providers/model-protocol.js";
import { activitySeries } from "../src/ui/activity-dashboard.js";
import { chatRequestToResponses } from "../src/bridge/anthropic/responses-transport.js";

const profile=parseProviderProfile({id:"demo",displayName:"Demo",baseUrl:"https://demo.invalid/v1",apiType:"auto"});
const model="claude-opus-example";
const request={model,max_tokens:64,messages:[{role:"user",content:"Hello"}]};
const message={type:"message",id:"message",role:"assistant",content:[{type:"text",text:"Hello"}],stop_reason:"end_turn",usage:{input_tokens:2,output_tokens:1}};
const response={id:"resp-test",model,status:"completed",output:[{type:"message",id:"out",role:"assistant",status:"completed",content:[{type:"output_text",text:"Hello"}]}],usage:{input_tokens:2,output_tokens:1}};
const event=(value:unknown)=>"data: "+JSON.stringify(value)+"\n\n";
const post=(url:string,body:unknown)=>fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

describe("automatic CLI and recorded protocol selection",()=>{
  it.each([["Claude Opus","claude-code"],["anthropic/claude-opus-4.8","claude-code"],["GPT-5.6","codex"],["openai/gpt-5.6-sol","codex"],["glm-5.3","codex"]])("routes %s to %s",(id,client)=>expect(automaticClient(profile,id)).toBe(client));
  it("lets diagnostics rule out a CLI and honors an explicit unknown-model preference",()=>{
    expect(automaticClient(profile,"gpt-5.6",{codexCompatibility:"INCOMPATIBLE",claudeCompatibility:"ADAPTER"})).toBe("claude-code");
    expect(automaticClient({...profile,preferredClient:"claude-code"},"glm-5.3")).toBe("claude-code");
  });
  it("uses recent successful per-model protocols, not another model or failed attempts",()=>{
    const now=new Date();const signals=[createProviderRuntimeHealthSignal({providerId:"demo",modelId:model,client:"claude-code",protocol:"openai-responses",outcome:"completed",observedAt:now}),createProviderRuntimeHealthSignal({providerId:"demo",modelId:"different",client:"claude-code",protocol:"anthropic-messages",outcome:"completed",observedAt:now})];
    const record={providerId:"demo",history:[],diagnostics:[],runtimeSignals:signals};
    expect(knownModelProtocol(record,undefined,model,"claude-code",now)).toBe("openai-responses");
    expect(knownModelProtocol(record,undefined,model,"claude-code",new Date(now.valueOf()+86400001))).toBeUndefined();
    expect(knownModelProtocol(record,undefined,"different","codex",now)).toBeUndefined();
  });
});

describe("universal bridge completion",()=>{
  it.each([false,true])("runs Claude Code over Responses, stream=%s",async stream=>{
    const signals:ProviderRuntimeHealthSignal[]=[];
    const upstream=vi.fn<typeof fetch>(async(url,init)=>{expect(String(url)).toBe("https://demo.invalid/v1/responses");const body=JSON.parse(String(init?.body));expect(body.input[0].role).toBe("user");expect(body.max_output_tokens).toBe(64);
      return stream?new Response(event({type:"response.created",response:{id:"resp-test",model},sequence_number:0})+event({type:"response.output_item.added",output_index:0,item:{type:"message",id:"out"},sequence_number:1})+event({type:"response.output_text.delta",output_index:0,delta:"Hel",sequence_number:2})+event({type:"response.output_item.done",output_index:0,item:response.output[0],sequence_number:3})+event({type:"response.completed",response,sequence_number:4}),{headers:{"content-type":"text/event-stream"}}):Response.json(response);});
    const bridge=new AnthropicBridgeServer({profile:{...profile,apiType:"openai-responses"},secretStore:new MemorySecretStore(),fetchImpl:upstream,healthSignalSink:signal=>{signals.push(signal);}});const address=await bridge.start();
    try{const result=await post(address.url+"/v1/messages",{...request,stream});expect(result.status).toBe(200);if(stream){const text=await result.text();expect(text).toContain('"type":"message_stop"');expect(text).toContain('"text":"Hel"');expect(text).toContain('"text":"lo"');}else expect(await result.json()).toMatchObject({role:"assistant",content:[{type:"text",text:"Hello"}]});expect(upstream).toHaveBeenCalledTimes(1);expect(signals.at(-1)).toMatchObject({protocol:"openai-responses",outcome:"completed"});}finally{await bridge.stop();}
  });
  it("preserves tool calls/results without converting assistant history into user prompts",()=>{
    const converted=chatRequestToResponses({model,messages:[{role:"user",content:"Read file"},{role:"assistant",content:null,tool_calls:[{id:"call_1",type:"function",function:{name:"read",arguments:'{"path":"x"}'}}]},{role:"tool",tool_call_id:"call_1",content:"contents"}]});
    expect(converted.input).toEqual([{role:"user",content:[{type:"input_text",text:"Read file"}]},{type:"function_call",call_id:"call_1",name:"read",arguments:'{"path":"x"}'},{type:"function_call_output",call_id:"call_1",output:"contents"}]);
  });
  it("does not retry an accepted Responses stream that ends mid-answer",async()=>{
    const upstream=vi.fn<typeof fetch>(async()=>new Response(event({type:"response.output_text.delta",output_index:0,delta:"Partial"}),{headers:{"content-type":"text/event-stream"}}));
    const bridge=new AnthropicBridgeServer({profile:{...profile,apiType:"openai-responses"},secretStore:new MemorySecretStore(),fetchImpl:upstream});const address=await bridge.start();
    try{const result=await post(address.url+"/v1/messages",{...request,stream:true});const text=await result.text();expect(text).toContain('"type":"error"');expect(text).not.toContain('"type":"message_stop"');expect(upstream).toHaveBeenCalledTimes(1);}finally{await bridge.stop();}
  });
  it.each([null,"max_tokens"])("does not report native stop_reason=%s as a complete answer",async stop_reason=>{
    const signals:ProviderRuntimeHealthSignal[]=[];const upstream=vi.fn<typeof fetch>(async()=>Response.json({...message,stop_reason}));
    const bridge=new AnthropicBridgeServer({profile:{...profile,apiType:"anthropic-messages"},secretStore:new MemorySecretStore(),fetchImpl:upstream,healthSignalSink:signal=>{signals.push(signal);}});const address=await bridge.start();
    try{const result=await post(address.url+"/v1/messages",request);await result.text();expect(signals.every(signal=>signal.outcome!=="completed")).toBe(true);if(stop_reason===null)expect(result.status).toBeGreaterThanOrEqual(400);else expect(signals.at(-1)?.outcome).toBe("incomplete");expect(upstream).toHaveBeenCalledTimes(1);}finally{await bridge.stop();}
  });
  it("uses a known Chat protocol without speculative Responses calls",async()=>{
    const upstream=vi.fn<typeof fetch>(async(url)=>{expect(String(url)).toContain("/chat/completions");return Response.json({id:"chat",model,choices:[{message:{role:"assistant",content:"OK"},finish_reason:"stop"}]});});
    const bridge=new ResponsesBridgeServer({profile,secretStore:new MemorySecretStore(),fetchImpl:upstream,protocolResolver:async()=>"openai-chat-completions"});const address=await bridge.start();
    try{const result=await post(address.baseUrl+"/responses",{model,input:"hello"});expect(result.status).toBe(200);await result.text();expect(upstream).toHaveBeenCalledTimes(1);}finally{await bridge.stop();}
  });
  it.each([null,"max_tokens"])("keeps native SSE stop_reason=%s incomplete",async stop_reason=>{
    const signals:ProviderRuntimeHealthSignal[]=[];
    const upstream=vi.fn<typeof fetch>(async()=>new Response(event({type:"message_start",message:{...message,content:[],stop_reason:null}})+event({type:"content_block_start",index:0,content_block:{type:"text",text:"Hello"}})+event({type:"content_block_stop",index:0})+event({type:"message_delta",delta:{stop_reason}})+event({type:"message_stop"}),{headers:{"content-type":"text/event-stream"}}));
    const bridge=new AnthropicBridgeServer({profile:{...profile,apiType:"anthropic-messages"},secretStore:new MemorySecretStore(),fetchImpl:upstream,healthSignalSink:signal=>{signals.push(signal);}});const address=await bridge.start();
    try{const result=await post(address.url+"/v1/messages",{...request,stream:true});const body=await result.text();expect(signals.every(signal=>signal.outcome!=="completed")).toBe(true);if(stop_reason===null){expect(body).toContain('"type":"error"');expect(body).not.toContain('"type":"message_stop"');}else expect(signals.at(-1)?.outcome).toBe("incomplete");expect(upstream).toHaveBeenCalledTimes(1);}finally{await bridge.stop();}
  });
  it("updates a stale Chat hint after an endpoint rejection and records the Responses protocol",async()=>{
    const signals:ProviderRuntimeHealthSignal[]=[];
    const upstream=vi.fn<typeof fetch>(async url=>String(url).endsWith('/chat/completions')?new Response(null,{status:404}):Response.json(response));
    const bridge=new ResponsesBridgeServer({profile,secretStore:new MemorySecretStore(),fetchImpl:upstream,protocolResolver:async()=>"openai-chat-completions",healthSignalSink:signal=>{signals.push(signal);}});const address=await bridge.start();
    try{const result=await post(address.baseUrl+"/responses",{model,input:"hello"});expect(result.status).toBe(200);await result.text();expect(upstream).toHaveBeenCalledTimes(2);expect(signals.at(-1)).toMatchObject({protocol:"openai-responses",outcome:"completed"});}finally{await bridge.stop();}
  });
});

describe("activity charts",()=>{
  it("shows gaps without invented availability and does not count telemetry and health twice",()=>{
    const now=new Date("2026-09-08T12:00:00");const event=createUsageTelemetryEvent({profile,modelId:model,client:"codex",protocol:"openai-responses",sessionId:"test",recordedAt:now,outcome:"completed",usage:{uncachedInputTokens:10,cacheReadInputTokens:3,cacheWriteInputTokens:0,outputTokens:4,reasoningOutputTokens:2,webSearchRequests:0,totalTokens:17}});
    const signal=createProviderRuntimeHealthSignal({providerId:profile.id,modelId:model,client:"codex",protocol:"openai-responses",observedAt:now,outcome:"completed"});const buckets=activitySeries([event],[signal],7,now);expect(buckets).toHaveLength(7);expect(buckets.at(-1)).toMatchObject({tokens:17,attempts:1,ok:1,failed:0});expect(buckets.slice(0,-1).every(bucket=>bucket.attempts===0)).toBe(true);
  });
});
