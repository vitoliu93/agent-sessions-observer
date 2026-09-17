/* 卡片四层：类型/状态、标题、一句事实、署名与详情入口。只有标题/摘要有意省略。 */
import type { CSSProperties } from 'react';
import type { Card as CardT } from '../../shared/types.ts';
import type { AppCtx } from '../App.tsx';
import { colors, labels, stateAt, typeOf, types } from '../lib.ts';

interface Props { c: CardT; t: number; style: CSSProperties; hl: boolean; out: boolean; sel: boolean; app: AppCtx }

export default function Card({ c, t, style, hl, out, sel, app: { a } }: Props) {
  const type = typeOf(c), st = stateAt(c, t), sigs = c.sig || [], facts = c.facts || [], acc = c.acc || [];
  const fact = c.summary || c.sub || facts[0] || '尚无结果';
  const badge = st === 'done' && ['goal', 'verify', 'concl'].includes(type) ? '已证实' : labels[st] || '状态未知';
  const count = type === 'goal' ? acc.length ? ` · ${acc.length} 项验收` : '' : facts.length ? ` · ${facts.length} 条` : '';
  return (
    <div className={`card ${type} ${st}${hl ? ' hl' : ''}${out ? ' out' : ''}${sel ? ' sel' : ''}`} id={'c-' + c.id} data-id={c.id} tabIndex={0} style={style}
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
      <div className="meta">
        <span className="ctag" style={{ color: colors[type] || '#b7c0cf' }}>{types[type] || '记录'}</span>
        <span className={`stbadge st-${st}`}>{badge}</span>
      </div>
      <h4 className="clamp2">{c.title}</h4>
      {type === 'goal'
        ? <ul className="acc">{acc.slice(0, 3).map((x, i) => <li key={i} className="clamp2">{x}</li>)}</ul>
        : <div className="fact clamp2">{fact}</div>}
      <div className="foot">
        <span className="sig1">{sigs.length ? <>{sigs[0].verb} · <b>{sigs[0].agent}</b></> : '署名未知'}</span>
        {sigs.length > 1 && <span className="more">{`另 ${sigs.length - 1} 项署名`}</span>}
        <button className="dtl">{'详情' + count}</button>
      </div>
      {c.type === 'subgoal' && <button className="branch">查看解决路径 →</button>}
    </div>
  );
}
