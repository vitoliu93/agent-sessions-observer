/* 抽屉：480px，标题固定，正文独立滚动，含关系面板。关闭时保留上次内容以便滑出。 */
import type { AppCtx } from '../App.tsx';
import { colIdx, labels, liveValue, stateAt, typeOf, types } from '../lib.ts';

export default function Drawer({ app: { s, a, view, ready, byId } }: { app: AppCtx }) {
  const id = s.drawerId ?? s.drawerShown, c = id ? byId.get(id) : undefined, t = s.viewTick;
  let head = null, body = null;
  if (ready && id === '__LIVE__') {
    const e = liveValue(view!, t);
    head = <h3>当前进展全文</h3>;
    body = (['now', 'known', 'next'] as const).map((k, i) =>
      <div key={k}><h4>{['正在做', '已证实', '还差什么'][i]}</h4><p>{e[k] || '未知'}</p></div>);
  } else if (c) {
    const rels = (view!.edges || []).filter(e => e.f === c.id || e.t === c.id);
    const facts = c.facts || [], notes = c.notes || [], steps = c.steps || [], acc = c.acc || [];
    head = <>
      <h3>{c.title}</h3>
      <div className="sub">{`${types[typeOf(c)] || '记录'} · ${labels[stateAt(c, t)] || '状态未知'} · ${s.follow ? '当前' : '历史快照'} #${t}`}</div>
    </>;
    body = <>
      <div className="kv"><b>署名</b><span>{(c.sig || []).map(g => `${g.verb}：${g.agent}`).join('；') || '未知'}</span></div>
      <p>{c.summary || c.sub || ''}</p>
      {c.summary && c.sub && c.summary !== c.sub && <p>{c.sub}</p>}
      <div className="kv"><b>{`关系 ${rels.length}`}</b></div>
      {rels.map((e, i) => {
        const other = e.f === c.id ? e.t : e.f, target = byId.get(other);
        return <button key={i} className="relrow" data-target={other} onClick={() => target && a.jump(other, colIdx(target))}>
          {`${e.f === c.id ? '→' : '←'} ${e.v} · ${target?.title || other}`}
        </button>;
      })}
      <div className="kv"><b>关键事实</b></div>
      <ul>{facts.length ? facts.map((x, i) => <li key={i}>{x}</li>) : <li>暂无事实记录</li>}</ul>
      {notes.length > 0 && <><div className="kv"><b>系统说明</b></div><ul>{notes.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      {steps.length > 0 && <><div className="kv"><b>修复过程</b></div><ul>{steps.map((x, i) =>
        <li key={i}>{`${x.title} · ${x.who || '署名未知'} · ${labels[x.st] || x.st || '状态未知'}`}</li>)}</ul></>}
      {acc.length > 0 && <><div className="kv"><b>验收条件</b></div><ul>{acc.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      <div className="evbox mono">{`来源：${c.ev || '未提供原始记录位置；这是归纳，不等于已核实证据。'}`}</div>
    </>;
  }
  return (
    <aside id="drawer" className={s.drawerId ? 'open' : undefined} aria-label="详情" tabIndex={-1}>
      <div className="dhead"><button className="close" id="dClose" aria-label="关闭详情" onClick={() => a.closeDrawer()}>✕</button><div id="dHead">{head}</div></div>
      <div id="dBody">{body}</div>
    </aside>
  );
}
