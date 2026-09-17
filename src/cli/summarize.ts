// summarize.ts — LLM 压缩：事件流 → 地图卡片 schema（经本机模型 CLI，零依赖）
import { spawn } from 'node:child_process';
import { Allow, parse as parsePartial } from 'partial-json';
import type { Card, CardType, Coverage, Edge, Live, MapResult, Sig, State, Step, Verb } from '../shared/types.ts';

export const ANALYZER_PROMPT_HEAD = '你是「需求解决地图」分析器。';
export const SCHEMA_DOC = `${ANALYZER_PROMPT_HEAD}输入是一个 coding agent（Claude Code 或 Codex）会话树的压缩事件流（主会话 + 子会话）。
把它归纳为一张地图 JSON。用户要用这张图回答三个问题：需求解决到哪一步？谁贡献了什么？还差什么才能完成？
一个会话里用户常常先后提出多项需求：做完一项接着做下一项、另开无关任务、或觉得做得不对推倒重来。地图是有向无环图，不是只有一个目标的树。

## 卡片类型（type 取值）
- goal    目标：用户提出的一项需求，含验收条件 acc 数组。用户每提一项新需求（后续任务、无关新任务、推倒重来）就建一张新目标卡，按提出顺序排；用户的新需求不能记成 gap
- subgoal 子目标：从目标拆出的、可独立验收的要求
- change  方案/修改：具体做了什么，一句动作+一个结果
- risk    风险/障碍：审出的风险或已发生的失败（区分状态）
- verify  验证：用什么检查、查到了什么（注明样本范围/被测版本）
- concl   结论：哪项要求已被证明；证据不足时用 "partial"
- gap     缺口：已提出的目标还差哪些证明/待办，不做完成度百分比
- group   折叠组：失败→修复→重验 支路，用 steps 数组承载（每步 {title,who,st}）

## 边（edges，动词必须是这些之一）
拆成(goal→subgoal) · 接着(goal→goal：旧目标做完后在其基础上继续，旧→新) · 推翻(goal→goal：新目标否定旧目标的做法重来，新→旧) · 采用(subgoal→change) · 妨碍(risk→change/subgoal) · 解决(group/change/verify/concl→risk) · 检查(subgoal/change→verify) · 支持(verify→concl) · 留下缺口(goal/subgoal/concl→gap)
change / risk / verify / gap 卡都要有一条从子目标或上游卡连过来的边，比如子目标直接做的验证写 检查(subgoal→verify)。
与已有目标无关的新任务不连目标边。没有明确因果依据的边不要连；时间相邻不构成因果。

## 署名（sig）
每张卡 sig: [{verb, agent}]。verb 用 提出/实现/执行/验证/报告/拆解/定义/依据 等中文动词。
agent 必须使用输入各会话标题中的完整 key（主会话为 host）。同角色的两个子会话不能合成 reviewer/programmer；缺身份则 sig 留空，并在 facts 说明未知。
规则：代理不是地点而是署名；主 agent 转述别人的判断不能改成自己署名；机制动作（派发/挂哨兵/收束/等待）不建卡，只体现为对应验证卡上的一行「报告·sentinel」署名。

## 状态（st）
doing（进行中）| done（已证实/完成）| failed（失败，记录保留）| partial（部分证实）| risk（待确认）| resolved（已解决）

## 分区（zone）
除 goal 外每张卡给 goalId：它服务的子目标卡 ID。subgoal 卡自身 goalId 等于自身 ID。兼容字段 zone 只可写该子目标的精确 title，不能按词相似猜测。

## 硬规则
1. 卡是「意图+结果」的回合，不是 tool call；同一工作反复讨论仍是一张卡
2. 未知就建 gap 或写进 facts 标注未知，绝不编造；失败记录不删除
3. 群发机制不画：不出现「派发」「等待」「收到消息」类卡片
4. 结论不能只写「完成」：写证明了什么、样本范围是什么、还缺什么
5. 30% 之类的完成度、倒计时、健康分一律不要
6. ev 只能原样引用输入中的 [会话key:行号]（如 [host:27]），可写多个；无法定位时必须写「模型归纳，未定位原始证据」，不得编造路径、行号或测试结果。

## 输出格式
严格输出一个 JSON 对象（无 markdown 围栏、无解释文字）：
{
  "goals": [{"id":"G1","title":"","sub":"","acc":["…"],"st":"doing","sig":[{"verb":"","agent":""}],"ev":"[host:3]"}],
  "cards": [{"id":"S1","type":"subgoal","goalId":"S1","zone":"旧兼容显示名","title":"","sub":"","sig":[{"verb":"","agent":""}],"st":"doing","facts":["…"],"ev":"[host:12] 或 模型归纳，未定位原始证据","steps":[{"title":"","who":"","st":""}]}],
  "edges": [{"f":"G1","t":"S1","v":"拆成"}],
  "live": {"now":"","known":"","nextK":"下一项验证","next":""},
  "note": "一句话：地图覆盖度与不确定处"
}
先写 goals，再写 cards，最后写 edges（界面按这个顺序边收边显示）。cards 里不含 goal；edge 的 f/t 引用 goals 或 cards 里的 id；zone 与 subgoal 的 title 对应。`;

