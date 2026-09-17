// 纯函数：快照取值、状态、分列与归属。不碰 DOM。
import type { Card, CardType, DataView, Edge, Live, State } from '../shared/types.ts';

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
export const typeOf = (c: Card): CardType => c.id === 'GOAL' ? 'goal' : c.type;
const COL: Record<string, number> = { goal: 0, subgoal: 1, change: 2, risk: 2, group: 2, verify: 3, concl: 4, gap: 4 };
export const colIdx = (c: Card) => COL[typeOf(c)] ?? 2;
export const isOpen = (c: Card | undefined, t: number) =>
  !!c && ['risk', 'gap'].includes(typeOf(c)) && !['done', 'resolved'].includes(stateAt(c, t));
const priority = (c: Card, t: number) => isOpen(c, t) ? 0 : stateAt(c, t) === 'failed' ? 1 : stateAt(c, t) === 'doing' ? 2
  : ['verify', 'concl'].includes(typeOf(c)) ? 3 : 4;

export function snapshot(d: DataView, t: number): View {
  const saved = atOrBefore(d.history, t);
  if (saved) return { ...d, ...saved, syncN: d.syncN, history: d.history };
  return { ...d, goal: d.goal ? { ...d.goal, type: 'goal', ...(d.goal.type ? {} : { states: [], st: 'unknown' as const }) } : null };
}
export const cardsOf = (v: View | null): Card[] => v ? [v.goal, ...v.cards].filter((c): c is Card => !!c) : [];
export const liveValue = (v: View, t: number): Live =>
  Array.isArray(v.live) ? atOrBefore(v.live as Live[], t) || {} : v.live || {};

/** 分支只使用明确归属或明确关系，不按标题相似度猜。 */
function owners(all: Card[], edges: Edge[]) {
  const sub = all.filter(c => c.type === 'subgoal'), result = new Map<string, Set<string>>();
  for (const c of all) {
    const exact = sub.find(s => s.id === (c.goalId || c.zoneId || c.zone)) ||
      sub.find(s => s.title === c.zone && sub.filter(x => x.title === c.zone).length === 1);
    if (exact) result.set(c.id, new Set([exact.id]));
    if (c.type === 'subgoal') result.set(c.id, new Set([c.id]));
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
  return result;
}

export type Plan = ReturnType<typeof plan>;

/** 分列、排序、折叠。branch 不存在时回到全局概览。 */
export function plan(all: Card[], edges: Edge[], branch: string, expanded: Set<string>, t: number) {
  const membership = owners(all, edges);
  let list = all;
  if (branch && branch !== '__unassigned__' && !list.some(c => c.type === 'subgoal' && c.id === branch)) branch = '';
  if (branch) list = list.filter(c => c.id === 'GOAL' ||
    (branch === '__unassigned__' ? !membership.get(c.id)?.size : membership.get(c.id)?.has(branch)));
  const cols: Card[][] = Array.from({ length: 5 }, () => []);
  for (const c of list) cols[colIdx(c)].push(c);
  const cardGroup = new Map<string, string>(), folded = new Map<number, Card[]>();
  cols.forEach((pool, i) => {
    const ordered = pool.map((c, n) => ({ c, n })).sort((a, b) => priority(a.c, t) - priority(b.c, t) || a.n - b.n).map(x => x.c);
    let shown = expanded.has(String(i)) ? ordered : ordered.slice(0, i === 0 ? 1 : 3);
    // 概览保留修改和结论入口
    const keep = i === 4 ? ordered.find(c => c.type === 'concl') :
      i === 2 ? ordered.find(c => ['change', 'group'].includes(c.type)) : undefined;
    if (keep && !shown.includes(keep)) shown = [keep, ...shown.slice(0, 2)];
    const hidden = ordered.filter(c => !shown.includes(c));
    cols[i] = shown;
    if (hidden.length) { folded.set(i, hidden); for (const c of hidden) cardGroup.set(c.id, 'fold-' + i); }
  });
  const unassigned = all.filter(c => c.id !== 'GOAL' && !membership.get(c.id)?.size).length;
  return { branch, cols, folded, cardGroup, unassigned };
}
