// segment.ts — 事件流 → 候选 episode 粗切 + 压缩文本（喂给 LLM）
import type { Coverage, CoverageSession } from '../shared/types.ts';
import type { SessionEvent } from './parse.ts';

/** 分段只需要这些字段 */
export type SegEvent = Pick<SessionEvent, 'type' | 'text' | 'blocks'> & Partial<Pick<SessionEvent, 'ts' | 'line' | 'side' | 'meta'>>;
export interface SegHost { sessionId: string; file?: string; events: SegEvent[] }
export interface SegChild { key: string; kind: string; label: string; sessionId?: string | null; file?: string | null; matched?: string; events?: SegEvent[] }

const GAP_MS = 5 * 60 * 1000;      // 5 分钟无事件 → 分段
const MAX_TEXT = 1100;             // 单条 assistant/user 文本截断
const MAX_THINK = 300;
const MAX_SEG_CHARS = 16000;       // 单段上限

function headTail(text: string, limit: number, label = '内容'): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const mark = `\n      …[${label}原长 ${text.length} 字，已保留头尾]…\n`;
  const room = Math.max(0, limit - mark.length);
  const head = Math.ceil(room * 0.6), tail = room - head;
  return { text: (text.slice(0, head) + mark + (tail ? text.slice(-tail) : '')).slice(0, limit), truncated: true };
}

export function fmtToolInput(name: string, input: Record<string, any> = {}): string {
  switch (name) {
    case 'Bash': return String(input.command || '').replace(/\s+/g, ' ').slice(0, 220);
    case 'Read': case 'Write': case 'Edit': return String(input.file_path || '');
    case 'Agent': case 'Task': return `${input.description || input.subagent_type || ''} :: ${String(input.prompt || '').slice(0, 80)}`;
    case 'spawn_agent': return `${input.task_name || '?'} (${input.agent_type || 'agent'})`;
    case 'exec': return String(input.input || '').replace(/\s+/g, ' ').slice(0, 220);
    case 'SendMessage': return `to=${input.to || '?'} ${String(input.summary || '').slice(0, 60)}`;
    case 'Skill': return String(input.name || input.skill || '');
    default: {
      const s = JSON.stringify(input);
      return s.length > 140 ? s.slice(0, 137) + '…' : s;
    }
  }
}

function tsOf(ev: SegEvent): number { return ev.ts ? Date.parse(ev.ts) : 0; }

/** 大回包的已知噪音模式（后台任务提示、系统输出等）整体跳过 */
const RESULT_SKIP = [
  /^Command running in background with ID:/,
  /^<local-command/,
  /^Files have not been modified since last read/,
];

function resultBody(o: string): string {
  const s = o || '';
  if (RESULT_SKIP.some(re => re.test(s.trim()))) return '';
  const head = 150, tail = 80;
  return s.length > head + tail
    ? s.slice(0, head).replace(/\s+/g, ' ') + ' …[' + s.length + ' chars]… ' + s.slice(-tail).replace(/\s+/g, ' ')
    : s.replace(/\s+/g, ' ');
}

