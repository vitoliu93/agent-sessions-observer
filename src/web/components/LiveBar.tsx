import { ArrowUpRight } from 'lucide-react';
import type { AppCtx } from '../App.tsx';
import { liveValue } from '../lib.ts';

export default function LiveBar({ app: { a, view, ready } }: { app: AppCtx }) {
  if (!ready) return null;
  const live = liveValue(view!);
  return <section className="live mb-5 grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 border-b border-line pb-5 max-sm:grid-cols-[1fr_auto]" id="live" aria-label="当前进展">
    <div><p className="mb-1 text-xs text-muted">当前工作</p><p id="lvNow" className="line-clamp-2 wrap-anywhere">{live.now || '尚无工作进展'}</p></div>
    <div className="max-sm:col-start-1 max-sm:row-start-2"><p className="mb-1 text-xs text-muted">仍需确认</p><p id="lvNext" className="line-clamp-2 text-warning wrap-anywhere">{live.next || '尚无结论'}</p></div>
    <button className="lcell btn text-muted max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1" onClick={() => a.openDrawer('__LIVE__')}>进展详情<ArrowUpRight className="size-3.5" /></button>
  </section>;
}
