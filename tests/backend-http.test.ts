import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(import.meta.dir, '..');
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, ms = 3000): Promise<T> { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(30); } throw new Error('timeout'); }

test('HTTP: 空启动、未知 sid=404、去重、失败保留及自动重试、完整快照', { timeout: 15000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-http-'));
  const sid = 'session-a';
  const sessionDir = path.join(tmp, '.claude/projects/p'); fs.mkdirSync(sessionDir, { recursive: true });
  const session = path.join(sessionDir, `${sid}.jsonl`);
  fs.writeFileSync(session, JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'please test' } }) + '\n');
  const cli = path.join(tmp, 'fake-model.mjs'), count = path.join(tmp, 'count');
  fs.writeFileSync(cli, `#!/usr/bin/env bun
import fs from 'node:fs'; const n=(Number(fs.existsSync(process.env.COUNT)&&fs.readFileSync(process.env.COUNT,'utf8'))||0)+1; fs.writeFileSync(process.env.COUNT,String(n)); if(n===3){console.log('{}');process.exit(0);} const fact=n===1?'OLD_FACT':'NEW_FACT'; console.log(JSON.stringify({goal:{id:'GOAL',title:'Goal',sub:'',acc:[],sig:[]},cards:[{id:'S1',type:'subgoal',goalId:'S1',title:'Sub',sub:'',sig:[],st:n===1?'doing':'done',facts:[fact],ev:'模型归纳，未定位原始证据',steps:[]}],edges:[{f:'GOAL',t:'S1',v:'拆成'}],live:{now:fact},note:fact}));`);
  fs.chmodSync(cli, 0o755);
  const port = 46000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(['bun', 'src/cli/index.ts', '--port', String(port), '--interval', '0.1', '--cli', cli], { cwd: root, env: { ...process.env, HOME: tmp, COUNT: count }, stdout: 'pipe', stderr: 'pipe' });
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port}/api/sessions`).catch(() => null))?.ok);
    let r = await fetch(`http://127.0.0.1:${port}/api/data?sid=missing`); assert.equal(r.status, 404);
    r = await fetch(`http://127.0.0.1:${port}/api/sessions/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sid }) }); assert.equal(r.status, 200);
    // 首次已经占用；手动同步不能制造第二个任务。
    await fetch(`http://127.0.0.1:${port}/api/resync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sid }) });
    const first = await until(async () => { const x = await (await fetch(`http://127.0.0.1:${port}/api/data?sid=${sid}`)).json(); return x.syncN === 1 && x; });
    assert.equal(Number(fs.readFileSync(count, 'utf8')), 1);
    assert.equal(first.history[0].cards[0].facts[0], 'OLD_FACT');
    await fetch(`http://127.0.0.1:${port}/api/resync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sid }) });
    const second = await until(async () => { const x = await (await fetch(`http://127.0.0.1:${port}/api/data?sid=${sid}`)).json(); return x.syncN === 2 && x; });
    assert.equal(second.cards[0].facts[0], 'NEW_FACT');
    assert.equal(second.history[0].cards[0].facts[0], 'OLD_FACT');
    assert.equal(second.history[0].goals[0].st, 'unknown');
    assert.equal(second.history[0].stamps[0].at, 1);
    const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${route}`, {method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post('/api/sessions/add',{id:'session'})).status,200);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()).sessions.length,1);
    assert.equal((await post('/api/resync',{id:sid},{origin:'https://untrusted.example'})).status,403);
    assert.equal((await post('/api/resync',{id:'中'.repeat(2000)})).status,413);
    fs.appendFileSync(session, JSON.stringify({type:'user',timestamp:'2026-01-01T00:01:00Z',message:{content:'new input'}})+'\n');
    const failed=await until(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/data?sid=${sid}`)).json();return x.lastError&&x;});
    assert.equal(failed.syncN,2);assert.equal(failed.cards[0].facts[0],'NEW_FACT');
    await wait(400);assert.equal(Number(fs.readFileSync(count,'utf8')),3);
    const recovered=await until(async()=>{const x=await(await fetch(`http://127.0.0.1:${port}/api/data?sid=${sid}`)).json();return x.syncN===3&&x;},8000);
    assert.equal(recovered.lastError,null);assert.equal(recovered.history.length,3);
    assert.equal(recovered.history[0].cards[0].facts[0],'OLD_FACT');
    const delta=await(await fetch(`http://127.0.0.1:${port}/api/data?sid=${sid}&since=2&boot=${recovered.boot}`)).json();
    assert.deepEqual(delta.history.map((h: any)=>h.at),[3]);assert.equal(delta.historySince,2);
    // 服务重启（进程标识不同）或客户端序号超前：给完整历史
    for(const q of ["since=2&boot=old-process",`since=9&boot=${recovered.boot}`]){const full=await(await fetch(`http://127.0.0.1:${port}/api/data?sid=${sid}&${q}`)).json();assert.deepEqual(full.history.map((h: any)=>h.at),[1,2,3]);assert.equal(full.historySince,0);}
    assert.equal((await(await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()).sessions[0].title,"");
  } finally { proc.kill(); await proc.exited; fs.rmSync(tmp,{recursive:true,force:true}); }
});