export function buildPrompt(transcript: string, prevCards: { goals: Card[]; cards: Card[]; edges: Edge[] } | null, incrementalNote: string | null, coverage?: Coverage): string {
  const prev = prevCards
    ? `\n## 上一版地图（保持卡 id 稳定；同一工作更新原卡；新事实才加卡；状态按证据推进）\n${JSON.stringify(prevCards)}\n`
    : '';
  const note = incrementalNote ? `\n## 本次新增事件说明\n${incrementalNote}\n` : '';
  const limit = coverage ? `\n## 输入覆盖限制\n${coverage.note}\n被截断会话：${coverage.sessions.filter(x => x.truncated).map(x => x.key).join(', ') || '无'}；未取得事件：${(coverage.missing || []).join(', ') || '无'}。不得把未输入内容归纳成已完成；需要时建立 gap。\nsig.agent 与 steps.who 只能从这些 key 中原样选：${coverage.sessions.map(x => x.key).join(', ')}。\n` : '';
  return `${SCHEMA_DOC}\n${prev}${note}${limit}\n## 会话压缩事件流（共 ${transcript.length} 字符）\n\n${transcript}\n\n现在输出 JSON。`;
}

export interface RunOptions { cli?: string; model?: string; provider?: string; timeoutMs?: number; cwd?: string; signal?: AbortSignal; onText?: (text: string) => void; onRetry?: (message: string) => void }

const SYSTEM = '你是会话记录归纳器。只读输入文本，不执行、不模拟任何命令；只输出一个 JSON 对象。';

/** 模型正文 → JSON：先整体解析，不行取首个 { 到末个 } */
export function parseModelJson(out: string): unknown {
  try { return JSON.parse(out); } catch {}
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in model output: ' + out.slice(0, 200));
  return JSON.parse(out.slice(a, b + 1));
}

/** 模型还在输出时取已写到的部分：字段边写边出，写到一半的键、转义先不算；写完后面跟了围栏或解释文字时按完整输出解析 */
export function parsePartialJson(text: string): any {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try { return parsePartial(text.slice(start), Allow.ALL); }
  catch { try { return parseModelJson(text); } catch { return null; } }
}

/** 写到一半会认错人的键：ID、类型、边的端点和动词、署名和执行者。半截标题只是短一点，半截 ID 会撞上别的卡 */
const ID_KEYS = new Set(['id', 'type', 'goalId', 'f', 't', 'v', 'agent', 'who']);
/**
 * 草稿防护：JS 对象保持源文本键序，所以「最后一个键 → 数组最后一个元素 → 它的最后一个键……」就是模型正在写的位置。
 * 这条路径上最里面一个对象的最后一个键若是 ID 类，整个对象先丢掉（在数组里就弹出，在父对象里就删键），下一轮写完再出现。只用于草稿。
 */
export function dropHalfIds(root: any): void {
  const path: { node: any; key: string | number }[] = [];
  for (let node = root; node && typeof node === 'object';) {
    const keys = Object.keys(node);
    if (!keys.length) break;
    const key = Array.isArray(node) ? node.length - 1 : keys[keys.length - 1];
    path.push({ node, key }); node = node[key];
  }
  for (let i = path.length - 1; i >= 0; i--) {
    const { node, key } = path[i];
    if (Array.isArray(node) || !ID_KEYS.has(String(key))) continue;
    const owner = path[i - 1];
    if (owner && Array.isArray(owner.node)) owner.node.pop(); else if (owner) delete owner.node[owner.key];
    return;
  }
}

/** 调无头模型 CLI：边输出边回调已收到的正文，结束后返回解析好的 JSON。prompt 不走命令行参数，规避长度限制。
 *  codex 走 app-server 协议（exec 不给增量）；claude 走 stream-json；pi 走 json 事件；其它可执行文件读 stdin、stdout 即正文。 */
