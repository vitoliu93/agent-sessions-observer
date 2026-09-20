import { ArrowUpRight, Zap } from 'lucide-react';
import type { AppCtx } from '../App.tsx';
import { liveValue, phases } from '../lib.ts';

/** 快判条：Jev 几百毫秒判一次会话此刻状态，不等地图；没开快判就不显示 */
export function PulseBar({ app: { s } }: { app: AppCtx }) {
  const p = s.pulse, rv = s.review;
  if (!p && !rv?.on) return null;
  const stuck = p && (p.phase === 'stuck' || p.stuck >= 0.5);
  const tone = stuck ? 'text-danger' : p?.phase === 'waiting_user' ? 'text-warning' : 'text-accent';
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return <section id="pulse" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-label="此刻状态" role="status">
    {p && <><span className={`inline-flex items-center gap-1.5 text-sm font-medium ${tone}`}><Zap className="size-3.5" /><span id="pulsePhase">{stuck ? phases.stuck : phases[p.phase]}</span></span>
    <span>把握 {pct(p.confidence)}</span>
    <span>卡住的可能 {pct(p.stuck)}</span>
    {!!s.data?.syncN && s.data.engine === 'cli' && <span title="新事件会改变地图的可能；到 30% 就重新归纳">{p.woke ? '新事件会改地图，已安排重新归纳' : `新事件改地图的可能 ${pct(p.changed)}`}</span>}
    {p.skipped > 0 && <span>已省 {p.skipped} 次归纳</span>}</>}
    {rv?.on && <span id="reviewStat" title={rv.error || '慢模型改写标题、纠正判错的卡、重拆子目标'}>{rv.running ? '慢模型审图中…' : rv.error ? '上次审图失败，保留已有结果' : !rv.at ? '底稿，等慢模型审' : rv.unreviewed ? `慢模型已审 · 新增 ${rv.unreviewed} 张待审` : '慢模型已审'}</span>}
    {p && <span className="font-mono">{new Date(p.at).toLocaleTimeString()} · {p.ms}ms</span>}
  </section>;
}

export default function LiveBar({ app: { a, view, ready } }: { app: AppCtx }) {
  if (!ready) return null;
  const live = liveValue(view!);
  return <section className="live mb-5 grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 border-b border-line pb-5 max-sm:grid-cols-[1fr_auto]" id="live" aria-label="当前进展">
    <div><p className="mb-1 text-xs text-muted">当前工作</p><p id="lvNow" className="line-clamp-2 wrap-anywhere">{live.now || '尚无工作进展'}</p></div>
    <div className="max-sm:col-start-1 max-sm:row-start-2"><p className="mb-1 text-xs text-muted">仍需确认</p><p id="lvNext" className="line-clamp-2 text-warning wrap-anywhere">{live.next || '尚无结论'}</p></div>
    <button className="lcell btn text-muted max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1" onClick={() => a.openDrawer('__LIVE__')}>进展详情<ArrowUpRight className="size-3.5" /></button>
  </section>;
}
