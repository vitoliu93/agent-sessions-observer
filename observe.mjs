#!/usr/bin/env node
// observe.mjs — Agent Session 观察台：输入 session ID → 需求解决地图（零依赖，Node ≥ 18）
//   node observe.mjs <sessionId> [moreId...] [--port 4173] [--interval 60] [--cli claude|pi|codex] [--provider p] [--model m] [--budget 400000]
// 支持同时观察多个 session，Header 下拉切换；POST /api/sessions 可在 UI 里追加。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSession, parseSession } from './src/parse.mjs';
import { buildTree } from './src/tree.mjs';
import { buildTranscript } from './src/segment.mjs';
import { buildPrompt, runClaude, normalizeMap } from './src/summarize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flagsWithValues = new Set(['--port', '--interval', '--model', '--budget', '--cli', '--provider']);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ids = [];
for (let i = 0; i < argv.length; i++) {
  if (flagsWithValues.has(argv[i])) { i++; continue; }   // 跳过 flag 及其值
  if (argv[i].startsWith('--')) continue;
  ids.push(argv[i]);
}
const PORT = +flag('--port', 4173);
const INTERVAL = +flag('--interval', 60) * 1000;
const MODEL = flag('--model', process.env.OBS_MODEL || '');
const CLI = flag('--cli', process.env.OBS_CLI || 'claude');
const PROVIDER = flag('--provider', process.env.OBS_PROVIDER || '');
const BUDGET = +flag('--budget', 400000);

if (!ids.length) {
  console.error('用法: node observe.mjs <sessionId|前缀> [更多session…] [--port 4173] [--interval 60] [--cli claude|pi|codex] [--provider p] [--model m] [--budget N]');
  process.exit(2);
}

const nowStamp = () => new Date().toTimeString().slice(0, 8);
const short = s => (s || '').slice(0, 8);

/* ── Observer：一个被观察的 session ══════════════ */
class Observer {
  constructor(prefix) {
    this.prefix = prefix; this.sessionId = null;
    this.host = null; this.tree = null;
    this.syncN = 0; this.updatedAt = null;
    this.goal = null; this.cards = []; this.edges = []; this.live = []; this.note = '';
    this.bornCard = new Map(); this.statesCard = new Map(); this.bornEdge = new Map();
    this.stamps = []; this.lastError = null; this.analyzing = false;
    this.filesSnap = '';
  }
  files() {
    return [this.host?.file, ...(this.tree?.children || []).map(c => c.file)].filter(Boolean);
  }
  filesSignature() {
    return this.files().map(f => { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; }).join('|');
  }
  changedSinceLastSync() {
    return this.syncN === 0 || this.filesSignature() !== this.filesSnap;
  }
  async analyze() {
    const first = this.syncN === 0;
    const hostInfo = findSession(this.prefix);
    const parsed = parseSession(hostInfo.file);
    const host = { ...hostInfo, ...parsed };
    this.sessionId = hostInfo.sessionId;
    const tree = buildTree(host);
    this.host = host; this.tree = tree;
    this.filesSnap = this.filesSignature();
    const transcript = buildTranscript(host, tree.children, BUDGET);
    const prevMap = this.cards.length ? { goal: this.goal, cards: this.cards, edges: this.edges } : null;
    const prompt = buildPrompt(transcript, prevMap, first ? null : '增量：与上一版相比保持卡 id 稳定，只推进有新证据的状态；失败记录不删除；未知仍然写未知。');
    const map = normalizeMap(await runClaude(prompt, { cli: CLI, model: MODEL || undefined, provider: PROVIDER || undefined }));
    this.applyMap(map);
    this.syncN++;
    this.updatedAt = new Date().toISOString();
    this.stamps.push({ at: this.syncN, data: nowStamp(), summary: nowStamp() });
    this.lastError = null;
    console.log(`[${short(this.sessionId)}] sync#${this.syncN} ok cards=${this.cards.length} tx=${transcript.length}`);
  }
  applyMap(map) {
    this.goal = map.goal; this.note = map.note;
    const nextLive = map.live && (map.live.now || map.live.known) ? map.live : (this.live[this.live.length - 1] || {});
    this.live.push({ at: this.syncN, ...nextLive });
    this.cards = map.cards; this.edges = map.edges;
    for (const c of [{ id: 'GOAL', st: 'done' }, ...map.cards]) {
      if (!this.bornCard.has(c.id)) this.bornCard.set(c.id, this.syncN);
      const arr = this.statesCard.get(c.id) || [];
      if (!arr.length || arr[arr.length - 1].s !== c.st) arr.push({ s: c.st, at: this.syncN });
      this.statesCard.set(c.id, arr);
    }
    for (const e of map.edges) {
      const k = `${e.f}>${e.t}>${e.v}`;
      if (!this.bornEdge.has(k)) this.bornEdge.set(k, this.syncN);
    }
  }
  stateFor(id, t) {
    const arr = this.statesCard.get(id) || [];
    let s = arr.length ? arr[0].s : 'doing';
    for (const x of arr) if (x.at <= t) s = x.s;
    return s;
  }
  dataView() {
    const t = this.syncN;
    const all0 = [{ ...this.goal, id: 'GOAL' }, ...this.cards];
    const all = all0.map(c => ({
      ...c,
      born: this.bornCard.get(c.id) ?? 0,
      states: this.statesCard.get(c.id) || [],
      st: this.stateFor(c.id, t),
    }));
    return {
      sessionId: this.sessionId, prefix: this.prefix,
      syncN: this.syncN, updatedAt: this.updatedAt, note: this.note,
      lastError: this.lastError, analyzing: this.analyzing,
      goal: all[0], cards: all.slice(1),
      edges: this.edges.map(e => ({ ...e, born: this.bornEdge.get(`${e.f}>${e.t}>${e.v}`) ?? 0 })),
      live: this.live, stamps: this.stamps,
      agents: agentSummary(all),
      children: (this.tree?.children || []).map(c => ({
        key: c.key, label: c.label, kind: c.kind, sessionId: c.sessionId,
        dispatchLine: c.dispatchLine, events: c.events.length, matched: c.matched,
      })),
    };
  }
  listView() {
    return {
      sid: this.sessionId || this.prefix, short: short(this.sessionId || this.prefix),
      prefix: this.prefix, syncN: this.syncN, analyzing: this.analyzing,
      lastError: this.lastError, updatedAt: this.updatedAt,
      cards: this.cards.length, note: this.note,
      children: this.tree?.children?.length || 0,
    };
  }
}

