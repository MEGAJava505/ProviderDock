import { ProviderRequestError } from "../../core/errors/provider-error.js";
import { normalizeResponsesResponse } from "../../protocols/openai-responses/response-normalization.js";
import { SseDecoder } from "../sse/sse-decoder.js";
import { ResponsesStreamState } from "../responses/responses-stream-state.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("Expected an API object.");
  return value as RecordValue;
}
const failure = (message: string) => new ProviderRequestError("PROTOCOL_ERROR", message);

/** The intermediate Chat representation preserves roles and tool call IDs. */
export function chatRequestToResponses(chat: Readonly<RecordValue>): RecordValue {
  if (!Array.isArray(chat.messages)) throw failure("Chat history is missing.");
  if (chat.stop != null) throw new ProviderRequestError("UNSUPPORTED_FEATURE", "Responses upstream does not support stop sequences.");
  const input: RecordValue[] = [];
  for (const value of chat.messages) {
    const message=record(value);const role=message.role;
    if (role === "tool") { input.push({ type:"function_call_output",call_id:message.tool_call_id,output:message.content });continue; }
    if (!["system","developer","user","assistant"].includes(String(role))) throw failure("Unsupported history role.");
    const parts = typeof message.content === "string" ? [{type:"text",text:message.content}] : message.content ?? [];
    if (!Array.isArray(parts)) throw failure("Unsupported message content.");
    const content = parts.map(value => {const part=record(value);if(part.type==="text")return {type:role==="assistant"?"output_text":"input_text",text:part.text};
      if(part.type==="image_url"&&role!=="assistant"){const image=record(part.image_url);return {type:"input_image",image_url:image.url,...(image.detail?{detail:image.detail}:{})};}
      throw new ProviderRequestError("UNSUPPORTED_FEATURE","This content cannot be represented in Responses.");});
    if(content.length)input.push({role,content});
    if(Array.isArray(message.tool_calls))for(const value of message.tool_calls){const call=record(value);const fn=record(call.function);input.push({type:"function_call",call_id:call.id,name:fn.name,arguments:fn.arguments});}
  }
  const output: RecordValue={model:chat.model,input,stream:chat.stream===true,store:false};
  for(const name of ["temperature","top_p","parallel_tool_calls"])if(chat[name]!==undefined)output[name]=chat[name];
  if(chat.max_tokens!==undefined)output.max_output_tokens=chat.max_tokens;
  if(Array.isArray(chat.tools))output.tools=chat.tools.map(value=>({type:"function",...record(record(value).function)}));
  if(chat.tool_choice!==undefined){const choice=chat.tool_choice;output.tool_choice=typeof choice==="string"?choice:{type:"function",name:record(record(choice).function).name};}
  return output;
}

function chatUsage(value: unknown): RecordValue | undefined {
  if (!value) return undefined;const usage=record(value);
  if(typeof usage.input_tokens!=="number"||typeof usage.output_tokens!=="number")return undefined;
  return {prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,total_tokens:usage.input_tokens+usage.output_tokens,
    prompt_tokens_details:usage.input_tokens_details,completion_tokens_details:usage.output_tokens_details};
}

export function responsesToChatJson(value: unknown): RecordValue {
  const response=normalizeResponsesResponse(value);
  if(response.status==="failed")throw failure("Responses provider reported a failed generation.");
  const content:string[]=[];const calls:RecordValue[]=[];
  for(const value of response.output as unknown[]){const item=record(value);
    if(item.type==="message"){if(item.role!==undefined&&item.role!=="assistant")throw failure("Provider returned a non-assistant output role.");for(const value of item.content as unknown[]){const part=record(value);if(part.type==="output_text")content.push(String(part.text??""));else if(part.type==="refusal")content.push(String(part.refusal??""));else throw failure("Unsupported Responses output content.");}}
    else if(item.type==="function_call")calls.push({id:item.call_id,type:"function",function:{name:item.name,arguments:item.arguments}});
    else if(item.type!=="reasoning")throw new ProviderRequestError("UNSUPPORTED_FEATURE","Responses output cannot be delivered to Claude Code.");
  }
  if(response.status==="incomplete"&&record(response.incomplete_details).reason!=="max_output_tokens")throw failure("Responses generation was incomplete.");
  return {id:response.id,model:response.model,choices:[{index:0,message:{role:"assistant",content:content.join(""),...(calls.length?{tool_calls:calls}:{})},finish_reason:response.status==="incomplete"?"length":calls.length?"tool_calls":"stop"}],usage:chatUsage(response.usage)};
}

