/* 当前进展只做摘要，全文在抽屉 */
import type { AppCtx } from '../App.tsx';
import { liveValue } from '../lib.ts';

export default function LiveBar({ app: { a, view, ready } }: { app: AppCtx }) {
  const e = ready ? liveValue(view!) : null;
  const cell = (k: string, id: string, v: string) => (
    <button className="lcell" type="button" onClick={() => a.openDrawer('__LIVE__')}>
      <div className="k">{k}</div><div className="v" id={id}>{v}</div><div className="hint">查看进展全文 →</div>
    </button>
  );
  return (
    <div className="live" id="live">
      <div className="lhead">当前进展</div>
      <div className="lbody">
        {cell('正在做', 'lvNow', e ? e.now || '尚无工作进展' : '—')}
        {cell('已证实', 'lvKnown', e ? e.known || '尚无已证实结果' : '—')}
        {cell('还差什么', 'lvNext', e ? e.next || '尚无结论' : '—')}
      </div>
    </div>
  );
}
