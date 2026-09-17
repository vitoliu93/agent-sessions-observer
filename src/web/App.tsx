/* 记录数据与当前阅读快照分开；历史、抽屉、地图始终读同一个 view。
   轮询与异步请求要读最新状态，所以状态放在一个可变 store 里，改完调 bump() 重绘。 */
import { useEffect, useReducer, useRef } from 'react';
import type { Card, DataView, Edge, SessionItem } from '../shared/types.ts';
import { cardsOf, isOpen, plan, snapshot, type View } from './lib.ts';
import Topbar from './components/Topbar.tsx';
import LiveBar from './components/LiveBar.tsx';
import SigBar from './components/SigBar.tsx';
import MapView, { type Emph } from './components/MapView.tsx';
import Drawer from './components/Drawer.tsx';
import History from './components/History.tsx';

export interface Store {
  data: DataView | null; pending: DataView | null; sessions: SessionItem[]; curSid: string | null;
  viewTick: number; follow: boolean;
  selectedId: string | null; hoveredId: string | null; selAgent: string | null;
  drawerId: string | null; drawerShown: string | null; opener: Element | null; room: boolean;
  branchId: string; expanded: Set<string>;
  requestN: number; lastKey: string;
  /** 正在显示分析中的草稿（还没有第一版正式地图）；fast：分析中每秒拉一次 */
  drafting: boolean; fast: boolean;
  notice: string; stat: string; resyncDisabled: boolean; boot: { show: boolean; msg: string };
  swOpen: boolean; pcOpen: boolean; pcQuery: string; histOpen: boolean;
  /** 布局稳定（卡片已定位可见）后执行：聚焦、滚动到卡片 */
  after: (() => void)[];
}
export type Actions = ReturnType<typeof createActions>;
export interface AppCtx { s: Store; a: Actions; view: View | null; ready: boolean; all: Card[]; byId: Map<string, Card> }

const newStore = (): Store => ({
  data: null, pending: null, sessions: [], curSid: null, viewTick: 0, follow: true,
  selectedId: null, hoveredId: null, selAgent: null, drawerId: null, drawerShown: null, opener: null, room: false,
  branchId: '', expanded: new Set(), requestN: 0, lastKey: '', drafting: false, fast: false,
  notice: '', stat: '加载中…', resyncDisabled: false, boot: { show: false, msg: '正在读取会话…' },
  swOpen: false, pcOpen: false, pcQuery: '', histOpen: false, after: [],
});

const errText = (e: unknown) => e instanceof Error ? e.message : String(e);
async function json<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || `请求失败 (${r.status})`);
  return d;
}
const $ = (id: string) => document.getElementById(id);