function agentSummary(cards) {
  const m = new Map();
  for (const c of cards) for (const g of c.sig || []) {
    if (!m.has(g.agent)) m.set(g.agent, { key: g.agent, label: g.agent, count: 0, verbs: {} });
    const a = m.get(g.agent); a.count++; a.verbs[g.verb] = (a.verbs[g.verb] || 0) + 1;
  }
  const palette = ['#60a5fa', '#34d399', '#fbbf24', '#2dd4bf', '#a78bfa', '#f87171', '#f472b6'];
  return [...m.values()].map((a, i) => ({ ...a, color: palette[i % palette.length] }));
}

/* ── 多观察者注册表 + 串行分析队列 ══════════════ */
const observers = new Map();       // sid/prefix → Observer
let queue = Promise.resolve();
let active = null;                 // 当前默认展示的 observer

function addSession(prefix) {
  const exist = [...observers.values()].find(o => o.prefix === prefix || o.sessionId === prefix);
  if (exist) return exist;
  const o = new Observer(prefix);
  observers.set(prefix, o);
  if (!active) active = o;
  enqueue(o);
  return o;
}
function removeSession(prefix) {
  const o = [...observers.values()].find(x => x.prefix === prefix || x.sessionId === prefix);
  if (!o) return false;
  observers.delete(o.prefix);
  if (active === o) active = [...observers.values()][0] || null;
  return true;
}
function enqueue(o) {
  queue = queue.then(() => o.analyze()).catch(e => {
    o.lastError = String(e.message || e); o.analyzing = false;
    console.error(`[${short(o.prefix)}] sync error:`, o.lastError);
  });
  return queue;
}
async function resync(o) {
  if (o.analyzing) return;
  o.analyzing = true;
  try { await enqueue(o); } finally { o.analyzing = false; }
}

/* ── HTTP ═══════════════════════════════════════ */
const webDir = path.join(__dirname, 'web');
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (u.pathname === '/api/sessions') {
      return json(200, { sessions: [...observers.values()].map(o => o.listView()) });
    }
    if (u.pathname === '/api/sessions/add' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      await new Promise(r => req.on('end', r));
      const { id } = JSON.parse(body || '{}');
      if (!id) return json(400, { error: 'missing id' });
      const o = addSession(String(id).trim());
      return json(200, { ok: true, sid: o.sessionId || o.prefix });
    }
    if (u.pathname === '/api/sessions/remove' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      await new Promise(r => req.on('end', r));
      const { id } = JSON.parse(body || '{}');
      return json(200, { ok: removeSession(id) });
    }
    if (u.pathname === '/api/data') {
      const sid = u.searchParams.get('sid');
      const o = sid
        ? ([...observers.values()].find(x => x.sessionId === sid || x.prefix === sid || (x.sessionId || '').startsWith(sid)) || active)
        : active;
      if (!o) return json(404, { error: 'no observer' });
      return json(200, o.dataView());
    }
    if (u.pathname === '/api/resync' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      await new Promise(r => req.on('end', r));
      const { id } = JSON.parse(body || '{}');
      const o = id ? [...observers.values()].find(x => x.sessionId === id || x.prefix === id) : active;
      if (!o) return json(404, { error: 'no observer' });
      resync(o);
      return json(200, { ok: true });
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(webDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`观察台: ${url}   sessions: ${ids.map(short).join(', ')}`);
  console.log('首次分析中（claude -p，每个 session 约 1-3 分钟）…');
  ids.forEach(id => addSession(id));
  setInterval(() => {
    for (const o of observers.values()) {
      if (o.changedSinceLastSync()) resync(o).catch(() => {});
    }
  }, INTERVAL);
});
