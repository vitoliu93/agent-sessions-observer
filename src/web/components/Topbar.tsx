import { useRef } from 'react';
import { Check, ChevronsUpDown, CircleAlert, LoaderCircle, PanelsTopLeft, Plus, RefreshCw, X } from 'lucide-react';
import type { AppCtx } from '../App.tsx';

export default function Topbar({ app: { s, a, ready } }: { app: AppCtx }) {
  const input = useRef<HTMLInputElement>(null);
  const cur = s.curSid || s.data?.sessionId || null, current = s.sessions.find(x => x.sid === cur);
  const StateIcon = s.fast ? LoaderCircle : s.notice ? CircleAlert : Check;
  return <header className={`relative z-60 flex min-h-15 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-paper px-5 py-3 sm:px-7 ${s.drawerId ? "lg:pr-[508px]" : ""}`}>
    <div className="flex items-center gap-2 whitespace-nowrap text-[15px] font-semibold"><PanelsTopLeft className="size-5" />观察台</div>
    <span className="hidden text-line sm:block" aria-hidden="true">/</span>
    <div className="switcher relative min-w-0 max-w-[min(52vw,420px)]">
      <button id="swBtn" className="btn max-w-full text-left" onClick={() => a.toggleMenu()} aria-expanded={s.swOpen} aria-controls="swMenu">
        <span className="sid truncate font-medium" id="swLabel" title={current ? [current.title, current.sid].filter(Boolean).join('\n') : ''}>{current?.title || (cur || '选择会话').slice(0, 12)}</span>
        <ChevronsUpDown className="size-3.5 text-muted" />
      </button>
      <div className={`popover menu left-0 w-90 max-sm:fixed max-sm:inset-x-3 max-sm:top-16 max-sm:w-auto${s.swOpen ? ' open' : ''}`} id="swMenu" hidden={!s.swOpen}>
        <div className="px-2 py-1.5 text-xs text-muted">观察的会话</div>
        <div id="swList">{s.sessions.length ? s.sessions.map(x => <div key={x.sid} className={`swrow flex items-center gap-2 rounded-[5px] p-1 ${x.sid === cur ? 'active bg-soft' : 'hover:bg-canvas'}`}>
          <button className="sid min-w-0 flex-1 px-2 py-1 text-left" data-sid={x.sid} title={x.sid} onClick={() => a.switchTo(x.sid)}>
            {x.title && <span className="ttl block truncate text-[13px] font-medium">{x.title}</span>}
            <span className="block font-mono text-[11px] text-muted">{x.short || x.sid.slice(0, 8)} · #{x.syncN}</span>
          </button>
          <span className="meta shrink-0 text-[11px] text-muted">{x.cards} 卡</span>
          <button className="rm btn px-1 text-muted hover:text-danger" data-rm={x.sid} aria-label={`停止观察 ${x.short || x.sid}`} onClick={() => a.remove(x.sid)}><X className="size-3.5" /></button>
        </div>) : <p className="p-3 text-[13px] text-muted">尚无会话</p>}</div>
        <form className="mt-2 flex gap-2 border-t border-line pt-3" onSubmit={e => { e.preventDefault(); a.add(input.current!); }}>
          <input id="swNew" ref={input} className="field flex-1" aria-label="会话 ID 或链接" placeholder="会话 ID、前缀或链接" spellCheck={false} />
          <button id="swAddBtn" className="btn bg-accent text-paper hover:bg-accent/90" type="submit"><Plus className="size-3.5" />添加</button>
        </form>
      </div>
    </div>
    <div className="ml-auto flex items-center gap-2">
      <button className="btn text-muted" disabled={!ready} onClick={() => a.openDrawer('__INFO__')} aria-label="查看同步详情">
        <StateIcon className={`size-3.5 ${s.fast ? 'animate-spin' : ''}`} /><span id="stat" className="text-xs max-sm:sr-only">{s.follow ? s.stat : `历史快照 · #${s.viewTick}`}</span>
      </button>
      <button className="btn btn-outline" id="btnResync" disabled={s.resyncDisabled} onClick={() => a.resync()}><RefreshCw className={`size-3.5 ${s.fast ? 'animate-spin' : ''}`} />同步</button>
    </div>
  </header>;
}
