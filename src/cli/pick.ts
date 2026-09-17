// pick.ts — 不给 session ID 时，在终端里列出最近会话让用户选（类似 claude --resume）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { firstUserInfo, indexAllSessions } from './parse.ts';
import { listCodexRollouts, readCodexMeta } from './codex.ts';
import { ANALYZER_PROMPT_HEAD } from './summarize.ts';

export interface RecentSession { id: string; source: 'claude' | 'codex'; title: string; cwd: string; mtime: number }

/** 会话引用 → ID：接受 ID、前缀或 Codex 复制的 codex://threads/<id> 链接 */
export function sessionRef(input: string): string {
  const s = String(input).trim();
  return s.match(/^codex:\/\/threads\/([^/?#\s]+)/)?.[1] ?? s;
}

/** 整个文件里找最后一条含 key 的 JSON 行（改名可能写在会话中间，只能全文找） */
function lastLine(buf: Buffer, key: string): any {
  const i = buf.lastIndexOf(key);
  if (i < 0) return null;
  const start = buf.lastIndexOf(10, i) + 1, end = buf.indexOf(10, i);
  try { return JSON.parse(buf.subarray(start, end < 0 ? buf.length : end).toString('utf8')); } catch { return null; }
}

function claudeInfo(file: string): { title: string; cwd: string } | null {
  let buf: Buffer; try { buf = fs.readFileSync(file); } catch { return null; }
  const at = buf.indexOf('"cwd":"');
  const cwdMatch = at < 0 ? null : buf.subarray(at, at + 2048).toString('utf8').match(/^"cwd":("(?:[^"\\]|\\.)*")/);
  let cwd = ''; try { cwd = cwdMatch ? JSON.parse(cwdMatch[1]) : ''; } catch {}
  const title = lastLine(buf, '"type":"custom-title"')?.customTitle || lastLine(buf, '"type":"ai-title"')?.aiTitle;
  if (title) return { title, cwd };
  const first = firstUserInfo(file)?.text?.replace(/\s+/g, ' ').trim() || '';
  if (first.startsWith(ANALYZER_PROMPT_HEAD)) return null;   // 旧版本分析器自己留下的会话
  return { title: first, cwd };
}

/** 最近的 Claude Code 与 Codex 主会话，按最后修改时间倒序；每种最多读 limit 个文件 */
export function listRecentSessions(limit = 80): RecentSession[] {
  const claude = indexAllSessions().sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, limit)
    .flatMap((s): RecentSession[] => { const info = claudeInfo(s.file); return info ? [{ id: s.sessionId, source: 'claude', mtime: s.mtime || 0, ...info }] : []; });

  const titles = new Map<string, string>();
  try {
    for (const line of fs.readFileSync(path.join(process.env.HOME || os.homedir(), '.codex/session_index.jsonl'), 'utf8').split('\n')) {
      try { const d = JSON.parse(line); if (d.id && d.thread_name) titles.set(d.id, d.thread_name); } catch {}
    }
  } catch {}
  const codex: RecentSession[] = [];
  const rollouts = listCodexRollouts().flatMap(r => { try { return [{ ...r, mtime: fs.statSync(r.file).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.mtime - a.mtime);
  for (const r of rollouts) {
    if (codex.length >= limit) break;
    const meta = readCodexMeta(r.file);
    if (!meta || (meta.thread_source && meta.thread_source !== 'user')) continue;   // 子 agent、审批线程随主会话观察
    codex.push({ id: r.sessionId, source: 'codex', title: titles.get(r.sessionId) || '', cwd: meta.cwd || '', mtime: r.mtime });
  }
  return [...claude, ...codex].sort((a, b) => b.mtime - a.mtime);
}

/** 显示宽度：中日韩全角字符占两格 */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
function fit(s: string, width: number): string {
  let out = '', w = 0;
  for (const ch of s) {
    const cw = WIDE.test(ch) ? 2 : 1;
    if (w + cw > width) return out.slice(0, -1) + '…';
    out += ch; w += cw;
  }
  return out + ' '.repeat(width - w);
}

export function matches(s: RecentSession, query: string): boolean {
  const hay = `${s.title} ${s.cwd} ${s.id} ${s.source}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(q => hay.includes(q));
}

/** 终端交互选择：↑↓ 选择，输入文字筛选，回车确认，Esc / Ctrl-C 取消（返回 null） */
export function pickSession(sessions: RecentSession[]): Promise<string | null> {
  const { stdin, stdout } = process;
  const home = os.homedir();
  let query = '', index = 0, top = 0;
  return new Promise(resolve => {
    const draw = () => {
      const list = sessions.filter(s => matches(s, query));
      const cols = stdout.columns || 100, rows = Math.max(5, (stdout.rows || 24) - 4);
      index = Math.min(index, Math.max(0, list.length - 1));
      if (index < top) top = index;
      if (index >= top + rows) top = index - rows + 1;
      const titleW = Math.max(16, Math.floor((cols - 34) * 0.6)), cwdW = Math.max(10, cols - 34 - titleW);
      const lines = [`选择要观察的会话  ↑↓ 选择 · 输入文字筛选 · 回车确认 · Esc 退出  （共 ${list.length} 个）`, `筛选：${query}`];
      list.slice(top, top + rows).forEach((s, i) => {
        const d = new Date(s.mtime), pad = (n: number) => String(n).padStart(2, '0');
        const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const row = `${when}  ${s.source.padEnd(6)}  ${fit(s.title || '（无标题）', titleW)}  ${fit(s.cwd.replace(home, '~'), cwdW)}  ${s.id.slice(0, 8)}`;
        lines.push(top + i === index ? `\x1b[7m❯ ${row}\x1b[0m` : `  ${row}`);
      });
      if (!list.length) lines.push('  没有匹配的会话');
      stdout.write('\x1b[H\x1b[2J' + lines.join('\n'));
      return list;
    };
    const done = (id: string | null) => {
      stdin.off('keypress', onKey); stdin.setRawMode(false); stdin.pause();
      stdout.write('\x1b[?25h\x1b[?1049l');
      resolve(id);
    };
    const onKey = (str: string | undefined, key: readline.Key = {}) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return done(null);
      if (key.name === 'return') { const s = sessions.filter(x => matches(x, query))[index]; return s ? done(s.id) : undefined; }
      if (key.name === 'up') index = Math.max(0, index - 1);
      else if (key.name === 'down') index++;
      else if (key.name === 'backspace') { query = query.slice(0, -1); index = top = 0; }
      else if (str && !key.ctrl && !key.meta && str >= ' ') { query += str; index = top = 0; }
      draw();
    };
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true); stdin.resume();
    stdin.on('keypress', onKey);
    stdout.write('\x1b[?1049h\x1b[?25l');
    draw();
  });
}
