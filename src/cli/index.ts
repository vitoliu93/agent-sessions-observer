// index.ts — Agent Session 观察台：输入 session ID → 需求解决地图（运行时零依赖，Node ≥ 18）
//   agent-sessions-obs <sessionId> [moreId...] [--port 4173] [--interval 60] [--cli codex|claude|pi] [--provider p] [--model m] [--budget 400000]
// 支持同时观察多个 session，Header 下拉切换；POST /api/sessions/add 可在 UI 里追加。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card, Coverage, DataView, Draft, Edge, Live, MapResult, SessionItem, Snapshot, Stamp, AgentSummary } from '../shared/types.ts';
import { findSession, parseSession } from './parse.ts';
import { buildTree, type Child } from './tree.ts';
import { buildTranscriptDetailed } from './segment.ts';
import { buildPrompt, runModel, normalizeMap, parsePartialJson } from './summarize.ts';
import { listRecentSessions, pickSession, sessionRef } from './pick.ts';

const HELP = `agent-sessions-obs — Agent Session「需求解决地图」观察台

用法：
  agent-sessions-obs                         列出最近会话，在终端里选一个（非终端环境则空启动，在页面添加）
  agent-sessions-obs <session-id-or-prefix> [<id>…] [选项]
                                             ID 也可以是 Codex 复制的 codex://threads/<id> 链接

选项：
  --port <n>        监听 127.0.0.1 端口（默认 4173）
  --interval <秒>   检查输入文件变化的间隔（默认 60）
  --budget <字符>   压缩事件流的字符上限（默认 400000）
  --cli <名称>      分析用的模型 CLI：codex | claude | pi（默认按此顺序用本机已安装的第一个，可用 OBS_CLI）
  --model <m>       模型（codex 默认 gpt-5.6-luna，claude 默认 haiku，pi 用自身配置；可用 OBS_MODEL）
  --provider <p>    pi 的 provider（可用 OBS_PROVIDER）
  -h, --help        显示本帮助
`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }
const flagsWithValues = new Set(['--port', '--interval', '--model', '--budget', '--cli', '--provider']);
const flag = (k: string, d: string | number): string => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : String(d); };
const ids: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (flagsWithValues.has(argv[i])) { i++; continue; }   // 跳过 flag 及其值
  if (argv[i].startsWith('--')) continue;
  ids.push(sessionRef(argv[i]));
}
const PORT = +flag('--port', 4173);
const INTERVAL = +flag('--interval', 60) * 1000;
const CLI_CHOICES = ['codex', 'claude', 'pi'];
/** 命令能否直接运行：带路径就查这个文件，否则逐个查 PATH 目录 */
function installed(cmd: string): boolean {
  const dirs = cmd.includes('/') ? [''] : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  return dirs.some(d => exts.some(e => { try { const f = path.join(d, cmd + e); fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }));
}
const ASKED_CLI = argv.includes('--cli') ? flag('--cli', '') : process.env.OBS_CLI || '';
const CLI = ASKED_CLI || CLI_CHOICES.find(installed) || '';
const DEFAULT_MODEL: Record<string, string> = { claude: 'haiku', codex: 'gpt-5.6-luna', pi: '' };  // 各 CLI 的默认压缩模型
const MODEL = flag('--model', process.env.OBS_MODEL || DEFAULT_MODEL[CLI] || '');
const PROVIDER = flag('--provider', process.env.OBS_PROVIDER || '');
const BUDGET = +flag('--budget', 400000);
const MAX_ID = 128, MAX_BODY = 4096;
const BOOT = Math.random().toString(36).slice(2); // 进程标识：增量历史只在同一进程内拼接
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !Number.isFinite(INTERVAL) || INTERVAL < 100 || !Number.isFinite(BUDGET) || BUDGET < 256) {
  console.error('invalid --port / --interval / --budget'); process.exit(2);
}
// 自定义可执行文件（带路径）只给测试和高级用法，不写进帮助
if (!CLI) { console.error('找不到可用的模型 CLI：请先安装 codex、claude 或 pi 其中一个，并确认在终端里能直接运行。'); process.exit(2); }
if (!CLI_CHOICES.includes(CLI) && !CLI.includes('/')) { console.error(`--cli 只支持 codex | claude | pi，收到 ${CLI}`); process.exit(2); }
if (!installed(CLI)) {
  const others = CLI_CHOICES.filter(installed);
  console.error(`找不到命令 ${CLI}：请先安装，并确认在终端里能直接运行 ${CLI}。` + (others.length ? `本机已安装：${others.join('、')}，可改用 --cli ${others[0]}。` : ''));
  process.exit(2);
}

