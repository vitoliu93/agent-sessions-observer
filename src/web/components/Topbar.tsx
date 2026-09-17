/* 顶栏：会话切换/添加/移除、触发同步、数据与摘要时间 */
import { useRef } from 'react';
import type { AppCtx } from '../App.tsx';
import { atOrBefore } from '../lib.ts';

export default function Topbar({ app: { s, a, view, ready } }: { app: AppCtx }) {
  const input = useRef<HTMLInputElement>(null);
  const cur = s.curSid || s.data?.sessionId || null, current = s.sessions.find(x => x.sid === cur);
  const stamp = ready ? atOrBefore(view!.stamps, s.viewTick) : null;
  const dot = current?.analyzing ? 'work' : current?.lastError ? 'err' : current?.syncN ? 'done' : 'empty';
  return (
    <div className="topbar">
      <div className="brand">◉ 观察台<span className="tag">需求解决地图</span></div>
      <div className="switcher">
        <button id="swBtn" onClick={() => a.toggleMenu()}>
          <span className={'dot ' + dot} id="swDot" />
          <span className="sid mono" id="swLabel" title={current ? [current.title, current.sid].filter(Boolean).join('\n') : ''}>
            {current?.title || (cur || '选择会话').slice(0, 12)}
          </span>
          <span className="caret">▼</span>
        </button>
        <div className={`menu${s.swOpen ? ' open' : ''}`} id="swMenu">
          <div id="swList">
            {s.sessions.length ? s.sessions.map(x => (
              <div key={x.sid} className={`swrow${x.sid === cur ? ' active' : ''}`}>
                <button className="sid" data-sid={x.sid} title={x.sid} onClick={() => a.switchTo(x.sid)}>
                  {x.title && <span className="ttl">{x.title}</span>}
                  <span className="mono">{`${x.short || x.sid.slice(0, 8)}… · #${x.syncN}`}</span>
                </button>
                <span className="meta">{`${x.cards} 卡`}</span>
                <button className="rm" data-rm={x.sid} aria-label={`停止观察 ${x.short}`} onClick={() => a.remove(x.sid)}>✕</button>
              </div>
            )) : <p>尚无会话</p>}
          </div>
          <div className="swAdd">
            <input id="swNew" ref={input} className="mono" placeholder="粘贴 session ID、前缀或 codex:// 链接，回车添加" spellCheck={false}
              onKeyDown={e => { if (e.key === 'Enter') a.add(input.current!); }} />
            <button id="swAddBtn" onClick={() => a.add(input.current!)}>添加</button>
          </div>
        </div>
      </div>
      <div className="controls">
        <button className="primary" id="btnResync" disabled={s.resyncDisabled} onClick={() => a.resync()}>触发同步</button>
        <span id="stat" style={{ fontSize: 12, color: 'var(--muted)' }}>{s.stat}</span>
      </div>
      <div className="stamps">
        <div>数据读到 <b className="mono" id="stData">{ready ? stamp?.data || view!.dataReadAt || '未知' : '—'}</b></div>
        <div>摘要更新到 <b className="mono" id="stSum">{ready ? stamp?.summary || view!.updatedAt || '未知' : '—'}</b></div>
      </div>
    </div>
  );
}
