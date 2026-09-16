// summarize.mjs — LLM 压缩：事件流 → 六类卡片 schema（经 claude -p，零依赖）
import { spawn } from 'node:child_process';

export const ANALYZER_PROMPT_HEAD = '你是「需求解决地图」分析器。';
export const SCHEMA_DOC = `${ANALYZER_PROMPT_HEAD}输入是一个 coding agent（Claude Code）会话树的压缩事件流（主会话 + 子会话）。
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
拆成(goal→subgoal) · 采用(subgoal→change) · 妨碍(risk→change/subgoal) · 解决(group/change→risk) · 检查(subgoal/change→verify) · 支持(verify→concl) · 留下缺口(concl→gap)
没有明确因果依据的边不要连；时间相邻不构成因果。

## 署名（sig）
每张卡 sig: [{verb, agent}]。verb 用 提出/实现/执行/验证/报告/拆解/定义/依据 等中文动词。
agent 是会话中实际出现的角色，用短名 kebab-case（如 host、reviewer、programmer、task-b1、sentinel）。
规则：代理不是地点而是署名；主 agent 转述别人的判断不能改成自己署名；机制动作（派发/挂哨兵/收束/等待）不建卡，只体现为对应验证卡上的一行「报告·sentinel」署名。

## 状态（st）
doing（进行中）| done（已证实/完成）| failed（失败，记录保留）| partial（部分证实）| risk（待确认）| resolved（已解决）

## 分区（zone）
除 goal 外每张卡给 zone：它服务的子目标的短语（如「耗时达标」「判定一致」）。subgoal 卡自身也是分区头。

## 硬规则
1. 卡是「意图+结果」的回合，不是 tool call；同一工作反复讨论仍是一张卡
2. 未知就建 gap 或写进 facts 标注未知，绝不编造；失败记录不删除
3. 群发机制不画：不出现「派发」「等待」「收到消息」类卡片
4. 结论不能只写「完成」：写证明了什么、样本范围是什么、还缺什么
5. 30% 之类的完成度、倒计时、健康分一律不要

## 输出格式
严格输出一个 JSON 对象（无 markdown 围栏、无解释文字）：
{
  "goal": {"id":"GOAL","title":"","sub":"","acc":["…"],"sig":[{"verb":"","agent":""}]},
  "cards": [{"id":"S1","type":"subgoal","zone":"…","title":"","sub":"","sig":[{"verb":"","agent":""}],"st":"doing","facts":["…"],"ev":"来源文件/行号或产物","steps":[{"title":"","who":"","st":""}]}],
  "edges": [{"f":"GOAL","t":"S1","v":"拆成"}],
  "live": {"now":"","known":"","nextK":"下一项验证","next":""},
  "note": "一句话：地图覆盖度与不确定处"
}
cards 里不含 goal；edge 的 f/t 引用 GOAL 或 cards 里的 id；zone 与 subgoal 的 title 对应。`;

export function buildPrompt(transcript, prevCards, incrementalNote) {
  const prev = prevCards
    ? `\n## 上一版地图（增量更新时保持卡 id 稳定：同一工作更新原卡，不要换 id 重建；新事实出现才加卡；状态按证据推进）\n${JSON.stringify(prevCards).slice(0, 40000)}\n`
    : '';
  const note = incrementalNote ? `\n## 本次新增事件说明\n${incrementalNote}\n` : '';
  return `${SCHEMA_DOC}\n${prev}${note}\n## 会话压缩事件流（共 ${transcript.length} 字符）\n\n${transcript}\n\n现在输出 JSON。`;
}

/** 调无头 LLM CLI，返回解析后的 JSON 对象。
 *  cli: 'claude'（默认）| 'pi' | 'codex'——prompt 一律走 stdin，规避大参数限制 */
export function runClaude(prompt, { cli = 'claude', model, provider, timeoutMs = 600000, cwd = '/tmp' } = {}) {
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
      if (model) args.push('--model', model);
    }
    const p = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    p.stdin.write(prompt); p.stdin.end();
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${cli} timeout`)); }, timeoutMs);
    p.stdout.on('data', d => { out += d; if (out.length > 8e6) p.kill('SIGKILL'); });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !out.trim()) return reject(new Error(`${cli} exit ${code}: ${err.slice(-400)}`));
      try { resolve(JSON.parse(out)); }
      catch {
        const a = out.indexOf('{'), b = out.lastIndexOf('}');
        if (a >= 0 && b > a) { try { resolve(JSON.parse(out.slice(a, b + 1))); } catch (e) { reject(e); } }
        else reject(new Error('no JSON in claude output: ' + out.slice(0, 200)));
      }
    });
    p.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

/** 规范化 LLM 输出：补 id、过滤非法边、goal 单卡 */
export function normalizeMap(map) {
  if (!map || !map.cards) throw new Error('bad map: missing cards');
  const cards = map.cards.filter(c => c && c.id && c.title);
  cards.forEach((c, i) => { if (!Array.isArray(c.sig)) c.sig = []; if (!Array.isArray(c.facts)) c.facts = []; });
  const ids = new Set(['GOAL', ...cards.map(c => c.id)]);
  const edges = (map.edges || []).filter(e => e && e.f && e.t && ids.has(e.f) && ids.has(e.t) && e.f !== e.t);
  const goal = map.goal || { id: 'GOAL', title: map.note || '会话目标', sub: '', acc: [], sig: [] };
  return { goal, cards, edges, live: map.live || {}, note: map.note || '' };
}
