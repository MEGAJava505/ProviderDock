import type { UsageTelemetryEvent } from "../core/usage/usage-event.js";

/** Calendar boundaries use the browser's local timezone, including DST and Monday weeks. */
export function usagePeriodStart(value: string, period: "day" | "week"): string {
  const date = new Date(value.length === 10 ? value + "T12:00:00" : value);
  if (Number.isNaN(date.valueOf())) throw new TypeError("Invalid usage date");
  if (period === "week") date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

export function usageBreakdown(events: readonly UsageTelemetryEvent[]) {
  const rows = new Map<string, { providerId: string; modelId: string; client: string; sessionId: string;
    requests: number; incomplete: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; searches: number; total: number }>();
  for (const event of events) {
    const key = JSON.stringify([event.providerId, event.modelId, event.client, event.sessionId]);
    const row = rows.get(key) ?? { providerId: event.providerId, modelId: event.modelId, client: event.client, sessionId: event.sessionId,
      requests: 0, incomplete: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, searches: 0, total: 0 };
    row.requests++; row.incomplete += Number(event.outcome !== "completed");
    row.input += event.usage.uncachedInputTokens; row.output += event.usage.outputTokens;
    row.cacheRead += event.usage.cacheReadInputTokens; row.cacheWrite += event.usage.cacheWriteInputTokens;
    row.reasoning += event.usage.reasoningOutputTokens; row.searches += event.usage.webSearchRequests;
    row.total += event.usage.totalTokens; rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total);
}

export const usageTimelineJavaScript = `
const usagePeriodStart=${usagePeriodStart.toString()};
const usageBreakdown=${usageBreakdown.toString()};
function renderUsageTimeline(){const root=byId('usage-timeline');const detail=byId('usage-breakdown');root.replaceChildren();detail.replaceChildren();const period=byId('usage-period').value;const dateInput=byId('usage-date');if(!dateInput.value)dateInput.value=usagePeriodStart(new Date().toISOString(),'day');const selected=usagePeriodStart(dateInput.value,period);const events=state.snapshot?.usageEvents||[];const buckets=new Map();for(const event of events){const key=usagePeriodStart(event.recordedAt,period);buckets.set(key,(buckets.get(key)||0)+event.usage.totalTokens)}
const dates=[];for(let i=13;i>=0;i--){const date=new Date(selected+'T12:00:00');date.setDate(date.getDate()-i*(period==='week'?7:1));dates.push(usagePeriodStart(date.toISOString(),period))}const max=Math.max(1,...dates.map(date=>buckets.get(date)||0));for(const date of dates){const count=buckets.get(date)||0;const button=node('button','usage-bar'+(date===selected?' active':''));button.type='button';button.setAttribute('aria-pressed',String(date===selected));button.setAttribute('aria-label',(period==='week'?'Неделя с ':'')+date+': '+fmtNum(count)+' токенов');const meter=node('meter');meter.min=0;meter.max=max;meter.value=count;meter.setAttribute('aria-hidden','true');button.append(node('strong','',fmtNum(count)),meter,node('small','',date.slice(8)+'.'+date.slice(5,7)));button.addEventListener('click',()=>{dateInput.value=date;renderUsageTimeline()});root.append(button)}
const filtered=events.filter(event=>usagePeriodStart(event.recordedAt,period)===selected);const total=filtered.reduce((sum,event)=>sum+event.usage.totalTokens,0);detail.append(node('p','usage-selected',(period==='week'?'Неделя с ':'День ')+selected+' · '+fmtNum(total)+' токенов · '+filtered.length+' запросов'));if(!filtered.length){detail.append(node('p','empty','За этот период сохранённых запросов нет.'));return}for(const row of usageBreakdown(filtered)){const item=node('details','usage-action');const summary=node('summary');summary.append(node('strong','',(providerById(row.providerId)?.displayName||row.providerId)+' / '+row.modelId),node('span','',row.client+' · '+row.requests+' запросов · '+fmtNum(row.total)+' токенов'));item.append(summary);const metrics=node('div','usage-token-types');for(const [label,value] of [['Вход',row.input],['Выход',row.output],['Чтение кэша',row.cacheRead],['Запись кэша',row.cacheWrite],['Рассуждения (в составе выхода)',row.reasoning],['Веб-поиск, запросов',row.searches]])metrics.append(node('span','',label+': '+fmtNum(value)));item.append(metrics,node('p','hint','Сессия '+row.sessionId+' · незавершённых запросов: '+row.incomplete));detail.append(item)}}
`;