const short = (s: string | null | undefined) => (s || '').slice(0, 8);
type HttpError = Error & { status?: number };

type Host = ReturnType<typeof findSession> & ReturnType<typeof parseSession>;

/* ── Observer：一个被观察的 session ══════════════ */
class Observer {
  prefix: string; sessionId: string | null = null; title = '';
  host: Host | null = null; tree: { children: Child[] } | null = null;
  syncN = 0; updatedAt: string | null = null; dataReadAt: string | null = null;
  goals: Card[] = []; cards: Card[] = []; edges: Edge[] = []; live: Live[] = []; note = ''; draft: Draft | null = null;
  bornCard = new Map<string, number>(); bornEdge = new Map<string, number>();
  stamps: Stamp[] = []; history: Snapshot[] = []; lastError: string | null = null; analyzing = false;
  filesSnap = '';
  failures = 0; retryAt = 0;
  budget?: number; controller: AbortController | null = null; removed = false;
  constructor(prefix: string) { this.prefix = prefix; }
  files(): string[] {
    return [this.host?.file, ...(this.tree?.children || []).map(c => c.file)].filter((f): f is string => !!f);
  }
  filesSignature(files = this.files()): string {
    return files.map(f => { try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}`; } catch { return `${f}:missing`; } }).join('|');
  }
  changedSinceLastSync(): boolean {
    if (this.syncN === 0 || this.filesSignature() !== this.filesSnap) return true;
    if (this.tree?.children.some(c => !c.file)) {
      const tree = buildTree(this.host!);
      return this.filesSignature([this.host!.file, ...tree.children.map(c => c.file).filter((f): f is string => !!f)]) !== this.filesSnap;
    }
    return false;
  }
  async analyze() {
    const first = this.syncN === 0, started = Date.now(), log = (m: string) => console.log(`[${short(this.sessionId || this.prefix)}] ${m}`);
    const hostInfo = findSession(this.sessionId || this.prefix);
    const parsed = parseSession(hostInfo.file);
    this.title = parsed.title || this.title || '';
    const host: Host = { ...hostInfo, ...parsed };
    this.sessionId = hostInfo.sessionId;
    const tree = buildTree(host);
    log(`读取会话：主会话 ${host.events.length} 条事件，子会话 ${tree.children.length} 个（定位到文件 ${tree.children.filter(c => c.file).length} 个）`);
    const inputs = [host, ...tree.children.filter(c => c.file)];
    const newestRead = Math.max(...inputs.map(c => c.mtime || 0));
    const inputSignature = inputs.map(c => c.signature).join('|');
    const prevMap = this.goals.length ? { goals: this.goals, cards: this.cards, edges: this.edges } : null;
    const agentKeys = ['host', ...tree.children.map(c => c.key)];
    this.controller = new AbortController();
    let transcriptInfo: ReturnType<typeof buildTranscriptDetailed>, raw: unknown;
    // 预算按字符算，中文 token 更密；模型报超长就缩预算重试，并记住能放下的预算
    for (this.budget ??= BUDGET; ; this.budget = Math.floor(this.budget * 0.6)) {
      transcriptInfo = buildTranscriptDetailed(host, tree.children, this.budget);
      const prompt = buildPrompt(transcriptInfo.text, prevMap, first ? null : '增量：与上一版相比保持卡 id 稳定，只推进有新证据的状态；用户新提出的需求建新目标卡，不记成缺口；失败记录不删除；未知仍然写未知。', transcriptInfo.coverage);
      log(`调用 ${CLI}${MODEL ? `（${MODEL}）` : ''} 归纳：输入 ${prompt.length} 字${transcriptInfo.coverage.truncated ? '，部分记录已截断' : ''}`);
      const tx = transcriptInfo.text, callStart = Date.now();
      this.draft = { goals: [], cards: [], edges: [], live: {}, chars: 0, startedAt: new Date().toISOString() };
      let parsedAt = 0;
      const onText = (text: string) => {
        if (!this.draft) return;
        this.draft.chars = text.length;
        if (Date.now() - parsedAt < 500) return;   // ponytail: 半截 JSON 每 0.5 秒最多解析一次
        parsedAt = Date.now();
        this.updateDraft(text, tx, agentKeys);
      };
      const beat = setInterval(() => log(`分析中 ${Math.round((Date.now() - callStart) / 1000)}s：` +
        (this.draft?.chars ? `已收到 ${this.draft.chars} 字，已出 ${this.draft.goals.length + this.draft.cards.length} 张卡` : '等待模型开始输出')), 15000);
      try { raw = await runModel(prompt, { cli: CLI, model: MODEL || undefined, provider: PROVIDER || undefined, signal: this.controller.signal, onText, onRetry: m => log(`模型输出中断，${CLI} 自动重试：${m}`) }); break; }
      catch (e) { if (!/prompt is too long|context.{0,20}(length|window|limit)|too many tokens/i.test((e as Error).message) || this.budget < 20000 || this.removed) throw e; log(`prompt too long, budget ${this.budget} → ${Math.floor(this.budget * 0.6)}`); }
      finally { clearInterval(beat); }
    }
    const map = normalizeMap(raw, { transcript: transcriptInfo.text, agentKeys });
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
    log(`sync#${this.syncN} ok cards=${this.cards.length} edges=${this.edges.length} tx=${transcriptInfo.text.length} 用时 ${Math.round((Date.now() - started) / 1000)}s`);
  }
  /** 半截输出能校验出目标才更新草稿；不合规的部分按正式规则丢弃。模型断流重来时，新草稿追上旧的才替换，页面不倒退 */
  updateDraft(text: string, transcript: string, agentKeys: string[]) {
    const partial = parsePartialJson(text);
    if (!partial || !this.draft) return;
    try {
      const m = normalizeMap({ ...partial, cards: Array.isArray(partial.cards) ? partial.cards : [], edges: Array.isArray(partial.edges) ? partial.edges : [] }, { transcript, agentKeys });
      if (m.goals.length + m.cards.length < this.draft.goals.length + this.draft.cards.length) return;
      Object.assign(this.draft, { goals: m.goals, cards: m.cards, edges: m.edges, live: m.live });
    } catch {}
  }
  applyMap(map: MapResult, tick: number) {
    this.goals = map.goals; this.note = map.note;
    const nextLive = map.live && (map.live.now || map.live.known) ? map.live : (this.live[this.live.length - 1] || {});
    this.live.push({ ...nextLive, at: tick });
    this.cards = map.cards; this.edges = map.edges;
    for (const c of [...map.goals, ...map.cards]) {
      if (!this.bornCard.has(c.id)) this.bornCard.set(c.id, tick);
    }
    for (const e of map.edges) {
      const k = `${e.f}>${e.t}>${e.v}`;
      if (!this.bornEdge.has(k)) this.bornEdge.set(k, tick);
    }
  }
  saveSnapshot(tick: number, coverage: Coverage) {
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const stamp = (c: Card) => ({ ...c, born: this.bornCard.get(c.id), states: [{ at: tick, s: c.st }] });
    const goals = this.goals.map(stamp), cards = this.cards.map(stamp);
    const snapshot: Snapshot = {
      at: tick, goals: clone(goals), cards: clone(cards),
      edges: clone(this.edges.map(e => ({ ...e, born: this.bornEdge.get(`${e.f}>${e.t}>${e.v}`) }))),
      live: clone(this.live.at(-1)!), note: this.note, agents: agentSummary([...goals, ...cards]),
      children: clone((this.tree?.children || []).map(c => ({ key: c.key, label: c.label, kind: c.kind, sessionId: c.sessionId, dispatchLine: c.dispatchLine, events: c.events.length, matched: c.matched }))),
      stamps: clone(this.stamps.slice(-1)), updatedAt: this.updatedAt, dataReadAt: this.dataReadAt, coverage: clone(coverage),
    };
    this.history.push(Object.freeze(snapshot));
  }
  dataView(since = 0, boot = ''): DataView {
    const saved = this.history.at(-1) || { goals: [], cards: [], edges: [], live: {}, agents: [], children: [], stamps: [], note: '' };
    return { sessionId: this.sessionId, prefix: this.prefix, syncN: this.syncN,
      updatedAt: this.updatedAt, dataReadAt: this.dataReadAt, lastError: this.lastError,
      analyzing: this.analyzing, draft: this.analyzing ? this.draft : null, ...this.historyAfter(since, boot), ...saved };
  }
  // 进程不同（服务重启）或客户端序号比服务端大（会话重加）：给完整历史，前端整体替换
  historyAfter(since: number, boot: string) {
    if (boot !== BOOT || since > this.syncN) since = 0;
    return { boot: BOOT, historySince: since, history: this.history.filter(h => h.at > since) };
  }
  listView(): SessionItem {
    return {
      sid: this.sessionId || this.prefix, short: short(this.sessionId || this.prefix),
      prefix: this.prefix, title: this.title || '', syncN: this.syncN, analyzing: this.analyzing,
      lastError: this.lastError, updatedAt: this.updatedAt,
      cards: this.cards.length, note: this.note,
      children: this.tree?.children?.length || 0,
    };
  }
}

function agentSummary(cards: Card[]): AgentSummary[] {
  const m = new Map<string, Omit<AgentSummary, 'color'>>();
  for (const c of cards) for (const g of c.sig || []) {
    if (!m.has(g.agent)) m.set(g.agent, { key: g.agent, label: g.agent, count: 0, verbs: {} });
    const a = m.get(g.agent)!; a.count++; a.verbs[g.verb] = (a.verbs[g.verb] || 0) + 1;
  }
  const palette = ['#60a5fa', '#34d399', '#fbbf24', '#2dd4bf', '#a78bfa', '#f87171', '#f472b6'];
  return [...m.values()].map((a, i) => ({ ...a, color: palette[i % palette.length] }));
}

/* ── 多观察者注册表 + 串行分析队列 ══════════════ */
const observers = new Map<string, Observer>();       // sid/prefix → Observer
let queue = Promise.resolve(), busy = false;
let active: Observer | null = null;                 // 当前默认展示的 observer

function addSession(prefix: string): Observer {
  let info; try { info = findSession(prefix); } catch (e) { (e as HttpError).status = /ambiguous/.test((e as Error).message) ? 409 : 404; throw e; }
  const exist = [...observers.values()].find(o => o.sessionId === info.sessionId);
  if (exist) return exist;
  const o = new Observer(prefix);
  o.sessionId = info.sessionId;
  try { o.title = parseSession(info.file).title || ''; } catch {} // 排队等分析时也能看到标题
  observers.set(prefix, o);
  if (!active) active = o;
  schedule(o);
  return o;
}
function removeSession(prefix: string): boolean {
  const o = [...observers.values()].find(x => x.prefix === prefix || x.sessionId === prefix);
  if (!o) return false;
  observers.delete(o.prefix);
  o.removed = true;
  o.controller?.abort();
  if (active === o) active = [...observers.values()][0] || null;
  return true;
}
function schedule(o: Observer | null): boolean {
  if (!o || o.removed || o.analyzing) return false;
  o.analyzing = true; // 入队前占用，首次与手动同步走同一条路。
  if (busy) console.log(`[${short(o.sessionId || o.prefix)}] 排队中：等其它会话分析完成`);
  queue = queue.then(async () => {
    if (o.removed) return;
    busy = true;
    await o.analyze();
  }).catch(e => {
    o.lastError = String(e.message || e);
    o.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(o.failures++, 6));
    console.error(`[${short(o.prefix)}] sync error:`, o.lastError);
  }).finally(() => { o.analyzing = false; o.controller = null; o.draft = null; busy = false; });
  return true;
}
function resync(o: Observer) {
  return schedule(o);
}

