/* 目标条：目标之间的「接着 / 推翻」是需求的先后，不是解决链路上的一步，
   所以横着放在顶栏里，不画进地图。点一个目标就只看它这一支。 */
import { Fragment } from 'react';
import type { AppCtx } from '../App.tsx';

export default function GoalTimeline({ app: { s, a, ready, all, edges, currentGoalId } }: { app: AppCtx }) {
  const goals = ready ? all.filter(c => c.type === 'goal') : [];
  if (goals.length < 2) return null;
  const at = goals.findIndex(g => g.id === currentGoalId);
  // 目标按提出顺序排，相邻两个之间的动词直接取它们之间的那条边
  const verb = (x: string, y: string) => edges.find(e => (e.f === x && e.t === y) || (e.f === y && e.t === x))?.v || '';
  return <div id="goalline" className="flex w-full min-w-0 items-center gap-1 overflow-x-auto border-t border-line/70 px-5 py-1.5 text-xs text-muted sm:px-7">
    <span className="shrink-0 pr-1">{at >= 0 ? `目标 ${at + 1}/${goals.length}` : `共 ${goals.length} 个目标`}</span>
    {goals.map((g, n) => {
      const v = n > 0 ? verb(goals[n - 1].id, g.id) : '';
      return <Fragment key={g.id}>
        {n > 0 && <span className={`shrink-0 px-0.5 text-[11px] ${v === '推翻' ? 'text-warning' : 'text-line'}`}>{v || '·'}</span>}
        <button id={'gt-' + g.id} title={g.title} onClick={() => a.branch(g.id)}
          className={`max-w-44 shrink-0 truncate rounded-[5px] px-2 py-0.5 ${g.id === currentGoalId ? 'bg-soft font-medium text-accent' : 'hover:text-accent'}`}>{g.title}</button>
      </Fragment>;
    })}
    {s.branchId && <button className="ml-2 shrink-0 px-1 hover:text-accent" onClick={() => a.reset()}>全部目标</button>}
  </div>;
}
