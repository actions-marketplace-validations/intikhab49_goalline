import { execFile } from 'node:child_process';
import os from 'node:os';

// Test and build runners that make a machine "busy" for timing-sensitive suites.
export const RUNNER_RE = /\b(jest|playwright|vitest|mocha|cypress|pytest)\b|next(\.js)? build|nest build|node(\.exe)?"? --test\b/i;

// The goalline CLI itself (bin/receipts.mjs by its old name) is never a runner: a verify that names a gate like "web-jest" is not a
// test run, and the tests a run or goalpost starts are separate processes that count on their own.
const CLI_RE = /\bbin[\\/](goalline|receipts)\.mjs\b/;

export const freeMb = () => Math.round(os.freemem() / 1048576);

// CPU load between now and stop(). stop(minMs) waits out the rest of minMs, so a window that
// already spans other work (fingerprinting the code) costs no extra time.
export function cpuWindow() {
  const snap = () =>
    os.cpus().reduce(
      (acc, c) => {
        const t = c.times;
        acc.idle += t.idle;
        acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
        return acc;
      },
      { idle: 0, total: 0 },
    );
  const a = snap();
  const startedAt = Date.now();
  return {
    async stop(minMs = 0) {
      const wait = minMs - (Date.now() - startedAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const b = snap();
      const total = b.total - a.total;
      return total > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / total)) : null;
    },
  };
}

const capture = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });

// Asynchronous: listing processes takes over a second on Windows, and a blocked event loop
// would stop reading the gate's output meanwhile.
export async function processes() {
  try {
    if (process.platform === 'win32') {
      const ps =
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
      const out = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      if (!out) return null;
      const rows = JSON.parse(out);
      return (Array.isArray(rows) ? rows : [rows]).map((p) => ({
        pid: p.ProcessId,
        ppid: p.ParentProcessId,
        name: p.Name || '',
        cmd: p.CommandLine || '',
      }));
    }
    const out = await capture('ps', ['-eo', 'pid=,ppid=,comm=,args=']);
    if (out === null) return null;
    return out
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] }));
  } catch {
    return null;
  }
}

// Test runners on this machine other than this process, its children, and the processes that
// started it (a test harness or script running this tool is not someone else's run).
// null = could not tell.
export async function foreignRunners(rootPid = process.pid) {
  const procs = await processes();
  if (!procs) return null;
  const kids = new Map();
  const parent = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
    parent.set(p.pid, p.ppid);
  }
  const mine = new Set([rootPid]);
  for (let p = parent.get(rootPid), depth = 0; p && !mine.has(p) && depth < 64; p = parent.get(p), depth++) mine.add(p);
  const queue = [rootPid];
  while (queue.length) {
    for (const c of kids.get(queue.pop()) || []) {
      if (!mine.has(c)) {
        mine.add(c);
        queue.push(c);
      }
    }
  }
  return procs
    .filter((p) => !mine.has(p.pid) && /node|python|pytest/i.test(p.name) && RUNNER_RE.test(p.cmd) && !CLI_RE.test(p.cmd))
    .map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 200) }));
}

export function startSampler({ everyMs = 30000 } = {}) {
  const s = { freeMbMin: freeMb(), foreignMax: 0, foreignSeen: [], samples: 0, unknown: 0 };
  let pending = null;
  const tick = async () => {
    s.samples++;
    s.freeMbMin = Math.min(s.freeMbMin, freeMb());
    const f = await foreignRunners();
    if (!f) {
      s.unknown++;
      return;
    }
    s.foreignMax = Math.max(s.foreignMax, f.length);
    for (const p of f) if (s.foreignSeen.length < 5 && !s.foreignSeen.some((x) => x.pid === p.pid)) s.foreignSeen.push(p);
  };
  const timer = setInterval(() => {
    if (!pending) pending = tick().finally(() => (pending = null));
  }, everyMs);
  return {
    async stop() {
      clearInterval(timer);
      await pending;
      return s;
    },
  };
}