function createActions(s: Store, bump: () => void) {
  const render = () => { s.hoveredId = null; bump(); };
  const tell = (message: string) => { s.notice = message; bump(); };

  function closeDrawer(focus = true) {
    const id = s.drawerId;
    s.drawerId = null; s.room = false;
    const wrap = $('wrap'); if (wrap) wrap.scrollLeft = 0;
    if (focus) ($('c-' + id) || (s.opener?.isConnected ? s.opener as HTMLElement : null))?.focus({ preventScroll: true });
    bump();
  }
  function resetView() {
    s.selectedId = s.hoveredId = s.selAgent = null; s.branchId = '';
    s.expanded.clear(); closeDrawer(false);
  }
  function clearMap(message: string) {
    s.data = null; s.lastKey = ''; s.pending = null; s.drafting = false;
    resetView();
    s.pcOpen = false; s.boot = { show: true, msg: message };
    bump();
  }
  function adopt(d: DataView, key = `${d.sessionId}:${d.syncN}:${d.updatedAt || ''}`) {
    const switched = s.data?.sessionId !== d.sessionId;
    s.data = d; s.pending = null; s.drafting = !d.syncN;
    if (switched) { resetView(); s.follow = true; s.viewTick = d.syncN; }
    if (s.follow) s.viewTick = d.syncN;
    s.lastKey = key;
    render();
  }
  async function refresh() {
    const n = ++s.requestN, sid = s.curSid || s.data?.sessionId || null, base = s.pending || s.data;
    const since = base && base.sessionId === sid ? base.history?.at(-1)?.at || 0 : 0;
    try {
      const list = await json<{ sessions?: SessionItem[] }>('/api/sessions');
      if (n !== s.requestN) return;
      s.sessions = list.sessions || [];
      bump();
      if (!s.sessions.length) {
        clearMap('尚未观察会话，请从左上角添加 session ID。');
        s.stat = '尚无会话'; s.resyncDisabled = true; return bump();
      }
      const d = await json<DataView>('/api/data' + (sid ? `?sid=${encodeURIComponent(sid)}&since=${since}&boot=${encodeURIComponent(base?.boot || '')}` : ''));
      if (n !== s.requestN) return;
      if (d.historySince) d.history = [...(base?.history || []).filter(h => h.at <= d.historySince), ...d.history];
      s.curSid = d.sessionId || sid;
      const dr = d.analyzing ? d.draft : null, shown = dr ? dr.goals.length + dr.cards.length : 0;
      const failed = `分析失败：${d.lastError}。稍后会自动重试，也可以点「触发同步」立即重试。`;
      const waiting = !dr?.chars ? '正在生成第一版地图：等模型开始输出…' : `正在生成第一版地图：已收到 ${dr.chars} 字，等第一个目标写完…`;
      s.boot = { show: !d.syncN && !shown, msg: d.lastError && !d.analyzing ? failed : d.analyzing ? waiting : '尚无摘要，请触发同步。' };
      s.stat = d.analyzing ? (shown ? `摘要生成中 · 已出 ${shown} 张卡` : '摘要生成中…') : d.lastError ? '上次同步失败' : `最新 · #${d.syncN}`;
      s.resyncDisabled = !!d.analyzing; s.fast = !!d.analyzing;
      s.notice = d.analyzing ? '' : d.lastError || '';
      if (!d.syncN) {
        // 第一版还没出来：边收边画草稿；已有正式地图时不拿草稿替换
        if (dr?.goals.length) {
          const key = `${d.sessionId}:draft:${dr.chars}`;
          return key === s.lastKey ? bump() : adopt({ ...d, goals: dr.goals, cards: dr.cards, edges: dr.edges, live: dr.live, history: [] }, key);
        }
        return clearMap(s.boot.msg);
      }
      if (`${d.sessionId}:${d.syncN}:${d.updatedAt || ''}` === s.lastKey) return bump();
      // 阅读中（详情、选中、回放、焦点在地图内）不替换地图，先提示
      if (s.data?.sessionId === d.sessionId && (!s.follow || s.drawerId || s.selectedId || document.activeElement?.closest('#wrap'))) {
        s.pending = d; return bump();
      }
      adopt(d);
    } catch (e) {
      if (n === s.requestN) { s.notice = errText(e); s.stat = '读取失败，可重试'; s.boot = { show: !s.data, msg: errText(e) }; bump(); }
    }
  }
  async function action(url: string, body: unknown) {
    try { await json(url, body); tell(''); await refresh(); } catch (e) { tell(errText(e)); }
  }
  // 卡被抽屉盖住时，地图在自身区域内横向滚开，不重排；#room 撑出可滚宽度
  function reveal(id: string) {
    const n = $('c-' + id), dw = $('drawer')!.offsetWidth;
    if (!n) return;
    n.scrollIntoView({ block: 'nearest' });
    const over = n.getBoundingClientRect().right - (innerWidth - dw - 16);
    if (over > 0) $('wrap')!.scrollLeft += over;
  }
  function openDrawer(id: string) {
    if (!s.data) return tell('尚无摘要可查看。');
    s.opener = document.activeElement; s.drawerId = s.drawerShown = id;
    if (id !== '__LIVE__') { s.selectedId = id; s.room = true; }
    s.after.push(() => { $('dClose')?.focus(); if (id !== '__LIVE__') reveal(id); });
    bump();
  }

  return {
    refresh, openDrawer, closeDrawer,
    stable() { for (const f of s.after.splice(0)) f(); },
    switchTo(sid: string) { s.curSid = sid; clearMap('正在读取所选会话…'); s.follow = true; s.swOpen = false; bump(); refresh(); },
    remove(sid: string) { if (sid === (s.curSid || s.data?.sessionId)) s.curSid = null; action('/api/sessions/remove', { id: sid }); },
    async add(input: HTMLInputElement) {
      const id = input.value.trim();
      if (!id) return;
      try { const r = await json<{ sid: string }>('/api/sessions/add', { id }); s.curSid = r.sid; input.value = ''; resetView(); await refresh(); }
      catch (e) { tell(errText(e)); }
    },
    resync() { action('/api/resync', { id: s.curSid || s.data?.sessionId }); },
    takePending() { const d = s.pending; if (!d) return; s.follow = true; s.selectedId = null; adopt(d); },
    slide(tick: number) { if (!s.data) return; s.viewTick = tick; s.follow = tick === s.data.syncN; s.selectedId = s.hoveredId = null; render(); },
    back() { if (!s.data) return; s.follow = true; s.selectedId = null; adopt(s.pending || s.data); },
    branch(id: string) { s.branchId = id; s.expanded.clear(); s.selectedId = null; render(); },
    reset() { resetView(); render(); },
    select(id: string) { s.selectedId = id; bump(); },
    hover(id: string | null) { s.hoveredId = id; bump(); },
    expand(col: number, firstId: string) { s.expanded.add(String(col)); s.after.push(() => $('c-' + firstId)?.focus()); render(); },
    collapse(col: number) { s.expanded.delete(String(col)); render(); },
    background() { s.selectedId = s.hoveredId = s.selAgent = null; bump(); },
    toggleAgent(key: string) { s.selAgent = s.selAgent === key ? null : key; s.hoveredId = s.selectedId = null; bump(); },
    pickAgent(key: string) { s.selAgent = s.selAgent === key ? null : key; s.hoveredId = s.selectedId = null; s.pcOpen = false; bump(); },
    togglePanel() { s.pcOpen = !s.pcOpen; if (s.pcOpen) s.after.push(() => $('pcSearch')?.focus()); bump(); },
    query(q: string) { s.pcQuery = q; bump(); },
    toggleMenu() { s.swOpen = !s.swOpen; bump(); },
    toggleHist() { s.histOpen = !s.histOpen; bump(); },
    // 关系跳转：回到全局、展开目标所在列，再滚开抽屉
    jump(id: string, col: number) {
      s.notice = ''; s.branchId = ''; s.expanded.add(String(col));
      s.selectedId = s.drawerId = s.drawerShown = id; s.room = true;
      s.after.push(() => { reveal(id); $('dClose')?.focus({ preventScroll: true }); });
      render();
    },
    key(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (s.drawerId) closeDrawer();
      else if (s.pcOpen) { s.pcOpen = false; bump(); $('pcAll')?.focus(); }
      else { s.selectedId = s.hoveredId = s.selAgent = null; bump(); }
    },
    docClick(e: MouseEvent) {
      const t = e.target as Element;
      const closeSw = s.swOpen && !t.closest('.switcher'), closePc = s.pcOpen && !t.closest('.sigbar');
      if (closeSw) s.swOpen = false;
      if (closePc) s.pcOpen = false;
      if (closeSw || closePc) bump();
    },
  };
}

