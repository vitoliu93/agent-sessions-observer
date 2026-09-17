// 隔离浏览器测试：不连接或改动用户的观察服务。页面取 dist-cli/web 构建产物（先 bun run build:web），接口全部拦截。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Page} from 'playwright-core';
import type {DataView, SessionItem} from '../src/shared/types.ts';
import {fixture} from './frontend-fixture.ts';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),dist=path.join(root,'dist-cli/web');
const browser=await chromium.launch({headless:true,executablePath:process.env.OBS_BROWSER||`${os.homedir()}/Library/Caches/ms-playwright/chromium-1155/chrome-mac/Chromium.app/Contents/MacOS/Chromium`});
const out=process.env.OBS_TEST_OUT||'/tmp/observe-acceptance/frontend';await fs.mkdir(out,{recursive:true});
const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.map':'application/json'};
const results:{name:string,status:string,error?:string}[]=[];
interface State{data?:DataView|null,sessions?:Partial<SessionItem>[],errors?:string[],delay?:number,error?:string|null}
declare global{interface Window{__original?:Element|null}}
async function test(name:string,fn:(p:Page)=>Promise<void>){let page:Page|undefined;try{page=await browser.newPage({viewport:{width:1920,height:1080}});await fn(page);results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:(e as Error).message});if(page)await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});}finally{await page?.close();}}
async function mount(page:Page,data:DataView|null=fixture(),state:State={}){
  state.data=data;state.sessions=data?[{sid:data.sessionId!,short:data.sessionId!,cards:data.cards.length,syncN:data.syncN,children:data.children.length}]:[];
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));state.errors=errors;
  await page.route('http://observe.test/**',async route=>{const url=new URL(route.request().url());
    if(!url.pathname.startsWith('/api/')){const file=path.join(dist,url.pathname==='/'?'index.html':url.pathname);
      return route.fulfill(await fs.readFile(file).then(body=>({contentType:mime[path.extname(file)]||'application/octet-stream',body}),()=>({status:404,body:'not found'})));}
    if(state.delay)await new Promise(r=>setTimeout(r,state.delay));
    if(url.pathname==='/api/sessions')return route.fulfill({json:{sessions:state.sessions}});
    if(state.error)return route.fulfill({status:503,json:{error:state.error}});
    return route.fulfill({json:state.data});
  });await page.goto('http://observe.test/');if(data?.syncN)await page.locator('.card').first().waitFor({timeout:10000});return state;
}
try{
await test('overview_42_16_52',async p=>{const d=fixture();assert.equal(d.cards.length,42);assert.equal(d.edges.length,52);await mount(p,d);
  const m=await p.evaluate(()=>({w:document.documentElement.scrollWidth,v:innerWidth,h:document.documentElement.scrollHeight,goal:document.querySelector<HTMLElement>('#c-GOAL')!.getBoundingClientRect().toJSON(),bad:[...document.querySelectorAll('.card')].filter(x=>x.scrollHeight>x.clientHeight+1||x.scrollWidth>x.clientWidth+1).map(x=>x.id),conclusions:document.querySelectorAll('.card.concl').length}));
  assert.equal(m.w,m.v);assert(m.h<=1080,JSON.stringify(m));assert(m.goal.x<100);assert.equal(m.bad.length,0);assert(m.conclusions>0);assert.equal(await p.locator('#pcN').textContent(),'16');await p.screenshot({path:path.join(out,'overview.png'),fullPage:true});});
await test('no_node_or_fold_overlap',async p=>{await mount(p);const hits=await p.evaluate(()=>{const a=[...document.querySelectorAll('.card,.foldentry')].map(x=>({id:x.id,r:x.getBoundingClientRect()})),out:string[][]=[];for(let i=0;i<a.length;i++)for(let j=i+1;j<a.length;j++){const x=a[i].r,y=a[j].r;if(x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top)out.push([a[i].id,a[j].id]);}return out;});assert.deepEqual(hits,[]);});
await test('poll_keeps_dom_and_focus',async p=>{await mount(p);await p.locator('#c-GOAL').focus();await p.evaluate(()=>window.__original=document.querySelector('#c-GOAL'));await p.waitForTimeout(5300);assert.equal(await p.evaluate(()=>document.activeElement!.id),'c-GOAL');assert(await p.evaluate(()=>window.__original===document.querySelector('#c-GOAL')));});
await test('fold_expand_collapse_keyboard',async p=>{await mount(p);const before=await p.locator('.card').count();await p.locator('#fold-2').focus();await p.keyboard.press('Enter');assert(await p.locator('.card').count()>before);await p.locator('[data-col="2"]').click();assert.equal(await p.locator('.card').count(),before);});
await test('detail_enter_escape_quotes',async p=>{await mount(p);const b=p.locator('.card.change .dtl').first();await b.focus();await p.keyboard.press('Enter');await p.locator('#drawer.open').waitFor();assert((await p.locator('#dBody').textContent())!.includes('"118s"'));await p.keyboard.press('Escape');assert.equal(await p.locator('#drawer.open').count(),0);assert((await p.evaluate(()=>document.activeElement!.id)).startsWith('c-'));});
await test('history_text_and_drawer',async p=>{await mount(p);await p.locator('#c-GOAL .dtl').click();await p.locator('#histBtn').click();await p.locator('#hslider').fill('1');assert.equal(await p.locator('#c-GOAL h4').textContent(),'旧目标正文');assert.equal(await p.locator('#dHead h3').textContent(),'旧目标正文');assert.equal(await p.locator('#lvKnown').textContent(),'旧结果');await p.locator('#hback').click();assert.equal(await p.locator('#c-GOAL h4').textContent(),'字体识别提速，判定结果不变');});
await test('pending_updates_do_not_replace_reading',async p=>{const state=await mount(p);await p.locator('#c-GOAL .dtl').click();state.data=structuredClone(state.data!);state.data.syncN=3;state.data.updatedAt='new';const snap=structuredClone(state.data.history[1]);snap.at=3;snap.goals[0].title='最新目标';state.data.history.push(snap);await p.waitForTimeout(5300);assert.equal(await p.locator('#dHead h3').textContent(),'字体识别提速，判定结果不变');assert.equal(await p.locator('#pending').isVisible(),true);await p.locator('#pending').click();assert.equal(await p.locator('#dHead h3').textContent(),'最新目标');});
await test('all_agents_and_live_keyboard',async p=>{await mount(p);await p.locator('#pcAll').click();assert.equal(await p.locator('.pcrow').count(),16);await p.locator('#pcSearch').fill('agent-15');await p.locator('.pcrow').focus();await p.keyboard.press('Enter');assert.equal(await p.locator('#pcPanel.open').count(),0);await p.locator('.lcell').first().focus();await p.keyboard.press('Enter');assert.equal(await p.locator('#dHead h3').textContent(),'当前进展全文');});
await test('relationship_reveals_folded_target',async p=>{await mount(p);await p.locator('#c-S1 .dtl').click();const target='C14';assert.equal(await p.locator('#c-'+target).count(),0);await p.locator(`[data-target="${target}"]`).click();assert.equal(await p.locator('#c-'+target).count(),1);assert((await p.locator('#dHead h3').textContent())!.includes(target));});
await test('empty_is_recoverable',async p=>{await mount(p,null);await p.locator('#boot').waitFor({state:'visible'});assert.equal(await p.locator('#swBtn').isEnabled(),true);assert((await p.locator('#boot').textContent())!.includes('尚未观察'));assert.equal(await p.locator('#swBtn').isVisible(),true);});
await test('edges_do_not_cross_cards',async p=>{await mount(p);const hits=await p.evaluate(()=>{const boxes=[...document.querySelectorAll('.card,.foldentry')].map(c=>({id:c.id,r:c.getBoundingClientRect()})),svg=document.querySelector<HTMLElement>('#edges')!.getBoundingClientRect(),hits:string[]=[];for(const e of document.querySelectorAll<SVGPathElement>('#edges path[data-edge]')){const n=e.getTotalLength();for(let k=6;k<n-6;k+=5){const p=e.getPointAtLength(k),x=p.x+svg.x,y=p.y+svg.y;const hit=boxes.find(b=>x>b.r.left+2&&x<b.r.right-2&&y>b.r.top+2&&y<b.r.bottom-2);if(hit){hits.push(hit.id);break;}}}return hits;});assert.deepEqual(hits,[]);});
await test('no_script_error',async p=>{const state=await mount(p);await p.locator('#reset').click();await p.locator('#branch').selectOption('S2');await p.locator('#c-S2 .dtl').click();await p.keyboard.press('Escape');assert.deepEqual(state.errors,[]);});

await test('first_error_can_retry',async p=>{const d=fixture();d.syncN=0;const state:State={error:'临时读取失败'};await mount(p,d,state);await p.locator('#boot').waitFor({state:'visible'});assert.equal(await p.locator('#swBtn').isEnabled(),true);assert.equal(await p.locator('#btnResync').isEnabled(),true);state.error=null;state.data=fixture();await p.locator('#btnResync').click();await p.locator('#c-GOAL').waitFor();assert.deepEqual(state.errors,[]);});
await test('agent_with_folded_contribution_has_visible_highlight',async p=>{await mount(p);await p.locator('#pcAll').click();await p.locator('#pcSearch').fill('agent-15');await p.locator('.pcrow').click();assert(await p.locator('.foldentry.hl').count()>0);});
await test('poll_preserves_session_menu_focus',async p=>{await mount(p);await p.locator('#swBtn').click();await p.locator('[data-sid]').focus();await p.waitForTimeout(5300);assert.equal(await p.evaluate(()=>(document.activeElement as HTMLElement).dataset.sid),'fixture-a');});
await test('history_without_selected_branch_resets_to_overview',async p=>{const d=fixture();d.history[0].cards=d.history[0].cards.filter(c=>c.id!=='S2');await mount(p,d);await p.locator('#branch').selectOption('S2');await p.locator('#histBtn').click();await p.locator('#hslider').fill('1');assert.equal(await p.locator('#branch').inputValue(),'');assert(await p.locator('.card').count()>1);});
await test('narrow_view_and_long_detail_remain_readable',async p=>{await p.setViewportSize({width:900,height:900});const d=fixture();d.history[1].cards[2].facts=['LONG_'+ 'x'.repeat(3000)];await mount(p,d);await p.locator('.card.change .dtl').first().click();const dims=await p.evaluate(()=>({w:document.documentElement.scrollWidth,v:innerWidth,body:document.querySelector<HTMLElement>('#dBody')!.scrollWidth,drawer:document.querySelector<HTMLElement>('#dBody')!.clientWidth}));assert.equal(dims.w,dims.v);assert.equal(dims.body,dims.drawer);});
for(const w of [1920,1280])await test('located_card_not_under_drawer_'+w,async p=>{await p.setViewportSize({width:w,height:900});await mount(p);
  const w0=await p.locator('#c-GOAL').evaluate(n=>(n as HTMLElement).offsetWidth);const v=p.locator('.card.verify').first();await v.locator('.dtl').click();await p.locator('#drawer.open').waitFor();
  assert.equal(await p.locator('#c-GOAL').evaluate(n=>(n as HTMLElement).offsetWidth),w0,'打开抽屉不重排');
  const targets=await p.locator('#dBody [data-target]').evaluateAll(ns=>ns.map(n=>(n as HTMLElement).dataset.target!));assert(targets.some(t=>t.startsWith('K')));
  const vid=await v.getAttribute("data-id");
  for(const t of targets){if(!await p.locator(`#dBody [data-target="${t}"]`).count()){await p.keyboard.press("Escape");await p.locator(`#c-${vid} .dtl`).click();}
    await p.locator(`#dBody [data-target="${t}"]`).first().click();await p.waitForTimeout(150);
    const seen=await p.evaluate(id=>{const n=document.getElementById('c-'+id)!,r=n.getBoundingClientRect();return [[r.left+4,r.top+4],[r.right-4,r.bottom-4]].every(([x,y])=>n.contains(document.elementFromPoint(x,y)));},t);
    assert(seen,t+' covered at '+w);}
  await p.keyboard.press('Escape');assert.equal(await p.locator('#wrap').evaluate(n=>n.scrollLeft),0);});
await test('agent_highlights_only_signed_cards',async p=>{await mount(p);await p.locator('#pcAll').click();await p.locator('#pcSearch').fill('agent-1');await p.locator('.pcrow[data-k="agent-1"]').click();const agents=await p.locator('.card.hl .sig1 b').allTextContents();assert(agents.length>0);assert.deepEqual([...new Set(agents)],['agent-1']);});
await test('selected_card_highlights_direct_relations_only',async p=>{await mount(p);const d=fixture();await p.locator('#c-S1').click();const hl=await p.locator('.card.hl').evaluateAll(ns=>ns.map(n=>(n as HTMLElement).dataset.id!));const direct=new Set(['S1',...d.edges.filter(e=>e.f==='S1'||e.t==='S1').flatMap(e=>[e.f,e.t])]);assert(hl.length>1);assert(hl.every(id=>direct.has(id)),hl.join());});
await test('visible_and_folded_cover_all_once',async p=>{await mount(p);const r=await p.evaluate(()=>({shown:document.querySelectorAll('.card').length,folded:[...document.querySelectorAll('.foldentry .t1')].reduce((a,n)=>a+parseInt(n.textContent!.match(/\d+/)![0]),0)}));assert.equal(r.shown+r.folded,43);});
await test('keyboard_focus_after_fold_and_live_drawer',async p=>{await mount(p);await p.locator('#fold-2').focus();await p.keyboard.press('Enter');assert((await p.evaluate(()=>document.activeElement!.id)).startsWith('c-'));const cell=p.locator('.lcell').first();await cell.focus();await p.keyboard.press('Enter');await p.locator('#drawer.open').waitFor();await p.keyboard.press('Escape');assert(await cell.evaluate(n=>n===document.activeElement));});
await test('multiple_goals_dag',async p=>{const d=fixture();const extra=(id:string,title:string)=>({...d.goals[0],id,title,st:'doing' as const,acc:[]});
  for(const x of [d,...d.history]){x.goals.push(extra('GOAL2','接着做：结果缓存'),extra('GOAL3','推倒重来：换识别模型'));x.edges.push({f:'GOAL',t:'GOAL2',v:'接着'},{f:'GOAL3',t:'GOAL',v:'推翻'});}
  const state=await mount(p,d);for(const id of ['GOAL','GOAL2','GOAL3'])assert((await p.locator('#c-'+id).boundingBox())!.x<100,id);
  await p.locator('#c-GOAL2').hover();assert((await p.locator('#edges text.hl').allTextContents()).includes('接着'));
  await p.locator('#branch').selectOption('GOAL');assert.equal(await p.locator('#c-GOAL2').count(),0);assert.equal(await p.locator('#c-S1').count(),1);
  await p.locator('#branch').selectOption('S1');assert.equal(await p.locator('#c-GOAL').count(),1);assert.equal(await p.locator('#c-S2').count(),0);assert.deepEqual(state.errors,[]);});
await test('draft_renders_progressively',async p=>{const full=fixture();
  const d:DataView={...full,syncN:0,analyzing:true,history:[],goals:[],cards:[],edges:[],draft:{goals:full.goals,cards:full.cards.slice(0,2),edges:full.edges.slice(0,2),live:{now:'草稿进行中'},chars:900,startedAt:'x'}};
  const state=await mount(p,d);await p.locator('#c-S1').waitFor();assert.equal(await p.locator('#boot').isVisible(),false);
  assert.match((await p.locator('#stat').textContent())!,/已出 3 张卡/);assert.match((await p.locator('#notebar').textContent())!,/生成中/);
  const next=structuredClone(d);next.draft!.cards=full.cards.slice(0,6);next.draft!.chars=2000;state.data=next;
  await p.locator('#c-C0').waitFor({timeout:2500});
  await p.locator('#c-C0 .dtl').click();assert.equal(await p.locator('#dBody .kv b',{hasText:'关系'}).first().textContent(),'关系生成中');
  state.data=full;await p.locator('#stat',{hasText:'最新 · #2'}).waitFor({timeout:2500});
  assert.equal(await p.locator('#pending').isVisible(),false);assert.match((await p.locator('#dBody .kv b',{hasText:'关系'}).first().textContent())!,/^关系 [1-9]/);
  assert.doesNotMatch((await p.locator('#notebar').textContent())!,/生成中/);assert.deepEqual(state.errors,[]);});
await test('history_delta_merges_with_held_history',async p=>{const state=await mount(p);const next=structuredClone(state.data!);const snap=structuredClone(next.history[1]);snap.at=3;next.syncN=3;next.updatedAt='n3';next.historySince=2;next.history=[snap];state.data=next;await p.waitForTimeout(5300);await p.locator('#histBtn').click();assert.equal(await p.locator('#hslider').getAttribute('max'),'3');await p.locator('#hslider').fill('1');assert.equal(await p.locator('#c-GOAL h4').textContent(),'旧目标正文');});
}finally{await browser.close();await fs.writeFile(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));}
if(results.some(x=>x.status==='FAIL'))process.exitCode=1;
