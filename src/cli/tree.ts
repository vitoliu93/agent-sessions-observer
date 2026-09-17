// tree.ts — agent 树重建：herdr 派生兄弟会话 + Agent(Task) 原生子agent + SendMessage
import { isCodexFile, codexChildren, type Rollout } from './codex.ts';
import { parseSession, firstUserInfo, indexAllSessions, norm, type Block, type IndexedSession, type SessionEvent } from './parse.ts';
import { ANALYZER_PROMPT_HEAD } from './summarize.ts';
import { listCursorDbs, matchCursorDispatch, parseCursorSession, projectKey, type CursorDb } from './cursor.ts';
import fs from 'node:fs';
import path from 'node:path';

export interface Dispatch {
  key: string; label: string; kind: string; prompt: string | null;
  ts?: string | null; line: number; cwd?: string; toolId?: string; meta?: Record<string, unknown>;
}

export interface Child {
  key: string; label: string; kind: string; meta?: Record<string, unknown>;
  file: string | null; sessionId: string | null;
  dispatchLine: number; dispatchLines?: number[]; matched: string;
  events: SessionEvent[]; signature?: string; mtime?: number;
}

export interface Host { file: string; sessionId: string; project?: string; events: SessionEvent[] }
export interface TreeSources { index?: IndexedSession[]; cursorDbs?: CursorDb[]; codexRollouts?: Rollout[] }

const HERDR_RE = /herdr agent (?:prompt|start)\s+([a-z][a-z0-9_-]{0,31})/g;
const HERDR_PROMPT_RE = /herdr agent prompt\s+([a-z][a-z0-9_-]{0,31})\s+'([\s\S]*?)'/g;

function bashCommands(events: SessionEvent[]): { ev: SessionEvent; cmd: string }[] {
  const cmds: { ev: SessionEvent; cmd: string }[] = [];
  for (const ev of events) {
    if (ev.side) continue;
    for (const b of ev.blocks) {
      if (b.t === 'tool' && b.name === 'Bash') {
        cmds.push({ ev, cmd: String(b.input?.command || '') });
      }
    }
  }
  return cmds;
}

