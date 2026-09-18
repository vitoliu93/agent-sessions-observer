import { Check, Users } from 'lucide-react';
import type { AppCtx } from '../App.tsx';
import { stateAt } from '../lib.ts';

export default function SigBar({ app: { s, a, ready, all } }: { app: AppCtx }) {
  const m = new Map<string, { count: number; doing: boolean }>();
  for (const c of all) for (const g of c.sig || []) {
    const x = m.get(g.agent) || { count: 0, doing: false };
    x.count++; x.doing ||= stateAt(c) === 'doing'; m.set(g.agent, x);
  }
  const entries = [...m].sort((x, y) => Number(y[1].doing) - Number(x[1].doing) || y[1].count - x[1].count);
  const found = entries.filter(([key]) => key.toLowerCase().includes(s.pcQuery.toLowerCase()));
  return <div className="sigbar relative">
    <button id="pcAll" className={`btn ${s.selAgent ? 'bg-soft text-accent' : ''}`} disabled={!ready} aria-expanded={s.pcOpen} aria-controls="pcPanel" onClick={() => a.togglePanel()}>
      <Users />参与者 <span id="pcN" className="text-[11px] text-muted">{m.size}</span>
    </button>
    <div id="pcPanel" className={`popover right-0 w-85 max-sm:fixed max-sm:inset-x-3 max-sm:top-20 max-sm:w-auto${s.pcOpen ? ' open' : ''}`} hidden={!s.pcOpen}>
      <input id="pcSearch" className="field mb-2 w-full" aria-label="搜索参与者" placeholder="搜索参与者…" spellCheck={false} value={s.pcQuery} onChange={e => a.query(e.target.value)} />
      <div id="pcList">{found.length ? found.map(([key, x]) => <button key={key} className={`pcrow flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[13px] hover:bg-canvas ${s.selAgent === key ? 'on text-accent' : ''}`} data-k={key} onClick={() => a.pickAgent(key)}>
        <span className="min-w-0 flex-1 wrap-anywhere">{key}</span>{s.selAgent === key && <Check className="size-3.5" />}
        <span className="shrink-0 text-[11px] text-muted">{x.count} 项{x.doing ? ' · 进行中' : ''}</span>
      </button>) : <p className="p-3 text-xs text-muted">无匹配署名</p>}</div>
      <p className="border-t border-line px-2 pt-2 text-[11px] text-muted">署名来自记录归纳，不代表独立核实。</p>
    </div>
  </div>;
}