test('HTTP: 模型报提示过长时缩预算重试，stdout 错误进入 lastError', { timeout: 15000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-http-'));
  const sid = 'session-long', dir = path.join(tmp, '.claude/projects/p'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: `REQ_${i} ${'中'.repeat(900)}` } })).join('\n') + '\n');
  const cli = path.join(tmp, 'fake-model.mjs'), sizes = path.join(tmp, 'sizes');
  // claude -p 超长时把错误写到 stdout 并 exit 1
  fs.writeFileSync(cli, `#!/usr/bin/env bun
import fs from 'node:fs'; const p=await Bun.stdin.text(); fs.appendFileSync(process.env.SIZES,p.length+'\\n'); if(p.length>60000){console.log('Prompt is too long');process.exit(1);} console.log(JSON.stringify({goal:{id:'GOAL',title:'Goal',sub:'',acc:[],sig:[]},cards:[],edges:[],live:{now:'x'},note:''}));`);
  fs.chmodSync(cli, 0o755);
  const port = 47000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(['bun', 'src/cli/index.ts', sid, '--port', String(port), '--budget', '150000', '--cli', cli], { cwd: root, env: { ...process.env, HOME: tmp, SIZES: sizes }, stdout: 'pipe', stderr: 'pipe' });
  try {
    const x = await until(async () => { const r = await fetch(`http://127.0.0.1:${port}/api/data?sid=${sid}`).catch(() => null); const d = r?.ok && await r.json(); return d?.syncN === 1 && d; }, 10000);
    const calls = fs.readFileSync(sizes, 'utf8').trim().split('\n').map(Number);
    assert(calls.length >= 2 && calls.at(-1)! <= 60000 && calls[0] > 60000, String(calls));
    assert.equal(x.lastError, null);
  } finally { proc.kill(); await proc.exited; fs.rmSync(tmp, { recursive: true, force: true }); }
});

// 原始请求：fetch 会把 /../ 规范化掉，穿越测试必须绕开客户端
function rawGet(port: number, target: string, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.end(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let out = ''; s.setEncoding('utf8'); s.on('data', d => { out += d; }); s.on('end', () => resolve(out)); s.on('error', reject);
  });
}

test('Node 产物：静态托管、SPA 回退、目录穿越不泄露文件', { timeout: 30000 }, async () => {
  // 产物打到临时目录，旁边放假 web/，不碰真实前端构建；用 node 跑，同时验证 Node 兼容
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-static-'));
  const build = Bun.spawnSync(['bun', 'build', 'src/cli/index.ts', '--target=node', '--format=esm', `--outfile=${path.join(tmp, 'index.js')}`], { cwd: root });
  assert.equal(build.exitCode, 0, build.stderr.toString());
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}'); // 同发布包：Node 18 不会自动识别 ESM
  fs.mkdirSync(path.join(tmp, 'web/assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'web/index.html'), 'INDEX_OK');
  fs.writeFileSync(path.join(tmp, 'web/assets/app.js'), 'APP_JS');
  fs.writeFileSync(path.join(tmp, 'SECRET.txt'), 'SECRET');
  const port = 48000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn([process.env.OBS_NODE || 'node', path.join(tmp, 'index.js'), '--port', String(port), '--cli', '/bin/sh'], { env: { ...process.env, HOME: tmp }, stdout: 'pipe', stderr: 'pipe' });
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port}/api/sessions`).catch(() => null))?.ok, 10000);
    let r = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await r.text(), 'INDEX_OK'); assert.match(r.headers.get('content-type')!, /text\/html/);
    r = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    assert.equal(await r.text(), 'APP_JS'); assert.match(r.headers.get('content-type')!, /javascript/);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/some/route`)).text(), 'INDEX_OK');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/nope`)).status, 404);
    // Host 不是本机地址（DNS rebinding）时接口拒绝
    assert.match(await rawGet(port, '/api/sessions', `evil.example:${port}`), /^HTTP\/1.1 403/);
    assert.match(await rawGet(port, '/api/sessions', `127.0.0.1:${port}`), /^HTTP\/1.1 200/);
    assert.match(await rawGet(port, '/api/sessions', 'localhost:8080'), /^HTTP\/1.1 200/, 'SSH 端口转发时端口不同也放行');
    assert.match(await rawGet(port, '/api/sessions', '127.0.0.1.evil.example'), /^HTTP\/1.1 403/);
    for (const target of ['/../SECRET.txt', '/..%2fSECRET.txt', '/..%2f..%2fpackage.json', '/%2e%2e/SECRET.txt']) {
      const res = await rawGet(port, target);
      assert(!res.includes('SECRET') && !res.includes('"name"'), `${target} leaked: ${res.slice(-80)}`);
    }
  } finally { proc.kill(); await proc.exited; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('HTTP: 分析中边输出边给草稿，完成后草稿清空、进入正式快照', { timeout: 15000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-draft-'));
  const sid = 'session-draft', dir = path.join(tmp, '.claude/projects/p'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: 'draft please' } }) + '\n');
  const answer = JSON.stringify({ goals: [{ id: 'G1', title: '先做', st: 'done' }, { id: 'G2', title: '后做', st: 'doing' }], cards: [{ id: 'S1', type: 'subgoal', title: '子目标', st: 'doing' }, { id: 'C1', type: 'change', title: '修改', st: 'done' }], edges: [{ f: 'G1', t: 'G2', v: '接着' }, { f: 'G2', t: 'S1', v: '拆成' }], live: { now: 'x' }, note: '' });
  const cut = answer.indexOf('{"id":"C1"');
  const cli = path.join(tmp, 'fake-model.mjs'), gate = path.join(tmp, 'gate');
  // 写完前半截后等测试放行，保证测试能看到分析中的草稿
  fs.writeFileSync(cli, `#!/usr/bin/env bun
