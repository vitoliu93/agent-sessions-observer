// segment.mjs — 事件流 → 候选 episode 粗切 + 压缩文本（喂给 LLM）
const GAP_MS = 5 * 60 * 1000;      // 5 分钟无事件 → 分段
const MAX_TEXT = 1100;             // 单条 assistant/user 文本截断
const MAX_OUT = 260;               // tool result 首尾截断
const MAX_THINK = 300;
const MAX_SEG_CHARS = 16000;       // 单段上限

export function fmtToolInput(name, input = {}) {
  const j = v => JSON.stringify(v ?? '').slice(0, 160);
  switch (name) {
    case 'Bash': return String(input.command || '').replace(/\s+/g, ' ').slice(0, 220);
    case 'Read': case 'Write': case 'Edit': return String(input.file_path || '');
    case 'Agent': case 'Task': return `${input.description || input.subagent_type || ''} :: ${String(input.prompt || '').slice(0, 80)}`;
    case 'SendMessage': return `to=${input.to || '?'} ${String(input.summary || '').slice(0, 60)}`;
    case 'Skill': return String(input.name || input.skill || '');
    default: {
      const s = JSON.stringify(input);
      return s.length > 140 ? s.slice(0, 137) + '…' : s;
    }
  }
}

function tsShort(ts) { return ts ? String(ts).slice(11, 19) : '??:??:??'; }
function tsOf(ev) { return ev.ts ? Date.parse(ev.ts) : 0; }

/** 大回包的已知噪音模式（后台任务提示、系统输出等）整体跳过 */
const RESULT_SKIP = [
  /^Command running in background with ID:/,
  /^<local-command/,
  /^Files have not been modified since last read/,
];

function resultBody(o) {
  const s = o || '';
  if (RESULT_SKIP.some(re => re.test(s.trim()))) return '';
  const head = 150, tail = 80;
  return s.length > head + tail
    ? s.slice(0, head).replace(/\s+/g, ' ') + ' …[' + s.length + ' chars]… ' + s.slice(-tail).replace(/\s+/g, ' ')
    : s.replace(/\s+/g, ' ');
}

/** 一个 session（host 或 child）→ 段落数组 [{start,end,lines:[...]}] */
export function segmentSession(events, label) {
  const segs = [];
  let cur = null;
  const push = () => { if (cur && cur.lines.length) segs.push(cur); cur = null; };
  const open = (ev) => { cur = { label, start: ev.ts, end: ev.ts, lines: [] }; };
  const GAP_MARK = '\n      ⟪ 时间断裂 · 此处省略无变化区间 ⟫';

  let lastTs = 0;
  for (const ev of events) {
    if (ev.side) continue;
    const t = tsOf(ev);
    const gap = lastTs && t - lastTs > GAP_MS;
    const isUserTurn = ev.type === 'user' && ev.text.trim() && !ev.blocks.some(b => b.t === 'result');
    const isDispatch = ev.blocks.some(b => b.t === 'tool' && (b.name === 'Agent' || b.name === 'Task' ||
      (b.name === 'Bash' && /herdr agent (?:prompt|start)\s/.test(String(b.input?.command || '')))));
    if (!cur || gap || isUserTurn || isDispatch) {
      if (cur && gap) cur.lines.push(GAP_MARK);
      push(); cur = { label, start: ev.ts, end: ev.ts, lines: [] };
    }
    lastTs = t || lastTs;
    cur.end = ev.ts || cur.end;
    const hh = tsShort(ev.ts);
    // 工具回包行（user 行携带 tool_result）
    for (const b of ev.blocks) {
      if (b.t === 'result') {
        if (b.isError) {
          cur.lines.push(`      ↳ ❌ ${resultBody(b.out).slice(0, 220)}`);
          continue;
        }
        // Read/Write/Edit/Glob/Grep 等文件类回包对因果无增益，只留一行确认
        const body = resultBody(b.out);
        if (!body) continue;
        cur.lines.push(`      ↳ ${body}`);
      }
    }
    if (isUserTurn) {
      const ut = ev.text.trim();
      if (/^<(local-command|command-)/.test(ut)) continue; // CLI 元信息（/model 等）不入图
      cur.lines.push(`      👤 USER: ${ev.text.replace(/\s+/g, ' ').slice(0, MAX_TEXT)}`);
    } else if (ev.type === 'assistant') {
      for (const b of ev.blocks) {
        if (b.t === 'think' && b.x.trim()) cur.lines.push(`      💭 ${b.x.replace(/\s+/g, ' ').slice(0, MAX_THINK)}`);
        else if (b.t === 'tool') cur.lines.push(`      🔧 ${b.name} ${fmtToolInput(b.name, b.input)}`);
      }
      const at = ev.text.replace(/\s+/g, ' ').trim();
      if (at) cur.lines.push(`      💬 ${at.slice(0, MAX_TEXT)}`);
    }
    if (cur.lines.length > 60) { push(); cur = { label, start: ev.ts, end: ev.ts, lines: [] }; }
  }
  push();
  // 合并渲染为文本
  return segs.map((s, i) => {
    let body = s.lines.join('\n');
    if (body.length > MAX_SEG_CHARS) body = body.slice(0, MAX_SEG_CHARS / 2) + '\n      …(中段截断)…\n' + body.slice(-MAX_SEG_CHARS / 2);
    return `#### [${label} · 段${String(i + 1).padStart(2, '0')}] ${s.start?.slice(11, 16) || '?'}–${s.end?.slice(11, 16) || '?'}\n${body}`;
  });
}

/** 组装整棵树的压缩文本，控制总量预算 */
export function buildTranscript(hostSession, children, budget = 300000) {
  const parts = [];
  parts.push(`# 主会话 host（${hostSession.sessionId.slice(0, 8)}…）`);
  parts.push(...segmentSession(hostSession.events, 'host'));
  for (const c of children) {
    if (!c.events.length) continue;
    parts.push(`\n# 子会话 ${c.key}（${c.kind} · ${c.sessionId?.slice(0, 8) || '未定位到文件'}）· ${c.label}`);
    parts.push(...segmentSession(c.events, c.key));
  }
  let text = parts.join('\n');
  if (text.length > budget) {
    // 超预算：保头（需求背景）也保尾（最新进展），只截中段——尾段是最重要的实时信息
    const headN = Math.floor(budget * 0.6);
    text = text.slice(0, headN) + '\n…(中段超出预算，已截断)…\n' + text.slice(-(budget - headN));
  }
  return text;
}
