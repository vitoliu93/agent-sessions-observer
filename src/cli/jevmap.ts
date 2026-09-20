// jevmap.ts — 地图由 Jev 画，不调慢模型。Jev 不会写字，所以：
//   · 卡片上的字全部从原文里摘（用户原话、agent 自己说的话、工具回包），不改写；
//   · 每个判断都出成选择题：这句话是不是新需求、这一步是改东西还是跑检查、成没成、哪一句最能说明结果；
//   · 连线按先后顺序用代码连，不让模型猜。
// 一步一请求、并发发出；判过的步骤按内容缓存，会话变长时只判新步骤。
import { createHash } from 'node:crypto';
import { choice, noul, type Questions } from '@typesafe-ai/sdk';
import type { Card, Edge, MapResult, State } from '../shared/types.ts';
import type { SegEvent } from './segment.ts';
import { fmtToolInput } from './segment.ts';
import { ask } from './jev.ts';

export interface Source { key: string; events: SegEvent[]; /** 子会话：主会话里派发它的那一行 */ dispatchLine?: number }
interface Step { key: string; line: number; ts: number; say: string; /** agent 没说话时当标题：工具调用自带的说明，或改了哪个文件 */ hint: string;
  tools: string[]; results: string[]; errors: number; last: boolean; /** 发出去还没回包的调用数 */ open: number; names: string[]; cmds: string[] }
interface Turn { line: number; ts: number; text: string; steps: Step[] }
type Answers = Record<string, any>;
/** 键是题目的位置（哪个回合、哪一步），值带材料指纹：步骤还在长时旧答案被顶掉，不越攒越多 */
export type JevCache = Map<string, { h: string; a: Answers }>;

