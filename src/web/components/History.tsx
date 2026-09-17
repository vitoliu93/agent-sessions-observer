/* 历史回放：默认收起；滑块读同一份完整快照 */
import type { AppCtx } from '../App.tsx';

export default function History({ app: { s, a, ready } }: { app: AppCtx }) {
  const d = ready ? s.data! : null, times = d ? (d.history || []).map(x => x.at) : [];
  const viewing = !!d && !s.follow;
  const label = !d ? '尚无可回放快照' : !times.length ? '旧版本未保存完整历史，仅可查看当前结果' :
    `${s.follow ? '实时' : '历史快照'} · #${s.viewTick}`;
  return (<>
    <div style={{ margin: '6px 20px 0' }}>
      <button id="histBtn" className={viewing ? 'viewing' : undefined} style={{ padding: '5px 14px', fontSize: 11.5 }}
        onClick={() => a.toggleHist()}>⏱ 历史回放</button>
    </div>
    <div className={`hist${s.histOpen ? ' open' : ''}${viewing ? ' viewing' : ''}`} id="hist">
      <span style={{ whiteSpace: 'nowrap' }}>时间轴</span>
      <span className="banner" id="hbanner">正在查看历史 <button id="hback" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => a.back()}>回到实时</button></span>
      {/* onInput 而非 onChange：程序化设值（如自动化测试）也要生效 */}
      <input type="range" id="hslider" step={1} min={d ? times[0] ?? d.syncN : 0} max={d ? d.syncN : 0} value={d ? s.viewTick : 0}
        disabled={times.length < 2} onInput={e => a.slide(+e.currentTarget.value)} onChange={() => {}} />
      <span className="mono" id="hlabel">{label}</span>
    </div>
  </>);
}
