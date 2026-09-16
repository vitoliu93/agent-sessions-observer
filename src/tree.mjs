// tree.mjs — agent 树重建：herdr 派生兄弟会话 + Agent(Task) 原生子agent + SendMessage
import { parseSession, firstUserText, indexAllSessions, norm } from './parse.mjs';
import { ANALYZER_PROMPT_HEAD } from './summarize.mjs';

const HERDR_RE = /herdr agent (?:prompt|start)\s+([a-z][a-z0-9_-]{0,31})/g;
const HERDR_PROMPT_RE = /herdr agent prompt\s+([a-z][a-z0-9_-]{0,31})\s+'([\s\S]*?)'/g;

function bashCommands(events) {
  const cmds = [];
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
export function extractDispatches(hostEvents) {
  const out = [];
  for (const { ev, cmd } of bashCommands(hostEvents)) {
    let m;
    HERDR_PROMPT_RE.lastIndex = 0;
    while ((m = HERDR_PROMPT_RE.exec(cmd))) {
      out.push({ key: m[1], label: m[1], kind: 'herdr', prompt: m[2], ts: ev.ts, line: ev.line });
    }
    HERDR_RE.lastIndex = 0;
    while ((m = HERDR_RE.exec(cmd))) {
      if (!out.some(o => o.key === m[1] && o.line === ev.line)) {
        out.push({ key: m[1], label: m[1], kind: 'herdr', prompt: null, ts: ev.ts, line: ev.line });
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
          key: 'agent-' + String(b.id).slice(-6),
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
export function buildTree(host) {
  const { file: hostFile, sessionId: hostId, events } = host;
  const dispatches = extractDispatches(events);
  const index = indexAllSessions().filter(s => s.sessionId !== hostId).sort((a,b) => a.file.localeCompare(b.file));

  // 每个候选 session 只取一次首条 user 文本（带缓存）
  const firstTextCache = new Map();
  const firstTextOf = (s) => {
    if (!firstTextCache.has(s.file)) firstTextCache.set(s.file, norm(firstUserText(s.file)));
    return firstTextCache.get(s.file);
  };

  const children = [];
  const byKey = new Map();          // 同名 agent 多轮派发 → 合并为一个 child
  const usedFiles = new Set([hostFile]);

  const mergeChild = (entry) => {
    const prev = byKey.get(entry.key);
    if (!prev) {
      byKey.set(entry.key, entry);
      children.push(entry);
    } else {
      if (entry.file && !prev.file) { Object.assign(prev, { file: entry.file, sessionId: entry.sessionId, matched: entry.matched }); }
      prev.dispatchLines = [...new Set([...(prev.dispatchLines || [prev.dispatchLine]), entry.dispatchLine])];
    }
  };

  for (const d of dispatches) {
    if (!d.prompt) continue; // 只有 start 没有文案的，等同 key 的 prompt 派发来补
    const head = norm(d.prompt).slice(0, 60);
    if (head.length < 12) continue;
    // resume/fork 会把首条消息复制进新文件：可能多个文件都含同一段头。
    // 全部收集，选最大的（最完整的转写），并加路径序保证确定性。
    const hits = [];
    for (const s of index) {
      if (usedFiles.has(s.file)) continue;
      const ft = firstTextOf(s);
      if (!ft || !ft.includes(head)) continue;
      // 排除本工具自身的分析器会话：它的首条 prompt 内嵌了整棵树的压缩文本，
      // 会包含所有派发头，造成自指误配
      if (ft.startsWith(ANALYZER_PROMPT_HEAD)) continue;
      hits.push(s);
    }
    hits.sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
    const hit = hits[0] || null;
    if (hit) usedFiles.add(hit.file);
    mergeChild({
      key: d.key, label: d.label, kind: d.kind, meta: d.meta,
      file: hit?.file || null, sessionId: hit?.sessionId || null,
      dispatchLine: d.line, matched: hit ? 'prompt-head' : (d.kind === 'herdr' ? 'no-file' : 'no-file'),
    });
  }
  // start-only 派发（无文案）：并进同名 child
  for (const d of dispatches) {
    if (d.prompt) continue;
    mergeChild({ key: d.key, label: d.label, kind: d.kind, meta: d.meta, file: null, sessionId: null, dispatchLine: d.line, matched: byKey.get(d.key)?.matched || 'no-file' });
  }

  for (const c of children) {
    if (c.file) {
      const parsed = parseSession(c.file);
      c.events = parsed.events.filter(e => !e.side);
    } else {
      c.events = [];
    }
  }
  children.sort((a, b) => (a.dispatchLine || 0) - (b.dispatchLine || 0));
  return { children, dispatches };
}

/** SendMessage 归属提示（v1：只在 segments 里标注，不做额外解析） */
export function sendMessages(events) {
  const out = [];
  for (const ev of events) {
    for (const b of ev.blocks) {
      if (b.t === 'tool' && b.name === 'SendMessage') {
        out.push({ ts: ev.ts, to: b.input?.to, summary: b.input?.summary || String(b.input?.message || '').slice(0, 80) });
      }
    }
  }
  return out;
}
