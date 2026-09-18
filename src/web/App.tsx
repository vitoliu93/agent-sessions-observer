/* 记录数据与当前阅读快照分开；历史、抽屉、地图始终读同一个 view。
   轮询与异步请求要读最新状态，所以状态放在一个可变 store 里，改完调 bump() 重绘。 */
import { useEffect, useReducer, useRef } from 'react';
import { ArrowUp, CircleAlert, FolderOpen, Info } from 'lucide-react';
import type { Card, DataView, Edge, SessionItem } from '../shared/types.ts';
import { cardsOf, chain, plan, snapshot, withOwnership, type View } from './lib.ts';
import Topbar from './components/Topbar.tsx';
import LiveBar from './components/LiveBar.tsx';
import MapView, { type Emph } from './components/MapView.tsx';
import Drawer from './components/Drawer.tsx';
import History from './components/History.tsx';
import ThinkingWheel from './components/ThinkingWheel.tsx';

export interface Store {
  data: DataView | null; pending: DataView | null; sessions: SessionItem[]; curSid: string | null;
  viewTick: number; follow: boolean;
  selectedId: string | null; hoveredId: string | null;
  drawerId: string | null; drawerShown: string | null; opener: Element | null; room: boolean;
  branchId: string; expanded: Set<string>;
  /** 地图按哪张卡的链路排版；选中后稍晚跟上，让链路外的卡先淡出 */
  focusId: string | null;
  requestN: number; lastKey: string;
  /** 正在显示分析中的草稿（还没有第一版正式地图）；fast：分析中每秒拉一次 */
  drafting: boolean; fast: boolean;
  notice: string; stat: string; resyncDisabled: boolean; boot: { show: boolean; msg: string };
  swOpen: boolean; histOpen: boolean;
  /** 布局稳定（卡片已定位可见）后执行：聚焦、滚动到卡片 */
  after: (() => void)[];
}
export type Actions = ReturnType<typeof createActions>;
/** edges：已按归属补上虚线边，地图、聚焦、详情都用它 */
export interface AppCtx { s: Store; a: Actions; view: View | null; ready: boolean; all: Card[]; byId: Map<string, Card>; edges: Edge[];
  /** 顶栏用：是否处在聚焦/分支视图、地图当前在看哪个目标 */
  focused: boolean; currentGoalId: string | null }

