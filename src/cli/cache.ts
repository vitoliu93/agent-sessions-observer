// 缓存带原话与改写，按私有文件保存；坏文件、旧格式都不能挡住出图。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isOverlay, type Overlay } from './review.ts';
import type { JevCache } from './jevmap.ts';

const MAX_CACHE = 32 * 1024 * 1024;
// HOME 优先，和 parse.ts 找会话目录的规则一致：bun 的 os.homedir() 不看 HOME，测试没法换家目录
export const cacheDir = () => path.join(process.env.HOME || os.homedir(), '.cache', 'agent-sessions-obs');
export function cacheFile(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || id === '.' || id === '..') throw new Error('invalid cache id');
  return path.join(cacheDir(), `${id}.json`);
}

const DAY = 24 * 60 * 60 * 1000;
// ponytail: 只按修改时间清，不看总大小。正在观察的会话每次保存都会刷新 mtime，不会被清掉。
// 要按目录总大小封顶时再加一轮「按 mtime 从旧到新删到低于上限」。
const CACHE_DAYS = 30, FAILED_DAYS = 7;
/** 启动时清一次旧缓存。只认自己命名的普通文件：符号链接、子目录、别人的文件一律不碰 */
export function sweepCache(now = Date.now()): number {
  let names: string[];
  try { names = fs.readdirSync(cacheDir()); } catch { return 0; }
  let gone = 0;
  for (const name of names) {
    // 失败原文 obs-failed-<会话>-<pid>-<时间>.txt 留 7 天；会话缓存 <会话 ID>.json 留 30 天
    const days = /^obs-failed-[A-Za-z0-9._-]+\.txt$/.test(name) ? FAILED_DAYS : /^[A-Za-z0-9._-]+\.json$/.test(name) ? CACHE_DAYS : 0;
    if (!days) continue;
    const file = path.join(cacheDir(), name);
    try {
      const s = fs.lstatSync(file);   // lstat 不跟着符号链接走，链接本身也不是普通文件
      if (!s.isFile() || now - s.mtimeMs < days * DAY) continue;
      fs.unlinkSync(file); gone++;
    } catch (e) { console.error(`旧缓存没删掉 ${name}：${(e as Error).message}`); }
  }
  return gone;
}

export function writePrivate(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('缓存目录不能是符号链接');
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function encodeCache(jev: JevCache, overlay: Overlay | null, reviewedAt: string | null): string {
  const text = JSON.stringify({ v: 3, jev: [...jev], overlay, reviewedAt });
  if (Buffer.byteLength(text) > MAX_CACHE) throw new Error('缓存超过 32 MiB，本次只保留在内存');
  return text;
}

export function readCache(file: string): { jev: JevCache; overlay: Overlay | null; reviewedAt: string | null } | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_CACHE) return null;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d.v !== 3 || !Array.isArray(d.jev) || !d.jev.every((x: any) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1]?.h === 'string' && x[1]?.a && typeof x[1].a === 'object' && !Array.isArray(x[1].a))) return null;
    return { jev: new Map(d.jev), overlay: isOverlay(d.overlay) ? d.overlay : null, reviewedAt: isOverlay(d.overlay) && typeof d.reviewedAt === 'string' ? d.reviewedAt : null };
  } catch { return null; }
}