import fs from 'node:fs'; await Bun.stdin.text(); process.stdout.write(${JSON.stringify(answer.slice(0, cut))});
while (!fs.existsSync(process.env.GATE)) await Bun.sleep(20); process.stdout.write(${JSON.stringify(answer.slice(cut))});`);
  fs.chmodSync(cli, 0o755);
  const port = 49000 + Math.floor(Math.random() * 1000);
  const proc = Bun.spawn(['bun', 'src/cli/index.ts', sid, '--port', String(port), '--cli', cli], { cwd: root, env: { ...process.env, HOME: tmp, GATE: gate }, stdout: 'pipe', stderr: 'pipe' });
  const data = async () => { const r = await fetch(`http://127.0.0.1:${port}/api/data?sid=${sid}`).catch(() => null); return r?.ok ? r.json() : null; };
  try {
    const mid = await until(async () => { const x = await data(); return x?.draft?.cards?.length && x; }, 10000);
    assert.equal(mid.syncN, 0); assert.equal(mid.analyzing, true);
    assert.deepEqual(mid.draft.goals.map((g: any) => g.id), ['G1', 'G2']);
    assert.deepEqual(mid.draft.cards.map((c: any) => c.id), ['S1']);
    assert(mid.draft.chars > 0);
    fs.writeFileSync(gate, '');
    const done = await until(async () => { const x = await data(); return x?.syncN === 1 && x; }, 10000);
    assert.equal(done.draft, null);
    assert.deepEqual(done.goals.map((g: any) => g.id), ['G1', 'G2']);
    assert.deepEqual(done.edges.map((e: any) => e.v), ['接着', '拆成']);
  } finally { proc.kill(); await proc.exited; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('模型 CLI：没指定时用本机已安装的第一个；指定的没装或都没装，启动即报清楚', { timeout: 15000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-pick-')), bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const run = (args: string[]) => Bun.spawn([process.execPath, 'src/cli/index.ts', ...args], { cwd: root, env: { HOME: tmp, PATH: bin }, stdout: 'pipe', stderr: 'pipe' });
  const text = (s: ReadableStream) => new Response(s).text();
  try {
    let p = run(['--port', '45999']);
    assert.equal(await p.exited, 2); assert.match(await text(p.stderr), /找不到可用的模型 CLI/);
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n'); fs.chmodSync(path.join(bin, 'claude'), 0o755);
    p = run(['--cli', 'codex', '--port', '45999']);
    assert.equal(await p.exited, 2); assert.match(await text(p.stderr), /找不到命令 codex.*本机已安装：claude，可改用 --cli claude/);
    const port = 45000 + Math.floor(Math.random() * 1000);
    p = run(['--port', String(port)]);
    const reader = p.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let out = '';
    while (!/自动改用/.test(out)) { const { value, done } = await reader.read(); if (done) break; out += value; }
    assert.match(out, /分析模型：claude（haiku）（本机找不到 codex，自动改用 claude）/);
    p.kill(); await p.exited;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
