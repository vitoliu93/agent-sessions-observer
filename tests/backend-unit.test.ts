import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeMap } from '../src/cli/summarize.ts';
import { firstUserInfo } from '../src/cli/parse.ts';
import { buildTranscriptDetailed } from '../src/cli/segment.ts';
import { buildTree } from '../src/cli/tree.ts';

const good = (): any => ({
  goal: { id: 'GOAL', title: '目标', sub: '', acc: [], sig: [] },
  cards: [
    { id: 'S1', type: 'subgoal', zoneId: 'S1', title: '子目标', sub: '', sig: [], st: 'doing', facts: [], ev: '', steps: [] },
    { id: 'C1', type: 'change', zone: '子目标', title: '修改', sub: '', sig: [], st: 'doing', facts: [], ev: '', steps: [] },
  ], edges: [{ f: 'GOAL', t: 'S1', v: '拆成' }, { f: 'S1', t: 'C1', v: '采用' }], live: {}, note: '',
});

test('结构坏图拒绝；坏卡、重复 ID、坏连线只丢弃并计数，坏状态记为未知', () => {
  for (const mutate of [(x: any) => { delete x.goal; }, (x: any) => { x.cards = {}; }]) { const x = good(); mutate(x); assert.throws(() => normalizeMap(x), /bad map/); }
  const z = good(); z.cards.push({ ...z.cards[0] }, { ...z.cards[1], id: 'X1', type: 'made-up' }); z.cards[1].st = 'wat'; z.cards[1].facts = 'oops';
  const zm = normalizeMap(z);
  assert.deepEqual(zm.cards.map(c => c.id), ['S1', 'C1']); assert.match(zm.note, /丢弃 2 张/);
  assert.equal(zm.cards[1].st, 'unknown'); assert.deepEqual(zm.cards[1].facts, []); assert.match(zm.cards[1].notes[0], /不合法/);
  const y = good(); y.edges.push({ f: 'S1', t: 'C1', v: '乱连' }, { f: 'GOAL', t: 'C1', v: '拆成' }, { f: 'S1', t: 'NOPE', v: '采用' });
  const kept = normalizeMap(y);
  assert.equal(kept.edges.length, 2); assert.match(kept.note, /丢弃 3 条/);
  const map = normalizeMap(good());
  assert.equal(map.goals[0].st, 'unknown');
  assert.equal(map.cards[1].zoneId, 'S1');
});

test('重复连线只留一条并计数；前端保留 ID 不给卡片用；来源引用只移除找不到的那条', () => {
  const x = good(); x.edges.push({ f: 'S1', t: 'C1', v: '采用' }); x.cards.push({ ...x.cards[1], id: '__LIVE__' }, { ...x.cards[1], id: '__unassigned__' });
  x.cards[1].ev = '[host:2] [host:99]';
  const m = normalizeMap(x, { transcript: '💬 [host:2] 已跑完' });
  assert.deepEqual(m.edges.map(e => `${e.f}>${e.t}>${e.v}`), ['GOAL>S1>拆成', 'S1>C1>采用']);
  assert.deepEqual(m.cards.map(c => c.id), ['S1', 'C1']);
  assert.match(m.note, /丢弃 2 张.*丢弃 1 条/);
  assert.equal(m.cards[1].ev, '[host:2]'); assert.match(m.cards[1].notes.at(-1)!, /来源 \[host:99\] 不在输入会话中，已移除/);
});

test('firstUserInfo 不越过 maxLines', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'observe-')), 'a.jsonl');
  fs.writeFileSync(f, `${Array.from({ length: 400 }, () => JSON.stringify({ type: 'assistant', message: { content: 'x' } })).join('\n')}\n${JSON.stringify({ type: 'user', message: { content: 'USER_ON_401' } })}\n`);
  assert.equal(firstUserInfo(f, 400), null);
});

