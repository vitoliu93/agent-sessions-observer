// parse.ts — Claude Code / Codex session JSONL 定位与解析（零依赖）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { isCodexFile, listCodexRollouts, parseCodexSession, readCodexMeta } from './codex.ts';

export type Block =
  | { t: 'text' }
  | { t: 'think'; x: string }
  | { t: 'tool'; id?: string; name: string; input: Record<string, any> }
  | { t: 'result'; id?: string; out: string; isError: boolean; agentId: string | null };

export interface SessionEvent {
  i: number;
  line: number;
  type: 'user' | 'assistant';
  ts?: string | null;
  cwd?: string;
  side: boolean;
  uuid?: string | null;
  parent?: string | null;
  text: string;
  blocks: Block[];
}

export interface ParsedSession {
  events: SessionEvent[];
  title?: string;
  meta?: any;
  bytes?: number;
  lines?: number;
  signature: string;
  mtime: number;
}

export interface SessionInfo { file: string; project: string; sessionId: string }
export interface IndexedSession extends SessionInfo { size?: number; mtime?: number; birthtime?: number }

export function projectsDir(): string {
  return path.join(process.env.HOME || os.homedir(), '.claude', 'projects');
}

/** 按 sessionId 全名或前缀定位 session 文件 */
export function findSession(prefix: string): SessionInfo {
  const dir = projectsDir();
  const hits: SessionInfo[] = [];
  let projects: string[]; try { projects = fs.readdirSync(dir); } catch { projects = []; }
  // Codex id 前 8 位是时间戳，同一时刻的子 agent/审批线程会撞前缀；前缀只匹配用户开的主线程，子线程随主会话观察
  for (const r of listCodexRollouts()) {
    if (!r.sessionId.startsWith(prefix)) continue;
    const source = r.sessionId === prefix ? 'user' : readCodexMeta(r.file)?.thread_source;
    if (!source || source === 'user') hits.push({ file: r.file, project: 'codex', sessionId: r.sessionId });
  }
  for (const proj of projects) {
    const pd = path.join(dir, proj);
    let st; try { st = fs.statSync(pd); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      if (!f.startsWith(prefix)) continue;
      hits.push({ file: path.join(pd, f), project: proj, sessionId: f.slice(0, -6) });
    }
  }
  if (hits.length === 0) throw new Error(`session not found: ${prefix}`);
  const exact = hits.filter(x => x.sessionId === prefix);
  if (exact.length === 1) return exact[0];
  // 前缀不是身份。多个命中时挑一个会把别人的会话当成本会话。
  if (hits.length !== 1) throw new Error(`ambiguous session prefix: ${prefix}，请给更长的前缀 (${hits.map(x => x.sessionId).join(', ')})`);
  return hits[0];
}

/** 扫描全部 session 文件（不做全量解析），供子会话匹配 */
export function indexAllSessions(): IndexedSession[] {
  const dir = projectsDir();
  const out: IndexedSession[] = [];
  let projects: string[]; try { projects = fs.readdirSync(dir); } catch { return out; }
  for (const proj of projects) {
    const pd = path.join(dir, proj);
    let st; try { st = fs.statSync(pd); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(pd)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(pd, f);
      let st; try { st = fs.statSync(file); } catch { continue; }
      out.push({ file, project: proj, sessionId: f.slice(0, -6), size: st.size, mtime: st.mtimeMs, birthtime: st.birthtimeMs });
    }
  }
  return out;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(x => typeof x === 'string' ? x : (x && x.type === 'text' ? x.text : '')).join(' ');
  }
  return JSON.stringify(content ?? '');
}

