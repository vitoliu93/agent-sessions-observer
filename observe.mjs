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
import { buildTranscriptDetailed } from './src/segment.mjs';
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
const CLI = flag('--cli', process.env.OBS_CLI || 'claude');
const DEFAULT_MODEL = { claude: 'haiku', codex: 'gpt-5.6-luna', pi: '' };  // 各 CLI 的默认压缩模型
const MODEL = flag('--model', process.env.OBS_MODEL || DEFAULT_MODEL[CLI] || '');
const PROVIDER = flag('--provider', process.env.OBS_PROVIDER || '');
const BUDGET = +flag('--budget', 400000);
const MAX_ID = 128, MAX_BODY = 4096;
const BOOT = Math.random().toString(36).slice(2); // 进程标识：增量历史只在同一进程内拼接
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !Number.isFinite(INTERVAL) || INTERVAL < 100 || !Number.isFinite(BUDGET) || BUDGET < 256) {
  console.error('invalid --port / --interval / --budget'); process.exit(2);
}

const short = s => (s || '').slice(0, 8);

/* ── Observer：一个被观察的 session ══════════════ */
class Observer {
  constructor(prefix) {
    this.prefix = prefix; this.sessionId = null;
    this.host = null; this.tree = null;
    this.syncN = 0; this.updatedAt = null; this.dataReadAt = null;
    this.goal = null; this.cards = []; this.edges = []; this.live = []; this.note = '';
    this.bornCard = new Map(); this.bornEdge = new Map();
    this.stamps = []; this.history = []; this.lastError = null; this.analyzing = false;
    this.filesSnap = '';
    this.failures = 0; this.retryAt = 0;
  }
  files() {
    return [this.host?.file, ...(this.tree?.children || []).map(c => c.file)].filter(Boolean);
  }
  filesSignature(files = this.files()) {
    return files.map(f => { try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return `${f}:missing`; } }).join('|');
  }
  changedSinceLastSync() {
    if (this.syncN === 0 || this.filesSignature() !== this.filesSnap) return true;
    if (this.tree?.children.some(c => !c.file)) {
      const tree = buildTree(this.host);
      return this.filesSignature([this.host.file, ...tree.children.map(c => c.file).filter(Boolean)]) !== this.filesSnap;
    }
    return false;
  }
  async analyze() {
    const first = this.syncN === 0;
    const hostInfo = findSession(this.sessionId || this.prefix);
    const parsed = parseSession(hostInfo.file);
    this.title = parsed.title || this.title || '';
    const host = { ...hostInfo, ...parsed };
    this.sessionId = hostInfo.sessionId;
    const tree = buildTree(host);
    const inputs = [host, ...tree.children.filter(c => c.file)];
    const newestRead = Math.max(...inputs.map(c => c.mtime));
    const inputSignature = inputs.map(c => c.signature).join('|');
    const prevMap = this.cards.length ? { goal: this.goal, cards: this.cards, edges: this.edges } : null;
    this.controller = new AbortController();
    let transcriptInfo, raw;
    // 预算按字符算，中文 token 更密；模型报超长就缩预算重试，并记住能放下的预算
    for (this.budget ??= BUDGET; ; this.budget = Math.floor(this.budget * 0.6)) {
      transcriptInfo = buildTranscriptDetailed(host, tree.children, this.budget);
      const prompt = buildPrompt(transcriptInfo.text, prevMap, first ? null : '增量：与上一版相比保持卡 id 稳定，只推进有新证据的状态；失败记录不删除；未知仍然写未知。', transcriptInfo.coverage);
      try { raw = await runClaude(prompt, { cli: CLI, model: MODEL || undefined, provider: PROVIDER || undefined, signal: this.controller.signal }); break; }
      catch (e) { if (!/prompt is too long|context.{0,20}(length|window|limit)|too many tokens/i.test(e.message) || this.budget < 20000 || this.removed) throw e; console.log(`[${short(this.sessionId)}] prompt too long, budget ${this.budget} → ${Math.floor(this.budget * 0.6)}`); }
    }
    const map = normalizeMap(raw, { transcript: transcriptInfo.text, agentKeys: ['host', ...tree.children.map(c => c.key)] });
    if (this.removed) return;
    // 失败前绝不修改任何可见状态或已消费签名。成功 tick 从 1 开始。
    const tick = this.syncN + 1;
    this.host = host; this.tree = tree;
    this.applyMap(map, tick);
    this.syncN = tick;
    this.updatedAt = new Date().toISOString();
    this.dataReadAt = newestRead ? new Date(newestRead).toISOString() : this.updatedAt;
    this.stamps.push({ at: tick, data: this.dataReadAt, summary: this.updatedAt });
    this.filesSnap = inputSignature;
    this.saveSnapshot(tick, transcriptInfo.coverage);
    this.lastError = null; this.failures = 0; this.retryAt = 0;
    console.log(`[${short(this.sessionId)}] sync#${this.syncN} ok cards=${this.cards.length} tx=${transcriptInfo.text.length}`);
  }
  applyMap(map, tick) {
    this.goal = map.goal; this.note = map.note;
    const nextLive = map.live && (map.live.now || map.live.known) ? map.live : (this.live[this.live.length - 1] || {});
    this.live.push({ ...nextLive, at: tick });
    this.cards = map.cards; this.edges = map.edges;
    for (const c of [map.goal, ...map.cards]) {
      if (!this.bornCard.has(c.id)) this.bornCard.set(c.id, tick);
    }
    for (const e of map.edges) {
      const k = `${e.f}>${e.t}>${e.v}`;
      if (!this.bornEdge.has(k)) this.bornEdge.set(k, tick);
    }
  }
  saveSnapshot(tick, coverage) {
    const clone = value => JSON.parse(JSON.stringify(value));
    const all = [this.goal, ...this.cards].map(c => ({ ...c, born: this.bornCard.get(c.id), states: [{ at: tick, s: c.st }] }));
    const snapshot = {
      at: tick, goal: clone(all[0]), cards: clone(all.slice(1)),
      edges: clone(this.edges.map(e => ({ ...e, born: this.bornEdge.get(`${e.f}>${e.t}>${e.v}`) }))),
      live: clone(this.live.at(-1)), note: this.note, agents: agentSummary(all),
      children: clone((this.tree?.children || []).map(c => ({ key: c.key, label: c.label, kind: c.kind, sessionId: c.sessionId, dispatchLine: c.dispatchLine, events: c.events.length, matched: c.matched }))),
      stamps: clone(this.stamps.slice(-1)), updatedAt: this.updatedAt, dataReadAt: this.dataReadAt, coverage: clone(coverage),
    };
    this.history.push(Object.freeze(snapshot));
  }
  dataView(since = 0, boot = '') {
    const saved = this.history.at(-1) || { goal: null, cards: [], edges: [], live: {}, agents: [], children: [], stamps: [], note: '' };
    return { sessionId: this.sessionId, prefix: this.prefix, syncN: this.syncN,
      updatedAt: this.updatedAt, dataReadAt: this.dataReadAt, lastError: this.lastError,
      analyzing: this.analyzing, ...this.historyAfter(since, boot), ...saved };
  }
  // 进程不同（服务重启）或客户端序号比服务端大（会话重加）：给完整历史，前端整体替换
  historyAfter(since, boot) {
    if (boot !== BOOT || since > this.syncN) since = 0;
    return { boot: BOOT, historySince: since, history: this.history.filter(h => h.at > since) };
  }
  listView() {
    return {
      sid: this.sessionId || this.prefix, short: short(this.sessionId || this.prefix),
      prefix: this.prefix, title: this.title || '', syncN: this.syncN, analyzing: this.analyzing,
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
  let info; try { info = findSession(prefix); } catch (e) { e.status = /ambiguous/.test(e.message) ? 409 : 404; throw e; }
  const exist = [...observers.values()].find(o => o.sessionId === info.sessionId);
  if (exist) return exist;
  const o = new Observer(prefix);
  o.sessionId = info.sessionId;
  try { o.title = parseSession(info.file).title; } catch {} // 排队等分析时也能看到标题
  observers.set(prefix, o);
  if (!active) active = o;
  schedule(o);
  return o;
}
function removeSession(prefix) {
  const o = [...observers.values()].find(x => x.prefix === prefix || x.sessionId === prefix);
  if (!o) return false;
  observers.delete(o.prefix);
  o.removed = true;
  o.controller?.abort();
  if (active === o) active = [...observers.values()][0] || null;
  return true;
}
function schedule(o) {
  if (!o || o.removed || o.analyzing) return false;
  o.analyzing = true; // 入队前占用，首次与手动同步走同一条路。
  queue = queue.then(async () => {
    if (o.removed) return;
    await o.analyze();
  }).catch(e => {
    o.lastError = String(e.message || e);
    o.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(o.failures++, 6));
    console.error(`[${short(o.prefix)}] sync error:`, o.lastError);
  }).finally(() => { o.analyzing = false; o.controller = null; });
  return true;
}
function resync(o) {
  return schedule(o);
}

