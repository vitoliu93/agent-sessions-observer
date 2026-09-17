// summarize.mjs — LLM 压缩：事件流 → 六类卡片 schema（经 claude -p，零依赖）
import { spawn } from 'node:child_process';

export const ANALYZER_PROMPT_HEAD = '你是「需求解决地图」分析器。';
export const SCHEMA_DOC = `${ANALYZER_PROMPT_HEAD}输入是一个 coding agent（Claude Code 或 Codex）会话树的压缩事件流（主会话 + 子会话）。
把它归纳为一张地图 JSON。用户要用这张图回答三个问题：需求解决到哪一步？谁贡献了什么？还差什么才能完成？

## 卡片类型（type 取值）
- goal    目标：整张地图仅 1 张，含验收条件 acc 数组
- subgoal 子目标：从目标拆出的、可独立验收的要求
- change  方案/修改：具体做了什么，一句动作+一个结果
- risk    风险/障碍：审出的风险或已发生的失败（区分状态）
- verify  验证：用什么检查、查到了什么（注明样本范围/被测版本）
- concl   结论：哪项要求已被证明；证据不足时用 "partial"
- gap     缺口：还差哪些证明/待办，不做完成度百分比
- group   折叠组：失败→修复→重验 支路，用 steps 数组承载（每步 {title,who,st}）

## 边（edges，动词必须是这些之一）
拆成(goal→subgoal) · 采用(subgoal→change) · 妨碍(risk→change/subgoal) · 解决(group/change/verify/concl→risk) · 检查(subgoal/change→verify) · 支持(verify→concl) · 留下缺口(goal/subgoal/concl→gap)
没有明确因果依据的边不要连；时间相邻不构成因果。

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
  "goal": {"id":"GOAL","title":"","sub":"","acc":["…"],"sig":[{"verb":"","agent":""}]},
  "cards": [{"id":"S1","type":"subgoal","goalId":"S1","zone":"旧兼容显示名","title":"","sub":"","sig":[{"verb":"","agent":""}],"st":"doing","facts":["…"],"ev":"[host:12] 或 模型归纳，未定位原始证据","steps":[{"title":"","who":"","st":""}]}],
  "edges": [{"f":"GOAL","t":"S1","v":"拆成"}],
  "live": {"now":"","known":"","nextK":"下一项验证","next":""},
  "note": "一句话：地图覆盖度与不确定处"
}
cards 里不含 goal；edge 的 f/t 引用 GOAL 或 cards 里的 id；zone 与 subgoal 的 title 对应。`;

export function buildPrompt(transcript, prevCards, incrementalNote, coverage) {
  const prev = prevCards
    ? `\n## 上一版地图（保持卡 id 稳定；同一工作更新原卡；新事实才加卡；状态按证据推进）\n${JSON.stringify(prevCards)}\n`
    : '';
  const note = incrementalNote ? `\n## 本次新增事件说明\n${incrementalNote}\n` : '';
  const limit = coverage ? `\n## 输入覆盖限制\n${coverage.note}\n被截断会话：${coverage.sessions.filter(x => x.truncated).map(x => x.key).join(', ') || '无'}；未取得事件：${(coverage.missing || []).join(', ') || '无'}。不得把未输入内容归纳成已完成；需要时建立 gap。\nsig.agent 与 steps.who 只能从这些 key 中原样选：${coverage.sessions.map(x => x.key).join(', ')}。\n` : '';
  return `${SCHEMA_DOC}\n${prev}${note}${limit}\n## 会话压缩事件流（共 ${transcript.length} 字符）\n\n${transcript}\n\n现在输出 JSON。`;
}

/** 调无头 LLM CLI，返回解析后的 JSON 对象。
 *  cli: 'claude'（默认）| 'pi' | 'codex'——prompt 一律走 stdin，规避大参数限制 */