/** 从 host 事件中提取派发记录：[{key,label,kind,prompt,ts,line}] */
export function extractDispatches(hostEvents: SessionEvent[]): Dispatch[] {
  const out: Dispatch[] = [];
  const agentCwd = new Map<string, string>();
  for (const { ev, cmd } of bashCommands(hostEvents)) {
    // 只认记录里的 cwd 或当前命令中明确写出的绝对 cd；不执行 shell、不展开变量。
    const cd = [...cmd.matchAll(/(?:^|[;&]\s*)cd\s+(?:"(\/[^"\n]+)"|'(\/[^'\n]+)'|(\/[^\s;&]+))\s*&&/g)].at(-1);
    const cwd = cd ? cd[1] || cd[2] || cd[3] : ev.cwd;
    for (const start of cmd.matchAll(/herdr agent start\s+([a-z][a-z0-9_-]{0,31})/g)) if (cwd) agentCwd.set(start[1], cwd);
    let m: RegExpExecArray | null;
    HERDR_PROMPT_RE.lastIndex = 0;
    while ((m = HERDR_PROMPT_RE.exec(cmd))) {
      out.push({ key: m[1], label: m[1], kind: 'herdr', prompt: m[2], ts: ev.ts, line: ev.line, cwd: agentCwd.get(m[1]) || cwd });
    }
    HERDR_RE.lastIndex = 0;
    while ((m = HERDR_RE.exec(cmd))) {
      const key = m[1];
      if (!out.some(o => o.key === key && o.line === ev.line)) {
        out.push({ key, label: key, kind: 'herdr', prompt: null, ts: ev.ts, line: ev.line });
      }
    }
  }
  // Agent(Task) 原生子agent
  for (const ev of hostEvents) {
    if (ev.side) continue;
    for (const b of ev.blocks) {
      if (b.t === 'tool' && (b.name === 'Agent' || b.name === 'Task')) {
        const inp = b.input || {};
        out.push({
          key: 'agent-' + String(b.id).slice(-6), toolId: b.id,
          label: inp.description || inp.subagent_type || 'subagent',
          kind: 'agent', prompt: inp.prompt || '', ts: ev.ts, line: ev.line,
          meta: { subagent_type: inp.subagent_type, model: inp.model },
        });
      }
    }
  }
  return out;
}

/**
 * 重建 agent 树。
 * 返回 { children: [{key,label,kind,file,sessionId,events,dispatchLine,matched}] }
 */
export function buildTree(host: Host, sources: TreeSources = {}): { children: Child[]; dispatches: Dispatch[] } {
  const { file: hostFile, sessionId: hostId, events } = host;
  if (isCodexFile(hostFile)) {
    // Codex 子 agent 首行记录父线程 id，身份精确，不需要按首句猜
    const spawnLine = new Map(events.flatMap(e => e.blocks.flatMap(b => b.t === 'tool' && b.name === 'spawn_agent' ? [[b.input?.task_name, e.line] as const] : [])));
    const children: Child[] = codexChildren(hostId, hostFile, sources.codexRollouts).map(c => {
      const parsed = parseSession(c.file);
      return { ...c, dispatchLine: spawnLine.get(c.key.split('.')[0]) || 0, events: parsed.events, signature: parsed.signature, mtime: parsed.mtime };
    });
    return { children: children.sort((a, b) => a.dispatchLine - b.dispatchLine), dispatches: [] };
  }
  const dispatches = extractDispatches(events);
  const index = (sources.index || indexAllSessions()).filter(s => s.sessionId !== hostId).sort((a, b) => a.file.localeCompare(b.file));
  const cursorDbs = sources.cursorDbs || listCursorDbs();   // 惰性读内容：matchCursorDispatch 内按 mtime 短路

  // 每个候选 session 只取一次首条 user 文本（带缓存）
  const firstTextCache = new Map<string, ReturnType<typeof firstUserInfo>>();
  const firstInfoOf = (s: IndexedSession) => {
    if (!firstTextCache.has(s.file)) firstTextCache.set(s.file, firstUserInfo(s.file));
    return firstTextCache.get(s.file);
  };

  const children: Child[] = [];
  const byKey = new Map<string, Child>();          // 同名 agent 多轮派发 → 合并为一个 child
  const usedFiles = new Set([hostFile]);

  const mergeChild = (entry: Omit<Child, 'events'>) => {
    const prev = byKey.get(entry.key);
    if (!prev) {
      const child = entry as Child;
      byKey.set(entry.key, child);
      children.push(child);
    } else {
      if (entry.file && prev.file && entry.file !== prev.file) {
        const base = `${entry.key}-${entry.sessionId}`;
        entry.key = base;
        if (!byKey.has(base)) { byKey.set(base, entry as Child); children.push(entry as Child); }
        return;
      }
      if (entry.file && !prev.file) { Object.assign(prev, { file: entry.file, sessionId: entry.sessionId, matched: entry.matched }); }
      prev.dispatchLines = [...new Set([...(prev.dispatchLines || [prev.dispatchLine]), entry.dispatchLine])];
    }
  };

  for (const d of dispatches) {
    // 命中文本不是身份。必须同项目、首条消息开头、派发后才开始，且候选唯一。
    const nativeId = events.flatMap(e => e.blocks).find((b): b is Extract<Block, { t: 'result' }> => b.t === 'result' && b.id === d.toolId)?.agentId;
    const nativeFile = nativeId && /^[A-Za-z0-9_-]+$/.test(nativeId)
      ? path.join(path.dirname(hostFile), hostId, 'subagents', `agent-${nativeId}.jsonl`) : null;
    if (nativeFile && fs.existsSync(nativeFile)) {
      mergeChild({ key: `agent-${nativeId}`, label: d.label, kind: d.kind, meta: d.meta, file: nativeFile, sessionId: nativeId!, dispatchLine: d.line, matched: 'exact-agent-id' });
      usedFiles.add(nativeFile);
      continue;
    }
    if (!d.prompt) continue;
    const head = norm(d.prompt).slice(0, 60);
    if (head.length < 12) {
      mergeChild({ key: d.key, label: d.label, kind: d.kind, file: null, sessionId: null, dispatchLine: d.line, matched: 'no-file' });
      continue;
    }
    const hits: IndexedSession[] = [];
    for (const s of index) {
      if (usedFiles.has(s.file)) continue;
      if (![host.project, d.cwd].filter(Boolean).some(p => projectKey(p) === projectKey(s.project))) continue;
      let info; try { info = firstInfoOf(s); } catch { continue; }
      const ft = norm(info?.text);
      const at = Date.parse(info?.ts || '') || s.birthtime || s.mtime || 0;
      const dispatched = Date.parse(d.ts || '') || 0;
      if (!ft || !dispatched || !at || at < dispatched - 60000 || at > dispatched + 300000) continue;
      const pos = ft.indexOf(head);
      if (pos < 0 || pos > 300) continue;
      // 排除本工具自身的分析器会话：它的首条 prompt 内嵌了整棵树的压缩文本，
      // 会包含所有派发头，造成自指误配
      if (ft.startsWith(ANALYZER_PROMPT_HEAD)) continue;
      hits.push(s);
    }
    let hit: { file: string; sessionId: string } | null = hits.length === 1 ? hits[0] : null;
    let matched = hit ? 'prompt-head' : (hits.length > 1 ? 'ambiguous' : 'no-file');
    // 两种客户端都检查；跨客户端也有两个候选时，不选一个冒充。
    const cursorDb = matchCursorDispatch({ ...d, projects: [host.project, d.cwd].filter((p): p is string => !!p) }, cursorDbs.filter(c => !usedFiles.has(c.db)));
    if (cursorDb && ('ambiguous' in cursorDb || hits.length)) { hit = null; matched = 'ambiguous'; }
    else if (cursorDb) { hit = { file: cursorDb.db, sessionId: cursorDb.sid }; matched = 'cursor-transcript'; }
    if (hit) usedFiles.add(hit.file);
    mergeChild({
      key: d.key, label: d.label, kind: d.kind, meta: d.meta,
      file: hit?.file || null, sessionId: hit?.sessionId || null,
      dispatchLine: d.line, matched,
    });
  }
  // start-only 派发（无文案）：并进同名 child
  for (const d of dispatches) {
    if (d.prompt) continue;
    mergeChild({ key: d.key, label: d.label, kind: d.kind, meta: d.meta, file: null, sessionId: null, dispatchLine: d.line, matched: byKey.get(d.key)?.matched || 'no-file' });
  }

  for (const c of children) {
    if (c.file) {
      const parsed = c.file.includes('/.cursor/projects/') ? parseCursorSession(c.file) : parseSession(c.file);
      c.events = parsed.events; // 子会话本身的 sidechain 是真实贡献，不可静默丢弃。
      c.signature = parsed.signature; c.mtime = parsed.mtime;
    } else {
      c.events = [];
    }
  }
  children.sort((a, b) => (a.dispatchLine || 0) - (b.dispatchLine || 0));
  return { children, dispatches };
}
