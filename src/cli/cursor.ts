// cursor.ts — Cursor Agent CLI 子会话解析（herdr --kind cursor 落盘格式）
// 位置：~/.cursor/projects/<munged-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl
// 行格式：{"role":"user"|"assistant","message":{"content":[{type:'text'|'tool_use'|'turn_ended',...}]}}
// user 文本带 <timestamp>/<user_query> 包裹；无 tool_result（结果体现在 assistant text）。
import fs from 'node:fs';
import path from 'node:path';
import { norm, readTextSnapshot, type SessionEvent, type ParsedSession } from './parse.ts';

export interface CursorDb { db: string; sid: string; project: string; mtime: number; _info?: { text: string; ts: number } | null }
export interface CursorDispatch { prompt?: string | null; ts?: string | null; project?: string; projects?: string[] }

export const projectKey = (value: unknown): string => String(value || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '');

export function listCursorDbs(): CursorDb[] {   // 名字保留：tree.ts 的调用面不变
  const root = path.join(process.env.HOME || '', '.cursor/projects');
  const out: CursorDb[] = [];
  if (!fs.existsSync(root)) return out;
  for (const proj of safeReaddir(root)) {
    const tdir = path.join(root, proj, 'agent-transcripts');
    for (const sid of safeReaddir(tdir)) {
      const f = path.join(tdir, sid, `${sid}.jsonl`);
      if (!fs.existsSync(f)) continue;
      try { out.push({ db: f, sid, project: proj, mtime: fs.statSync(f).mtimeMs }); } catch { /* 文件可能刚被移走 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);   // 新的在前
}

function safeReaddir(dir: string): string[] { try { return fs.readdirSync(dir); } catch { return []; } }

export function stripCursorWrap(s: unknown): string {
  return String(s || '')
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')
    .replace(/<\/?user_query>/g, '')
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/g, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
    .trim();
}

/** 首条实质 user 文本（剥掉 timestamp 等包裹） */
function cursorFirstInfo(file: string): { text: string; ts: number } | null {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let o: any; try { o = JSON.parse(ln); } catch { continue; }
      if (o?.role !== 'user') continue;
      const parts = o.message?.content;
      const raw: string = Array.isArray(parts) ? parts.map(p => p?.text || '').join('') : String(parts || '');
      const t = stripCursorWrap(raw);
      if (t) return { text: t, ts: Date.parse(raw.match(/<timestamp>([\s\S]*?)<\/timestamp>/)?.[1]?.trim() || '') };
    }
  } catch { /* 损坏行/权限 → 空 */ }
  return null;
}

/** 派发 → cursor 转写匹配。
 *  herdr prompt 在首条 user_query 里，前面只有 timestamp 块，所以 head 命中位置应在
 *  首条消息必须在派发前 60s 到后 5min 内；mtime 不能冒充开始时间。 */
export function matchCursorDispatch(d: CursorDispatch, dbs: CursorDb[]): CursorDb | { ambiguous: true } | null {
  const head = norm(d.prompt || '').slice(0, 60);
  if (!d.ts || head.length < 12) return null;
  const tsMs = Date.parse(d.ts);
  if (!Number.isFinite(tsMs)) return null;
  const cands: CursorDb[] = [];
  for (const c of dbs) {
    const projects = d.projects || (d.project ? [d.project] : []);
    if (projects.length && !projects.some(p => projectKey(p) === projectKey(c.project))) continue;
    if (c.mtime < tsMs - 60000) continue;
    const info = c._info ?? (c._info = cursorFirstInfo(c.db));
    if (!info || !Number.isFinite(info.ts) || info.ts < tsMs - 60000 || info.ts > tsMs + 300000) continue;
    const idx = norm(info.text).indexOf(head);
    if (idx >= 0 && idx < 300) cands.push(c);
  }
  if (!cands.length) return null;
  return cands.length === 1 ? cands[0] : { ambiguous: true };
}

/** transcript jsonl → parseSession 兼容事件流（ts 恒 null） */
export function parseCursorSession(file: string): ParsedSession {
  const events: SessionEvent[] = [];
  const { raw, signature, mtime } = readTextSnapshot(file);
  const push = (ev: Pick<SessionEvent, 'type' | 'text' | 'blocks' | 'line'>) => { if (ev.text.trim() || ev.blocks.length) events.push({ i: events.length, side: false, uuid: null, ts: null, ...ev }); };
  try {
    for (const [i, ln] of raw.split('\n').entries()) {
      if (!ln.trim()) continue;
      let o: any; try { o = JSON.parse(ln); } catch { continue; }
      const role = o?.role;
      if (role !== 'user' && role !== 'assistant') continue;   // turn_ended 等跳过
      const parts = o.message?.content;
      const ev: Pick<SessionEvent, 'type' | 'text' | 'blocks' | 'line'> = { type: role, text: '', blocks: [], line: i + 1 };
      if (Array.isArray(parts)) for (const p of parts) {
        if (p?.type === 'text') ev.text += (ev.text ? '\n' : '') + (role === 'user' ? stripCursorWrap(p.text) : String(p.text || ''));
        else if (p?.type === 'tool_use') ev.blocks.push({ t: 'tool', name: String(p.name || '?'), input: p.input || {} });
      } else ev.text = role === 'user' ? stripCursorWrap(parts) : String(parts || '');
      push(ev);
    }
  } catch { /* 读失败 → 空事件流 */ }
  return { events, signature, mtime };
}