/** 解析一个 session 文件为事件数组（tool_result 也归入 user 行） */
export function readTextSnapshot(file: string): { raw: string; signature: string; mtime: number } {
  // 会话可能正被追加：只取读到的完整行；签名取读前状态，之后的追加会在下次检查时触发同步
  const before = fs.statSync(file), text = fs.readFileSync(file, 'utf8');
  const cut = text.lastIndexOf('\n') + 1;
  let raw = text; try { JSON.parse(text.slice(cut) || '{}'); } catch { raw = text.slice(0, cut); } // 末行写了一半才丢
  return { raw, signature: `${file}:${before.size}:${before.mtimeMs}`, mtime: before.mtimeMs };
}

export function parseSession(file: string): ParsedSession {
  if (isCodexFile(file)) return parseCodexSession(file);
  const { raw, signature, mtime } = readTextSnapshot(file);
  const events: SessionEvent[] = [];
  let customTitle = '', aiTitle = '';
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    const t = d.type;
    if (t === 'custom-title' && d.customTitle) customTitle = d.customTitle;
    if (t === 'ai-title' && d.aiTitle) aiTitle = d.aiTitle;
    if (t !== 'user' && t !== 'assistant') continue;
    const msg = d.message || {};
    const content = msg.content;
    const blocks: Block[] = [];
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (typeof b === 'string') { text += b; continue; }
        const bt = b?.type;
        if (bt === 'text') { text += (b.text || ''); blocks.push({ t: 'text' }); }
        else if (bt === 'thinking') blocks.push({ t: 'think', x: (b.thinking || b.text || '').slice(0, 500) });
        else if (bt === 'tool_use') blocks.push({ t: 'tool', id: b.id, name: b.name, input: b.input || {} });
        else if (bt === 'tool_result') blocks.push({ t: 'result', id: b.tool_use_id, out: resultText(b.content), isError: !!b.is_error, agentId: d.toolUseResult?.agentId || null });
      }
    }
    const hasTool = blocks.some(b => b.t === 'tool' || b.t === 'result');
    if (!text.trim() && !hasTool) continue;
    events.push({
      i: events.length, line: i + 1, type: t, ts: d.timestamp, cwd: d.cwd,
      side: !!d.isSidechain, uuid: d.uuid, parent: d.parentUuid,
      text, blocks,
    });
  }
  return { events, title: customTitle || aiTitle, bytes: Buffer.byteLength(raw), lines: lines.length, signature, mtime };
}

/** 首条真实 user 文本的身份信息。只读前 maxLines 行，不能越界扫描。 */
export function firstUserInfo(file: string, maxLines = 400): { text: string; ts: string | null; line: number } | null {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  const decoder = new StringDecoder('utf8');
  let acc = '';
  let read = 0, lineCount = 0;
  try {
    while (lineCount < maxLines) {
      const n = fs.readSync(fd, buf, 0, buf.length, read);
      acc += n ? decoder.write(buf.subarray(0, n)) : decoder.end() + '\n'; read += n;
      const lines = acc.split('\n'); acc = lines.pop()!;
      for (const line of lines) {
        lineCount++;
        if (lineCount > maxLines) return null;
        let d: any; try { d = JSON.parse(line); } catch { continue; }
        if (d.type !== 'user' || d.isSidechain) continue;
        const c = d.message?.content;
        if (typeof c === 'string' && c.trim()) return { text: c, ts: d.timestamp || null, line: lineCount };
        if (Array.isArray(c)) {
          const t = c.filter(b => b?.type === 'text').map(b => b.text).join(' ');
          if (t.trim()) return { text: t, ts: d.timestamp || null, line: lineCount };
          if (c.some(b => b?.type === 'tool_result')) continue; // 工具回包不算
        }
      }
      if (n === 0) break;
    }
  } finally { fs.closeSync(fd); }
  return null;
}

/** 首条真实 user 文本（用于 herdr 派发匹配），只读前 maxLines 行 */
export function firstUserText(file: string, maxLines = 400): string {
  return firstUserInfo(file, maxLines)?.text || '';
}

export const norm = (s: string | null | undefined): string => (s || '').replace(/\s+/g, ' ').trim();