export function runModel(prompt: string, { cli = 'codex', model, provider, timeoutMs = 600000, cwd = '/tmp', signal, onText, onRetry }: RunOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let args: string[];
    if (cli === 'codex') args = ['app-server'];
    else if (cli === 'claude') {
      // 换掉默认的编码 agent 身份，否则长输入下模型会去"执行命令"而不是输出 JSON
      args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', SYSTEM];
      if (model) args.push('--model', model);
    } else if (cli === 'pi') {
      args = ['-p', '--mode', 'json'];           // 无消息参数时自动读 stdin
      if (provider) args.push('--provider', provider);
      if (model) args.push('--model', model);
    } else {
      args = ['-p', '--output-format', 'text'];
      if (model) args.push('--model', model);
    }
    if (signal?.aborted) return reject(new Error('analysis cancelled'));
    const p = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, detached: process.platform !== 'win32' });
    let text = '', err = '', buf = '', junk = '', failure = '', settled = false;
    const stop = () => { try { process.platform === 'win32' ? p.kill('SIGKILL') : process.kill(-p.pid!, 'SIGKILL'); } catch {} };
    const finish = () => { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); stop(); };
    const fail = (e: Error) => { if (settled) return; finish(); reject(e); };
    const done = () => { if (settled) return; finish(); try { resolve(parseModelJson(text)); } catch (e) { reject(e); } };
    const abort = () => fail(new Error('analysis cancelled'));
    const timer = setTimeout(() => fail(new Error(`${cli} timeout`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const emit = (t: string) => { text = t; if (text.length > 8e6) return fail(new Error('model output too large')); onText?.(text); };
    const send = (msg: object) => p.stdin.write(JSON.stringify(msg) + '\n');

    const codexItems = new Map<string, string>();
    function onCodex(m: any) {
      const params = m.params || {};
      if (m.id !== undefined && m.error) return fail(new Error(`codex ${m.error.message || JSON.stringify(m.error)}`));
      if (m.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'thread/start', params: { model: model || null, cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, developerInstructions: SYSTEM } });
      } else if (m.id === 2) {
        send({ id: 3, method: 'turn/start', params: { threadId: m.result.thread.id, input: [{ type: 'text', text: prompt, text_elements: [] }] } });
      } else if (m.method === 'item/agentMessage/delta') {
        codexItems.set(params.itemId, (codexItems.get(params.itemId) || '') + params.delta);
        emit(codexItems.get(params.itemId)!);
      } else if (m.method === 'item/completed' && params.item?.type === 'agentMessage') {
        emit(params.item.text);                   // 完整正文为准
      } else if (m.method === 'error') {
        if (params.willRetry) onRetry?.(params.error?.message || 'unknown error');   // 断流重连，正文会从头再来
        else failure = params.error?.message || 'unknown error';
      } else if (m.method === 'turn/completed') {
        const turn = params.turn || {};
        if (turn.status === 'completed') done();
        else fail(new Error(`codex turn ${turn.status}: ${turn.error?.message || failure}`));
      } else if (m.id !== undefined && m.method) {
        send({ id: m.id, error: { code: -32601, message: 'not supported' } }); // 只读归纳，不接受审批等请求
      }
    }
    function onClaude(m: any) {
      const ev = m.event || {};
      if (m.type === 'stream_event' && ev.type === 'message_start') text = '';
      else if (m.type === 'stream_event' && ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit(text + ev.delta.text);
      else if (m.type === 'result') { if (m.is_error) failure = String(m.result || m.subtype || 'error'); else if (typeof m.result === 'string') emit(m.result); }
    }
    function onPi(m: any) {
      if (m.message?.role !== 'assistant' && m.type !== 'message_update') return;
      if (m.type === 'message_start') text = '';
      else if (m.type === 'message_update' && m.assistantMessageEvent?.type === 'text_delta') emit(text + m.assistantMessageEvent.delta);
      else if (m.type === 'message_end') {
        if (m.message.errorMessage) failure = m.message.errorMessage;
        else emit((m.message.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join(''));
      }
    }
    const onLine = cli === 'codex' ? onCodex : cli === 'claude' ? onClaude : cli === 'pi' ? onPi : null;

    p.stdin.on('error', fail);
    p.stdout.on('data', d => {
      if (!onLine) return emit(text + d);
      buf += d;
      if (buf.length > 8e6) return fail(new Error('model output too large'));
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { junk ||= line.slice(0, 400); continue; }  // 非 JSON 行只用于报错说明
        onLine(m);
      }
    });
    p.stderr.on('data', d => { err = (err + d).slice(-16000); });
    p.on('close', code => {
      if (settled) return;
      if (code !== 0 || failure || cli === 'codex') return fail(new Error(`${cli} exit ${code}: ${(failure || err || junk || text).slice(-400)}`)); // claude -p 把错误写到 stdout
      done();
    });
    p.on('error', (e: NodeJS.ErrnoException) => fail(e.code === 'ENOENT' ? new Error(`找不到命令 ${cli}：请先安装，或用 --cli 换成已安装的 codex / claude / pi`) : e));
    if (cli === 'codex') send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-sessions-obs', title: null, version: '0' }, capabilities: null } });
    else p.stdin.end(prompt);
  });
}