test('预算保留每个 agent 身份、用户需求头尾与截断说明', () => {
  const events: any[] = [{ type: 'user', ts: '2026-01-01T00:00:00Z', text: `HEAD ${'x'.repeat(1300)} TAIL_ACCEPTANCE`, blocks: [] }];
  const children = ['a', 'b', 'c'].map(key => ({ key, kind: 'agent', label: key, sessionId: key, matched: 'prompt-head', events }));
  const out = buildTranscriptDetailed({ sessionId: 'host', events }, children, 900);
  assert.match(out.text, /TAIL_ACCEPTANCE/);
  for (const key of ['a', 'b', 'c']) assert.match(out.text, new RegExp(`子会话 ${key}`));
  assert.equal(out.coverage.truncated, true);
});

test('子会话仅接收同项目、派发后、首部唯一命中的候选；歧义明确报告', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-tree-'));
  const prompt = 'prompt-head must be at the front and this is enough';
  const make = (name: string, first: string) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:01:00Z', message: { content: first } }) + '\n'); return f; };
  const late = make('late.jsonl', `${'x'.repeat(400)} ${prompt}`), one = make('one.jsonl', prompt);
  const host: any = { file: 'host', project: 'p', sessionId: 'host', events: [{ side: false, line: 1, ts: '2026-01-01T00:00:00Z', blocks: [{ t: 'tool', name: 'Bash', input: { command: `herdr agent prompt alpha '${prompt}'` } }], text: '' }] };
  const tree = buildTree(host, { index: [{ file: late, project: 'p', sessionId: 'late', mtime: Date.now(), birthtime: Date.now() }, { file: one, project: 'p', sessionId: 'one', mtime: Date.now(), birthtime: Date.now() }], cursorDbs: [] });
  assert.equal(tree.children[0].sessionId, 'one');
  const two = make('two.jsonl', prompt);
  const ambiguous = buildTree(host, { index: [{ file: one, project: 'p', sessionId: 'one', mtime: Date.now() }, { file: two, project: 'p', sessionId: 'two', mtime: Date.now() }], cursorDbs: [] });
  assert.equal(ambiguous.children[0].matched, 'ambiguous');
});

test('预算回收短会话剩余额度，真实子代理 sidechain 不丢弃', () => {
  const events: any[] = Array.from({ length: 30 }, (_, i) => ({ type: 'user', text: `REQ_${i} ${'x'.repeat(900)} TAIL`, blocks: [], ts: '2026-01-01T00:00:00Z' }));
  const children: any[] = Array.from({ length: 12 }, (_, i) => ({ key: `missing-${i}`, kind: 'agent', label: '未知', events: [] }));
  children.push({ key: 'native', kind: 'agent', label: '原生', events: [{ ...events[0], side: true, text: 'SIDECHAIN_CONTRIBUTION' }] });
  const out = buildTranscriptDetailed({ sessionId: 'host', events }, children, 12000);
  assert.equal(out.text.length, 12000);
  assert.match(out.text, /SIDECHAIN_CONTRIBUTION/);
  assert.match(out.text, /REQ_29/);
  assert.equal(out.coverage.missing.length, 12);
});

