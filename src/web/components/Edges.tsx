/* 所有跨列线经列间空隙和卡片上方走，不穿过第三方卡片。折叠映射只代表集合。 */
import { Fragment, useLayoutEffect, useRef } from 'react';
import type { Card, Edge } from '../../shared/types.ts';
import { isOpen } from '../lib.ts';
import type { Emph, Pos } from './MapView.tsx';

interface Props {
  ready: boolean; W: number; H: number; edges: Edge[]; byId: Map<string, Card>;
  pos: Record<string, Pos>; cardGroup: Map<string, string>; emph: Emph; t: number;
}

export default function Edges({ ready, W, H, edges, byId, pos, cardGroup, emph, t }: Props) {
  const ref = useRef<SVGSVGElement>(null);

  // 标签逐个显示并实测：越界或与卡片/已放标签重叠就隐藏
  useLayoutEffect(() => {
    const svg = ref.current!, placed: DOMRect[] = [], bounds = svg.getBoundingClientRect();
    const rects = [...svg.parentElement!.querySelectorAll('.card,.foldentry')].map(n => n.getBoundingClientRect());
    for (const text of svg.querySelectorAll('text')) {
      const show = text.dataset.cand === '1';
      text.classList.toggle('show', show);
      if (!show) continue;
      const r = text.getBoundingClientRect(), overlap = (x: DOMRect) => r.left < x.right && r.right > x.left && r.top < x.bottom && r.bottom > x.top;
      if (r.left < bounds.left || r.right > bounds.right || r.top < bounds.top || r.bottom > bounds.bottom ||
        placed.some(overlap) || rects.some(overlap)) text.classList.remove('show');
      else placed.push(r);
    }
  });

  const grouped = new Map<string, { f: string; t: string; v: Edge['v']; rels: Edge[] }>();
  for (const e of ready ? edges : []) {
    if (!byId.has(e.f) || !byId.has(e.t)) continue;
    const f = pos[e.f] ? e.f : cardGroup.get(e.f), to = pos[e.t] ? e.t : cardGroup.get(e.t);
    if (!f || !to || f === to || !pos[f] || !pos[to]) continue;
    const key = JSON.stringify([f, to, e.v]);
    if (!grouped.has(key)) grouped.set(key, { f, t: to, v: e.v, rels: [] });
    grouped.get(key)!.rels.push(e);
  }
  let defaults = 0;
  const views = [...grouped].map(([key, edge], n) => {
    const a = pos[edge.f], b = pos[edge.t], right = b.x > a.x, same = a.x === b.x;
    const ax = same || right ? a.x + a.w : a.x, bx = same ? b.x + b.w : right ? b.x : b.x + b.w, ay = a.y + a.h / 2, by = b.y + b.h / 2;
    const exit = ax + (same || right ? 10 : -10), enter = bx + (same ? 10 : right ? -10 : 10), adjacent = !same && Math.abs(a.x - b.x) < a.w + 50;
    const lane = 55 + (n % 7) * 6;
    const route = same ? `M${ax},${ay}H${exit}V${by}H${bx}` :
      adjacent ? `M${ax},${ay}H${(exit + enter) / 2}V${by}H${bx}` :
      `M${ax},${ay}H${exit}V${lane}H${enter}V${by}H${bx}`;
    // 默认只强调主线与未解决问题
    const main = edge.rels.some(e => byId.get(e.f)?.type === 'goal' ||
      (e.v === '妨碍' && isOpen(byId.get(e.f), t)) || (e.v === '留下缺口' && isOpen(byId.get(e.t), t)));
    const hit = emph.active && edge.rels.some(emph.direct);
    const cand = emph.active ? hit : main && defaults++ < 6;
    const label = edge.v + (edge.rels.length > 1 ? ` ×${edge.rels.length}` : '') +
      (edge.f.startsWith('fold-') || edge.t.startsWith('fold-') ? ' · 组内' : '');
    return <Fragment key={key}>
      <path d={route} fill="none" stroke="#718198" strokeWidth="1.4" markerEnd="url(#arrow)" data-edge="1"
        className={`${main ? 'main' : 'ctx'}${hit ? ' hl' : ''}`} />
      <text fill="#b6c4d7" textAnchor="middle" x={adjacent || !same ? (exit + enter) / 2 : exit + 14}
        y={adjacent || same ? (ay + by) / 2 : lane - 3} className={hit ? 'hl' : undefined} data-cand={cand ? '1' : undefined}>{label}</text>
    </Fragment>;
  });

  return (
    <svg className="edges" id="edges" ref={ref} width={W} height={H}>
      {ready && <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" /></marker></defs>}
      {views}
    </svg>
  );
}
