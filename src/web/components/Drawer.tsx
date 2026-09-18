import { X } from 'lucide-react';
import type { AppCtx } from '../App.tsx';
import { atOrBefore, colIdx, labels, liveValue, stateAt, types } from '../lib.ts';
import Status from './Status.tsx';

export default function Drawer({ app: { s, a, view, ready, byId, edges } }: { app: AppCtx }) {
  const id = s.drawerId ?? s.drawerShown, c = id ? byId.get(id) : undefined, t = s.viewTick;
  let head = null, body = null;
  if (ready && id === '__LIVE__') {
    const live = liveValue(view!);
    head = <h3 id="detailTitle" className="text-base font-semibold">当前进展全文</h3>;
    body = (['now', 'known', 'next'] as const).map((key, i) => <section key={key}>
      <h4 className="section-label first:mt-0">{['正在做', '已证实的范围', '仍需确认'][i]}</h4><p id={key === 'known' ? 'lvKnown' : undefined}>{live[key] || '未知'}</p>
    </section>);
  } else if (ready && id === '__INFO__') {
    const stamp = atOrBefore(view!.stamps, t);
    head = <h3 id="detailTitle" className="text-base font-semibold">同步详情</h3>;
    body = <>
      <h4 className="section-label mt-0">当前阅读</h4><p>{s.follow ? '最新摘要' : '历史快照'} · #{t}</p>
      <h4 className="section-label">数据读到</h4><p id="stData" className="font-mono text-[13px]">{stamp?.data || view!.dataReadAt || '未知'}</p>
      <h4 className="section-label">摘要生成到</h4><p id="stSum" className="font-mono text-[13px]">{stamp?.summary || view!.updatedAt || '未知'}</p>
      <h4 className="section-label">数据说明</h4><p>{view!.note || '未提供额外说明。'}</p>
      {view!.coverage?.note && <p>{view!.coverage.note}</p>}
      <h4 className="section-label">子会话 · {view!.children?.length || 0}</h4>
      <ul>{(view!.children || []).map(child => <li key={child.key}><span>{child.label || child.key}</span><span className="ml-2 text-xs text-muted">{child.matched === 'no-file' ? '未找到记录' : child.matched === 'ambiguous' ? '归属待确认' : child.events === 0 ? '没有读取到记录' : `${child.events} 条记录`}</span></li>)}</ul>
      <div className="evbox">署名来自记录归纳。部分子会话未定位或归属不明时，不代表完整覆盖。</div>
    </>;
  } else if (c) {
    const rels = edges.filter(e => e.f === c.id || e.t === c.id);
    const facts = c.facts || [], notes = c.notes || [], steps = c.steps || [], acc = c.acc || [];
    head = <>
      <h3 id="detailTitle" className="text-base font-semibold leading-relaxed">{c.title}</h3>
      <div className="sub mt-1 text-xs text-muted">{types[c.type] || '记录'} · {s.follow ? '当前' : '历史快照'} #{t}</div>
    </>;
    body = <>
      <Status state={stateAt(c)} type={c.type} />
      {c.sub && <><h4 className="section-label">摘要</h4><p>{c.sub}</p></>}
      <div className="kv"><b>关键事实</b></div>
      <ul>{facts.length ? facts.map((x, i) => <li key={i}>{x}</li>) : <li>暂无事实记录</li>}</ul>
      {acc.length > 0 && <><div className="kv"><b>验收条件</b></div><ul>{acc.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      <div className="kv"><b>署名</b></div><p>{(c.sig || []).map(g => `${g.verb}：${g.agent}`).join('；') || '未知'}</p>
      {notes.length > 0 && <><div className="kv"><b>系统说明</b></div><ul>{notes.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
      {steps.length > 0 && <><div className="kv"><b>修复过程</b></div><ul>{steps.map((x, i) => <li key={i}>{`${x.title} · ${x.who || '署名未知'} · ${labels[x.st] || x.st || '状态未知'}`}</li>)}</ul></>}
      <div className="kv"><b>{s.drafting && !rels.length ? '关系生成中' : `关系 ${rels.length}`}</b></div>
      {rels.map((e, i) => {
        const other = e.f === c.id ? e.t : e.f, target = byId.get(other);
        return <button key={i} className="relrow" data-target={other} disabled={!target} onClick={() => target && a.jump(other, colIdx(target))}>{`${e.f === c.id ? '→' : '←'} ${e.v} · ${target?.title || other}`}</button>;
      })}
      <div className="evbox">{`来源：${c.ev || '未提供原始记录位置；这是归纳，不等于已核实证据。'}`}</div>
    </>;
  }
  return <aside id="drawer" className={`fixed inset-y-0 right-0 z-80 flex w-120 max-w-[calc(100vw-32px)] flex-col border-l border-line bg-paper wrap-anywhere${s.drawerId ? ' open' : ''}`} role="dialog" aria-modal="false" aria-label="详情" tabIndex={-1} inert={!s.drawerId}>
    <div className="dhead relative shrink-0 border-b border-line p-5 pr-14">
      <button className="btn absolute top-3 right-3 px-1.5 text-muted" id="dClose" aria-label="关闭详情" onClick={() => a.closeDrawer()}><X /></button><div id="dHead">{head}</div>
    </div>
    <div id="dBody" className="min-h-0 flex-1 overflow-y-auto p-5 text-sm leading-relaxed">{body}</div>
  </aside>;
}
