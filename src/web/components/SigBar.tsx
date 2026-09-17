/* 参与者：摘要一行 + 可搜索面板，不铺满横带 */
import type { AppCtx } from '../App.tsx';
import { stateAt } from '../lib.ts';

export default function SigBar({ app: { s, a, view, ready, all } }: { app: AppCtx }) {
  const m = new Map<string, { count: number; doing: boolean }>();
  for (const c of all) for (const g of c.sig || []) {
    const x = m.get(g.agent) || { count: 0, doing: false };
    x.count++; x.doing ||= stateAt(c, s.viewTick) === 'doing';
    m.set(g.agent, x);
  }
  const entries = [...m].sort((x, y) => Number(y[1].doing) - Number(x[1].doing) || y[1].count - x[1].count);
  const q = s.pcQuery.toLowerCase(), found = entries.filter(([k]) => k.toLowerCase().includes(q));
  return (
    <div className="sigbar">
      <span style={{ letterSpacing: 1, fontSize: 10.5, flex: 'none' }}>参与者 <b id="pcN" style={{ color: 'var(--muted)' }}>{m.size}</b></span>
      <span id="sigchips" style={{ display: 'flex', gap: 8, minWidth: 0, overflow: 'hidden' }}>
        {entries.slice(0, 3).map(([k, x]) => (
          <button key={k} className={`sigchip${s.selAgent === k ? ' on' : ''}`} data-k={k} onClick={() => a.toggleAgent(k)}>
            <span className="label">{k}</span><span className="n">{`${x.count} 项署名`}</span>
          </button>
        ))}
      </span>
      <span style={{ marginLeft: 'auto', flex: 'none', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 10.5 }} id="pcWork">{ready ? `${(view!.children || []).length} 个子会话 · 署名由模型归纳` : ''}</span>
        <button id="pcAll" style={{ padding: '4px 12px', fontSize: 11 }} onClick={() => a.togglePanel()}>全部参与者</button>
      </span>
      <div id="pcPanel" className={s.pcOpen ? 'open' : undefined}>
        <input id="pcSearch" placeholder="搜索参与者…" spellCheck={false} value={s.pcQuery} onChange={e => a.query(e.target.value)} />
        <div id="pcList">
          {ready && (found.length ? found.map(([k, x]) => (
            <button key={k} className={`pcrow${s.selAgent === k ? ' on' : ''}`} data-k={k} onClick={() => a.pickAgent(k)}>
              {k}<span className="n">{`${x.count} 项署名${x.doing ? ' · 有进行中的工作' : ''}`}</span>
            </button>
          )) : <p>无匹配署名</p>)}
        </div>
      </div>
    </div>
  );
}
