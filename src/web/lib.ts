// 纯函数：快照取值、状态、分列与归属。不碰 DOM。
import type { Card, DataView, Edge, Live, State } from '../shared/types.ts';

/** 当前阅读的快照：历史快照叠在最新数据上 */
export type View = DataView & { at?: number };

export const types: Record<string, string> = { goal: '目标', subgoal: '子目标', change: '修改', risk: '风险',
  verify: '验证', concl: '结论', gap: '缺口', group: '修复过程' };
export const colors: Record<string, string> = { goal: '#9fc1f7', subgoal: '#9fc1f7', change: '#b7c0cf', risk: '#fde68a',
  verify: '#7ee6d8', concl: '#86efac', gap: '#9aa3b2', group: '#b7c0cf' };
export const labels: Record<string, string> = { doing: '进行中', done: '已完成', failed: '失败', partial: '部分证实',
  risk: '待确认', resolved: '已解决', unknown: '状态未知' };

export function atOrBefore<T extends { at?: number }>(xs: readonly T[] | undefined, t: number): T | null {
  let best: T | null = null;
  for (const x of xs || []) if (x.at !== undefined && x.at <= t && (!best || x.at >= best.at!)) best = x;
  return best;
}
export const stateAt = (c: Card, t: number): State => atOrBefore(c.states, t)?.s || c.st || 'unknown';
const COL: Record<string, number> = { goal: 0, subgoal: 1, change: 2, risk: 2, group: 2, verify: 3, concl: 4, gap: 4 };
export const colIdx = (c: Card) => COL[c.type] ?? 2;
export const isOpen = (c: Card | undefined, t: number) =>
  !!c && ['risk', 'gap'].includes(c.type) && !['done', 'resolved'].includes(stateAt(c, t));
const priority = (c: Card, t: number) => isOpen(c, t) ? 0 : stateAt(c, t) === 'failed' ? 1 : stateAt(c, t) === 'doing' ? 2
  : ['verify', 'concl'].includes(c.type) ? 3 : 4;

export function snapshot(d: DataView, t: number): View {
  const saved = atOrBefore(d.history, t);
  return saved ? { ...d, ...saved, syncN: d.syncN, history: d.history } : d;
}
export const cardsOf = (v: View | null): Card[] => v ? [...(v.goals || []), ...v.cards] : [];
export const liveValue = (v: View, t: number): Live =>
  Array.isArray(v.live) ? atOrBefore(v.live as Live[], t) || {} : v.live || {};

/** 分支只使用明确归属或明确关系，不按标题相似度猜。目标经「拆成」拥有子目标的全部路径。 */
function owners(all: Card[], edges: Edge[]) {
  const sub = all.filter(c => c.type === 'subgoal'), result = new Map<string, Set<string>>();
  // 目标和子目标先登记自己，目标直接留下的缺口才能顺着边找到归属
  for (const c of all) {
    if (c.type === 'goal' || c.type === 'subgoal') { result.set(c.id, new Set([c.id])); continue; }
    const exact = sub.find(s => s.id === (c.goalId || c.zoneId || c.zone)) ||
      sub.find(s => s.title === c.zone && sub.filter(x => x.title === c.zone).length === 1);
    if (exact) result.set(c.id, new Set([exact.id]));
  }
  for (let i = 0; i < all.length; i++) {
    let changed = false;
    for (const e of edges) {
      if (!['采用', '检查', '支持', '留下缺口', '解决', '妨碍'].includes(e.v)) continue;
      const f = e.v === '妨碍' ? e.t : e.f, t = e.v === '妨碍' ? e.f : e.t;
      const from = result.get(f);
      if (!from) continue;
      const set = result.get(t) || new Set<string>();
      for (const id of from) if (!set.has(id)) { set.add(id); changed = true; }
      result.set(t, set);
    }
    if (!changed) break;
  }
  for (const e of edges) {
    if (e.v !== '拆成') continue;
    for (const set of result.values()) if (set.has(e.t)) set.add(e.f);
  }
  return result;
}

export type Plan = ReturnType<typeof plan>;

