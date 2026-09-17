// pick.ts — 不给 session ID 时，在终端里列出最近会话让用户选（类似 claude --resume）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autocomplete, isCancel } from '@clack/prompts';
import stringWidth from 'string-width';
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

/** 临时目录里的会话多是脚本或 AI 派生的一次性任务，不列出 */
const TEMP_DIRS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()];
export const isTempDir = (cwd: string) => TEMP_DIRS.some(d => cwd === d || cwd.startsWith(d + '/'));

/** 最近的 Claude Code 与 Codex 主会话，按最后修改时间倒序；每种最多读 limit 个文件 */
export function listRecentSessions(limit = 80): RecentSession[] {
  const claude: RecentSession[] = [];
  // ponytail: 临时目录会话可能很多，最多翻 limit*4 个文件凑够 limit 个
  for (const s of indexAllSessions().sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).slice(0, limit * 4)) {
    if (claude.length >= limit) break;
    const info = claudeInfo(s.file);
    if (info && !isTempDir(info.cwd)) claude.push({ id: s.sessionId, source: 'claude', mtime: s.mtime || 0, ...info });
  }

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
    if (!meta || (meta.thread_source && meta.thread_source !== 'user') || isTempDir(meta.cwd || '')) continue;   // 子 agent、审批线程随主会话观察
    codex.push({ id: r.sessionId, source: 'codex', title: titles.get(r.sessionId) || '', cwd: meta.cwd || '', mtime: r.mtime });
  }
  return [...claude, ...codex].sort((a, b) => b.mtime - a.mtime);
}

/** 显示宽度：全角、emoji 占两格，组合字符不占格（string-width 按 Unicode 东亚宽度和字素簇算） */
const charWidth = (ch: string) => stringWidth(ch);
export const textWidth = (s: string) => stringWidth(s);
function fit(s: string, width: number): string {
  const over = textWidth(s) > width, max = over ? width - 2 : width;
  let out = '', w = 0;
  // 按字素簇截断：带肤色的 emoji、带组合重音的字母是一个整体，不能从中间切开
  for (const { segment: ch } of new Intl.Segmenter().segment(s)) { if (w + charWidth(ch) > max) break; out += ch; w += charWidth(ch); }
  return out + (over ? '..' : '') + ' '.repeat(Math.max(0, max - w));
}

/** 一行列表：前缀 2 格 + 时间 11 + 来源 6 + 标题 + 目录 + ID 8，列间 2 格；总宽比终端少 2 格，避免折行 */
export function formatRow(s: RecentSession, cols: number, home = os.homedir()): string {
  const d = new Date(s.mtime), pad = (n: number) => String(n).padStart(2, '0');
  const when = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const room = Math.max(20, cols - 2 - (2 + 11 + 2 + 6 + 2 + 2 + 2 + 8));
  const cwdW = Math.min(36, Math.floor(room * 0.4)), titleW = room - cwdW;
  return `${when}  ${s.source.padEnd(6)}  ${fit(s.title || '（无标题）', titleW)}  ${fit(s.cwd.replace(home, '~'), cwdW)}  ${s.id.slice(0, 8).padEnd(8)}`;
}

export function matches(s: RecentSession, query: string): boolean {
  const hay = `${s.title} ${s.cwd} ${s.id} ${s.source}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(q => hay.includes(q));
}

/** 终端交互选择：↑↓ 选择，输入文字筛选，回车确认，Esc / Ctrl-C 取消（返回 null） */
export async function pickSession(sessions: RecentSession[]): Promise<string | null> {
  const cols = process.stdout.columns || 100, rows = process.stdout.rows || 24;
  const picked = await autocomplete({ message: `选择要观察的会话（共 ${sessions.length} 个）`, maxItems: Math.max(3, rows - 6),
    options: sessions.map(s => ({ value: s.id, label: formatRow(s, cols - 4) })),   // clack 每行前面占 3 格
    filter: (q, o) => matches(sessions.find(s => s.id === o.value)!, q),
    validate: v => v === undefined ? '没有匹配的会话' : undefined });   // 无匹配时回车留在原地，不退出
  return isCancel(picked) ? null : picked;
}