/** Stream deltas once; a terminal snapshot only fills content not yet delivered. */
export async function responsesTransportToChat(upstream: Response, signal: AbortSignal): Promise<Response> {
  if (!upstream.ok) return upstream;
  if (!upstream.headers.get("content-type")?.includes("text/event-stream")) {
    const reader=upstream.body?.getReader();if(!reader)throw failure("Responses body is empty.");const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16*1024*1024)throw failure("Responses body exceeds the size limit.");chunks.push(chunk.value);}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    return Response.json(responsesToChatJson(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
  }
  if(!upstream.body)throw failure("Responses stream is empty.");
  const reader=upstream.body.getReader();const decoder=new SseDecoder();const state=new ResponsesStreamState();const encoder=new TextEncoder();
  const items=new Map<number,{text:string;arguments:string;callId?:string;name?:string;toolIndex?:number}>();let nextTool=0;let model:unknown;let id:unknown;let bytes=0;
  const body=new ReadableStream<Uint8Array>({
    async start(controller){
      const send=(delta:RecordValue,finish:unknown=null,usage?:RecordValue)=>controller.enqueue(encoder.encode('data: '+JSON.stringify({id:id||'responses-adapter',model,choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})+'\n\n'));
      const itemAt=(index:number)=>{let item=items.get(index);if(!item){item={text:'',arguments:''};items.set(index,item);}return item;};
      const completeItem=(index:number,value:unknown)=>{const output=record(value);const item=itemAt(index);
        if(output.type==='function_call'){if(item.toolIndex===undefined){item.toolIndex=nextTool++;item.callId=String(output.call_id);item.name=String(output.name);send({tool_calls:[{index:item.toolIndex,id:item.callId,type:'function',function:{name:item.name,arguments:''}}]});}
          const args=String(output.arguments??'');if(!args.startsWith(item.arguments))throw failure('Responses tool arguments changed after delivery.');if(args.length>item.arguments.length)send({tool_calls:[{index:item.toolIndex,function:{arguments:args.slice(item.arguments.length)}}]});item.arguments=args;
        }else if(output.type==='message'){if(output.role!==undefined&&output.role!=='assistant')throw failure('Provider output role must be assistant.');const text=(output.content as unknown[]).map(value=>{const part=record(value);if(part.type==='output_text')return String(part.text??'');if(part.type==='refusal')return String(part.refusal??'');throw failure('Unsupported output content.');}).join('');if(!text.startsWith(item.text))throw failure('Responses text changed after delivery.');if(text.length>item.text.length)send({content:text.slice(item.text.length)});item.text=text;
        }else if(output.type!=='reasoning')throw failure('Unsupported Responses output item.');};
      const process=(data:string,eventId?:string)=>{if(data==='[DONE]')return;const observation=state.observe(record(JSON.parse(data)),eventId);if(observation.kind!=='forward')return;const event=observation.event;if(event.response){const response=record(event.response);id=response.id??id;model=response.model??model;}
        const index=Number(event.output_index??0);const item=itemAt(index);
        if(event.type==='response.output_text.delta'||event.type==='response.refusal.delta'){const text=String(event.delta??'');item.text+=text;send({content:text});}
        else if(event.type==='response.output_item.done')completeItem(index,event.item);
        else if(event.type==='response.completed'||event.type==='response.incomplete'){const response=record(event.response);const chat=responsesToChatJson(response);(response.output as unknown[]).forEach((output,index)=>completeItem(index,output));send({},record((chat.choices as unknown[])[0]).finish_reason,chatUsage(response.usage));controller.enqueue(encoder.encode('data: [DONE]\n\n'));}
        else if(event.type==='response.failed'||event.type==='error')throw failure('Responses provider reported a failed generation.');
      };
      const cancel=()=>{void reader.cancel(signal.reason).catch(()=>undefined);};signal.addEventListener('abort',cancel,{once:true});
      try{while(!state.terminalEventSeen){const chunk=await reader.read();if(chunk.done){for(const event of decoder.finish())if(event.data)process(event.data,event.id);break;}bytes+=chunk.value.byteLength;if(bytes>16*1024*1024)throw failure('Responses stream exceeds the size limit.');for(const event of decoder.push(chunk.value)){if(event.data)process(event.data,event.id);if(state.terminalEventSeen)break;}}
        if(!state.terminalEventSeen)throw failure('Responses stream ended before a terminal event.');controller.close();
      }catch(error){
        if(signal.aborted)controller.error(error);
        else {controller.enqueue(encoder.encode('data: '+JSON.stringify({error:{type:'INCOMPLETE_RESPONSE',message:'Responses stream ended without a valid complete answer.'}})+'\n\n'));controller.close();}
      }finally{signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    },cancel(reason){return reader.cancel(reason).catch(()=>undefined);},
  });
  return new Response(body,{headers:{'content-type':'text/event-stream'}});
}
