import { History as HistoryIcon } from 'lucide-react';
import type { AppCtx } from '../App.tsx';

export function HistoryButton({ app: { s, a, ready } }: { app: AppCtx }) {
  return <button id="histBtn" className={`btn ${s.histOpen || !s.follow ? 'viewing bg-soft text-accent' : ''}`} disabled={!ready} onClick={() => a.toggleHist()} aria-expanded={s.histOpen} aria-controls="hist"><HistoryIcon />历史</button>;
}

export default function History({ app: { s, a, ready } }: { app: AppCtx }) {
  const d = ready ? s.data! : null, times = d ? (d.history || []).map(x => x.at) : [];
  const viewing = !!d && !s.follow;
  const label = !d ? '尚无快照' : s.drafting ? '第一版生成中' : !times.length ? '此版本未保存完整历史' : `${s.follow ? '最新' : '历史快照'} · #${s.viewTick}`;
  return <div className={`hist mb-4 flex flex-wrap items-center gap-4 border-y border-line py-3 text-xs text-muted${s.histOpen ? ' open' : ''}${viewing ? ' viewing' : ''}`} id="hist" hidden={!s.histOpen}>
    <span>历史快照</span>
    <span id="hbanner" className="text-warning" hidden={!viewing}>正在查看历史</span>
    <input type="range" id="hslider" className="min-w-20 flex-1 accent-accent" aria-label="历史快照" step={1} min={d ? times[0] ?? d.syncN : 0} max={d?.syncN || 0} value={d ? s.viewTick : 0}
      disabled={times.length < 2} onInput={e => a.slide(+e.currentTarget.value)} onChange={() => {}} />
    <span className="font-mono" id="hlabel">{label}</span>
    <button id="hback" className="btn btn-outline" hidden={!viewing} onClick={() => a.back()}>回到最新</button>
  </div>;
}
