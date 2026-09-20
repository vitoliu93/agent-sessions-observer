import type { CSSProperties } from 'react';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { WEAK_AT, type Card as CardT } from '../../shared/types.ts';
import type { AppCtx } from '../App.tsx';
import { stateAt, types } from '../lib.ts';
import Status from './Status.tsx';

interface Props { c: CardT; style: CSSProperties; hl: boolean; out: boolean; sel: boolean; app: AppCtx }

export default function Card({ c, style, hl, out, sel, app: { a } }: Props) {
  const type = c.type, st = stateAt(c), sigs = c.sig || [], acc = c.acc || [];
  const fact = c.sub || c.facts?.[0] || '尚无结果';
  return <div className={`card ${type} ${st} min-w-0 cursor-pointer rounded-md border border-line bg-paper p-3.5 hover:border-accent/50${hl ? ' hl' : ''}${out ? ' out' : ''}${sel ? ' sel' : ''}`} id={'c-' + c.id} data-id={c.id} tabIndex={out ? -1 : 0} style={style} aria-label={`${c.title}，按 Enter 查看详情`} inert={out}
    onClick={e => {
      const target = e.target as Element;
      if (target.closest('.dtl')) return a.openDrawer(c.id);
      if (target.closest('.branch')) return a.branch(c.id);
      a.select(c.id);
    }}
    onMouseEnter={() => a.hover(c.id)} onMouseLeave={() => a.hover(null)}
    onFocus={e => { if (e.target === e.currentTarget) a.hover(c.id); }}
    onBlur={e => { if (e.target === e.currentTarget) a.hover(null); }}
    onKeyDown={e => { if (e.target === e.currentTarget && e.key === 'Enter') { e.preventDefault(); a.openDrawer(c.id); } }}>
    <div className="mb-2 flex min-h-5 flex-wrap items-center justify-between gap-1.5 text-[11px] text-muted">
      <span>{['change', 'risk', 'gap', 'group'].includes(type) ? types[type] : ''}</span>{c.support !== undefined && c.support < WEAK_AT
        ? <span className="weak inline-flex shrink-0 items-center gap-1 text-[11px] text-warning" title={`快判核对：引用的原文撑得住这张卡的可能只有 ${Math.round(c.support * 100)}%`}>证据弱</span>
        : <Status state={st} type={type} />}
    </div>
    <h4 className={`mb-1.5 line-clamp-2 font-semibold wrap-anywhere ${type === 'goal' ? 'text-base' : 'text-sm'}`}>{c.title}</h4>
    {type === 'goal' ? <ul className="acc my-3 list-disc space-y-1.5 pl-4 text-[13px] text-muted">{acc.slice(0, 3).map((x, i) => <li key={i} className="line-clamp-2 wrap-anywhere">{x}</li>)}</ul>
      : <p className="fact line-clamp-2 text-[13px] leading-relaxed text-muted wrap-anywhere">{fact}</p>}
    <div className="foot mt-3 flex min-h-6 items-center gap-1.5 border-t border-line/50 pt-2 text-[11px] text-muted">
      <span className="sig1 min-w-0 flex-1 truncate" title={sigs.map(g => `${g.verb} · ${g.agent}`).join('；')}>{sigs.length ? <>{sigs[0].verb} · <b className="font-normal">{sigs[0].agent}</b></> : '署名未知'}</span>
      {sigs.length > 1 && <span aria-label={`另 ${sigs.length - 1} 项署名`}>+{sigs.length - 1}</span>}
      <button className="dtl inline-flex shrink-0 items-center gap-0.5 py-1 pl-1 hover:text-accent" aria-label={`查看详情：${c.title}`}>详情<ArrowUpRight className="size-3" /></button>
    </div>
    {type === 'subgoal' && <button className="branch mt-2 inline-flex items-center gap-1 text-[11px] text-accent">查看分支<ArrowRight className="size-3" /></button>}
  </div>;
}