/** 一个 session（host 或 child）→ 段落数组 [{start,end,lines:[...]}] */
export function segmentSession(events: SegEvent[], label: string, source = '', { includeSidechain = false } = {}): string[] {
  const segs: { label: string; start?: string | null; end?: string | null; lines: string[] }[] = [];
  let cur: (typeof segs)[number] | null = null;
  const push = () => { if (cur && cur.lines.length) segs.push(cur); cur = null; };
  const GAP_MARK = '\n      ⟪ 时间断裂 · 此处省略无变化区间 ⟫';

  let lastTs = 0;
  for (const ev of events) {
    if (ev.side && !includeSidechain) continue;
    const t = tsOf(ev);
    const gap = lastTs && t - lastTs > GAP_MS;
    const isUserTurn = ev.type === 'user' && ev.text.trim() && !ev.blocks.some(b => b.t === 'result');
    const isDispatch = ev.blocks.some(b => b.t === 'tool' && (b.name === 'Agent' || b.name === 'Task' || b.name === 'spawn_agent' ||
      (b.name === 'Bash' && /herdr agent (?:prompt|start)\s/.test(String(b.input?.command || '')))));
    if (!cur || gap || isUserTurn || isDispatch) {
      if (cur && gap) (cur as (typeof segs)[number]).lines.push(GAP_MARK);
      push(); cur = { label, start: ev.ts, end: ev.ts, lines: [] };
    }
    const c: (typeof segs)[number] = cur!;
    lastTs = t || lastTs;
    c.end = ev.ts || c.end;
    const evidence = source ? ` [${source}:${ev.line || '?'}]` : '';
    // 工具回包行（user 行携带 tool_result）
    for (const b of ev.blocks) {
      if (b.t === 'result') {
        if (b.isError) {
          c.lines.push(`      ↳${evidence} ❌ ${resultBody(b.out).slice(0, 220)}`);
          continue;
        }
        // 回包只保留头尾摘要，已知噪音整条跳过
        const body = resultBody(b.out);
        if (!body) continue;
        c.lines.push(`      ↳${evidence} ${body}`);
      }
    }
    if (isUserTurn) {
      const ut = ev.text.trim();
      if (/^<(local-command|command-)/.test(ut)) continue; // CLI 元信息（/model 等）不入图
      const clipped = headTail(ev.text.replace(/\s+/g, ' '), MAX_TEXT, '用户需求');
      c.lines.push(`      👤 USER:${evidence} ${clipped.text}`);
    } else if (ev.type === 'assistant') {
      for (const b of ev.blocks) {
        if (b.t === 'think' && b.x.trim()) c.lines.push(`      💭${evidence} ${b.x.replace(/\s+/g, ' ').slice(0, MAX_THINK)}`);
        else if (b.t === 'tool') c.lines.push(`      🔧${evidence} ${b.name} ${fmtToolInput(b.name, b.input)}`);
      }
      const at = ev.text.replace(/\s+/g, ' ').trim();
      if (at) c.lines.push(`      💬${evidence} ${headTail(at, MAX_TEXT, '代理输出').text}`);
    }
    if (c.lines.length > 60) { push(); cur = { label, start: ev.ts, end: ev.ts, lines: [] }; }
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
export function buildTranscriptDetailed(hostSession: SegHost, children: SegChild[], budget = 300000): { text: string; coverage: Coverage } {
  const parts: { key: string; text: string }[] = [];
  parts.push({ key: 'host', text: `# 主会话 host（${hostSession.sessionId.slice(0, 8)}…）\n源文件：${hostSession.file || '未提供'}\n${segmentSession(hostSession.events, 'host', hostSession.file ? 'host' : '').join('\n')}` });
  for (const c of children) {
    // 即使没有可读事件也要留下身份和匹配状态，模型不能把它当作没有该 agent。
    const body = c.events?.length ? segmentSession(c.events, c.key, c.file ? c.key : '', { includeSidechain: true }).join('\n') : '      ⟪未取得可归属事件；不可据此作出结论⟫';
    parts.push({ key: c.key, text: `# 子会话 ${c.key}（${c.kind} · ${c.sessionId?.slice(0, 8) || '未定位到文件'}）· ${c.label}\n匹配=${c.matched || 'unknown'}\n${body}` });
  }
  if (!Number.isFinite(budget) || budget < parts.length * 160) throw new Error(`transcript budget too small for ${parts.length} session identities`);
  // 短会话用不完的额度交回；不能让十个空子会话挤掉主会话的大半内容。
  const limits = parts.map(p => Math.min(160, p.text.length));
  let left = Math.floor(budget) - parts.length + 1 - limits.reduce((a, b) => a + b, 0);
  while (left > 0) {
    const hungry = parts.map((_, i) => i).filter(i => limits[i] < parts[i].text.length);
    if (!hungry.length) break;
    const share = Math.max(1, Math.floor(left / hungry.length));
    for (const i of hungry) { const n = Math.min(share, left, parts[i].text.length - limits[i]); limits[i] += n; left -= n; }
  }
  const rendered = parts.map((p, i) => {
    const clip = headTail(p.text, limits[i], `会话 ${p.key}`);
    return { key: p.key, totalChars: p.text.length, includedChars: clip.text.length, truncated: clip.truncated || /原长 .* 字|\[\d+ chars\]|中段截断/.test(p.text), text: clip.text };
  });
  const truncated = rendered.some(x => x.truncated);
  return {
    text: rendered.map(x => x.text).join('\n'),
    coverage: { truncated, missing: children.filter(c => !c.events?.length).map(c => c.key), note: truncated ? '部分记录被截断；未输入内容不能作为结论，需查原始证据。' : '已输入可读取的压缩片段，不等于完整原文或已核实结论。', sessions: rendered.map(({ text, ...x }): CoverageSession => x) },
  };
}
