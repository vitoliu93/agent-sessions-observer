/* 竖直段只走列间空隙，横向段按实测坐标挑一条不压卡片的高度，所以线待在两端卡片附近，不再冲到画布顶。折叠映射只代表集合。 */
import { Fragment, useLayoutEffect, useRef } from 'react';
import type { Card, Edge } from '../../shared/types.ts';
import { isOpen } from '../lib.ts';
import type { Emph, Pos } from './MapView.tsx';

interface Props {
  ready: boolean; W: number; H: number; gap: number; edges: Edge[]; byId: Map<string, Card>;
  pos: Record<string, Pos>; cardGroup: Map<string, string>; emph: Emph;
}

export default function Edges({ ready, W, H, gap, edges, byId, pos, cardGroup, emph }: Props) {
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
  const boxes = Object.values(pos), half = gap / 2;
  // 横向段要横穿中间几列，从两端中点起上下找第一条不压卡片的高度；实在没有就走所有卡下方
  const freeLane = (x1: number, x2: number, prefer: number) => {
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
    const hit = (y: number) => boxes.some(v => v.x + v.w > lo && v.x < hi && y > v.y - 12 && y < v.y + v.h + 12);
    for (let d = 0; d <= 1200; d += 8) {
      if (!hit(prefer + d)) return prefer + d;
      if (prefer - d > 66 && !hit(prefer - d)) return prefer - d;
    }
    return Math.max(...boxes.map(v => v.y + v.h)) + 20;
  };
  const views = [...grouped].map(([key, edge], n) => {
    const a = pos[edge.f], b = pos[edge.t], right = b.x > a.x, same = a.x === b.x;
    const ay = a.y + a.h / 2, by = b.y + b.h / 2, jog = (n % 3 - 1) * 5;   // 同一条缝里的多根线错开
    // 同列（目标之间）中间没隔着别的卡就直上直下连，隔着就走列左侧，避开右侧那条跨列出口
    const blocked = same && boxes.some(v => v.x === a.x && v.y > Math.min(a.y, b.y) && v.y < Math.max(a.y, b.y));
    const straight = same && !blocked;
    const adjacent = !same && Math.abs(a.x - b.x) < a.w + 50;
    const ax = same ? a.x : right ? a.x + a.w : a.x, bx = same ? b.x : right ? b.x : b.x + b.w;
    const exit = right ? a.x + a.w + half : a.x - half, enter = right ? b.x - half : b.x + b.w + half;
    const lane = !same && !adjacent ? freeLane(exit, enter, (ay + by) / 2) : 0;
    const cx = a.x + a.w / 2, down = a.y < b.y;
    const route = straight ? `M${cx},${down ? a.y + a.h : a.y}V${down ? b.y : b.y + b.h}` :
      same ? `M${ax},${ay}H${Math.max(4, a.x - half + jog)}V${by}H${bx}` :
      adjacent ? `M${ax},${ay}H${(exit + enter) / 2 + jog}V${by}H${bx}` :
      `M${ax},${ay}H${exit + jog}V${lane}H${enter + jog}V${by}H${bx}`;
    // 线的粗细只强调主线与未解决问题；动词一律先标出来，放不下的由重叠检测挑掉
    const main = edge.rels.some(e => byId.get(e.f)?.type === 'goal' ||
      (e.v === '妨碍' && isOpen(byId.get(e.f))) || (e.v === '留下缺口' && isOpen(byId.get(e.t))));
    const hit = emph.active && edge.rels.some(emph.direct);
    const cand = emph.active ? hit : true;
    const label = edge.v + (edge.rels.length > 1 ? ` ×${edge.rels.length}` : '') +
      (edge.f.startsWith('fold-') || edge.t.startsWith('fold-') ? ' · 组内' : '');
    return <Fragment key={key}>
      <path d={route} fill="none" stroke="#8a9e94" strokeWidth="1.2" markerEnd="url(#arrow)" data-edge="1"
        className={`${main ? 'main' : 'ctx'}${hit ? ' hl' : ''}${edge.v === '包含' ? ' implied' : ''}`} />
      <text fill="#606f68" textAnchor={straight ? 'start' : 'middle'}
        x={straight ? cx + 8 : same ? Math.max(4, a.x - half) + 14 : adjacent ? (exit + enter) / 2 : (exit + enter) / 2}
        y={same || adjacent ? (ay + by) / 2 : lane - 4} className={hit ? 'hl' : undefined} data-cand={cand ? '1' : undefined}>{label}</text>
    </Fragment>;
  });

  return (
    <svg className="edges" id="edges" ref={ref} width={W} height={H}>
      {ready && <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a9e94" /></marker></defs>}
      {views}
    </svg>
  );
}