const TYPES = new Set<string>(['goal', 'subgoal', 'change', 'risk', 'verify', 'concl', 'gap', 'group']);
const STATES = new Set<string>(['doing', 'done', 'failed', 'partial', 'risk', 'resolved', 'unknown']);
const EDGE_RULES: Record<string, [string[], string[]]> = {
  '拆成': [['goal'], ['subgoal']], '接着': [['goal'], ['goal']], '推翻': [['goal'], ['goal']], '采用': [['subgoal'], ['change']],
  '妨碍': [['risk'], ['change', 'subgoal']], '解决': [['group', 'change', 'verify', 'concl'], ['risk']],
  '检查': [['subgoal', 'change'], ['verify']], '支持': [['verify'], ['concl']],
  '留下缺口': [['goal', 'subgoal', 'concl'], ['gap']],
};
const isString = (x: unknown): x is string => typeof x === 'string';
const stringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every(isString);
const toState = (x: unknown): State => STATES.has(x as string) ? x as State : 'unknown';
function bad(message: string): never { throw new Error(`bad map: ${message}`); }

type NormalizedCard = Card & Required<Pick<Card, 'ev' | 'facts' | 'notes' | 'steps' | 'goalId'>>;

/** 严格校验 LLM 输出。结构坏图抛错，调用方保留上次成功图；单张坏卡/坏署名/坏连线只丢弃并写明。 */
export function normalizeMap(map: any, { transcript, agentKeys }: { transcript?: string; agentKeys?: string[] } = {}): MapResult & { cards: NormalizedCard[] } {
  if (!map || typeof map !== 'object' || !Array.isArray(map.cards) || !Array.isArray(map.edges)) bad(`cards and edges must be arrays (got keys: ${map && typeof map === 'object' ? Object.keys(map).join(',').slice(0, 120) : typeof map})`);
  // 目标可以有多个；兼容旧格式的单个 goal 对象
  const rawGoals: any[] = (Array.isArray(map.goals) ? map.goals : map.goal ? [map.goal] : []).map((g: any) => g && typeof g === 'object' ? { ...g, type: 'goal' } : g);
  // 未知署名只丢这一条并在系统说明里写明，不冒认来源，也不因一处错名作废整版地图
  const normalizeSig = (sig: unknown, notes: string[]): Sig[] => {
    const list: Sig[] = Array.isArray(sig) ? sig.filter(x => x && isString(x.verb) && isString(x.agent)) : [];
    const unknown = agentKeys ? list.filter(x => !agentKeys.includes(x.agent)) : [];
    if (unknown.length) notes.push(`署名 ${unknown.map(x => x.agent).join('、')} 不在输入会话中，已移除`);
    return list.filter(x => !unknown.includes(x)).map(x => ({ verb: x.verb, agent: x.agent }));
  };
  const seen = new Set<string>();
  const hints = new Map<string, { zone: string; zoneId: string }>();   // 模型的旧兼容归属字段，只用于折算 goalId
  // 单张卡的问题只影响这张卡：状态不合法记为 unknown，类型/标题/ID 不合法或重复就丢弃并计数
  let droppedCards = 0;
  const all: NormalizedCard[] = [...rawGoals, ...map.cards].flatMap((raw: any): NormalizedCard[] => {
    if (!raw || typeof raw !== 'object' || !isString(raw.id) || !/^[A-Za-z0-9_-]{1,100}$/.test(raw.id) || /^(fold-|__)/.test(raw.id) || seen.has(raw.id)
      || !TYPES.has(raw.type) || !isString(raw.title) || !raw.title.trim()) { droppedCards++; return []; }
    seen.add(raw.id);
    hints.set(raw.id, { zone: isString(raw.zone) ? raw.zone : '', zoneId: isString(raw.zoneId) ? raw.zoneId : '' });
    const notes: string[] = [];
    const sig = normalizeSig(raw.sig, notes);
    const steps: Step[] = (Array.isArray(raw.steps) ? raw.steps : []).filter((x: any) => x && isString(x.title)).map((x: any) => {
      const st = toState(x.st), who = isString(x.who) ? x.who : '';
      if (!agentKeys || !who || agentKeys.includes(who)) return { title: x.title, who, st };
      notes.push(`步骤「${x.title}」的执行者 ${who} 不在输入会话中，已移除`);
      return { title: x.title, who: '', st };
    });
    if (!STATES.has(raw.st) && raw.type !== 'goal') notes.push(`状态 ${JSON.stringify(raw.st ?? null)} 不合法，记为未知`);
    return [{ id: raw.id, type: raw.type as CardType, st: toState(raw.st), title: raw.title, sub: isString(raw.sub) ? raw.sub : '',
      ev: isString(raw.ev) ? raw.ev : '', sig, facts: Array.isArray(raw.facts) ? raw.facts.filter(isString) : [], notes, steps,
      goalId: isString(raw.goalId) ? raw.goalId : '',
      ...(raw.type === 'goal' ? { acc: Array.isArray(raw.acc) ? raw.acc.filter(isString) : [] } : {}) }];
  });
  const goals = all.filter(c => c.type === 'goal'), cards = all.filter(c => c.type !== 'goal');
  if (!goals.length) bad('no valid goal');
  const byId = new Map<string, Card>(all.map((c): [string, Card] => [c.id, c]));
  // 连线是模型推断：不合规或重复的只丢弃并计数，不补造、不作废整版
  const seenEdge = new Set<string>();
  const edges: Edge[] = map.edges.filter((e: any) => {
    if (!e || !isString(e.f) || !isString(e.t) || !isString(e.v) || e.f === e.t || !byId.has(e.f) || !byId.has(e.t)) return false;
    const rule = EDGE_RULES[e.v], key = `${e.f}>${e.t}>${e.v}`;
    if (!rule || !rule[0].includes(byId.get(e.f)!.type) || !rule[1].includes(byId.get(e.t)!.type) || seenEdge.has(key)) return false;
    seenEdge.add(key);
    return true;
  }).map((e: any) => ({ f: e.f, t: e.t, v: e.v as Verb }));
  const droppedEdges = map.edges.length - edges.length;
  const subgoals = cards.filter(c => c.type === 'subgoal');
  const notProof = new Set(transcript ? [...transcript.matchAll(/(?:👤 USER:|💭) ?(\[[^\]\n]+:\d+\])/g)].map(m => m[1]) : []);
  for (const c of all) {
    if (transcript !== undefined) {
      let refs: string[] = c.ev.match(/\[[^\]\n]+:\d+\]/g) || [];
      const missing = refs.filter(ref => !transcript.includes(ref));
      if (missing.length) { refs = refs.filter(ref => !missing.includes(ref)); c.notes.push(`来源 ${missing.join('、')} 不在输入会话中，已移除`); }
      if (['change', 'verify', 'concl'].includes(c.type) && refs.some(ref => notProof.has(ref))) {
        refs = refs.filter(ref => !notProof.has(ref));
        c.notes.push('来源中的用户需求原话或模型思考不能证明结果，已移除');
      }
      c.ev = refs.length ? refs.join(' ') : '模型归纳，未定位原始证据';
    }
    if (c.type === 'goal') continue;
    if (c.type === 'subgoal') { c.goalId = c.id; continue; }
    const hint = hints.get(c.id)!;
    if (subgoals.some(s => s.id === c.goalId)) continue;
    if (subgoals.some(s => s.id === hint.zoneId)) { c.goalId = hint.zoneId; continue; }
    const exact = subgoals.filter(s => s.title === hint.zone);
    const related = subgoals.filter(s => edges.some(e => (e.f === s.id && e.t === c.id) || (e.t === s.id && e.f === c.id)));
    c.goalId = exact.length === 1 ? exact[0].id : related.length === 1 ? related[0].id : 'unknown';
  }

  // 进展只是摘要：留下文字字段，列表用分号连起来，其余丢掉
  const liveIn = map.live && typeof map.live === 'object' && !Array.isArray(map.live) ? map.live : {};
  const live: Live = Object.fromEntries(Object.entries(liveIn).map(([k, v]) => [k, isString(v) ? v : stringArray(v) ? v.join('；') : null]).filter(([, v]) => v !== null));
  const note = [(isString(map.note) ? map.note : '').replace(/[。；;.\s]+$/, ''), droppedCards && `丢弃 ${droppedCards} 张不合规卡片`, droppedEdges && `丢弃 ${droppedEdges} 条不合规连线`].filter(Boolean).join('；');
  return { goals, cards, edges, live: { ...live }, note };
}