/* ── HTTP ═══════════════════════════════════════ */
// 发布产物旁边有 web/；从 src/cli 开发运行时读 dist-cli/web
const webDir = fs.existsSync(path.join(__dirname, 'web')) ? path.join(__dirname, 'web') : path.resolve(__dirname, '../../dist-cli/web');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
};
function validId(id: unknown): id is string { return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID && /^[A-Za-z0-9._-]+$/.test(id); }
function readJson(req: http.IncomingMessage): Promise<any> {
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
/** 静态文件：解码后仍须落在 webDir 内；未命中回退 index.html（单页应用） */
function serveStatic(pathname: string, res: http.ServerResponse) {
  const index = path.join(webDir, 'index.html');
  if (!fs.existsSync(index)) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('前端未构建：请先运行 bun run build:web'); }
  let rel; try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  const file = path.resolve(webDir, '.' + rel);
  let isFile = false; try { isFile = file.startsWith(webDir + path.sep) && fs.statSync(file).isFile(); } catch {}
  const target = isFile ? file : index;
  res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
  res.end(fs.readFileSync(target));
}
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const json = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    // 只认本机地址：DNS rebinding 时 Host 是攻击者域名，读写接口都拒绝
    if (u.pathname.startsWith('/api/') && !LOCAL_HOSTS.has(req.headers.host || '')) return json(403, { error: 'host not allowed' });
    if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'cross-origin write rejected' });
    if (u.pathname === '/api/sessions') {
      return json(200, { sessions: [...observers.values()].map(o => o.listView()) });
    }
    if (u.pathname === '/api/sessions/add' && req.method === 'POST') {
      const body = await readJson(req), id = typeof body.id === 'string' ? sessionRef(body.id) : body.id;
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
      return json(200, o.dataView(Math.max(0, parseInt(u.searchParams.get('since') || '', 10) || 0), u.searchParams.get('boot') || ''));
    }
    if (u.pathname === '/api/resync' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (id !== undefined && !validId(id)) return json(400, { error: 'invalid id' });
      const o = id ? [...observers.values()].find(x => x.sessionId === id || x.prefix === id) : active;
      if (!o) return json(404, { error: 'no observer' });
      resync(o); // 不 await；队列内异常已经捕获，不能成为未处理 rejection。
      return json(200, { ok: true });
    }
    if (req.method === 'GET' && !u.pathname.startsWith('/api/')) return serveStatic(u.pathname, res);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json((e as HttpError).status || 500, { error: String((e as Error).message || e) });
  }
});