test('首次消息跨 UTF-8 读块且末尾无换行仍可完整读取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-unicode-'));
  try {
    const file = path.join(dir, 'u.jsonl');
    const text = 'a'.repeat(1024 * 1024 - 42) + '中文验收';
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: text } }));
    assert.equal(firstUserInfo(file)?.text, text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('显式派发 cwd 接受子项目；无关项目、旧会话及跨客户端歧义不冒认', async () => {
  const { matchCursorDispatch } = await import('../src/cli/cursor.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-cwd-'));
  try {
    const prompt = 'a sufficiently unique dispatch prompt at the beginning';
    const file = path.join(dir, 'child.jsonl'), cursor = path.join(dir, 'cursor.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:30Z', message: { content: prompt } }) + '\n');
    const host: any = { file: 'host', project: '-workspace', sessionId: 'host', events: [{ side: false, line: 1, cwd: '/workspace', ts: '2026-01-01T00:00:00Z', text: '', blocks: [{ t: 'tool', name: 'Bash', input: { command: `cd /workspace/child && herdr agent prompt alpha '${prompt}'` } }] }] };
    const entry = { file, project: '-workspace-child', sessionId: 'child' };
    assert.equal(buildTree(host, { index: [entry], cursorDbs: [] }).children[0].sessionId, 'child');
    assert.equal(buildTree(host, { index: [{ ...entry, project: '-unrelated' }], cursorDbs: [] }).children[0].matched, 'no-file');
    const cursorEntry = { db: cursor, sid: 'cursor', project: 'workspace-child', mtime: Date.now() };
    const write = (ts: string) => fs.writeFileSync(cursor, JSON.stringify({ role: 'user', message: { content: `<timestamp>${ts}</timestamp><user_query>${prompt}</user_query>` } }) + '\n');
    write('2026-01-01T00:00:20Z');
    assert.equal(buildTree(host, { index: [entry], cursorDbs: [{ ...cursorEntry }] }).children[0].matched, 'ambiguous');
    write('2025-12-01T00:00:00Z');
    assert.equal(matchCursorDispatch({ prompt, ts: host.events[0].ts, project: '/workspace/child' }, [{ ...cursorEntry }]), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('原生 tool_result agentId 精确定位，不依赖长 prompt 或非 sidechain 事件', async () => {
  const { parseSession } = await import('../src/cli/parse.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-native-'));
  try {
    fs.mkdirSync(path.join(dir, 'host/subagents'), { recursive: true });
    const file = path.join(dir, 'host.jsonl');
    fs.writeFileSync(file, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { prompt: '短任务' } }] } },
      { type: 'user', toolUseResult: { agentId: 'native123' }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'DONE' }] } },
    ].map(x => JSON.stringify(x)).join('\n'));
    fs.writeFileSync(path.join(dir, 'host/subagents/agent-native123.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: 'NATIVE_RESULT' } }));
    const tree = buildTree({ file, sessionId: 'host', project: 'p', ...parseSession(file) }, { index: [], cursorDbs: [] });
    assert.equal(tree.children[0].matched, 'exact-agent-id');
    assert.equal(tree.children[0].events[0].text, 'NATIVE_RESULT');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('署名只能来自输入身份，伪造来源降为未定位；空标题、错误类型不蒙混通过', () => {
  const x = good(); x.cards[0].sig = [{ verb: '验证', agent: 'invented' }];
  x.cards[0].sig.push({ verb: '实现', agent: 'host' });
  const kept = normalizeMap(x, { agentKeys: ['host'] }).cards[0];
  assert.deepEqual(kept.sig, [{ verb: '实现', agent: 'host' }]);
  assert.match(kept.notes.at(-1)!, /invented.*已移除/);
  assert.equal(kept.facts.some(f => f.includes('已移除')), false);
  x.cards[0].sig = []; x.cards[0].ev = '[invented.jsonl:99]';
  assert.match(normalizeMap(x, { transcript: '[real.jsonl:1]' }).cards[0].ev, /未定位/);
  const lv = good(); lv.live = { now: ['a', 'b'], known: 3, next: 'c' }; assert.deepEqual(normalizeMap(lv).live, { now: 'a；b', next: 'c' });
  for (const mutate of [(y: any) => y.goal.title = ' ']) {
    const y = good(); mutate(y); assert.throws(() => normalizeMap(y), /bad map/);
  }
  const y = good(); y.cards[0].id = 'fold-2'; y.cards[1].sub = 0;
  const ym = normalizeMap(y); assert.deepEqual(ym.cards.map(c => [c.id, c.sub]), [['C1', '']]);
});

test('模型非零退出不采信 JSON；超时和取消都结束自己的进程', async () => {
  const { runModel } = await import('../src/cli/summarize.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-cli-'));
  try {
    const cli = path.join(dir, 'model');
    fs.writeFileSync(cli, '#!/bin/sh\ncat >/dev/null\necho "{}"\nexit 7\n'); fs.chmodSync(cli, 0o755);
    await assert.rejects(runModel('input', { cli }), /exit 7/);
    fs.writeFileSync(cli, '#!/bin/sh\ncat >/dev/null\nsleep 30\n');
    await assert.rejects(runModel('input', { cli, timeoutMs: 40 }), /timeout/);
    const controller = new AbortController();
    const run = runModel('input', { cli, signal: controller.signal });
    controller.abort(); await assert.rejects(run, /cancelled/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('会话正被追加时读取不抛错，只丢写了一半的末行', async () => {
  const { readTextSnapshot } = await import('../src/cli/parse.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-race-')), file = path.join(dir, 's.jsonl');
  try {
    fs.writeFileSync(file, '{"a":1}\n{"b":2}');
    assert.equal(readTextSnapshot(file).raw, '{"a":1}\n{"b":2}');
    fs.writeFileSync(file, '{"a":1}\n{"b":');
    assert.equal(readTextSnapshot(file).raw, '{"a":1}\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('证据引用用会话 key；目标卡未知署名写进备注', async () => {
  const { buildTranscriptDetailed } = await import('../src/cli/segment.ts');
  const text = buildTranscriptDetailed({ sessionId: 'host-session', file: '/very/long/path/host.jsonl', events: [{ type: 'user', text: 'hello', blocks: [], line: 7, ts: '2026-01-01T00:00:00Z' }] }, [], 5000).text;
  assert.match(text, /\[host:7\]/);
  const x = good(); x.goal.sig = [{ verb: '定义', agent: 'invented' }];
  const m = normalizeMap(x, { agentKeys: ['host'] });
  assert.deepEqual(m.goals[0].sig, []); assert.match(m.goals[0].notes!.join(), /署名 invented/);
});

test('会话标题：改名优先，其次最新 ai-title', async () => {
  const { parseSession } = await import('../src/cli/parse.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-title-')), file = path.join(dir, 's.jsonl');
  try {
    const rows = [{ type: 'ai-title', aiTitle: '旧标题' }, { type: 'ai-title', aiTitle: '新标题' }];
    fs.writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
    assert.equal(parseSession(file).title, '新标题');
    fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: '用户改名' }) + '\n');
    assert.equal(parseSession(file).title, '用户改名');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('修改/验证/结论不能拿需求原话当证据；步骤执行者按已知 key 检查', () => {
  const x = good(); const tx = '👤 USER: [host:1] 请提速\n💬 [host:2] 已跑完测试';
  x.cards[1].ev = '[host:1] [host:2]';
  x.cards[1].steps = [{ title: '改排序', who: 'invented', st: 'done' }, { title: '复跑', who: 'host', st: 'done' }];
  const c = normalizeMap(x, { transcript: tx, agentKeys: ['host'] }).cards[1];
  assert.equal(c.type, 'change'); assert.equal(c.ev, '[host:2]');
  assert.deepEqual(c.steps.map(s => s.who), ['', 'host']);
  assert.equal(c.notes.length, 2);
  x.cards[0].ev = '[host:1]';
  assert.equal(normalizeMap(x, { transcript: tx }).cards[0].ev, '[host:1]'); // 子目标可以引用需求原话
});

test('Codex：前缀只认主线程，过滤注入上下文，子 agent 按 parent_thread_id 精确挂载', async () => {
  const { findSession, parseSession } = await import('../src/cli/parse.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-codex-')), old = process.env.HOME;
  const day = path.join(home, '.codex/sessions/2026/09/16'); fs.mkdirSync(day, { recursive: true });
  const host = '01a0a985-9682-7031-91fc-1fad66020d86', child = '01a0a985-aaaa-7031-91fc-1fad66020d86', guard = '01a0a985-9737-7252-b52a-5a80157dddc0';
  const write = (id: string, meta: object, rows: object[]) => fs.writeFileSync(path.join(day, `rollout-2026-09-16T17-21-39-${id}.jsonl`), [{ type: 'session_meta', payload: { id, cwd: '/w', ...meta } }, ...rows].map(x => JSON.stringify({ timestamp: '2026-09-16T09:00:00Z', ...x })).join('\n') + '\n');
  const msg = (role: string, text: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
  const goal = '<codex_internal_context source="goal"><objective>修好观察台</objective></codex_internal_context>';
  write(host, { thread_source: 'user' }, [msg('developer', '系统'), msg('user', '# AGENTS.md instructions for /w'), msg('user', '<environment_context>x</environment_context>'), msg('user', goal), msg('user', goal),
    { type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'c1', arguments: JSON.stringify({ task_name: 'backend_fix', agent_type: 'worker' }) } }]);
  write(child, { thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: host, agent_path: '/root/backend_fix', agent_role: 'worker' } } }, parent_thread_id: host }, [msg('assistant', 'CHILD_DONE')]);
  write(guard, { thread_source: 'guardian_review', parent_thread_id: host }, []);
  fs.writeFileSync(path.join(home, '.codex/session_index.jsonl'), JSON.stringify({ id: host, thread_name: '修观察台' }) + '\n');
  process.env.HOME = home;
  try {
    const h = findSession('01a0a985');
    assert.equal(h.sessionId, host);
    const p = parseSession(h.file);
    assert.equal(p.title, '修观察台');
    assert.deepEqual(p.events.filter(e => e.type === 'user' && e.text).map(e => e.text), ['修好观察台']);
    const tree = buildTree({ ...h, ...p });
    assert.deepEqual(tree.children.map(c => [c.key, c.matched, c.events[0].text]), [['backend_fix', 'exact-parent-id', 'CHILD_DONE']]);
    assert.equal(tree.children[0].dispatchLine, 7);
  } finally { process.env.HOME = old; fs.rmSync(home, { recursive: true, force: true }); }
});

test('多目标：旧格式单目标兼容；目标间只允许 接着/推翻；无合法目标整版拒绝', () => {
  const x = good(); delete x.goal;
  x.goals = [{ id: 'G1', title: '先做 A', st: 'done' }, { id: 'G2', title: '接着做 B', st: 'doing' }, { id: 'G3', title: '推倒 A 重来' }, { id: 'G1', title: '重复' }];
  x.edges = [{ f: 'G1', t: 'G2', v: '接着' }, { f: 'G3', t: 'G1', v: '推翻' }, { f: 'G1', t: 'S1', v: '接着' }, { f: 'G2', t: 'S1', v: '拆成' }];
  const m = normalizeMap(x);
  assert.deepEqual(m.goals.map(g => [g.id, g.type, g.st]), [['G1', 'goal', 'done'], ['G2', 'goal', 'doing'], ['G3', 'goal', 'unknown']]);
  assert.deepEqual(m.edges.map(e => e.v), ['接着', '推翻', '拆成']);
  assert.match(m.note, /丢弃 1 张.*丢弃 1 条/);
  assert.equal(m.cards.some(c => c.type === 'goal'), false);
  assert.throws(() => normalizeMap({ ...x, goals: [{ id: 'G1', title: ' ' }] }), /no valid goal/);
});

test('半截 JSON 只取写完的目标、卡与边，不留半张卡', async () => {
  const { parsePartialJson } = await import('../src/cli/summarize.ts');
  const full = JSON.stringify({ goals: [{ id: 'G1', title: 'g', sig: [{ verb: 'v', agent: 'host' }] }], cards: [{ id: 'S1', type: 'subgoal', title: 's "}{]" 引号' }, { id: 'C1', type: 'change', title: 'c', facts: ['x'] }], edges: [{ f: 'G1', t: 'S1', v: '拆成' }] });
  assert.equal(parsePartialJson('```json\n'), null);
  assert.equal(parsePartialJson(full.slice(0, full.indexOf('host'))), null);   // 目标还没写完
  const cut = parsePartialJson(full.slice(0, full.indexOf('"facts"')));      // C1 写了一半
  assert.deepEqual(cut.cards.map((c: any) => c.id), ['S1']);
  assert.equal(cut.cards[0].title, 's "}{]" 引号');
  assert.deepEqual(parsePartialJson('```json\n' + full + '\n```'), JSON.parse(full));
});

test('三种模型 CLI 的流式协议：边收边回调，结束取完整正文；报错带上原因', async () => {
  const { runModel } = await import('../src/cli/summarize.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-stream-')), oldPath = process.env.PATH;
  const answer = JSON.stringify({ goals: [{ id: 'G1', title: 'ok' }], cards: [], edges: [] });
  const half = JSON.stringify(answer.slice(0, 20)), rest = JSON.stringify(answer.slice(20)), whole = JSON.stringify(answer);
  const script = (name: string, body: string) => { fs.writeFileSync(path.join(dir, name), `#!/usr/bin/env bun\n${body}`); fs.chmodSync(path.join(dir, name), 0o755); };
  const say = 'const say=o=>console.log(JSON.stringify(o));';
  script('codex', `${say} if(process.env.FAIL_MODE){} let n=0; for await (const chunk of console) { const m=JSON.parse(chunk);
    if(m.id===1) say({id:1,result:{}}); if(m.id===2) say({id:2,result:{thread:{id:'t'}}});
    if(m.id===3){ if(process.env.FAIL_MODE){say({method:'error',params:{error:{message:'502 upstream'},willRetry:false}});say({method:'turn/completed',params:{turn:{status:'failed',error:null}}});continue;}
      say({id:3,result:{turn:{id:'u'}}}); say({method:'item/agentMessage/delta',params:{itemId:'x',delta:'{"goa'}}); say({method:'error',params:{error:{message:'stream disconnected'},willRetry:true}}); say({method:'item/agentMessage/delta',params:{itemId:'i',delta:${half}}}); await Bun.sleep(50);
      say({method:'item/agentMessage/delta',params:{itemId:'i',delta:${rest}}}); say({method:'item/completed',params:{item:{type:'agentMessage',id:'i',text:${whole}}}});
      say({method:'turn/completed',params:{turn:{status:'completed'}}}); } }`);
  script('claude', `${say} await Bun.stdin.text(); if(process.env.FAIL_MODE){say({type:'result',is_error:true,result:'API Error: 502'});process.exit(1);}
    say({type:'system',subtype:'init'}); say({type:'stream_event',event:{type:'message_start'}});
    say({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:${half}}}}); await Bun.sleep(50);
    say({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:${rest}}}}); say({type:'result',is_error:false,result:${whole}});`);
  script('pi', `${say} await Bun.stdin.text(); say({type:'message_start',message:{role:'assistant',content:[]}});
    say({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:${half}}}); await Bun.sleep(50);
    say({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:${rest}}});
    say({type:'message_end',message:{role:'assistant',content:[{type:'thinking',thinking:'x'},{type:'text',text:${whole}}]}});`);
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    for (const cli of ['codex', 'claude', 'pi']) {
      const seen: string[] = [];
      const retries: string[] = [];
      const out: any = await runModel('prompt', { cli, onText: t => seen.push(t), onRetry: m => retries.push(m) });
      if (cli === 'codex') assert.deepEqual(retries, ['stream disconnected']);
      assert.equal(out.goals[0].title, 'ok', cli);
      assert(seen.some(t => t.length > 0 && t.length < answer.length), `${cli} 没有增量：${JSON.stringify(seen)}`);
    }
    process.env.FAIL_MODE = '1';
    await assert.rejects(runModel('prompt', { cli: 'codex' }), /codex turn failed: 502 upstream/);
    await assert.rejects(runModel('prompt', { cli: 'claude' }), /claude exit 1: API Error: 502/);
  } finally { process.env.PATH = oldPath; delete process.env.FAIL_MODE; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('会话选择：codex:// 链接转 ID；最近会话含标题、目录，只列主线程，按修改时间倒序，可筛选', async () => {
  const { sessionRef, listRecentSessions, matches } = await import('../src/cli/pick.ts');
  assert.equal(sessionRef(' codex://threads/01a09ede-a29c-7c52-b223-5bda8d47ebee '), '01a09ede-a29c-7c52-b223-5bda8d47ebee');
  assert.equal(sessionRef('codex://threads/abc?x=1'), 'abc');
  assert.equal(sessionRef('4c972375'), '4c972375');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-pick-')), old = process.env.HOME;
  const claudeDir = path.join(home, '.claude/projects/-w'), codexDir = path.join(home, '.codex/sessions/2026/09/17');
  fs.mkdirSync(claudeDir, { recursive: true }); fs.mkdirSync(codexDir, { recursive: true });
  const write = (file: string, rows: object[], mtime: number) => { fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); fs.utimesSync(file, mtime, mtime); };
  write(path.join(claudeDir, 'aaaa.jsonl'), [{ type: 'user', cwd: '/w/app', message: { content: '修登录' } }, { type: 'ai-title', aiTitle: '旧名' }, { type: 'custom-title', customTitle: '用户改名' }, { type: 'ai-title', aiTitle: '新名' }], 3000);
  write(path.join(claudeDir, 'bbbb.jsonl'), [{ type: 'user', cwd: '/w', message: { content: '没有标题时用首条需求' } }], 1000);
  const rollout = (id: string, meta: object, mtime: number) => write(path.join(codexDir, `rollout-2026-09-17T10-00-00-${id}.jsonl`), [{ type: 'session_meta', payload: { id, cwd: '/w/codex', ...meta } }], mtime);
  const main = '01a0a985-9682-7031-91fc-1fad66020d86', child = '01a0a985-aaaa-7031-91fc-1fad66020d86';
  rollout(main, { thread_source: 'user' }, 2000); rollout(child, { thread_source: 'subagent' }, 4000);
  write(path.join(claudeDir, 'tmp1.jsonl'), [{ type: 'user', cwd: '/private/tmp', message: { content: 'AI 派生的一次性任务' } }], 5000);
  rollout('01a0a985-bbbb-7031-91fc-1fad66020d86', { thread_source: 'user', cwd: '/tmp/x' }, 5000);
  fs.writeFileSync(path.join(home, '.codex/session_index.jsonl'), JSON.stringify({ id: main, thread_name: 'Codex 线程' }) + '\n');
  process.env.HOME = home;
  try {
    const list = listRecentSessions();
    assert.deepEqual(list.map(s => [s.source, s.id, s.title, s.cwd]), [
      ['claude', 'aaaa', '用户改名', '/w/app'], ['codex', main, 'Codex 线程', '/w/codex'], ['claude', 'bbbb', '没有标题时用首条需求', '/w']]);
    assert.deepEqual(list.filter(s => matches(s, 'codex 线程')).map(s => s.id), [main]);
    const { formatRow, textWidth } = await import('../src/cli/pick.ts');
    const long = { ...list[0], title: '字体识别技能合并与性能优化'.repeat(8), cwd: '/Users/x/' + '很长的目录/'.repeat(10) };
    for (const cols of [60, 100, 237]) for (const s of [...list, long]) assert.equal(textWidth(formatRow(s, cols, '/Users/x')), cols - 4, `cols=${cols}`);
  } finally { process.env.HOME = old; fs.rmSync(home, { recursive: true, force: true }); }
});
