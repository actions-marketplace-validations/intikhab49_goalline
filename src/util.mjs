import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.11.0';
export const isWin = process.platform === 'win32';

// The receipts it signs live in ~/.receipts. RECEIPTS_HOME is the old name of GOALLINE_HOME.
export const home = () => process.env.GOALLINE_HOME || process.env.RECEIPTS_HOME || path.join(os.homedir(), '.receipts');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
export const toPosix = (p) => p.split(path.sep).join('/');
export const short = (sha) => (sha ? sha.slice(0, 7) : '-');
export const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
export const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export class UsageError extends Error {}

export function exec(cmd, args, { cwd, env, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (!allowFail && r.status !== 0) {
    const tail = String(r.stderr || '').trim().split('\n').slice(-3).join(' | ');
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${tail}`);
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Run a shell command line, pass its output through to `out`/`err` (null = silent) and capture all of it.
export function spawnCapture(line, { cwd, env, shell = true, out = process.stdout, err = process.stderr, limit = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    const child = spawn(line, { cwd, env: env ? { ...process.env, ...env } : process.env, shell, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
    const tee = (stream) => (buf) => {
      if (stream) stream.write(buf);
      if (size + buf.length <= limit) {
        chunks.push(buf);
        size += buf.length;
      } else truncated = true;
    };
    child.stdout.on('data', tee(out));
    child.stderr.on('data', tee(err));
    child.on('error', (err) => resolve({ code: 127, output: Buffer.from(`could not start: ${err.message}`), truncated }));
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), output: Buffer.concat(chunks), truncated }));
  });
}

// Options come before `--`; everything after `--` is the command. Keys are camelCased.
export function parseArgs(argv, { booleans = [], repeat = [] } = {}) {
  const opts = {};
  const positional = [];
  let command = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      command = argv.slice(i + 1);
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value;
    if (booleans.includes(key)) value = eq === -1 ? true : a.slice(eq + 1) !== 'false';
    else if (eq !== -1) value = a.slice(eq + 1);
    else if (i + 1 < argv.length && argv[i + 1] !== '--') value = argv[++i];
    else throw new UsageError(`--${key} needs a value`);
    if (repeat.includes(key)) (opts[key] ||= []).push(value);
    else opts[key] = value;
  }
  return { opts, positional, command };
}

const reEscape = (s) => s.replace(/[.+^$()|[\]\\{}]/g, '\\$&');

// Minimal glob: `**/` (any directories), `*`, `?` and `{a,b}`. Paths use forward slashes.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) !== -1) {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map(reEscape).join('|')})`;
      i = end;
    } else re += reEscape(c);
  }
  return new RegExp(`^${re}$`);
}

export const matcher = (globs) => {
  const res = globs.map(globToRegExp);
  return (p) => res.some((r) => r.test(p));
};

export function quoteArg(a) {
  if (a === '') return isWin ? '""' : "''";
  if (!/[\s"'&|<>^%!;$`*?()]/.test(a)) return a;
  return isWin ? `"${a.replace(/"/g, '""')}"` : `'${a.replace(/'/g, `'\\''`)}'`;
}

// One argument is taken as a full command line; several are quoted and joined.
export const commandLine = (argv) => (argv.length === 1 ? argv[0] : argv.map(quoteArg).join(' '));

export function fmtDuration(ms) {
  if (ms == null) return '-';
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${(s / 60).toFixed(1)}m`;
}

export function fmtWhen(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function firstUsefulLine(msg) {
  const lines = stripAnsi(msg || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return clip(lines.find((l) => !l.startsWith('●')) || lines[0] || '');
}

// "Expected 5, received 6" when the runner printed both, else the first useful line.
export function failureSummary(msg) {
  const clean = stripAnsi(msg || '');
  // Jest prints a thrown Error('Expected: 5\nReceived: 6') with its class first ("Error: Expected:
  // 5"), and some matchers put the value on the next line, which can be empty before the stack.
  const value = (label) => {
    const m = new RegExp(`^\\s*(?:\\w*Error:\\s*)?${label}[^:\\n]*:[ \\t]*(.*)$`, 'm').exec(clean);
    if (!m) return null;
    if (m[1].trim()) return m[1].trim();
    const next = clean.slice(m.index + m[0].length + 1).split('\n')[0] || '';
    return next.trim() && !/^\s*at\s/.test(next) ? next.trim() : '(empty)';
  };
  const exp = value('Expected');
  const rec = value('Received');
  if (exp !== null && rec !== null) return clip(`Expected ${exp}, received ${rec}`);
  // toHaveBeenCalledWith with no matching call prints the expected arguments and the call count.
  const calls = /^\s*Number of calls:\s*(\d+)/m.exec(clean)?.[1];
  if (exp !== null && calls !== undefined) return clip(`Expected a call with ${exp}, got ${calls} call(s)`);
  // Vitest words toBe and toEqual as chai does: "expected 6 to be 5 // Object.is equality",
  // "expected [ 'a' ] to deeply equal [ 'a', 'b' ]".
  const chai =
    /^\s*(?:\w*Error:\s*)?expected (.+) to be (.+) \/\/ Object\.is equality\s*$/m.exec(clean) ||
    /^\s*(?:\w*Error:\s*)?expected (.+) to (?:deeply |strictly )?equal (.+?)\s*$/m.exec(clean);
  if (chai) return clip(`Expected ${chai[2]}, received ${chai[1]}`);
  return firstUsefulLine(clean);
}

// Paths inside a scratch copy, written relative to it: no note keeps the temp folder (and the user
// name in it). Runners print them with either slash, as file URLs, or (Python's repr of a Windows
// path) with every backslash doubled.
export function relativize(text, dir) {
  if (!text || !dir) return text || '';
  const escaped = dir.split('\\').join('\\\\');
  let out = String(text);
  for (const prefix of [`${dir}${path.sep}`, `${dir.split('\\').join('/')}/`, `${escaped}\\\\`, `${pathToFileURL(dir).href}/`]) out = out.split(prefix).join('');
  return out;
}