const newStore = (): Store => ({
  data: null, pending: null, sessions: [], curSid: null, viewTick: 0, follow: true,
  selectedId: null, hoveredId: null, drawerId: null, drawerShown: null, opener: null, room: false,
  branchId: '', expanded: new Set(), focusId: null, requestN: 0, lastKey: '', drafting: false, fast: false,
  notice: '', stat: '加载中…', resyncDisabled: false, boot: { show: false, msg: '正在读取会话…' },
  swOpen: false, histOpen: false, after: [],
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
    s.selectedId = s.hoveredId = null; s.branchId = '';
    s.expanded.clear(); closeDrawer(false);
  }
  function clearMap(message: string) {
    s.data = null; s.lastKey = ''; s.pending = null; s.drafting = false;
    resetView();
    s.boot = { show: true, msg: message };
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
      const failed = `分析失败：${d.lastError}。稍后会自动重试，也可以点「同步」立即重试。`;
      const waiting = dr?.chars
        ? `正在生成第一版地图：已收到 ${dr.chars} 字，等第一张卡出现…`
        : dr?.thinking
        ? `正在推演需求解决路径（已推演 ${dr.thinking.length} 字）…`
        : '正在启动归纳推演：等模型开始输出…';
      s.boot = { show: !d.syncN && !shown, msg: d.lastError && !d.analyzing ? failed : d.analyzing ? waiting : '尚无摘要，请点击同步。' };
      s.stat = d.analyzing
        ? (shown
          ? `摘要生成中 · 已出 ${shown} 张卡`
          : dr?.thinking
          ? `推演思考中 · ${dr.thinking.length} 字`
          : '摘要生成中…')
        : d.lastError
        ? '上次同步失败'
        : `最新 · #${d.syncN}`;
      s.resyncDisabled = !!d.analyzing; s.fast = !!d.analyzing;
      s.notice = d.analyzing ? '' : d.lastError || '';
      if (!d.syncN) {
        // 第一版还没出来：若已解析出卡片草稿，边收边画地图草稿
        if (dr?.goals.length) {
          const key = `${d.sessionId}:draft:${dr.chars}`;
          return key === s.lastKey ? bump() : adopt({ ...d, goals: dr.goals, cards: dr.cards, edges: dr.edges, live: dr.live, history: [] }, key);
        }
        // 正在推演中（Thinking/ToolCalls 阶段）：保留完整数据视图让滚轮实时展示
        if (d.analyzing) {
          s.data = d;
          s.drafting = true;
          bump();
          return;
        }
        return clearMap(s.boot.msg);
      }
      if (`${d.sessionId}:${d.syncN}:${d.updatedAt || ''}` === s.lastKey) return bump();
      // 阅读中（详情、选中、回放、焦点在地图内）不替换正式地图，先提示；草稿直接换成正式版
      if (s.data?.sessionId === d.sessionId && !s.drafting && (!s.follow || s.drawerId || s.selectedId || document.activeElement?.closest('#wrap'))) {
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
    if (id !== '__LIVE__' && id !== '__INFO__') { s.selectedId = s.focusId = id; s.room = true; }
    s.after.push(() => { $('dClose')?.focus(); if (id !== '__LIVE__' && id !== '__INFO__') reveal(id); });
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
    background() { s.selectedId = s.hoveredId = null; bump(); },
    toggleMenu() { s.swOpen = !s.swOpen; bump(); },
    toggleHist() { s.histOpen = !s.histOpen; bump(); },
    // 关系跳转：回到全局、展开目标所在列，再滚开抽屉
    jump(id: string, col: number) {
      s.notice = ''; s.branchId = ''; s.expanded.add(String(col));
      s.selectedId = s.focusId = s.drawerId = s.drawerShown = id; s.room = true;
      s.after.push(() => { reveal(id); $('dClose')?.focus({ preventScroll: true }); });
      render();
    },
    key(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (s.drawerId) closeDrawer();
      else if (s.swOpen) { s.swOpen = false; bump(); $('swBtn')?.focus(); }
      else { s.selectedId = s.hoveredId = null; bump(); }
    },
    docClick(e: MouseEvent) {
      const t = e.target as Element;
      if (s.swOpen && !t.closest('.switcher')) { s.swOpen = false; bump(); }
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

  const view = s.data ? snapshot(s.data, s.viewTick) : null;
  const ready = !!(view?.goals?.length && (s.data?.syncN || s.drafting));
  const all = ready ? cardsOf(view) : [], edges: Edge[] = !ready ? [] : s.drafting ? view!.edges || [] : withOwnership(all, view!.edges || []);   // 草稿里边写在最后，没写到前不补虚线
  const byId = new Map(all.map(c => [c.id, c]));
  // 聚焦：选中卡后链路外的卡先淡出，180ms 后再把链路排紧；取消选中立刻回到完整地图
  if (!s.selectedId || !byId.has(s.selectedId)) s.focusId = null;
  const focusSet = s.focusId && byId.has(s.focusId) ? chain(all, edges, s.focusId) : null;
  const chainIds = !s.selectedId || !byId.has(s.selectedId) ? null : s.selectedId === s.focusId ? focusSet : chain(all, edges, s.selectedId);
  useEffect(() => {
    if (!s.selectedId || s.selectedId === s.focusId) return;
    const timer = setTimeout(() => { s.focusId = s.selectedId; bump(); }, 180);
    return () => clearTimeout(timer);
  }, [s.selectedId, s.focusId]);
  const p = plan(all, edges, s.branchId, s.expanded, focusSet);
  s.branchId = p.branch;
  if (s.drawerId && s.drawerId !== '__LIVE__' && s.drawerId !== '__INFO__' && !byId.has(s.drawerId)) { s.drawerId = null; s.room = false; }

  // 高亮：选中看整条链路；没选中时悬停看直接关系。
  // 聚焦时不理会悬停：卡片重排后会滑到鼠标下，跟着变高亮会乱
  const hover = chainIds ? null : s.hoveredId, active = !!(hover || chainIds);
  const ids: Set<string> = hover ? new Set([hover]) : chainIds || new Set();
  const direct = (e: Edge) => hover ? e.f === hover || e.t === hover : !!chainIds && chainIds.has(e.f) && chainIds.has(e.t);
  const hl = new Set(ids);
  if (hover) for (const e of edges) if (direct(e)) { hl.add(e.f); hl.add(e.t); }
  const emph: Emph = { active, hl, direct, out: chainIds, groups: new Set([...hl].map(id => p.cardGroup.get(id)).filter((g): g is string => !!g)) };

  // 地图当前在看哪个目标：只剩一个目标时才算，概览摆着全部目标时没有「当前」
  const goalsShown = p.cols[0].filter(c => c.type === 'goal');
  const currentGoalId = goalsShown.length === 1 ? goalsShown[0].id : null;
  const focused = !!(focusSet || p.branch);
  const app: AppCtx = { s, a, view, ready, all, byId, edges, focused, currentGoalId };
  const note = ready ? [s.drafting ? '生成中：已出现的内容可能变化。' : '',
    view!.coverage?.truncated || view!.coverage?.missing.length ? view!.coverage.note : '',
    (view!.children || []).some(c => ['no-file', 'ambiguous'].includes(c.matched) || c.events === 0) ?
      '部分子会话未定位或归属不确定，不代表完整覆盖。' : ''].filter(Boolean).join(' ') : '';

  return (<>
    <Topbar app={app} />
    <main className="min-w-0 px-5 pt-6 pb-14 sm:px-7">
      <div className={s.drawerId ? "lg:mr-120" : undefined}>
      <LiveBar app={app} />
      <History app={app} />
      <button id="pending" className="btn btn-outline mb-3 text-accent" hidden={!s.pending} onClick={() => a.takePending()}><ArrowUp className="size-3.5" />{s.pending ? `有新摘要 #${s.pending.syncN} · 点击更新` : ''}</button>
      <div id="notice" className="mb-3 flex items-start gap-2 rounded-md border border-warning/25 bg-paper p-3 text-[13px] text-warning wrap-anywhere" hidden={!s.notice} role="status" aria-live="polite"><CircleAlert className="mt-0.5" />{s.notice}</div>
      </div>
      <MapView app={app} plan={p} emph={emph} edges={edges} />
      <footer className={`fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-3 border-t border-line/70 bg-canvas/92 px-5 py-2 text-xs text-muted backdrop-blur-md sm:px-7 ${s.drawerId ? "lg:pr-[508px]" : ""}`} hidden={!ready && !note}>
        <p id="notebar" className="flex-1 text-warning wrap-anywhere" hidden={!note}>{note}</p>
        {ready && <button className="btn ml-auto text-xs shrink-0" onClick={() => a.openDrawer('__INFO__')}><Info className="size-3.5" />数据说明</button>}
      </footer>
      {s.boot.show && s.data?.analyzing && !ready ? (
        <ThinkingWheel draft={s.data?.draft || null} analyzing={s.data?.analyzing} sessionId={s.curSid} />
      ) : (
        <section id="boot" className="flex min-h-80 flex-col items-center justify-center gap-3 px-4 text-center" role="status" hidden={!s.boot.show}>
          <FolderOpen className="size-8 text-muted" /><h2 className="msg max-w-xl text-base font-medium wrap-anywhere">{s.boot.msg}</h2>
          <button className="btn btn-outline" onClick={() => { a.toggleMenu(); requestAnimationFrame(() => $('swNew')?.focus()); }}>添加或切换会话</button>
        </section>
      )}
    </main>
    <Drawer app={app} />
  </>);
}
