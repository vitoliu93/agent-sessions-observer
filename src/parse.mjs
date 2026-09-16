// parse.mjs — Claude Code session JSONL 定位与解析（零依赖）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function projectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** 按 sessionId 全名或前缀定位 session 文件 */
export function findSession(prefix) {
  const dir = projectsDir();
  const hits = [];
  for (const proj of fs.readdirSync(dir)) {
    const pd = path.join(dir, proj);
    let st; try { pd && (fs.statSync(pd)); } catch { continue; }
    if (!fs.statSync(pd).isDirectory()) continue;
    for (const f of fs.readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      if (!f.startsWith(prefix)) continue;
      hits.push({ file: path.join(pd, f), project: proj, sessionId: f.slice(0, -6) });
    }
  }
  if (hits.length === 0) throw new Error(`session not found: ${prefix}`);
  hits.sort((a, b) =>
    (a.sessionId === prefix ? -1 : 0) - (b.sessionId === prefix ? -1 : 0) ||
    fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);
  return hits[0];
}

/** 扫描全部 session 文件（不做全量解析），供子会话匹配 */
export function indexAllSessions() {
  const dir = projectsDir();
  const out = [];
  for (const proj of fs.readdirSync(dir)) {
    const pd = path.join(dir, proj);
    let st; try { st = fs.statSync(pd); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(pd, f);
      out.push({ file, project: proj, sessionId: f.slice(0, -6), size: fs.statSync(file).size });
    }
  }
  return out;
}

const NOISE = new Set(['attachment', 'file-history-snapshot', 'file-history-delta', 'mode',
  'permission-mode', 'last-prompt', 'ai-title', 'queue-operation', 'atis-latch', 'summary', 'system']);

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(x => typeof x === 'string' ? x : (x && x.type === 'text' ? x.text : '')).join(' ');
  }
  return JSON.stringify(content ?? '');
}

/** 解析一个 session 文件为事件数组（tool_result 也归入 user 行） */
export function parseSession(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const events = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const t = d.type;
    if (t !== 'user' && t !== 'assistant') continue;
    const msg = d.message || {};
    const content = msg.content;
    const blocks = [];
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (typeof b === 'string') { text += b; continue; }
        const bt = b.type;
        if (bt === 'text') { text += (b.text || ''); blocks.push({ t: 'text' }); }
        else if (bt === 'thinking') blocks.push({ t: 'think', x: (b.thinking || b.text || '').slice(0, 500) });
        else if (bt === 'tool_use') blocks.push({ t: 'tool', id: b.id, name: b.name, input: b.input || {} });
        else if (bt === 'tool_result') blocks.push({ t: 'result', id: b.tool_use_id, out: resultText(b.content), isError: !!b.is_error });
      }
    }
    const hasTool = blocks.some(b => b.t === 'tool' || b.t === 'result');
    if (!text.trim() && !hasTool) continue;
    events.push({
      i: events.length, line: i + 1, type: t, ts: d.timestamp,
      side: !!d.isSidechain, uuid: d.uuid, parent: d.parentUuid,
      text, blocks,
    });
  }
  return { events, bytes: raw.length, lines: lines.length };
}

/** 首条真实 user 文本（用于 herdr 派发匹配），只读前 maxLines 行 */
export function firstUserText(file, maxLines = 400) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  let acc = '';
  let read = 0, lineCount = 0;
  try {
    while (lineCount < maxLines) {
      const n = fs.readSync(fd, buf, 0, buf.length, read);
      if (n === 0) break;
      acc += buf.toString('utf8', 0, n); read += n;
      const lines = acc.split('\n'); acc = lines.pop();
      for (const line of lines) {
        lineCount++;
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (d.type !== 'user' || d.isSidechain) continue;
        const c = d.message?.content;
        if (typeof c === 'string' && c.trim()) return c;
        if (Array.isArray(c)) {
          const t = c.filter(b => b?.type === 'text').map(b => b.text).join(' ');
          if (t.trim()) return t;
          if (c.some(b => b?.type === 'tool_result')) continue; // 工具回包不算
        }
      }
    }
  } finally { fs.closeSync(fd); }
  return '';
}

export const norm = s => (s || '').replace(/\s+/g, ' ').trim();
