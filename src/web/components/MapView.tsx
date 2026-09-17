/* 地图画布：列宽按容器实测，卡片先隐藏渲染、量高度后定位；边在定位后画。 */
import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import type { Card as CardT, Edge } from '../../shared/types.ts';
import type { AppCtx } from '../App.tsx';
import { isOpen, stateAt, type Plan } from '../lib.ts';
import Card from './Card.tsx';
import Edges from './Edges.tsx';

export interface Pos { x: number; y: number; w: number; h: number }
/** out：选中卡的链路；链路外的卡淡出 */
export interface Emph { active: boolean; hl: Set<string>; groups: Set<string>; direct: (e: Edge) => boolean; out: Set<string> | null }

const HEADS = ['目标 · 验收条件', '子目标', '修改 · 问题', '验证 · 证据', '结论 · 缺口'];
const PAD = 24, GAP = 32;

export default function MapView({ app, plan, emph, edges }: { app: AppCtx; plan: Plan; emph: Emph; edges: Edge[] }) {
  const { s, a, ready, byId } = app;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(0);
  const [layout, setLayout] = useState({ pos: {} as Record<string, Pos>, height: 0, key: '', n: 0 });
  /** 上一次提交时已经摆好的卡：只有它们换位置时才滑过去，新出现的卡原地淡入 */
  const placed = useRef(new Set<string>());
  const widthRef = useRef(0);
  widthRef.current = wrapW;
  const W = Math.max(wrapW, 960), cw = (W - 2 * PAD - 4 * GAP) / 5, x = (i: number) => PAD + i * (cw + GAP);

  // 下一帧再重绘，避免在尺寸回调里改尺寸触发 ResizeObserver 循环
  useLayoutEffect(() => {
    const wrap = wrapRef.current!;
    const ro = new ResizeObserver(() => requestAnimationFrame(() => {
      if (Math.abs(wrap.clientWidth - widthRef.current) > 2) setWrapW(wrap.clientWidth);
    }));
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // 每次提交后实测；位置有变就同步重排（在绘制前完成），稳定后再执行聚焦/滚动
  useLayoutEffect(() => {
    const wrap = wrapRef.current!;
    placed.current = new Set(Object.keys(layout.pos));
    if (Math.abs(wrap.clientWidth - wrapW) > 2) { setWrapW(wrap.clientWidth); return; }
    const pos: Record<string, Pos> = {};
    let bottom = 0;
    if (ready) {
      bottom = 280;
      plan.cols.forEach((pool, i) => {
        let y = 104;
        for (const id of [...pool.map(c => c.id), ...(plan.folded.has(i) ? ['fold-' + i] : [])]) {
          const h = document.getElementById(id.startsWith('fold-') ? id : 'c-' + id)!.offsetHeight;
          pos[id] = { x: x(i), y, w: cw, h };
          y += h + 14;
        }
        bottom = Math.max(bottom, y + 18);
      });
    }
    const key = JSON.stringify([pos, bottom]);
    if (key !== layout.key) { setLayout({ pos, height: bottom, key, n: layout.n + 1 }); return; }
    a.stable();
  });

  const place = (id: string, i: number) => {
    const p = layout.pos[id];
    return { left: x(i), top: p ? p.y : 100, width: cw, visibility: p ? undefined : 'hidden' as const, transition: placed.current.has(id) ? undefined : 'none' };
  };
  const foldEntry = (i: number, list: CardT[]) => {
    const failed = list.filter(c => stateAt(c) === 'failed').length;
    return <button id={'fold-' + i} type="button" style={place('fold-' + i, i)}
      className={`foldentry${emph.active && emph.groups.has('fold-' + i) ? ' hl' : ''}${emph.out && !list.some(c => emph.out!.has(c.id)) ? ' out' : ''}`}
      onClick={() => a.expand(i, list[0].id)}>
      <span className="t1">{`另 ${list.length} 条记录`}</span>
      <span className="t2"><span className="uns">{`${list.filter(isOpen).length} 项风险/缺口待解决`}</span>
        {failed ? ` · ${failed} 条失败记录` : ''}</span>
      <span className="go">展开本列 →</span>
    </button>;
  };

  return (
    <div className={`wrap${emph.active ? ' focusmode' : ''}`} id="wrap" ref={wrapRef} style={{ height: layout.height, transition: placed.current.size ? undefined : 'none' }}
      onClick={e => { if (e.target === wrapRef.current || (e.target as Element).id === 'edges') a.background(); }}>
      {/* 排版一变就重建连线层，让连线等卡片滑到位后再淡入 */}
      <Edges key={layout.n} ready={ready} W={W} H={Math.max(0, layout.height - 2)} edges={edges} byId={byId} pos={layout.pos}
        cardGroup={plan.cardGroup} emph={emph} />
      {ready && plan.cols.map((pool, i) => <Fragment key={i}>
        <div className="colhead" style={{ left: x(i), width: cw }}>
          {HEADS[i]}{s.expanded.has(String(i)) && <> <button data-col={i} onClick={() => a.collapse(i)}>收起</button></>}
        </div>
        {pool.map(c => <Card key={c.id} c={c} style={place(c.id, i)} app={app}
          hl={emph.active && emph.hl.has(c.id)} out={!!emph.out && !emph.out.has(c.id)} sel={c.id === s.selectedId} />)}
        {plan.folded.has(i) && foldEntry(i, plan.folded.get(i)!)}
      </Fragment>)}
      {s.room && <div id="room" style={{ left: wrapW + Math.min(480, innerWidth - 32) }} />}
    </div>
  );
}