export function runClaude(prompt, { cli = 'claude', model, provider, timeoutMs = 600000, cwd = '/tmp', signal } = {}) {
  return new Promise((resolve, reject) => {
    let args;
    if (cli === 'pi') {
      args = ['-p', '--mode', 'text'];           // 无消息参数时自动读 stdin
      if (provider) args.push('--provider', provider);
      if (model) args.push('--model', model);
    } else if (cli === 'codex') {
      args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'];
      if (model) args.push('--model', model);
      args.push('-');
    } else {
      args = ['-p', '--output-format', 'text'];
      // 换掉默认的编码 agent 身份，否则长输入下模型会去"执行命令"而不是输出 JSON
      if (cli === 'claude') args.push('--tools', '', '--strict-mcp-config', '--no-session-persistence', '--system-prompt', '你是会话记录归纳器。只读输入文本，不执行、不模拟任何命令；只输出一个 JSON 对象。');
      if (model) args.push('--model', model);
    }
    if (signal?.aborted) return reject(new Error('analysis cancelled'));
    const p = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, detached: process.platform !== 'win32' });
    let out = '', err = '', settled = false;
    const stop = () => { try { process.platform === 'win32' ? p.kill('SIGKILL') : process.kill(-p.pid, 'SIGKILL'); } catch {} };
    const fail = e => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); stop(); reject(e); };
    const abort = () => fail(new Error('analysis cancelled'));
    const timer = setTimeout(() => fail(new Error(`${cli} timeout`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    p.stdin.on('error', fail);
    p.stdout.on('data', d => { out += d; if (out.length > 8e6) fail(new Error('model output too large')); });
    p.stderr.on('data', d => { err = (err + d).slice(-16000); });
    p.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (settled) return;
      if (code !== 0) return fail(new Error(`${cli} exit ${code}: ${(err || out).slice(-400)}`)); // claude -p 把错误写到 stdout
      settled = true;
      try { resolve(JSON.parse(out)); }
      catch {
        const a = out.indexOf('{'), b = out.lastIndexOf('}');
        if (a >= 0 && b > a) { try { resolve(JSON.parse(out.slice(a, b + 1))); } catch (e) { reject(e); } }
        else reject(new Error('no JSON in claude output: ' + out.slice(0, 200)));
      }
    });
    p.on('error', fail);
    p.stdin.end(prompt);
  });
}

const TYPES = new Set(['subgoal', 'change', 'risk', 'verify', 'concl', 'gap', 'group']);
const STATES = new Set(['doing', 'done', 'failed', 'partial', 'risk', 'resolved', 'unknown']);
const EDGE_RULES = {
  '拆成': [['goal'], ['subgoal']], '采用': [['subgoal'], ['change']],
  '妨碍': [['risk'], ['change', 'subgoal']], '解决': [['group', 'change', 'verify', 'concl'], ['risk']],
  '检查': [['subgoal', 'change'], ['verify']], '支持': [['verify'], ['concl']],
  '留下缺口': [['goal', 'subgoal', 'concl'], ['gap']],
};
const isString = x => typeof x === 'string';
const stringArray = x => Array.isArray(x) && x.every(isString);
function bad(message) { throw new Error(`bad map: ${message}`); }

