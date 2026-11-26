/** 스크립트용 .env 로더 (의존성 없이). 이미 설정된 환경변수는 덮어쓰지 않는다. */
import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(root = process.cwd()) {
  for (const name of ['.env.local', '.env']) {
    const p = path.join(root, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

export function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const pre = args.find((a) => a.startsWith(`--${name}=`));
  return pre ? pre.slice(name.length + 3) : undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}
