import { Check, CircleAlert, CircleDashed, CircleX } from 'lucide-react';
import type { CardType, State } from '../../shared/types.ts';
import { labels } from '../lib.ts';

export default function Status({ state, type }: { state: State; type?: CardType }) {
  const done = state === 'done' || state === 'resolved';
  const Icon = done ? Check : state === 'failed' ? CircleX : state === 'risk' ? CircleAlert : CircleDashed;
  const color = done ? 'text-accent' : state === 'failed' ? 'text-danger' : ['risk', 'partial'].includes(state) ? 'text-warning' : 'text-muted';
  const label = state === 'done' && type && ['goal', 'verify', 'concl'].includes(type) ? '已证实' : labels[state] || '状态未知';
  return <span className={`stbadge inline-flex shrink-0 items-center gap-1 text-[11px] ${color}`}><Icon className="size-3.5" />{label}</span>;
}