const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s;
/** 超长的留头尾：选项里会有末尾的句子，材料里也得看得到 */
const headTail = (s: string, n: number) => s.length > n ? `${s.slice(0, n / 2)} … ${s.slice(-n / 2)}` : s;
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
/** 字数：一个汉字顶两个字母 */
const weight = (s: string) => [...s.replace(/[^\p{L}\p{N}]/gu, '')].reduce((n, ch) => n + (/\p{Script=Han}/u.test(ch) ? 2 : 1), 0);
/** 拆句：选择题的选项和卡片标题都从这里来。太长的消息留头 4 句、尾 4 句 */
export function sentences(text: string, max = 8): string[] {
  const all = text.split(/(?<=[。！？!?；;])|(?<=\.)\s+|\n+/).map(flat).filter(s => weight(s) >= 4);
  const pick = all.length > max ? [...all.slice(0, max / 2), ...all.slice(-max / 2)] : all;
  return pick.map(s => clip(s, 160));
}
/** 不用问 Jev 的：只看不改的工具 */
const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'ToolSearch', 'WebFetch', 'WebSearch', 'LS', 'TodoWrite', 'Skill', 'AskUserQuestion', 'TaskOutput', 'ListAgents']);
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const LOOK = /^(cd \S+ && )?(git (status|diff|log|show)|ls|cat|head|tail|rg|fd|wc|pwd|which|echo)\b[^|;&><$`]*$/;
const lookingCommand = (c: string) => LOOK.test(c) && !/(?:^|\s)(?:-[^-\s]*[xX]|--exec(?:-batch)?|--output|--ext-diff)(?:\b|=)/.test(c);
/** 只认命令位置；文件名、提交信息、heredoc 正文里的 test 不是检查。不确定就交 Jev。 */
export function checksCommand(command: string): boolean {
  const code = command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[\t ]*\2\b/g, '')
    .replace(/'(?:[^']*)'|"(?:\\.|[^"\\])*"/g, ' QUOTED ');
  return code.split(/&&|\|\||[;|\n]/).some(part => {
    const c = part.trim().replace(/^(?:\w+=\S+\s+)*/, '').replace(/^(?:timeout|gtimeout)\s+\d+(?:\.\d+)?[smhd]?\s+/, '');
    return /^(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint|build)|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|make\s+(?:test|check|lint)|(?:(?:bunx|npx|uv run|pnpm exec)\s+|python3?\s+-m\s+)?(?:tsc|eslint|pytest|vitest|jest|playwright))(?=\s|$)/.test(c);
  });
}

/** 用户真正说的话：斜杠命令取参数，CLI 元信息和系统注入不算 */
function userText(ev: SegEvent): string {
  if (ev.meta) return '';
  const t = ev.text.trim(), args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  if (args) return args;
  if (/^<(local-command|command-|system-reminder|task-notification)|^\[Request interrupted|^Caveat:|^Base directory for this skill|^\[Image:|^This session is being continued/.test(t)) return '';
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/** 主会话按用户发言切成回合；agent 每说一段话、或每一次「调用 → 回包」算一步。子会话的步骤按时间插进回合 */
export function buildTurns(host: Source, children: Source[] = []): Turn[] {
  const turns: Turn[] = [];
  const stepsOf = ({ key, events }: Source, onUser?: (ev: SegEvent, text: string) => void): Step[] => {
    const steps: Step[] = []; let cur: Step | null = null, lastTs = 0;
    for (const ev of events) {
      if (ev.side && key === 'host') continue;
      lastTs = (ev.ts && Date.parse(ev.ts)) || lastTs;
      for (const b of ev.blocks) if (b.t === 'result' && cur) { cur.open = Math.max(0, cur.open - 1); if (flat(b.out)) cur.results.push(clip(flat(b.out), 300)); if (b.isError) cur.errors++; }
      if (ev.type === 'user' && !ev.blocks.some(b => b.t === 'result')) { const text = userText(ev); if (text && onUser) { cur = null; onUser(ev, text); } continue; }
      if (ev.type !== 'assistant') continue;
      const say = flat(ev.text), calls = ev.blocks.flatMap(b => b.t === 'tool' ? [b] : []);
      // agent 开口说话、或上一步已经收到回包又发起新调用，都算新的一步
      if (say || !cur || (calls.length && cur.results.length)) { cur = { key, line: ev.line || 0, ts: lastTs, say, hint: '', tools: [], results: [], errors: 0, last: false, open: 0, names: [], cmds: [] }; steps.push(cur); }
      for (const b of calls) {
        cur.tools.push(`${b.name} ${fmtToolInput(b.name, b.input)}`); cur.names.push(b.name); cur.open++;
        if (b.name === 'Bash' || b.name === 'exec') cur.cmds.push(String(b.input?.command || b.input?.input || ''));
        if (!cur.hint) cur.hint = flat(String(b.input?.description || '')) || (WRITES.has(b.name) && b.input?.file_path ? `改 ${String(b.input.file_path).split('/').slice(-2).join('/')}` : '');
      }
    }
    return steps;
  };
  // 斜杠命令会把同一段话记两遍，连着重复的只算一次
  const hostSteps = stepsOf(host, (ev, text) => turns.at(-1)?.text !== text && turns.push({ line: ev.line || 0, ts: (ev.ts && Date.parse(ev.ts)) || 0, text, steps: [] }));
  if (!turns.length) return [];
  for (const s of hostSteps) (turns.findLast(t => t.line <= s.line) || turns[0]).steps.push(s);
  for (const t of turns) if (t.steps.length) t.steps.at(-1)!.last = true;   // 回合收尾那段话才可能是结论
  for (const c of children) for (const s of stepsOf(c)) {
    // 没有时间戳的子会话：当成紧跟在派发它的那一步后面
    const dispatched = turns.findLast(t => t.line <= (c.dispatchLine || 0)) || turns[0];
    const target = !s.ts || !turns.some(t => t.ts) ? dispatched : turns.findLast(t => t.ts <= s.ts) || turns[0];
    if (!s.ts) s.ts = (hostSteps.findLast(h => h.line <= (c.dispatchLine || 0))?.ts || 0) + 1;
    target.steps.push(s);
  }
  // 子会话的检查要排在主会话的结论前面，结论才连得上它；收尾那一步始终最后处理
  for (const t of turns) t.steps = t.steps.map((s, i) => ({ s, i })).sort((a, b) => +a.s.last - +b.s.last || (a.s.ts && b.s.ts ? a.s.ts - b.s.ts : 0) || a.i - b.i).map(x => x.s);
  return turns;
}

const hash = (x: unknown) => createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 16);
/** 选择题的答案必须是给出的选项之一；不是就当没答上来，也不进缓存 */
function legal(a: Answers, q: Questions): boolean {
  return Object.entries(q).every(([k, x]) => x.type === 'choice' ? Object.hasOwn(x.criteria as object, a[k]?.choice) : x.type === 'noul' ? Number.isFinite(a[k]?.noul) && a[k].noul >= 0 && a[k].noul <= 1 : true);
}
async function cached(cache: JevCache, tag: string, state: Record<string, any>, questions: Questions, signal?: AbortSignal): Promise<Answers | null> {
  const h = hash([state, questions]), hit = cache.get(tag);
  if (hit?.h === h && legal(hit.a, questions)) return hit.a;
  try { const a = await ask(state, questions, signal); if (!legal(a, questions)) return null; cache.set(tag, { h, a }); return a; } catch (e) { if (signal?.aborted || [401, 403].includes((e as { status: number }).status)) throw e; return null; }
}
/** 每轮最多排 8 个任务；请求总并发由 jev.ts 限制，不等于每分钟用量上限 */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  let stopped = false;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (!stopped && i < items.length) try { await fn(items[i++]); } catch (e) { stopped = true; throw e; } }));
}
const options = (ss: string[]) => Object.fromEntries(ss.map((s, i) => [`s${i}`, s]));

// 五个选项的唯一区别：要不要新开目标、旧的成果留不留
const RELATION = {
  new_goal: 'a new task unrelated to the earlier requests',
  follow_up: 'a new, different task that uses the finished result of an earlier request',
  redo: 'rejects how the earlier request was done and asks to do it again differently; the earlier work is thrown away',
  refine: 'adds a detail or an extra requirement to the request in progress; the earlier work stays',
  not_a_request: 'asks for no new work: an answer to the agent, an approval, thanks, chat, or telling the agent to continue',
} as const;
// 「撞上问题」是结果不是动作，由成没成那一题和报错回包决定，不放进这一题
const KIND = {
  explore: 'only read files, searched, planned, or thought; nothing was changed and nothing was checked',
  change: 'created, edited, or deleted files, installed something, or changed system state',
  verify: 'ran a test, build, type check, or another check and looked at the result',
  report: 'told the user a result, a conclusion, or a summary, or asked the user a question',
} as const;
const END = { done: 'it succeeded', failed: 'it failed or errored', doing: 'not finished, or the result is unknown' } as const;
type Kind = 'change' | 'verify' | 'report' | 'problem';
const ORDER: Kind[] = ['problem', 'change', 'verify', 'report'];

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

/** 能用规则定的不问 Jev：工具名和命令比语气可靠 */
function byRule(s: Step): { kinds?: Kind[]; /** 改和测都认出来了，不用再问 Jev 干了什么 */ sure?: boolean; explore?: true; end?: State } {
  const end: State | undefined = s.open > 0 ? 'doing' : s.results.length && s.errors === s.results.length ? 'failed' : undefined;
  const kinds: Kind[] = [];
  if (s.names.some(n => WRITES.has(n))) kinds.push('change');
  // heredoc 里的正文不算命令：往文件里写一段带 test( 的代码不是在跑测试
  if (s.cmds.some(checksCommand)) kinds.push('verify');
  if (kinds.length) return { kinds, end, sure: kinds.length === 2 };
  const looking = s.names.length > 0 && s.names.every(n => READ_ONLY.has(n) || ((n === 'Bash' || n === 'exec') && s.cmds.length > 0 && s.cmds.every(lookingCommand)));
  if (looking && (!s.say || !s.last)) return end === 'failed' ? { kinds: ['problem'], end, sure: true } : { explore: true };
  return { end };
}

export async function buildJevMap(host: Source, children: Source[], cache: JevCache, signal?: AbortSignal): Promise<MapResult & { asked: number; total: number; failed: number }> {
  const turns = buildTurns(host, children);
  if (!turns.length) throw new Error('bad map: no user request in session');
  let failed = 0, asked = 0;
  const askJev: typeof cached = async (c, tag, st, q, sig) => { const miss = c.get(tag)?.h; const a = await cached(c, tag, st, q, sig); if (a && c.get(tag)?.h !== miss) asked++; return a; };

  // 第一轮：每条用户发言和前面的需求是什么关系、哪几句是要求、哪一句最能当标题
  const turnAns = new Map<Turn, { relation: keyof typeof RELATION; reqs: string[]; title: string }>();
  await pool(turns, 8, async t => {
    const ss = sentences(t.text), i = turns.indexOf(t);
    const q: Questions = { relation: choice('How does the new user message relate to the earlier user messages?', RELATION) };
    if (ss.length > 1) q.title = choice('Which sentence best states what the user wants?', options(ss));
    ss.forEach((s, n) => { q[`req${n}`] = noul({ question: 'Is this sentence a concrete requirement or an acceptance condition for the work?', sentence: s }); });
    const a = await askJev(cache, `turn:${t.line}`, { earlier_user_messages: turns.slice(Math.max(0, i - 3), i).map(x => clip(flat(x.text), 500)), new_user_message: headTail(t.text, 3000) }, q, signal);
    if (!a) failed++;
    // 像路径、命令的行不算要求；一两个字的也不算
    const reqs = ss.filter((x, n) => (a?.[`req${n}`]?.noul ?? 0) >= 0.6 && !/^[\/~.$`]/.test(x) && weight(x) >= 6);
    // 「好的，继续」这类短话 Jev 爱判成接着做：很短、又摘不出要求的，不算需求
    const approval = /^(?:好的|好|继续|好的继续|嗯|ok|okay|yes|goahead|continue)$/i.test(t.text.replace(/[\s，。！!,.]/g, ''));
    const relation = a && approval && !reqs.length && a.relation.choice !== 'redo' ? 'not_a_request' : a?.relation?.choice ?? 'refine';
    turnAns.set(t, { relation, reqs, title: ss[+(a?.title?.choice ?? 's0').slice(1)] || clip(flat(t.text), 160) });
  });

  // 回合 → 目标和要求。第一条发言总是目标；「补充」挂到当前目标下，「不是需求」的发言不建卡，它后面的步骤仍算当前目标的
  const goals: Card[] = [], cards: Card[] = [], edges: Edge[] = [];
  const subsOf = new Map<Turn, Card[]>();
  let goal: Card | null = null, subs: Card[] = [];
  for (const t of turns) {
    const a = turnAns.get(t)!, rel = goal ? a.relation : 'new_goal', ev = `[host:${t.line}]`;
    if (rel !== 'not_a_request') {
      if (rel !== 'refine') {
        const prev: Card | null = goal;
        goal = { id: `G-${t.line}`, type: 'goal', title: a.title, sub: clip(flat(t.text), 300), st: 'doing', sig: [{ verb: '接到', agent: 'host' }], acc: a.reqs, ev, facts: [] };
        goals.push(goal); subs = [];
        if (prev && rel === 'follow_up') edges.push({ f: prev.id, t: goal.id, v: '接着' });
        if (prev && rel === 'redo') edges.push({ f: goal.id, t: prev.id, v: '推翻' });
      }
      // 要求卡：原话里的每句要求一张；只有一句或没摘出来，就整条发言一张
      const titles = a.reqs.length > 1 ? a.reqs : [rel === 'refine' ? a.title : '最初的要求'];
      const fresh = titles.map((title, n): Card => ({ id: `S-${t.line}-${n}`, type: 'subgoal', goalId: `S-${t.line}-${n}`, title, sub: clip(flat(t.text), 300), st: 'doing', sig: [{ verb: '接到', agent: 'host' }], ev, facts: [] }));
      for (const s of fresh) { cards.push(s); edges.push({ f: goal!.id, t: s.id, v: '拆成' }); }
      subs = rel === 'refine' ? [...subs, ...fresh] : fresh;
    }
    subsOf.set(t, subs);
  }

  // 第二轮：规则定不了的才问 Jev——这一步干了什么、成没成、为哪条要求；回合收尾的那一步再问哪句是结果、有没有留尾巴
  const stepAns = new Map<Step, { kinds: Kind[]; end: State; a: Answers }>();
  const jobs = turns.flatMap(t => t.steps.map(s => ({ t, s })));
  await pool(jobs, 8, async ({ t, s }) => {
    const rule = byRule(s), ofTurn = subsOf.get(t)!;
    if (rule.explore) return;                                           // 只看不改的步骤不成卡，不用问
    const ss = s.last ? sentences(s.say) : [], q: Questions = {};
    // 规则只认出一样时照样问：用 shell 改文件再跑检查的一步，规则只看得见检查
    if (!rule.sure || s.last) q.kind = choice('What did the coding agent do in this step?', KIND);
    if (!rule.end) q.end = choice('How did this step end?', END);
    if (ofTurn.length > 1) q.serves = choice('Which user requirement does this step serve?', Object.fromEntries(ofTurn.map(c => [c.id, c.title])));
    if (s.last) {
      // 「没做完」才降状态；「问用户要不要顺手再做点别的」是客气话，只出一张提示卡
      q.unfinished = noul('Does the agent say that part of the requested work is still not done or not verified?');
      q.asks_user = noul('Does the agent ask the user to decide or approve something before it can go on?');
    }
    if (ss.length > 1) { q.result = choice('Which sentence best states the result of the work?', options(ss)); q.rest = choice('Which sentence best states what is still open or needs the user?', options(ss)); }
    let a: Answers | null = {};
    if (Object.keys(q).length) a = await askJev(cache, `step:${s.key}:${s.line}`, { user_request: clip(flat(t.text), 600), agent_said: headTail(s.say, 1500), tool_calls: s.tools.slice(0, 10), tool_results: s.results.slice(-8) }, q, signal);
    if (!a) return void failed++;
    const asked: Kind[] = a.kind && a.kind.choice !== 'explore' ? [a.kind.choice] : [];
    const kinds = [...new Set([...(rule.kinds || []), ...asked])].sort((x, y) => ORDER.indexOf(x) - ORDER.indexOf(y));   // 先改、再测、最后才是结论
    stepAns.set(s, { kinds, end: rule.end ?? a.end?.choice ?? 'doing', a });
  });

  // 步骤 → 卡：同一回合里连着的同类步骤并成一张；连线按先后顺序。一步既改又测就出两张
  const LETTER = { change: 'C', verify: 'V', problem: 'R', report: 'K' } as const, TYPE = { change: 'change', verify: 'verify', problem: 'risk', report: 'concl' } as const;
  const VERB = { change: '实现', verify: '验证', problem: '遇到', report: '报告' } as const;
  for (const t of turns) {
    const ofTurn = subsOf.get(t)!, chat = turnAns.get(t)!.relation === 'not_a_request' && t !== turns[0];
    if (!ofTurn.length) continue;
    let open: { card: Card & { said?: boolean }; kind: Kind } | null = null, lastChange: Card | null = null, worked = false;
    const verifies: Card[] = [], risks: { card: Card; n: number }[] = [];
    let n = 0;
    for (const s of t.steps) for (const kind of stepAns.get(s)?.kinds || []) {
      const { end, a } = stepAns.get(s)!; n++;
      if (kind === 'report' && !s.last) continue;                     // 半路上的进度汇报不是结论
      if (kind === 'report' && chat && !worked) continue;             // 用户道谢、agent 回客套话：不是结论，不能把前面的失败翻成做完了
      const owner = ofTurn.find(c => c.id === a.serves?.choice) || ofTurn.at(-1)!;
      const ss = kind === 'problem' ? [] : sentences(s.say), first = ss[0] || clip(s.hint || s.tools[0] || '', 160) || '没有说明的一步';
      const st: State = kind === 'problem' ? 'risk' : s.errors && end !== 'done' ? 'failed' : end;
      const fact = [first, s.results.at(-1) && `回包：${clip(s.results.at(-1)!, 200)}`].filter(Boolean).join(' · ');
      if (kind !== 'report') worked = true;
      if (open && open.kind === kind && open.card.goalId === owner.id && open.card.sig[0].agent === s.key && kind !== 'report') {
        const c = open.card; c.facts!.push(fact); if (!c.said && ss[0]) { c.title = ss[0]; c.said = true; } c.st = st; c.ev += ` [${s.key}:${s.line}]`; c.sub = clip(s.results.at(-1) || c.sub, 200);
        continue;
      }
      const title = kind === 'report' ? ss[+(a.result?.choice ?? 's0').slice(1)] || first : first;
      const card: Card = { id: `${LETTER[kind]}-${safe(s.key)}-${s.line}`, type: TYPE[kind], goalId: owner.id, title, sub: clip(kind === 'report' ? s.say : s.results.at(-1) || s.tools[0] || '', 200), st, sig: [{ verb: VERB[kind], agent: s.key }], facts: [fact], ev: `[${s.key}:${s.line}]` };
      cards.push(card); open = { card: Object.assign(card, { said: !!ss[0] }), kind };
      const anchor = (lastChange?.goalId === owner.id ? lastChange : owner).id;
      if (kind === 'change') { edges.push({ f: owner.id, t: card.id, v: '采用' }); lastChange = card; }
      if (kind === 'verify') { edges.push({ f: anchor, t: card.id, v: '检查' }); verifies.push(card); (card as any).n = n; }
      if (kind === 'problem') { edges.push({ f: card.id, t: anchor, v: '妨碍' }); risks.push({ card, n }); }
      if (kind === 'report') {
        for (const v of verifies) edges.push({ f: v.id, t: card.id, v: '支持' });
        // 撞过的问题：之后有检查通过，才算解决了；最后一次检查之后才冒出来的不算
        const pass = verifies.findLast(v => v.st === 'done');
        if (pass) for (const r of risks) if (r.n < (pass as any).n) { r.card.st = 'resolved'; edges.push({ f: pass.id, t: r.card.id, v: '解决' }); }
        const unfinished = (a.unfinished?.noul ?? 0) >= 0.5, asks = (a.asks_user?.noul ?? 0) >= 0.5;
        if (unfinished || asks) {
          const rest = ss[+(a.rest?.choice ?? `s${ss.length - 1}`).slice(1)] || first;
          cards.push({ id: `P-${safe(s.key)}-${s.line}`, type: 'gap', goalId: owner.id, title: rest, sub: '', st: 'risk', sig: [{ verb: '报告', agent: s.key }],
            facts: [unfinished ? `把握 ${Math.round(a.unfinished.noul * 100)}%：agent 收尾时说还有没做完或没验证的部分` : `把握 ${Math.round(a.asks_user.noul * 100)}%：agent 在等你拿主意`], ev: `[${s.key}:${s.line}]` });
          edges.push({ f: card.id, t: `P-${safe(s.key)}-${s.line}`, v: '留下缺口' });
          if (unfinished && card.st === 'done') card.st = 'partial';
        }
        for (const c of ofTurn) c.st = card.st === 'done' ? 'done' : card.st === 'failed' ? 'failed' : 'partial';
      }
    }
  }
  for (const c of cards) delete (c as any).n;
  // 目标状态跟着它最后一条要求走
  for (const g of goals) { const mine = cards.filter(c => c.type === 'subgoal' && edges.some(e => e.f === g.id && e.t === c.id)); g.st = mine.at(-1)?.st ?? 'doing'; }

  const lastStep = turns.at(-1)!.steps.at(-1), gaps = cards.filter(c => c.type === 'gap'), concl = cards.filter(c => c.type === 'concl' && c.st === 'done');
  return { goals, cards, edges, asked, total: turns.length + jobs.length, failed,
    live: { now: clip(lastStep?.say || lastStep?.tools.at(-1) || turns.at(-1)!.text, 200), known: concl.at(-1)?.title || '', next: gaps.at(-1)?.title || '' },
    note: [`快判地图：${turns.length} 条用户发言、${jobs.length} 步，卡片文字摘自原文，没有改写`, failed && `${failed} 处 Jev 没答上来，稍后重问`].filter(Boolean).join('；') };
}