export default function App() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const ref = useRef<{ s: Store; a: Actions }>(null);
  if (!ref.current) { const s = newStore(); ref.current = { s, a: createActions(s, bump) }; }
  const { s, a } = ref.current;

  useEffect(() => {
    // 分析中每秒拉一次草稿，平时 5 秒
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => { timer = setTimeout(async () => { await a.refresh(); tick(); }, s.fast ? 1000 : 5000); };
    a.refresh().then(tick);
    document.addEventListener('keydown', a.key);
    document.addEventListener('click', a.docClick);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', a.key); document.removeEventListener('click', a.docClick); };
  }, [a]);

  const view = s.data ? snapshot(s.data, s.viewTick) : null, t = s.viewTick;
  const ready = !!(view?.goals?.length && (s.data?.syncN || s.drafting));
  const all = ready ? cardsOf(view) : [], edges: Edge[] = ready ? view!.edges || [] : [];
  const byId = new Map(all.map(c => [c.id, c]));
  const p = plan(all, edges, s.branchId, s.expanded, t);
  s.branchId = p.branch;
  if (s.drawerId && s.drawerId !== '__LIVE__' && !byId.has(s.drawerId)) { s.drawerId = null; s.room = false; }

  // 高亮：悬停/选中看直接关系；选参与者看其署名卡
  const focus = s.hoveredId || s.selectedId, active = !!(focus || s.selAgent);
  const ids = new Set(focus ? [focus] : all.filter(c => (c.sig || []).some(g => g.agent === s.selAgent)).map(c => c.id));
  const direct = (e: Edge) => focus ? e.f === focus || e.t === focus : ids.has(e.f) || ids.has(e.t);
  const hl = new Set(ids);
  if (focus) for (const e of edges) if (direct(e)) { hl.add(e.f); hl.add(e.t); }
  const emph: Emph = { active, hl, direct, groups: new Set([...hl].map(id => p.cardGroup.get(id)).filter((g): g is string => !!g)) };

  const app: AppCtx = { s, a, view, ready, all, byId };
  const note = ready ? [s.drafting ? '生成中：模型还在输出，已出的卡片可能还会变' : '', view!.note, view!.coverage?.note,
    (view!.children || []).some(c => ['no-file', 'ambiguous'].includes(c.matched) || c.events === 0) ?
      '部分子会话未定位或归属不确定，不能视作完整覆盖。' : ''].filter(Boolean).join(' · ') : '';

  return (<>
    <Topbar app={app} />
    <LiveBar app={app} />
    <SigBar app={app} />
    <div className="toolbar">
      <label>查看 <select id="branch" value={p.branch} onChange={e => a.branch(e.target.value)}>
        <option value="">全局概览</option>
        {all.filter(c => c.type === 'goal').length > 1 && all.filter(c => c.type === 'goal').map(c => <option key={c.id} value={c.id}>{`目标 · ${c.title}`}</option>)}
        {all.filter(c => c.type === 'subgoal').map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
        {p.unassigned > 0 && <option value="__unassigned__">{`归属待确认 · ${p.unassigned} 条`}</option>}
      </select></label>
      <span id="scope">{ready ? `${all.filter(c => c.type === 'goal').length} 个目标 · ${all.filter(c => c.type !== 'goal').length} 条记录 · ${all.filter(c => isOpen(c, t)).length} 项风险/缺口待解决` +
        (p.unassigned ? ` · ${p.unassigned} 条归属待确认` : '') : ''}</span>
      <button id="reset" onClick={() => a.reset()}>重置视图</button>
      <button id="pending" hidden={!s.pending} onClick={() => a.takePending()}>{s.pending ? `有新摘要 #${s.pending.syncN} · 点击更新` : ''}</button>
      <span id="notice" role="status" aria-live="polite">{s.notice}</span>
    </div>
    <MapView app={app} plan={p} emph={emph} edges={edges} />
    <div id="notebar">{note}</div>
    <History app={app} />
    <Drawer app={app} />
    <div id="boot" role="status" style={s.boot.show ? { display: 'flex' } : undefined}>
      <div className="msg">{s.boot.msg}</div><div className="steps">可从左上角添加或切换会话。</div>
    </div>
  </>);
}
