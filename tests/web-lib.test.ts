import test from 'node:test';
import assert from 'node:assert/strict';
import type { Card, Edge } from '../src/shared/types.ts';
import { chain, plan, withOwnership } from '../src/web/lib.ts';

const card = (id: string, type: Card['type'], goalId = ''): Card => ({ id, type, title: id, sub: '', st: 'doing', sig: [], goalId });
// 目标 G1 拆成 S1；C1→V1→K1 一条路径；X 是目标直接留下的缺口；G2 是接着做的新目标
const all = [card('G1', 'goal'), card('G2', 'goal'), card('S1', 'subgoal', 'S1'), card('C1', 'change', 'S1'), card('V1', 'verify', 'S1'), card('K1', 'concl'), card('X', 'gap'), card('R1', 'risk')];
const edges: Edge[] = [{ f: 'G1', t: 'S1', v: '拆成' }, { f: 'S1', t: 'C1', v: '采用' }, { f: 'C1', t: 'V1', v: '检查' }, { f: 'V1', t: 'K1', v: '支持' },
  { f: 'G1', t: 'X', v: '留下缺口' }, { f: 'R1', t: 'S1', v: '妨碍' }, { f: 'G1', t: 'G2', v: '接着' }];
const ids = (p: ReturnType<typeof plan>) => p.cols.flat().map(c => c.id).sort();

test('目标直接留下的缺口有归属：不算待确认，在目标分支里可见，在子目标分支里不出现', () => {
  assert.equal(plan(all, edges, '', new Set()).unassigned, 0);
  assert.deepEqual(ids(plan(all, edges, 'G1', new Set())), ['C1', 'G1', 'K1', 'R1', 'S1', 'V1', 'X']);
  assert.deepEqual(ids(plan(all, edges, 'S1', new Set())), ['C1', 'G1', 'K1', 'R1', 'S1', 'V1']);
  assert.deepEqual(ids(plan(all, edges, '__unassigned__', new Set())), ['G1', 'G2']);
});

test('withOwnership 只按 goalId 补虚线，顺着已有边能找到子目标的不补', () => {
  const owned = [...all, card('V2', 'verify', 'S1'), card('K2', 'concl', 'S1')];
  const out = withOwnership(owned, [...edges, { f: 'V2', t: 'K2', v: '支持' }]);
  assert.deepEqual(out.filter(e => e.v === '包含'), [{ f: 'S1', t: 'V2', v: '包含' }]);
  assert.equal(withOwnership(all, edges).length, edges.length);
});

test('chain 取前后整条链路；目标之间的先后不进链路，交给顶部目标条', () => {
  assert.deepEqual([...chain(all, edges, 'C1')].sort(), ['C1', 'G1', 'K1', 'S1', 'V1']);
  assert.deepEqual([...chain(all, edges, 'X')].sort(), ['G1', 'X']);
  assert.deepEqual([...chain(all, edges, 'G1')].sort(), ['C1', 'G1', 'K1', 'R1', 'S1', 'V1', 'X']);   // 接着做的 G2 不在里面
});
