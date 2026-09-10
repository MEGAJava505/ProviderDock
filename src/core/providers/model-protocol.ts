import type { ProviderProfile } from "./provider-profile.js";
import type { ProviderHealthRecord } from "../health/provider-health-repository.js";
import type { PortalRecord } from "../portals/portal-types.js";

export type ModelProtocol = "openai-responses" | "openai-chat-completions" | "anthropic-messages";
export type ModelProtocolResolver = (profile: ProviderProfile, modelId: string, client: "codex" | "claude-code") => Promise<ModelProtocol | undefined>;

/** Successful traffic is stronger evidence than an advertised endpoint. */
export function knownModelProtocol(record: ProviderHealthRecord | undefined, portal: PortalRecord | undefined, modelId: string,
  client: "codex" | "claude-code", now = new Date()): ModelProtocol | undefined {
  const compatible = (protocol: string): protocol is ModelProtocol => ["openai-responses", "openai-chat-completions", ...(client === "claude-code" ? ["anthropic-messages"] : [])].includes(protocol);
  const latest=(record?.runtimeSignals??[]).filter(signal=>signal.modelId===modelId&&signal.outcome==="completed"&&compatible(signal.protocol)&&
    Date.parse(signal.observedAt)<=now.valueOf()&&now.valueOf()-Date.parse(signal.observedAt)<24*3600000).sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
  if(latest&&compatible(latest.protocol))return latest.protocol;
  const diagnostic=record?.diagnostics.find(item=>item.modelId===modelId&&item.verdict==="PASS"&&
    Date.parse(item.checkedAt)<=now.valueOf()&&now.valueOf()-Date.parse(item.checkedAt)<30*60000);
  if(diagnostic?.protocol&&compatible(diagnostic.protocol))return diagnostic.protocol;
  const catalog=portal?.latest?.catalog;
  if(catalog?.status!=="ok"||Date.parse(catalog.expiresAt)<=now.valueOf())return undefined;
  const endpoints=catalog.value?.models.find(item=>item.modelId===modelId)?.endpointTypes??[];
  const aliases: Record<string,ModelProtocol>={openai:"openai-chat-completions",chat:"openai-chat-completions","chat/completions":"openai-chat-completions","openai-chat-completions":"openai-chat-completions",responses:"openai-responses","openai-response":"openai-responses","openai-responses":"openai-responses",anthropic:"anthropic-messages",claude:"anthropic-messages",messages:"anthropic-messages","anthropic-messages":"anthropic-messages"};
  const supported=new Set(endpoints.map(name=>aliases[name]).filter(value=>value&&compatible(value)));
  for(const protocol of client==="claude-code"?["anthropic-messages","openai-chat-completions","openai-responses"] as const:["openai-responses","openai-chat-completions"] as const)if(supported.has(protocol))return protocol;
  return undefined;
}