/** 分列、排序、折叠。branch 不存在时回到全局概览；focus 是聚焦链路，只摆链路上的卡且不折叠。 */
export function plan(all: Card[], edges: Edge[], branch: string, expanded: Set<string>, t: number, focus: Set<string> | null = null) {
  const membership = owners(all, edges);
  let list = all;
  if (branch && branch !== '__unassigned__' && !list.some(c => ['goal', 'subgoal'].includes(c.type) && c.id === branch)) branch = '';
  // 看子目标时也保留拆出它的目标；看归属待确认时保留全部目标
  const owner = membership.get(branch);
  if (branch) list = list.filter(c => branch === '__unassigned__' ? c.type === 'goal' || !membership.get(c.id)?.size
    : membership.get(c.id)?.has(branch) || (c.type === 'goal' && !!owner?.has(c.id)));
  if (focus) list = list.filter(c => focus.has(c.id));
  const cols: Card[][] = Array.from({ length: 5 }, () => []);
  for (const c of list) cols[colIdx(c)].push(c);
  const cardGroup = new Map<string, string>(), folded = new Map<number, Card[]>();
  cols.forEach((pool, i) => {
    const ordered = pool.map((c, n) => ({ c, n })).sort((a, b) => priority(a.c, t) - priority(b.c, t) || a.n - b.n).map(x => x.c);
    let shown = focus || expanded.has(String(i)) ? ordered : ordered.slice(0, 3);
    // 概览保留修改和结论入口
    const keep = i === 4 ? ordered.find(c => c.type === 'concl') :
      i === 2 ? ordered.find(c => ['change', 'group'].includes(c.type)) : undefined;
    if (keep && !shown.includes(keep)) shown = [keep, ...shown.slice(0, 2)];
    const hidden = ordered.filter(c => !shown.includes(c));
    cols[i] = shown;
    if (hidden.length) { folded.set(i, hidden); for (const c of hidden) cardGroup.set(c.id, 'fold-' + i); }
  });
  const unassigned = all.filter(c => c.type !== 'goal' && !membership.get(c.id)?.size).length;
  return { branch, cols, folded, cardGroup, unassigned };
}

/**
 * 模型常漏写子目标连到卡片的边，但卡上的 goalId/zoneId 明确写了归属。
 * 顺着已有的边往左找不到自己的子目标时，补一条「子目标 包含 卡片」，画成虚线；只认 ID，不按标题猜。
 */
export function withOwnership(all: Card[], edges: Edge[]): Edge[] {
  const byId = new Map(all.map(c => [c.id, c])), out = [...edges];
  // 从左往右补：验证补上以后，它支持的结论就能顺着验证找到子目标，不用再补
  for (const c of [...all].sort((x, y) => colIdx(x) - colIdx(y))) {
    const owner = byId.get(c.goalId || c.zoneId || '');
    if (owner?.type === 'subgoal' && colIdx(c) > 1 && !chain(all, out, c.id).has(owner.id)) out.push({ f: owner.id, t: c.id, v: '包含' });
  }
  return out;
}

/**
 * 选中卡的前后链路。地图从左到右是 目标 → 子目标 → 修改/问题 → 验证 → 结论/缺口，
 * 所以「前面」沿列号不增的关系往左找，「后面」沿列号不减的关系往右找，不管边的箭头方向。
 * 目标之间的接着/推翻只算选中卡自己的直接关系，不顺着展开别的目标。
 * ponytail: 同列可以互相走（修改 ↔ 问题），共用一个问题的兄弟修改也会被带进来；嫌多再按边方向收紧
 */
export function chain(all: Card[], edges: Edge[], id: string): Set<string> {
  const byId = new Map(all.map(c => [c.id, c])), result = new Set([id]);
  if (!byId.has(id)) return result;
  for (const dir of [-1, 1]) {
    const seen = new Set([id]), queue = [id];
    while (queue.length) {
      const cur = queue.shift()!, col = colIdx(byId.get(cur)!);
      for (const e of edges) {
        const next = e.f === cur ? e.t : e.t === cur ? e.f : '', card = byId.get(next);
        if (!card || seen.has(next) || (colIdx(card) - col) * dir < 0) continue;
        const goals = col === 0 && colIdx(card) === 0;
        if (goals && cur !== id) continue;
        result.add(next); seen.add(next);
        if (!goals) queue.push(next);
      }
    }
  }
  return result;
}
