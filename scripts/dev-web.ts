// 两个监听共用同一个生命周期；退出时不留下后台构建进程。
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = resolve(dirname(fileURLToPath(import.meta.resolve('@tailwindcss/cli/package.json'))), 'dist/index.mjs');
const children = [
  Bun.spawn([process.execPath, cli, '-i', 'src/web/styles.css', '-o', 'src/web/styles.generated.css', '--watch=always'], { stdout: 'inherit', stderr: 'inherit' }),
  Bun.spawn([process.execPath, 'build', 'src/web/index.html', '--outdir', 'dist-cli/web', '--watch'], { stdout: 'inherit', stderr: 'inherit' }),
];
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exited));
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
await Promise.race(children.map(async child => { const code = await child.exited; await stop(code || 1); }));
