import type { Card, CardType, DataView, Snapshot, State } from '../src/shared/types.ts';

export function fixture(): DataView {
  const make=(id:string,type:CardType,n:number,goalId='S1'):Card=>({id,type,goalId,zone:goalId,title:`${id} · ${type==='verify'?'验证范围':type==='change'?'并发处理修改':'需求解决记录'} ${n}`,sub:'仅本次样本；完整范围见详情。',st:(['risk','gap'].includes(type)?'risk':type==='change'&&n%3===0?'doing':'done') as State,sig:[{verb:type==='verify'?'验证':'实现',agent:`agent-${n%16}`}],facts:[`证据 ${id}：耗时 "118s"，结果一致需独立检查。`,'长路径 /'+ '目录/'.repeat(35)+'result.json','未确认的条件必须保留。'],ev:`fixture.jsonl:${n+1}`,born:1});
  const goal:Card={...make('GOAL','goal',0),title:'字体识别提速，判定结果不变',st:'unknown',acc:['30 秒片处理耗时 ≤120s','判定结果与基线一致','失败记录保留且可查','抽样不代表全部素材通过']};
  const cards=[{...make('S1','subgoal',1),title:'耗时达标'},{...make('S2','subgoal',2),title:'判定一致'}];
  for(const [type,count,prefix] of [['change',16,'C'],['risk',5,'R'],['verify',10,'V'],['concl',5,'K'],['gap',4,'G']] as const)for(let i=0;i<count;i++)cards.push(make(prefix+i,type,i,i%2?'S2':'S1'));
  const edges:Snapshot['edges']=[{f:'GOAL',t:'S1',v:'拆成'},{f:'GOAL',t:'S2',v:'拆成'}];
  for(let i=0;i<16;i++)edges.push({f:i%2?'S2':'S1',t:'C'+i,v:'采用'});
  for(let i=0;i<10;i++)edges.push({f:'C'+i,t:'V'+i,v:'检查'});
  for(let i=0;i<5;i++)edges.push({f:'V'+i,t:'K'+i,v:'支持'},{f:'R'+i,t:'C'+i,v:'妨碍'});
  for(let i=0;i<4;i++)edges.push({f:'K'+i,t:'G'+i,v:'留下缺口'});
  for(let i=0;i<10;i++)edges.push({f:i%2?'S2':'S1',t:'V'+i,v:'检查'});
  // 类型补齐字段（label/color/kind 等）不参与前端判断
  const base:Omit<Snapshot,'at'>={goals:[goal],cards,edges,live:{now:'agent-0 检查并发结果；agent-3 修复排序。',known:'仅30秒样本118s；还没有全量判定一致证据。',next:'补齐基线验证。'},agents:Array.from({length:16},(_,i)=>({key:`agent-${i}`,label:`agent-${i}`,count:0,verbs:{},color:'#60a5fa'})),children:Array.from({length:16},(_,i)=>({key:`agent-${i}`,label:`agent-${i}`,kind:'agent',sessionId:null,dispatchLine:0,events:1,matched:'exact'})),note:'可重复测试夹具，不是生产事实。',stamps:[{at:1,data:'10:00:00',summary:'10:00:01'},{at:2,data:'10:01:00',summary:'10:01:01'}],updatedAt:'2026-09-16T10:01:01Z',dataReadAt:null};
  const old=structuredClone(base);old.goals[0].title='旧目标正文';old.cards[2].facts=['旧事实，不含新结论'];old.live.known='旧结果';
  return {...base,sessionId:'fixture-a',prefix:'fixture-a',lastError:null,analyzing:false,draft:null,boot:'fixture',historySince:0,syncN:2,history:[{...old,at:1},{...structuredClone(base),at:2}]};
}
