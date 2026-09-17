// codex.ts — Codex CLI 会话定位与解析（零依赖）
// 位置：~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<uuid>.jsonl（归档在 ~/.codex/archived_sessions/）
// 首行 session_meta；子 agent 是独立 rollout，首行 parent_thread_id 精确指向父会话。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTextSnapshot, type ParsedSession, type SessionEvent, type Block } from './parse.ts';

export interface Rollout { file: string; sessionId: string; name: string }

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const codexHome = () => path.join(process.env.HOME || os.homedir(), '.codex');
export const isCodexFile = (file: string): boolean => /(^|\/)rollout-[^/]*\.jsonl$/.test(file) && file.includes('/.codex/');

/** 全部 rollout 文件，按文件名（含开始时间）排序 */
export function listCodexRollouts(): Rollout[] {
  const out: Rollout[] = [];
  const walk = (dir: string) => {
    let names; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name.startsWith('rollout-') && UUID.test(d.name)) out.push({ file: p, sessionId: d.name.match(UUID)![1], name: d.name });
    }
  };
  walk(path.join(codexHome(), 'sessions'));
  walk(path.join(codexHome(), 'archived_sessions'));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 只读首行 session_meta（首行可能带几十 KB 的指令，按块读到换行为止） */
export function readCodexMeta(file: string): any {
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(64 * 1024);
  let acc = Buffer.alloc(0), pos = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos); pos += n;
      acc = Buffer.concat([acc, buf.subarray(0, n)]);
      const nl = acc.indexOf(10);
      if (nl >= 0 || n === 0) {
        const d = JSON.parse(acc.subarray(0, nl >= 0 ? nl : acc.length).toString('utf8'));
        return d.type === 'session_meta' ? d.payload : null;
      }
      if (acc.length > 4 * 1024 * 1024) return null;
    }
  } catch { return null; } finally { fs.closeSync(fd); }
}

/** 会话标题：~/.codex/session_index.jsonl 里该 id 的最后一条 thread_name */
export function codexTitle(sessionId: string): string {
  let raw; try { raw = fs.readFileSync(path.join(codexHome(), 'session_index.jsonl'), 'utf8'); } catch { return ''; }
  let title = '';
  for (const line of raw.split('\n')) {
    if (!line.includes(sessionId)) continue;
    try { const d = JSON.parse(line); if (d.id === sessionId && d.thread_name) title = d.thread_name; } catch {}
  }
  return title;
}

const textOf = (content: unknown): string => (Array.isArray(content) ? content : [])
  .filter(c => c && ['input_text', 'output_text', 'text'].includes(c.type)).map(c => c.text || '').join('');

// Codex 往 user 角色里注入 AGENTS.md、环境、技能清单等上下文，这些不是用户需求
const INJECTED = /^\s*(<(?!codex_internal_context)[a-z_]+[\s>]|# AGENTS\.md instructions)/;

function userText(text: string): string {
  const objective = text.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/);   // /goal 续跑：只取用户原始目标
  if (objective) return objective[1];
  if (/^\s*<codex_internal_context/.test(text) || INJECTED.test(text)) return '';
  return text;
}

/** rollout → parseSession 兼容事件流 */
export function parseCodexSession(file: string): ParsedSession {
  const { raw, signature, mtime } = readTextSnapshot(file);
  const events: SessionEvent[] = [], lines = raw.split('\n');
  let meta: any = null;
  const push = (i: number, d: any, type: SessionEvent['type'], text: string, blocks: Block[]) => events.push({ i: events.length, line: i + 1, type, ts: d.timestamp, cwd: meta?.cwd, side: false, text, blocks });
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let d: any; try { d = JSON.parse(lines[i]); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'session_meta') { meta = p; continue; }
    if (d.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      const text = userText(textOf(p.content));
      const last = events.findLast(e => e.type === 'user' && e.text);
      if (text.trim() && text !== last?.text) push(i, d, 'user', text, []);   // /goal 每轮续跑重复注入同一目标
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content);
      if (text.trim()) push(i, d, 'assistant', text, [{ t: 'text' }]);
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let input; try { input = p.type === 'function_call' ? JSON.parse(p.arguments || '{}') : { input: p.input }; } catch { input = { arguments: p.arguments }; }
      push(i, d, 'assistant', '', [{ t: 'tool', id: p.call_id, name: p.name, input }]);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const out = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
      push(i, d, 'user', '', [{ t: 'result', id: p.call_id, out, isError: false, agentId: null }]);
    } else if (p.type === 'agent_message') {
      // 团队消息：正文常加密，只有回报（如 FINAL_ANSWER）是明文；当作工具回包，不冒充用户需求
      const body = textOf(p.content).replace(/^Message Type:[\s\S]*?Payload:\n?/, '').trim();
      if (body) push(i, d, 'user', '', [{ t: 'result', id: p.id, out: `${p.author || '?'} → ${p.recipient || '?'}：${body}`, isError: false, agentId: null }]);
    }
  }
  return { events, title: meta ? codexTitle(meta.id) : '', meta, bytes: Buffer.byteLength(raw), lines: lines.length, signature, mtime };
}

/** 子 agent：按 parent_thread_id 精确找后代（含孙代）；审批用的 guardian 线程不算贡献者 */
export function codexChildren(hostId: string, hostFile: string, rollouts: Rollout[] = listCodexRollouts()) {
  const since = path.basename(hostFile).slice(0, 'rollout-YYYY-MM-DD'.length);
  const metas = rollouts.filter(r => r.name >= since && r.sessionId !== hostId).map(r => ({ ...r, meta: readCodexMeta(r.file) }))
    .filter(r => r.meta?.thread_source === 'subagent' && r.meta.parent_thread_id);
  const out: { key: string; label: string; kind: string; file: string; sessionId: string; dispatchLine: number; matched: string }[] = [];
  const parents = new Set([hostId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of metas) {
      if (out.some(c => c.sessionId === r.sessionId) || !parents.has(r.meta.parent_thread_id)) continue;
      const spawn = r.meta.source?.subagent?.thread_spawn || {};
      const agentPath: string = spawn.agent_path || r.meta.agent_path || '';
      out.push({
        key: agentPath.replace(/^\/root\/?/, '').replace(/\//g, '.') || `codex-${r.sessionId.slice(0, 8)}`,
        label: [r.meta.agent_role, r.meta.agent_nickname].filter(Boolean).join(' · ') || 'codex agent',
        kind: 'codex', file: r.file, sessionId: r.sessionId, dispatchLine: 0, matched: 'exact-parent-id',
      });
      parents.add(r.sessionId); grew = true;
    }
  }
  return out;
}
