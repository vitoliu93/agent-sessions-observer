import type { Card, CardType, DataView, Snapshot, State } from '../src/shared/types.ts';

export function fixture(): DataView {
  const make=(id:string,type:CardType,n:number,goalId='S1'):Card=>({id,type,goalId,title:`${id} · ${type==='verify'?'验证范围':type==='change'?'并发处理修改':'需求解决记录'} ${n}`,sub:'仅本次样本；完整范围见详情。',st:(['risk','gap'].includes(type)?'risk':type==='change'&&n%3===0?'doing':'done') as State,sig:[{verb:type==='verify'?'验证':'实现',agent:`agent-${n%16}`}],facts:[`证据 ${id}：耗时 "118s"，结果一致需独立检查。`,'长路径 /'+ '目录/'.repeat(35)+'result.json','未确认的条件必须保留。'],ev:`fixture.jsonl:${n+1}`});
  const goal:Card={...make('GOAL','goal',0),title:'字体识别提速，判定结果不变',st:'unknown',acc:['30 秒片处理耗时 ≤120s','判定结果与基线一致','失败记录保留且可查','抽样不代表全部素材通过']};
  const cards=[{...make('S1','subgoal',1),title:'耗时达标'},{...make('S2','subgoal',2),title:'判定一致'}];
  for(const [type,count,prefix] of [['change',16,'C'],['risk',5,'R'],['verify',10,'V'],['concl',5,'K'],['gap',4,'G']] as const)for(let i=0;i<count;i++)cards.push(make(prefix+i,type,i,i%2?'S2':'S1'));
  const edges:Snapshot['edges']=[{f:'GOAL',t:'S1',v:'拆成'},{f:'GOAL',t:'S2',v:'拆成'}];
  for(let i=0;i<16;i++)edges.push({f:i%2?'S2':'S1',t:'C'+i,v:'采用'});
  for(let i=0;i<10;i++)edges.push({f:'C'+i,t:'V'+i,v:'检查'});
  for(let i=0;i<5;i++)edges.push({f:'V'+i,t:'K'+i,v:'支持'},{f:'R'+i,t:'C'+i,v:'妨碍'});
  for(let i=0;i<4;i++)edges.push({f:'K'+i,t:'G'+i,v:'留下缺口'});
  for(let i=0;i<10;i++)edges.push({f:i%2?'S2':'S1',t:'V'+i,v:'检查'});
  const base:Snapshot={goals:[goal],cards,edges,live:{now:'agent-0 检查并发结果；agent-3 修复排序。',known:'仅30秒样本118s；还没有全量判定一致证据。',next:'补齐基线验证。'},children:Array.from({length:16},(_,i)=>({key:`agent-${i}`,label:`agent-${i}`,kind:'agent',events:1,matched:'exact'})),note:'可重复测试夹具，不是生产事实。',updatedAt:'2026-09-16T10:01:01Z',dataReadAt:'10:01:00'};
  return {...base,sessionId:'fixture-a',lastError:null,analyzing:false,draft:null,pulse:null,engine:'cli',review:{on:false,running:false,at:null,unreviewed:0,error:null},syncN:2};
}
