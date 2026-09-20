// index.ts — Agent Session 观察台：输入 session ID → 需求解决地图（依赖已打进产物，Node ≥ 22）
//   agent-sessions-obs <sessionId> [moreId...] [--port 4173] [--interval 60] [--cli codex|claude|pi] [--provider p] [--model m] [--budget 400000]
// 支持同时观察多个 session，Header 下拉切换；POST /api/sessions/add 可在 UI 里追加。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WEAK_AT } from '../shared/types.ts';
import type { Card, Coverage, DataView, Draft, Edge, Live, MapResult, Pulse, SessionItem, Snapshot, ToolCallView } from '../shared/types.ts';
import { findSession, parseSession } from './parse.ts';
import { buildTree, type Child } from './tree.ts';
import { buildTranscriptDetailed, segmentSession } from './segment.ts';
import { buildPrompt, runModel, normalizeMap, parsePartialJson, dropHalfIds } from './summarize.ts';
import { listRecentSessions, pickSession, sessionRef } from './pick.ts';
import { DELTA_MAX, WAKE_AT, checkCards, citedEvidence, disableJev, jevOn, pulse } from './jev.ts';
import { buildJevMap, type JevCache } from './jevmap.ts';
import { REVIEW_SYSTEM, applyOverlay, buildReviewPrompt, mergeOverlay, normalizeOverlay, pending, planReview, type Overlay } from './review.ts';
import { cacheDir, cacheFile, encodeCache, readCache, sweepCache, writePrivate } from './cache.ts';

const HELP = `agent-sessions-obs — Agent Session「需求解决地图」观察台

用法：
  agent-sessions-obs                         列出最近会话，在终端里选一个（非终端环境则空启动，在页面添加）
  agent-sessions-obs <session-id-or-prefix> [<id>…] [选项]
                                             ID 也可以是 Codex 复制的 codex://threads/<id> 链接

选项：
  --port <n>        监听 127.0.0.1 端口（默认 4173）
  --interval <秒>   慢模型两轮的最短间隔（默认 60）；无 Jev 时也是文件检查间隔
  --budget <字符>   压缩事件流的字符上限（默认 400000）
  --cli <名称>      分析用的模型 CLI：codex | claude | pi（默认按此顺序用本机已安装的第一个，可用 OBS_CLI）
  --model <m>       模型（codex 默认 gpt-5.6-luna，claude 默认 haiku，pi 用自身配置；可用 OBS_MODEL）
  --provider <p>    pi 的 provider（可用 OBS_PROVIDER）
  --engine <名称>   地图由谁画：jev | cli。有 JEV_API_KEY 或 TYPESAFE_API_KEY 时默认 jev：
                    几秒出图、会话一变就更新，卡片文字摘自原文；cli 用本机慢模型归纳，1–3 分钟一版
  --no-review       jev 画图时不让慢模型审图（默认：本机装了模型 CLI 就审）
  --no-jev          完全不用 Jev（等于 --engine cli，并关掉此刻状态、把关和证据核对）
  -h, --help        显示本帮助
`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }
// 不认识的选项、选项缺值都直接报错退出，不再静默跳过
function parseArgv() {
  try {
    return parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      port: { type: 'string' }, interval: { type: 'string' }, budget: { type: 'string' },
      cli: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' }, engine: { type: 'string' }, 'no-jev': { type: 'boolean' }, 'no-review': { type: 'boolean' },
    } });
  } catch (e) { console.error((e as Error).message); process.exit(2); }
}
const { values: opt, positionals } = parseArgv();
const ids: string[] = positionals.map(sessionRef);
const PORT = +(opt.port ?? 4173);
const INTERVAL = +(opt.interval ?? 60) * 1000;
const CLI_CHOICES = ['codex', 'claude', 'pi'];
/** 命令能否直接运行：带路径就查这个文件，否则逐个查 PATH 目录 */
function installed(cmd: string): boolean {
  const dirs = cmd.includes('/') ? [''] : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  return dirs.some(d => exts.some(e => { try { const f = path.join(d, cmd + e); fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }));
}
const ASKED_CLI = opt.cli ?? process.env.OBS_CLI ?? '';
const CLI = ASKED_CLI || CLI_CHOICES.find(installed) || '';
const DEFAULT_MODEL: Record<string, string> = { claude: 'haiku', codex: 'gpt-5.6-luna', pi: '' };  // 各 CLI 的默认压缩模型
const MODEL = opt.model ?? (process.env.OBS_MODEL || DEFAULT_MODEL[CLI] || '');
const PROVIDER = opt.provider ?? (process.env.OBS_PROVIDER || '');
const BUDGET = +(opt.budget ?? 400000);
if (opt['no-jev']) disableJev();
const ENGINE = (opt.engine ?? (jevOn() ? 'jev' : 'cli')) as 'jev' | 'cli';
if (ENGINE !== 'jev' && ENGINE !== 'cli') { console.error(`--engine 只支持 jev | cli，收到 ${ENGINE}`); process.exit(2); }
if (ENGINE === 'jev' && !jevOn()) { console.error('--engine jev 需要环境变量 JEV_API_KEY 或 TYPESAFE_API_KEY'); process.exit(2); }
// jev 画图时每 5 秒看一次文件，变了就重画（只判新步骤）；cli 画图时每 10 秒快判一次，慢同步仍至少隔 --interval 秒
// ponytail: 每次变化整份重读 JSONL；超大会话跟不上时改成按偏移量增量读
const FAST_MS = ENGINE === 'jev' ? 5000 : 10000;
const MAX_ID = 128, MAX_BODY = 4096;
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !Number.isFinite(INTERVAL) || INTERVAL < 100 || !Number.isFinite(BUDGET) || BUDGET < 256) {
  console.error('invalid --port / --interval / --budget'); process.exit(2);
}
// jev 画图时模型 CLI 只用来审图：没装就只有 Jev 底稿，不报错
const REVIEW = ENGINE === 'jev' && !opt['no-review'] && !!CLI && (CLI_CHOICES.includes(CLI) || CLI.includes('/')) && installed(CLI);
// 自定义可执行文件（带路径）只给测试和高级用法，不写进帮助
if (ENGINE === 'jev') {} else if (!CLI) { console.error('找不到可用的模型 CLI：请先安装 codex、claude 或 pi 其中一个，并确认在终端里能直接运行。'); process.exit(2); }
else if (!CLI_CHOICES.includes(CLI) && !CLI.includes('/')) { console.error(`--cli 只支持 codex | claude | pi，收到 ${CLI}`); process.exit(2); }
else if (!installed(CLI)) {
  const others = CLI_CHOICES.filter(installed);
  console.error(`找不到命令 ${CLI}：请先安装，并确认在终端里能直接运行 ${CLI}。` + (others.length ? `本机已安装：${others.join('、')}，可改用 --cli ${others[0]}。` : ''));
  process.exit(2);
}

