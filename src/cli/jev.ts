// jev.ts — 快判（System 1）：Jev 只做选择题。慢模型画地图，Jev 负责三件事：
//   1. pulse   会话此刻在干什么、卡没卡住（几百毫秒，不等地图）
//   2. 把关     新事件会不会改变地图 → 决定要不要叫醒慢模型
//   3. 核对     已完成的卡，引用的原文撑不撑得住它的说法
// Jev 以英文训练为主，题目一律写英文；材料（state）保持原文。没有 key 时整个模块不工作，产品照旧。
import { TypeSafeClient, choice, noul, type Questions } from '@typesafe-ai/sdk';
import type { Card, Pulse } from '../shared/types.ts';

const KEY = process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY || '';
let client: TypeSafeClient | null = null;
let off = false;
export const jevOn = () => (!!KEY || !!client) && !off;
export const disableJev = () => { off = true; };
/** 测试用：换掉网络层 */
export function setJevClient(c: Pick<TypeSafeClient, 'systemOne'> | null) { client = c as TypeSafeClient | null; off = false; authError = null; }
const jev = () => client ??= new TypeSafeClient({ apiKey: KEY, timeout: 8000, retry: { maxRetries: 3 }, logLevel: 'off' });

let active = 0, authError: Error | null = null;
const waiting: (() => void)[] = [];
/** 画图、快判、证据核对共用 8 个位置，不能每个调用方各自开一池。排队和重试合计最多 40 秒。 */
export async function ask(state: Record<string, any>, questions: Questions, signal?: AbortSignal): Promise<Record<string, any>> {
  const bound = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(40000)]);
  while (active >= 8) await new Promise<void>((resolve, reject) => {
    bound.throwIfAborted();
    const done = () => { bound.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => { const i = waiting.indexOf(done); if (i >= 0) waiting.splice(i, 1); reject(bound.reason); };
    waiting.push(done); bound.addEventListener('abort', cancel, { once: true });
  });
  active++;
  try { bound.throwIfAborted(); if (authError) throw authError; return (await jev().systemOne({ state, questions }, { signal: bound })).answers; }
  catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) {
      authError = Object.assign(new Error('Jev 密钥无效或无权限：请检查 JEV_API_KEY / TYPESAFE_API_KEY，改好后重启；也可用 --no-jev'), { status });
      throw authError;
    }
    throw e;
  } finally { active--; waiting.shift()?.(); }
}

/** 新事件最多送这么多字；超过说明攒了很多，直接叫醒慢模型 */
export const DELTA_MAX = 12000;
/** 「会改变地图」的概率到这个数就叫醒慢模型。宁可多跑一次，不能漏掉用户的新需求 */
export const WAKE_AT = 0.3;

const PHASES = {
  exploring: 'reading code or docs, searching, planning',
  editing: 'writing or changing files',
  verifying: 'running tests, builds, or checks',
  waiting_user: 'finished its turn, asked the user a question, or waits for user input or approval',
  stuck: 'repeating failed attempts or blocked by errors',
} as const;

/** delta：上次慢同步之后的新事件（压缩文本）。只看尾部，最近的事最能说明此刻 */
export async function pulse(delta: string, signal?: AbortSignal): Promise<Omit<Pulse, 'skipped' | 'woke'>> {
  const started = Date.now();
  const a = await ask({ new_events_of_a_coding_agent_session: delta.slice(-DELTA_MAX) }, {
      phase: choice('What is the coding agent doing at the end of this log?', PHASES),
      stuck: noul('Is the agent stuck: repeated failures or errors with no progress?'),
      changed: noul('Do these new events change a map of the user\'s requirements and their progress?', {
        true: 'a new user request or correction, a finished code change, a test or check result, a new failure, or a conclusion',
        false: 'only reading, searching, thinking, or unfinished work in progress',
      }),
    }, signal);
  if (!a.phase || !Object.hasOwn(PHASES, a.phase.choice) || [a.phase.confidence, a.stuck?.noul, a.changed?.noul].some(x => !Number.isFinite(x) || x < 0 || x > 1)) throw new Error('Jev 此刻状态答案不合法');
  return { at: new Date().toISOString(), phase: a.phase.choice, confidence: a.phase.confidence, stuck: a.stuck.noul, changed: a.changed.noul, ms: Date.now() - started };
}

/** 引用行和紧跟它的工具回包行 */
export function evidenceOf(ev: string, lines: string[]): string {
  const refs = ev.match(/\[[^\]\n]+:\d+\]/g) || [], out: string[] = [];
  for (const ref of refs) for (let i = lines.findIndex(l => l.includes(ref)); i >= 0 && i < lines.length; i++) {
    if (out.length && !lines[i].includes(ref) && !/^\s*↳/.test(lines[i])) break;
    if (!out.includes(lines[i])) out.push(lines[i]);
    if (out.length > 12) break;
  }
  return out.join('\n').slice(0, 6000);
}

/** 慢模型画的图：说「做完了」的修改、验证、结论卡，拿它引用的原文当证据 */
export function citedEvidence(cards: Card[], transcript: string): { c: Card; evidence: string }[] {
  const lines = transcript.split('\n');
  return cards.filter(c => ['change', 'verify', 'concl'].includes(c.type) && ['done', 'resolved'].includes(c.st))
    .map(c => ({ c, evidence: evidenceOf(c.ev || '', lines) })).filter(x => x.evidence);
}

/** 逐张核对：证据撑不撑得住卡上的说法。一卡一请求，材料越短 Jev 越准；失败的卡不写分数。
 *  memo：同一份说法和证据不重问。分数只留一位小数：Jev 同一题两次能差 0.01，不能让这点抖动算成「图变了」 */
export async function checkCards(todo: { c: Card; evidence: string }[], signal?: AbortSignal, memo: Map<string, number> = new Map()): Promise<number> {
  await Promise.all(todo.map(async ({ c, evidence }) => {
    const claim = [c.title, ...(c.facts || [])].filter(Boolean).join('\n').slice(0, 3000), ev = evidence.slice(0, 6000), key = claim + '\u0000' + ev;
    if (memo.has(key)) return void (c.support = memo.get(key));
    try {
      const answers = await ask({ claim, evidence_from_session_log: ev }, { supported: noul('Does the evidence show that the claim really happened with the stated result?', {
          true: 'the log lines show the action or result the claim describes',
          false: 'the log lines are unrelated, only show an intention or plan, or contradict the claim',
        }) }, signal);
      const value = answers.supported?.noul;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return;
      c.support = Math.round(value * 10) / 10;
      if (memo.size >= 2000) memo.delete(memo.keys().next().value!);
      memo.set(key, c.support);
    } catch {}
  }));
  return todo.filter(x => x.c.support !== undefined).length;
}