// 没给 ID 且在终端里：列出最近会话让用户选；非终端（管道、测试）照旧空启动
if (!ids.length && process.stdin.isTTY && process.stdout.isTTY) {
  const recent = listRecentSessions();
  if (recent.length) {
    const picked = await pickSession(recent);
    if (!picked) { console.log('已取消。'); process.exit(0); }
    ids.push(picked);
  } else console.log('本机没有找到 Claude Code 或 Codex 会话；空启动，可在页面添加 session ID。');
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`观察台: ${url}   sessions: ${ids.map(short).join(', ')}`);
  console.log(`分析模型：${CLI}${MODEL ? `（${MODEL}）` : ''}${!ASKED_CLI && CLI !== CLI_CHOICES[0] ? `（本机找不到 ${CLI_CHOICES.slice(0, CLI_CHOICES.indexOf(CLI)).join('、')}，自动改用 ${CLI}）` : ''}`);
  console.log(ids.length ? '首次分析中，每个 session 约 1-3 分钟，进度每 15 秒打印一次…' : '尚无会话；可在页面添加 session ID。');
  ids.forEach(id => { try { if (!validId(id)) throw new Error('invalid session id'); addSession(id); } catch (e) { console.error((e as Error).message); } });
  setInterval(() => {
    for (const o of observers.values()) {
      if (o.analyzing || Date.now() < o.retryAt) continue;
      try { if (o.changedSinceLastSync()) resync(o); }
      catch (e) { console.error(`[${short(o.sessionId || o.prefix)}] check error: ${(e as Error).message || e}`); }
    }
  }, INTERVAL);
});