/* ── HTTP ═══════════════════════════════════════ */
const webDir = path.join(__dirname, 'web');
function validId(id) { return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID && /^[A-Za-z0-9._-]+$/.test(id); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '', bytes = 0, rejected = false;
    req.setEncoding('utf8');
    req.on('data', d => {
      if (rejected) return;
      bytes += Buffer.byteLength(d);
      if (bytes > MAX_BODY) { rejected = true; reject(Object.assign(new Error('body too large'), { status: 413 })); req.resume(); return; }
      body += d;
    });
    req.on('end', () => { if (rejected) return; try { resolve(JSON.parse(body || '{}')); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'cross-origin write rejected' });
    if (u.pathname === '/api/sessions') {
      return json(200, { sessions: [...observers.values()].map(o => o.listView()) });
    }
    if (u.pathname === '/api/sessions/add' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (!validId(id)) return json(400, { error: 'invalid id' });
      const o = addSession(id);
      return json(200, { ok: true, sid: o.sessionId || o.prefix });
    }
    if (u.pathname === '/api/sessions/remove' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (!validId(id)) return json(400, { error: 'invalid id' });
      return json(200, { ok: removeSession(id) });
    }
    if (u.pathname === '/api/data') {
      const sid = u.searchParams.get('sid');
      if (sid !== null && !validId(sid)) return json(400, { error: 'invalid sid' });
      const o = sid ? [...observers.values()].find(x => x.sessionId === sid || x.prefix === sid) : active;
      if (!o) return json(404, { error: 'no observer' });
      return json(200, o.dataView(Math.max(0, parseInt(u.searchParams.get('since'), 10) || 0), u.searchParams.get('boot') || ''));
    }
    if (u.pathname === '/api/resync' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (id !== undefined && !validId(id)) return json(400, { error: 'invalid id' });
      const o = id ? [...observers.values()].find(x => x.sessionId === id || x.prefix === id) : active;
      if (!o) return json(404, { error: 'no observer' });
      resync(o); // 不 await；队列内异常已经捕获，不能成为未处理 rejection。
      return json(200, { ok: true });
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(webDir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(e.status || 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`观察台: ${url}   sessions: ${ids.map(short).join(', ')}`);
  console.log(ids.length ? '首次分析中（claude -p，每个 session 约 1-3 分钟）…' : '尚无会话；可在页面添加 session ID。');
  ids.forEach(id => { try { if (!validId(id)) throw new Error('invalid session id'); addSession(id); } catch (e) { console.error(e.message); } });
  setInterval(() => {
    for (const o of observers.values()) {
      if (o.analyzing || Date.now() < o.retryAt) continue;
      try { if (o.changedSinceLastSync()) resync(o); }
      catch (e) { console.error(`[${short(o.sessionId || o.prefix)}] check error: ${e.message || e}`); }
    }
  }, INTERVAL);
});
