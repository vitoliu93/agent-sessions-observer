// 终端选择器：用 Bun 自带的伪终端起子进程、发按键，看它选中谁
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const script = `
  import { pickSession } from './src/cli/pick.ts';
  const sessions = Array.from({ length: 30 }, (_, i) => ({ id: 'id-' + i, source: i % 3 ? 'claude' : 'codex', title: i % 5 ? '修登录 ' + i : '🚀 发布 ' + i + ' 中文标题', cwd: '/w/p' + i, mtime: 1e12 - i * 60000 }));
  console.log('PICKED ' + JSON.stringify(await pickSession(sessions)));
`;
async function drive(keys: string[]): Promise<{ picked: string | null; screen: string }> {
  let out = '';
  const proc = Bun.spawn(['bun', '-e', script], { cwd: root, terminal: { cols: 90, rows: 12, data(_t, d) { out += String(d); } } });
  await Bun.sleep(600);
  for (const k of keys) { proc.terminal!.write(k); await Bun.sleep(250); }
  await proc.exited;
  const m = out.match(/PICKED (.+)/);
  return { picked: m ? JSON.parse(m[1]) : undefined, screen: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
}

test('终端选择器：筛选 + ↓ + 回车选中第二个匹配；无匹配时回车不退出；Esc 返回 null', { timeout: 20000 }, async () => {
  const a = await drive(['codex', '\x1b[B', '\r']);
  assert.equal(a.picked, 'id-3');   // codex 会话是 id-0、id-3、id-6…
  const b = await drive(['xyz', '\r', '\x7f\x7f\x7f', '\r']);
  assert.equal(b.picked, 'id-0');   // 没有匹配时回车留在原地；退掉筛选词后回车选第一个
  const c = await drive(['\x1b']);
  assert.equal(c.picked, null);
  assert.match(c.screen, /🚀 发布 0 中文标题/);
});