/** 严格校验 LLM 输出。结构坏图抛错，调用方保留上次成功图；单张坏卡/坏署名/坏连线只丢弃并写明。 */
export function normalizeMap(map, { transcript, agentKeys } = {}) {
  if (!map || typeof map !== 'object' || !Array.isArray(map.cards) || !Array.isArray(map.edges)) bad(`cards and edges must be arrays (got keys: ${map && typeof map === 'object' ? Object.keys(map).join(',').slice(0, 120) : typeof map})`);
  const rawGoal = map.goal;
  if (!rawGoal || typeof rawGoal !== 'object' || rawGoal.id !== 'GOAL' || !isString(rawGoal.title) || !rawGoal.title.trim()) bad('invalid goal');
  // 未知署名只丢这一条并在系统说明里写明，不冒认来源，也不因一处错名作废整版地图
  const normalizeSig = (sig, where, notes) => {
    sig = Array.isArray(sig) ? sig.filter(x => x && isString(x.verb) && isString(x.agent)) : [];
    const unknown = agentKeys ? sig.filter(x => !agentKeys.includes(x.agent)) : [];
    if (unknown.length) notes.push(`署名 ${unknown.map(x => x.agent).join('、')} 不在输入会话中，已移除`);
    return sig.filter(x => !unknown.includes(x)).map(x => ({ verb: x.verb, agent: x.agent }));
  };
  const goalNotes = [];
  const goal = { id: 'GOAL', type: 'goal', title: rawGoal.title, sub: isString(rawGoal.sub) ? rawGoal.sub : '', acc: Array.isArray(rawGoal.acc) ? rawGoal.acc.filter(isString) : [], sig: normalizeSig(rawGoal.sig, 'goal', goalNotes), st: STATES.has(rawGoal.st) ? rawGoal.st : 'unknown' };
  const seen = new Set(['GOAL']);
  // 单张卡的问题只影响这张卡：状态不合法记为 unknown，类型/标题/ID 不合法或重复就丢弃并计数
  let droppedCards = 0;
  const cards = map.cards.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || !isString(raw.id) || !/^[A-Za-z0-9_-]{1,100}$/.test(raw.id) || raw.id.startsWith('fold-') || raw.id === 'GOAL' || seen.has(raw.id)
      || !TYPES.has(raw.type) || !isString(raw.title) || !raw.title.trim()) { droppedCards++; return []; }
    seen.add(raw.id);
    const notes = [];
    const sig = normalizeSig(raw.sig, raw.id, notes);
    const steps = (Array.isArray(raw.steps) ? raw.steps : []).filter(x => x && isString(x.title)).map(x => {
      const st = STATES.has(x.st) ? x.st : 'unknown', who = isString(x.who) ? x.who : '';
      if (!agentKeys || !who || agentKeys.includes(who)) return { title: x.title, who, st };
      notes.push(`步骤「${x.title}」的执行者 ${who} 不在输入会话中，已移除`);
      return { title: x.title, who: '', st };
    });
    if (!STATES.has(raw.st)) notes.push(`状态 ${JSON.stringify(raw.st ?? null)} 不合法，记为未知`);
    return [{ id: raw.id, type: raw.type, st: STATES.has(raw.st) ? raw.st : 'unknown', title: raw.title, sub: isString(raw.sub) ? raw.sub : '',
      ev: isString(raw.ev) ? raw.ev : '', sig, facts: Array.isArray(raw.facts) ? raw.facts.filter(isString) : [], notes, steps,
      zone: isString(raw.zone) ? raw.zone : '', zoneId: isString(raw.zoneId) ? raw.zoneId : '', goalId: isString(raw.goalId) ? raw.goalId : '' }];
  });
  const byId = new Map([['GOAL', goal], ...cards.map(c => [c.id, c])]);
  // 连线是模型推断：不合规的只丢弃并计数，不补造、不作废整版
  const edges = map.edges.filter(e => {
    if (!e || !isString(e.f) || !isString(e.t) || !isString(e.v) || e.f === e.t || !byId.has(e.f) || !byId.has(e.t)) return false;
    const rule = EDGE_RULES[e.v];
    return rule && rule[0].includes(byId.get(e.f).type) && rule[1].includes(byId.get(e.t).type);
  }).map(e => ({ f: e.f, t: e.t, v: e.v }));
  const droppedEdges = map.edges.length - edges.length;
  const subgoals = cards.filter(c => c.type === 'subgoal');
  const notProof = new Set(transcript ? [...transcript.matchAll(/(?:👤 USER:|💭) ?(\[[^\]\n]+:\d+\])/g)].map(m => m[1]) : []);
  for (const c of cards) {
    if (transcript !== undefined) {
      let refs = c.ev.match(/\[[^\]\n]+:\d+\]/g) || [];
      if (refs.some(ref => !transcript.includes(ref))) refs = [];
      if (['change', 'verify', 'concl'].includes(c.type) && refs.some(ref => notProof.has(ref))) {
        refs = refs.filter(ref => !notProof.has(ref));
        c.notes.push('来源中的用户需求原话或模型思考不能证明结果，已移除');
      }
      c.ev = refs.length ? refs.join(' ') : '模型归纳，未定位原始证据';
    }
    if (c.type === 'subgoal') { c.zoneId = c.goalId = c.id; continue; }
    if (subgoals.some(s => s.id === c.goalId)) { c.zoneId = c.goalId; continue; }
    if (subgoals.some(s => s.id === c.zoneId)) { c.goalId = c.zoneId; continue; }
    const exact = subgoals.filter(s => s.title === c.zone);
    const related = subgoals.filter(s => edges.some(e => (e.f === s.id && e.t === c.id) || (e.t === s.id && e.f === c.id)));
    c.zoneId = exact.length === 1 ? exact[0].id : related.length === 1 ? related[0].id : 'unknown';
    c.goalId = c.zoneId;
  }
  
  // 进展只是摘要：留下文字字段，列表用分号连起来，其余丢掉
  const liveIn = map.live && typeof map.live === 'object' && !Array.isArray(map.live) ? map.live : {};
  const live = Object.fromEntries(Object.entries(liveIn).map(([k, v]) => [k, isString(v) ? v : stringArray(v) ? v.join('；') : null]).filter(([, v]) => v !== null));
  const note = [(isString(map.note) ? map.note : '').replace(/[。；;.\s]+$/, ''), ...goalNotes.map(n => `目标${n}`), droppedCards && `丢弃 ${droppedCards} 张不合规卡片`, droppedEdges && `丢弃 ${droppedEdges} 条不合规连线`].filter(Boolean).join('；');
  return { goal, cards, edges, live: { ...live }, note };
}