const short = (s: string | null | undefined) => (s || '').slice(0, 8);
const ts = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
type HttpError = Error & { status?: number };

type Host = ReturnType<typeof findSession> & ReturnType<typeof parseSession>;

/* ── Observer：一个被观察的 session ══════════════ */
class Observer {
  prefix: string; sessionId: string | null = null; title = '';
  host: Host | null = null; tree: { children: Child[] } | null = null;
  syncN = 0; updatedAt: string | null = null; dataReadAt: string | null = null;
  goals: Card[] = []; cards: Card[] = []; edges: Edge[] = []; live: Live = {}; note = ''; draft: Draft | null = null;
  current: Snapshot | null = null; lastError: string | null = null; analyzing = false;
  filesSnap = '';
  failures = 0; retryAt = 0;
  budget?: number; controller: AbortController | null = null; removed = false;
  rerun = false; pulseCtl: AbortController | null = null; inputSnap = '';
  /* 快判（Jev）：seen 是上次慢同步读到的每个文件的事件数，之后的算新事件 */
  pulse: Pulse | null = null; seen = new Map<string, number>(); file0 = ''; pulseSnap = ''; pulseFiles: string[] = [];
  jevRetries = 0; wake = false; skipped = 0; lastSlowAt = 0; ticking = false; jevCache: JevCache = new Map(); mapKey = '';
  /* 慢模型审图：rawMap 是 Jev 底稿，overlay 是修改单，每次重画后重新套用 */
  rawMap: MapResult | null = null; view: MapResult | null = null; saved = ''; overlay: Overlay | null = null; cwd = '';
  changedAt = Date.now(); supportMemo = new Map<string, number>();
  /** 审图的全部状态：gen 用来作废审到一半的旧单子，ctl 用来取消正在跑的慢模型 */
  review = { running: false, at: null as string | null, tried: 0, failures: 0, gen: 0, unreviewed: 0, error: null as string | null, ctl: null as AbortController | null };
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
  /** 快判一拍：文件变了就让 Jev 看新事件，判此刻状态、判要不要叫醒慢模型；到点且该醒就排队慢同步。
   *  Jev 不通时退回老办法：文件变了就慢同步 */
  async fastTick() {
    if (this.ticking || this.removed) return;
    this.ticking = true;
    const ctl = this.pulseCtl = new AbortController();
    const mayRun = () => !this.analyzing && Date.now() >= this.retryAt && (ENGINE === 'jev' || Date.now() - this.lastSlowAt >= INTERVAL);
    try {
      const files = this.pulseFiles.length ? this.pulseFiles : [this.file0];
      if (this.filesSignature(files) !== this.pulseSnap) {
        const hostInfo = findSession(this.sessionId || this.prefix);
        const host: Host = { ...hostInfo, ...parseSession(hostInfo.file) };
        const parts = [{ key: 'host', file: host.file, events: host.events, signature: host.signature }, ...buildTree(host).children.filter(c => c.file).map(c => ({ key: c.key, file: c.file!, events: c.events, signature: c.signature }))];
        // 还没有地图时只看主会话最后 40 条；之后看上次慢同步以来的全部新事件
        const delta = parts.map(p => segmentSession(p.events.slice(this.seen.get(p.file) ?? (this.syncN ? 0 : p.key === 'host' ? -40 : p.events.length)), p.key, p.key, { includeSidechain: p.key !== 'host' }).join('\n')).filter(Boolean).join('\n');
        this.pulseFiles = parts.map(p => p.file); this.pulseSnap = parts.map(p => p.signature).join('|');
        if (this.inputSnap !== this.pulseSnap) { this.inputSnap = this.pulseSnap; this.changedAt = Date.now(); }
        if (delta) {
          const r = await pulse(delta, ctl.signal);
          if (this.removed) return;
          // jev 画图便宜，有新事件就重画——第一版还没出来时也一样：先开观察台、用户后说话的会话靠这个出图
          const woke = ENGINE === 'jev' || (!!this.syncN && (r.changed >= WAKE_AT || delta.length > DELTA_MAX));
          if (woke) this.wake = true; else if (this.syncN) this.skipped++;
          this.pulse = { ...r, skipped: this.skipped, woke };
          console.log(`[${ts()}] [${short(this.sessionId || this.prefix)}] 快判 ${r.ms}ms：${r.phase}(${r.confidence.toFixed(2)}) 卡住 ${r.stuck.toFixed(2)} 改图 ${r.changed.toFixed(2)}${ENGINE === 'jev' ? '' : this.syncN ? woke ? ' → 叫醒慢模型' : ` → 不重新归纳（已拦 ${this.skipped} 次）` : ''}`);
        }
      }
      if (this.wake && mayRun()) schedule(this);
      this.maybeReview();   // agent 刚停下来等用户：图没变也该审了
    } catch (e) {
      if (ctl.signal.aborted || this.removed) return;
      console.error(`[${ts()}] [${short(this.sessionId || this.prefix)}] 快判失败，退回按文件变化同步：${(e as Error).message || e}`);
      try { if (mayRun() && this.changedSinceLastSync()) schedule(this); } catch {}
    } finally { this.ticking = false; if (this.pulseCtl === ctl) this.pulseCtl = null; this.maybeReview(); }
  }
  async analyze() {
    const first = this.syncN === 0, started = Date.now(), log = (m: string) => console.log(`[${ts()}] [${short(this.sessionId || this.prefix)}] ${m}`);
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
    const rawCwd = host.events.find(e => e.cwd)?.cwd || (host.project && path.isAbsolute(host.project) ? host.project : '');
    let projectCwd = process.cwd();
    if (rawCwd) {
      try {
        if (fs.existsSync(rawCwd) && fs.statSync(rawCwd).isDirectory()) projectCwd = rawCwd;
      } catch {}
    }
    this.controller = new AbortController();
    let map: ReturnType<typeof normalizeMap>, coverage: Coverage, size = '', jevFailed = 0;
    if (ENGINE === 'jev') {
      // Jev 画图：每一步出成选择题并发去问，判过的走缓存；卡片文字摘自原文
      const bound = AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]);
      const r = await buildJevMap({ key: 'host', events: host.events }, tree.children.filter(c => c.file).map(c => ({ key: c.key, events: c.events, dispatchLine: c.dispatchLine })), this.jevCache, bound);
      const overlay = this.overlay;
      let shaped: ReturnType<typeof applyOverlay> = { ...r, unreviewed: r.goals.length + r.cards.length };
      // 修改单套不上去（缓存里的旧单子、没料到的形状）：丢掉它，照底稿出图，不能让整个会话出不了图
      if (this.overlay) try { shaped = applyOverlay(r, this.overlay); } catch (e) { log(`修改单套不上去，已丢弃：${(e as Error).message}`); this.overlay = null; this.save(); }
      map = normalizeMap(shaped, { agentKeys });
      // normalizeMap 只留模型能写的字段；原话、已审标记、纠正理由是系统加的，按 ID 接回去
      const shapedById = new Map([...shaped.goals, ...shaped.cards].map(c => [c.id, c]));
      for (const c of [...map.goals, ...map.cards]) { const s = shapedById.get(c.id)!; if (s.raw) c.raw = s.raw; if (s.reviewed) c.reviewed = true; c.notes = [...(s.notes || []), ...(c.notes || [])]; }
      if (this.removed) return;
      this.rawMap = r; this.view = map; this.review.unreviewed = shaped.unreviewed; this.cwd = projectCwd;
      this.save();
      // agent 说做完了不算数：拿这一回合跑过的检查结果，对一遍结论
      const factsOf = (id: string) => map.cards.find(c => c.id === id)?.facts || [];
      await checkCards(map.cards.filter(c => c.type === 'concl').map(c => ({ c, evidence: map.edges.filter(e => e.v === '支持' && e.t === c.id).flatMap(e => factsOf(e.f)).join('\n') })).filter(x => x.evidence), bound, this.supportMemo);
      if (this.removed) return;
      if (overlay !== this.overlay) { this.rerun = true; return; }   // 审图完成或手动同步时旧单子不能再发布
      jevFailed = r.failed;
      coverage = { truncated: false, missing: tree.children.filter(c => !c.events.length).map(c => c.key), note: '', sessions: [] };
      size = `问 Jev ${r.asked}/${r.total} 次`;
    } else {
      let transcriptInfo: ReturnType<typeof buildTranscriptDetailed>, raw: unknown;
      let rawText = '', dropped = '';   // 模型正文；dropped 是被后来的消息整个覆盖掉的那一份
      /** 归纳失败时把模型原始正文落盘：只有它能还原模型到底吐了什么，报错信息里带上路径 */
      const dumpRaw = (e: Error): Error => {
        if (!rawText && !dropped) return e;
        try {
          const f = path.join(cacheDir(), `obs-failed-${short(this.sessionId || this.prefix)}-${process.pid}-${Date.now()}.txt`);
          writePrivate(f, (dropped ? `## 被覆盖的正文（${dropped.length} 字）\n${dropped}\n\n` : '') + `## 最终正文（${rawText.length} 字）\n${rawText}`);
          return new Error(`${e.message}；原始输出已存到 ${f}`);
        } catch { return e; }
      };
      // 预算按字符算，中文 token 更密；模型报超长就缩预算重试，并记住能放下的预算
      for (this.budget ??= BUDGET; ; this.budget = Math.floor(this.budget * 0.6)) {
        transcriptInfo = buildTranscriptDetailed(host, tree.children, this.budget);
        const prompt = buildPrompt(transcriptInfo.text, prevMap, first ? null : '增量：与上一版相比保持卡 id 稳定，只推进有新证据的状态；用户新提出的需求建新目标卡，不记成缺口；失败记录不删除；未知仍然写未知。', transcriptInfo.coverage);
        log(`调用 ${CLI}${MODEL ? `（${MODEL}）` : ''} 归纳：输入 ${prompt.length} 字${transcriptInfo.coverage.truncated ? '，部分记录已截断' : ''}`);
        const tx = transcriptInfo.text, callStart = Date.now();
        this.draft = { goals: [], cards: [], edges: [], live: {}, chars: 0, startedAt: new Date().toISOString(), thinking: '', toolCalls: [] };
        rawText = ''; dropped = '';
        let parsedAt = 0;
        const onText = (text: string) => {
          if (!this.draft) return;
          // 正文只会变长；变短说明 CLI 用新一条消息整个覆盖了旧正文，旧的那份要留住才能复盘
          if (text.length < rawText.length) { dropped = rawText; log(`正文被覆盖：${rawText.length} 字 → ${text.length} 字`); }
          rawText = text;
          this.draft.chars = text.length;
          if (Date.now() - parsedAt < 500) return;   // ponytail: 半截 JSON 每 0.5 秒最多解析一次
          parsedAt = Date.now();
          this.updateDraft(text, tx, agentKeys);
        };
        const onThinking = (thinkingText: string) => {
          if (!this.draft) return;
          this.draft.thinking = thinkingText;
        };
        const onTool = (tool: ToolCallView) => {
          if (!this.draft) return;
          this.draft.toolCalls ??= [];
          const exist = tool.id ? this.draft.toolCalls.find(t => t.id === tool.id) : null;
          if (exist) Object.assign(exist, tool);
          else this.draft.toolCalls.push(tool);
        };
        const beat = setInterval(() => {
          const dr = this.draft;
          const sec = Math.round((Date.now() - callStart) / 1000);
          if (dr?.chars) {
            log(`分析中 ${sec}s：已收到 ${dr.chars} 字，已出 ${dr.goals.length + dr.cards.length} 张卡`);
          } else if (dr?.toolCalls?.length && !dr.toolCalls.at(-1)?.result) {
            const cur = dr.toolCalls.at(-1)!;
            log(`分析中 ${sec}s：交叉验证中 · ${cur.name} ${typeof cur.args === 'string' ? cur.args : JSON.stringify(cur.args || '')}`);
          } else if (dr?.thinking) {
            log(`分析中 ${sec}s：思考推演中（已推演 ${dr.thinking.length} 字）` + (dr.toolCalls?.length ? `，已验证 ${dr.toolCalls.length} 次` : ''));
          } else {
            log(`分析中 ${sec}s：等待模型开始输出`);
          }
        }, 15000);
        try {
          raw = await runModel(prompt, {
            cli: CLI,
            model: MODEL || undefined,
            provider: PROVIDER || undefined,
            cwd: projectCwd,
            signal: this.controller.signal,
            onText,
            onThinking,
            onTool,
            onRetry: m => log(`模型输出中断，${CLI} 自动重试：${m}`),
          });
          break;
        }
        catch (e) { if (!/prompt is too long|context.{0,20}(length|window|limit)|too many tokens/i.test((e as Error).message) || this.budget < 20000 || this.removed) throw dumpRaw(e as Error); log(`prompt too long, budget ${this.budget} → ${Math.floor(this.budget * 0.6)}`); }
        finally { clearInterval(beat); }
      }
      try { map = normalizeMap(raw, { transcript: transcriptInfo.text, agentKeys }); }
      catch (e) { throw dumpRaw(e as Error); }
      if (this.removed) return;
      if (jevOn()) {
        const checkStart = Date.now(), n = await checkCards(citedEvidence(map.cards, transcriptInfo.text), this.controller.signal);
        const weak = map.cards.filter(c => c.support !== undefined && c.support < WEAK_AT).length;
        log(`快判核对证据：${n} 张已完成的卡，${weak} 张证据弱，用时 ${Date.now() - checkStart}ms`);
        if (this.removed) return;
      }
      coverage = transcriptInfo.coverage; size = `tx=${transcriptInfo.text.length}`;
    }
    // 卡片与连线没变就不换地图，状态说明仍要更新
    const mapKey = JSON.stringify([map.goals, map.cards, map.edges]);
    const settle = () => {
      // 签名保留读入时的值；分析期间追加的内容仍会触发下一拍，不伪造一次文件变化
      this.seen = new Map([[host.file, host.events.length], ...tree.children.filter(c => c.file).map((c): [string, number] => [c.file!, c.events.length])]);
      this.wake = this.filesSignature(inputs.map(c => c.file!)) !== inputSignature; this.skipped = 0; this.lastSlowAt = Date.now();
      this.filesSnap = inputSignature; this.lastError = null; this.failures = 0; this.retryAt = 0;
      // Jev 有几题没答上来（限流、超时）：会话不再变也要回头补问，退避 15 秒到 5 分钟
      if (jevFailed) { this.wake = true; this.retryAt = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(this.jevRetries++, 5)); } else this.jevRetries = 0;
    };
    if (ENGINE === 'jev' && this.syncN && mapKey === this.mapKey) {
      this.host = host; this.tree = tree; this.note = map.note;
      this.dataReadAt = newestRead ? new Date(newestRead).toISOString() : this.dataReadAt;
      settle(); this.saveSnapshot(coverage); this.maybeReview(); return log(`图没变（${size}，用时 ${Date.now() - started}ms）`);
    }
    this.mapKey = mapKey;
    // 失败前绝不修改任何可见状态或已消费签名。成功 tick 从 1 开始。
    const tick = this.syncN + 1;
    this.host = host; this.tree = tree;
    this.applyMap(map);
    this.syncN = tick;
    this.updatedAt = new Date().toISOString();
    this.dataReadAt = newestRead ? new Date(newestRead).toISOString() : this.updatedAt;
    settle();
    this.saveSnapshot(coverage);
    this.maybeReview();
    log(`sync#${this.syncN} ok cards=${this.cards.length} edges=${this.edges.length} ${size} 用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  /** 慢模型审图：第一版底稿出来就审一次；之后等 agent 停下来等用户、或攒了 10 张没审的卡再审，两次至少隔 --interval 秒。
   *  按目标分开审、只送没审过的卡，最多 3 个目标并行；审完一个并一个、重画一次，地图一块一块变好读。
   *  不进分析队列：审图要几十秒，不能挡着 Jev 几秒一版的重画 */
  maybeReview() {
    if (!this.rawMap || !this.view) return;
    const raw = this.rawMap, view = this.view, r = this.review, now = Date.now();
    const plan = planReview({ on: REVIEW, running: r.running, removed: this.removed, failures: r.failures, triedAt: r.tried,
      changedAt: this.changedAt, interval: INTERVAL, reviewed: !!this.overlay, waitingUser: this.pulse?.phase === 'waiting_user',
      pending: pending(raw, this.overlay) }, now);
    if (!plan) return;
    const { jobs, total } = plan;
    const started = now, log = (m: string) => console.log(`[${ts()}] [${short(this.sessionId || this.prefix)}] ${m}`);
    r.running = true; r.tried = started; r.error = null;
    const ctl = r.ctl = new AbortController(), gen = r.gen;
    let ok = 0;
    log(`慢模型审图：${jobs.length} 个目标、${total} 张没审过的卡，调用 ${CLI}${MODEL ? `（${MODEL}）` : ''}`);
    let next = 0;
    const worker = async () => {
      for (let job; (job = jobs[next++]);) {
        const [goalId, todo] = job, t0 = Date.now();
        try {
          const out = await runModel(buildReviewPrompt(raw, view, goalId, todo), { cli: CLI, model: MODEL || undefined, provider: PROVIDER || undefined, cwd: this.cwd || process.cwd(), signal: ctl.signal, system: REVIEW_SYSTEM, effort: 'low' });
          if (gen !== r.gen || ctl.signal.aborted || this.removed) return;
          const o = normalizeOverlay(out, raw, this.overlay, goalId, todo); ok++;
          this.overlay = mergeOverlay(this.overlay, o); r.at = new Date().toISOString(); this.save();
          log(`审完目标 ${goalId}（${todo.length} 张卡，${Math.round((Date.now() - t0) / 1000)}s）：改写 ${o.rewrite.length}，纠正 ${o.fix.length}，并卡 ${o.merge.length}，去掉 ${o.drop.length}，子目标 ${o.groups.length}，连线 +${o.addEdges.length} -${o.dropEdges.length}`);
          schedule(this, true);   // 分析忙时也要留下一个重画请求，不能丢掉刚审好的单子
        } catch (e) { if (ctl.signal.aborted) return; r.error = String((e as Error).message || e); if (!this.removed) console.error(`[${ts()}] [${short(this.sessionId || this.prefix)}] 目标 ${goalId} 审图失败（这部分照底稿显示）：${r.error}`); }
      }
    };
    Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker)).finally(() => { r.running = false; if (r.ctl === ctl) r.ctl = null; r.failures = ok || ctl.signal.aborted ? 0 : r.failures + 1; log(`审图结束，共 ${Math.round((Date.now() - started) / 1000)}s`); });
  }
  /** Jev 的答案和慢模型的修改单落盘：重启不重问、不重审。卡片 ID 取自原始记录行号，隔了重启照样对得上 */
  load() {
    if (ENGINE !== 'jev' || !this.sessionId) return;
    const d = readCache(cacheFile(this.sessionId));
    if (d) { this.jevCache = d.jev; this.overlay = d.overlay; this.review.at = d.reviewedAt; }
  }
  save() {
    if (ENGINE !== 'jev' || !this.sessionId) return;
    try {
      const text = encodeCache(this.jevCache, this.overlay, this.review.at);
      if (text === this.saved) return;
      writePrivate(cacheFile(this.sessionId), text);
      this.saved = text;
    } catch (e) { console.error(`缓存没写进去：${(e as Error).message}`); }
  }
  /** 半截输出能校验出目标才更新草稿：字段边写边变长，写到一半的 ID 先丢，其余不合规的部分按正式规则丢弃。
   *  卡片张数只增不减：一张卡要 id、type、title 都到了才算，之后不会再丢；张数相等时照样替换（内容变长了）。
   *  模型断流重来时文本从头开始、张数下降，追上旧草稿才替换，页面不倒退 */
  updateDraft(text: string, transcript: string, agentKeys: string[]) {
    const partial = parsePartialJson(text);
    if (!partial || !this.draft) return;
    dropHalfIds(partial);
    try {
      const m = normalizeMap(partial, { transcript, agentKeys });
      if (m.goals.length + m.cards.length < this.draft.goals.length + this.draft.cards.length) return;
      Object.assign(this.draft, { goals: m.goals, cards: m.cards, edges: m.edges, live: m.live });
    } catch {}
  }
  applyMap(map: MapResult) {
    this.goals = map.goals; this.cards = map.cards; this.edges = map.edges; this.note = map.note;
    // 模型这轮没写进展就沿用上一轮的
    if (map.live && (map.live.now || map.live.known)) this.live = map.live;
  }
  saveSnapshot(coverage: Coverage) {
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    this.current = {
      goals: clone(this.goals), cards: clone(this.cards), edges: clone(this.edges), live: clone(this.live), note: this.note,
      children: (this.tree?.children || []).map(c => ({ key: c.key, label: c.label, kind: c.kind, events: c.events.length, matched: c.matched })),
      updatedAt: this.updatedAt, dataReadAt: this.dataReadAt, coverage: clone(coverage),
      thinking: this.draft?.thinking, toolCalls: clone(this.draft?.toolCalls || []),
    };
  }
  dataView(): DataView {
    const saved = this.current || { goals: [], cards: [], edges: [], live: {}, children: [], note: '' };
    return { sessionId: this.sessionId, syncN: this.syncN,
      updatedAt: this.updatedAt, dataReadAt: this.dataReadAt, lastError: this.lastError,
      analyzing: this.analyzing, draft: this.analyzing ? this.draft : null, pulse: this.pulse, engine: ENGINE,
      review: { on: REVIEW, running: this.review.running, at: this.review.at, unreviewed: REVIEW ? this.review.unreviewed : 0, error: this.review.error }, ...saved };
  }
  listView(): SessionItem {
    return {
      sid: this.sessionId || this.prefix, short: short(this.sessionId || this.prefix),
      prefix: this.prefix, title: this.title || '', syncN: this.syncN, analyzing: this.analyzing,
      lastError: this.lastError, updatedAt: this.updatedAt,
      cards: this.cards.length, note: this.note,
      children: this.tree?.children?.length || 0, phase: this.pulse?.phase ?? null,
    };
  }
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
  o.sessionId = info.sessionId; o.file0 = info.file; o.load();
  try { o.title = parseSession(info.file).title || ''; } catch {} // 排队等分析时也能看到标题
  observers.set(prefix, o);
  if (!active) active = o;
  schedule(o);
  if (jevOn()) o.fastTick();   // 第一版地图要等一两分钟，快判先给出此刻状态
  return o;
}
function removeSession(prefix: string): boolean {
  const o = [...observers.values()].find(x => x.prefix === prefix || x.sessionId === prefix);
  if (!o) return false;
  observers.delete(o.prefix);
  o.removed = true;
  o.review.gen++; o.controller?.abort(); o.review.ctl?.abort(); o.pulseCtl?.abort();
  if (active === o) active = [...observers.values()][0] || null;
  return true;
}
function schedule(o: Observer | null, again = false): boolean {
  if (!o || o.removed) return false;
  if (o.analyzing) { if (again) o.rerun = true; return false; }
  o.analyzing = true; // 入队前占用，首次与手动同步走同一条路。
  if (busy) console.log(`[${ts()}] [${short(o.sessionId || o.prefix)}] 排队中：等其它会话分析完成`);
  queue = queue.then(async () => {
    if (o.removed) return;
    busy = true;
    await o.analyze();
  }).catch(e => {
    if (o.removed) return;
    o.lastError = String(e.message || e);
    o.wake = true;   // 首轮超时且快判也失败时，不能只能等文件再次变化才恢复
    o.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(o.failures++, 6));
    console.error(`[${ts()}] [${short(o.prefix)}] sync error:`, o.lastError);
  }).finally(() => {
    o.analyzing = false; o.controller = null; o.draft = null; busy = false;
    if (o.rerun) { o.rerun = false; schedule(o); }
  });
  return true;
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
// 只看主机名不看端口：SSH 端口转发时浏览器里的端口和服务端口不同
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const server = http.createServer(async (req, res) => {
  const json = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    let u: URL;
    try { u = new URL(req.url || '/', 'http://x'); } catch { return json(400, { error: 'invalid URL' }); }
    // 只认本机地址：DNS rebinding 时 Host 是攻击者域名，读写接口都拒绝
    if (u.pathname.startsWith('/api/') && !LOCAL_HOST.test(req.headers.host || '')) return json(403, { error: 'host not allowed' });
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
      return json(200, o.dataView());
    }
    if (u.pathname === '/api/resync' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (id !== undefined && !validId(id)) return json(400, { error: 'invalid id' });
      const o = id ? [...observers.values()].find(x => x.sessionId === id || x.prefix === id) : active;
      if (!o) return json(404, { error: 'no observer' });
      if (REVIEW) { o.review.gen++; o.review.ctl?.abort(); Object.assign(o.review, { at: null, tried: 0, failures: 0, error: null }); o.overlay = null; o.mapKey = ''; o.save(); }   // 手动同步：丢掉修改单，整张重审
      schedule(o, REVIEW); // 审图模式重画不能丢；CLI 模式重复点按仍合并。
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

// 启动时清一次旧缓存就够了：进程通常只跑几小时，不另起定时器
const swept = sweepCache();
if (swept) console.log(`清掉 ${swept} 个过期缓存文件`);

let tickTimer: ReturnType<typeof setInterval> | undefined;
function shutdown() {
  clearInterval(tickTimer);
  for (const o of observers.values()) removeSession(o.prefix);
  server.close(); server.closeAllConnections();
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`观察台: ${url}   sessions: ${ids.map(short).join(', ')}`);
  console.log(ENGINE === 'jev' ? `画图：Jev 几秒一版出底稿；${REVIEW ? `慢模型 ${CLI}${MODEL ? `（${MODEL}）` : ''} 审图：改写、纠错、重组` : '没有慢模型审图（没装模型 CLI 或加了 --no-review），卡片是原话'}` : `分析模型：${CLI}${MODEL ? `（${MODEL}）` : ''}${!ASKED_CLI && CLI !== CLI_CHOICES[0] ? `（本机找不到 ${CLI_CHOICES.slice(0, CLI_CHOICES.indexOf(CLI)).join('、')}，自动改用 ${CLI}）` : ''}`);
  console.log(jevOn() ? '快判：Jev 已开启，会话片段会发到 api.typesafe.ai（--no-jev 关闭）' : '快判：未开启（设置 JEV_API_KEY 或 TYPESAFE_API_KEY 后可用）');
  console.log(ids.length ? ENGINE === 'jev' ? '首次画图中，几秒就好…' : '首次分析中，每个 session 约 1-3 分钟，进度每 15 秒打印一次…' : '尚无会话；可在页面添加 session ID。');
  ids.forEach(id => { try { if (!validId(id)) throw new Error('invalid session id'); addSession(id); } catch (e) { console.error((e as Error).message); } });
  tickTimer = setInterval(() => {
    for (const o of observers.values()) {
      if (jevOn()) { o.fastTick(); continue; }
      if (o.analyzing || Date.now() < o.retryAt) continue;
      try { if (o.changedSinceLastSync()) schedule(o); }
      catch (e) { console.error(`[${short(o.sessionId || o.prefix)}] check error: ${(e as Error).message || e}`); }
    }
  }, jevOn() ? Math.min(INTERVAL, FAST_MS) : INTERVAL);
});
