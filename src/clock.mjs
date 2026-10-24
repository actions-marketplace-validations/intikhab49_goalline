// The clock: goalline's side of the watch in clock-preload.cjs. A gate whose own code read the real
// clock passed at that moment, and the same code can fail on another day, so its receipt counts
// until the next midnight, or for --clock-ttl. So do fake timers' reads while their time came from the
// real clock; set to a fixed time, they don't count.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtWhen, UsageError } from './util.mjs';

const PRELOAD = fileURLToPath(new URL('./clock-preload.cjs', import.meta.url));
// The runners whose tests run in the Node processes the watch sees.
const NODE_RUNNERS = new Set(['jest', 'vitest', 'node-test']);
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseTtl(s) {
  if (s === undefined) return undefined;
  const m = /^(\d+)([smhd])?$/.exec(String(s));
  if (!m || (!m[2] && m[1] !== '0')) throw new UsageError(`--clock-ttl needs a number and s, m, h or d, like 12h, or 0 (got "${s}")`);
  return Number(m[1]) * (m[2] ? UNIT_MS[m[2]] : 0);
}

// The environment a gate runs with: every Node process it starts loads the watch. NODE_OPTIONS
// reads a backslash inside quotes as an escape, so the path goes with forward slashes.
export function startClock(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goalline-clock-'));
  const preload = `--require "${PRELOAD.split(path.sep).join('/')}"`;
  const prior = process.env.NODE_OPTIONS;
  return { dir, env: { NODE_OPTIONS: prior ? `${prior} ${preload}` : preload, GOALLINE_CLOCK_DIR: dir, GOALLINE_CLOCK_ROOT: root } };
}

// What each watched process reported. The folder goes with it.
export function readClock(clock) {
  if (!clock) return null;
  const seen = [];
  try {
    for (const f of fs.readdirSync(clock.dir)) {
      try {
        seen.push(JSON.parse(fs.readFileSync(path.join(clock.dir, f), 'utf8')));
      } catch {
        // A process killed while writing: the rest still tell.
      }
    }
  } catch {
    // No folder, no reports.
  }
  fs.rmSync(clock.dir, { recursive: true, force: true });
  return seen;
}

const nextMidnight = (d) => {
  const m = new Date(d);
  m.setHours(24, 0, 0, 0);
  return m;
};

// The receipt's clock record. Only a run whose tests ran in Node is judged by it: Playwright's code
// under test reads the browser's clock, pytest's the Python one.
export function clockRecord(seen, { off, runner, startedAt, ttlMs }) {
  if (off) return { watched: false, why: 'turned off (--no-clock)' };
  if (!seen) return { watched: false, why: 'the watch could not start' };
  if (!NODE_RUNNERS.has(runner)) {
    if (runner === 'unknown') return { watched: false, why: 'no Jest, Vitest or node --test summary in the output' };
    return { watched: false, why: runner === 'playwright' ? 'the code under test runs in a browser' : `${runner} runs outside Node` };
  }
  if (!seen.length) return { watched: false, why: 'no Node process reported' };
  const sites = new Map();
  let reads = 0;
  for (const s of seen) {
    reads += s.reads || 0;
    for (const [at, n] of s.sites || []) sites.set(at, (sites.get(at) || 0) + n);
  }
  const rec = { watched: true, reads, sites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 5) };
  if (seen.some((s) => s.capped)) rec.capped = true;
  // A watch that gave up saw too much to say the clock was never read.
  if (seen.some((s) => s.incomplete)) rec.incomplete = true;
  if (reads || rec.incomplete) {
    const from = new Date(startedAt);
    rec.expires = (ttlMs === undefined ? nextMidnight(from) : new Date(from.getTime() + ttlMs)).toISOString();
    rec.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return rec;
}

const firstSite = (c) => c.sites?.[0]?.[0];

// For the run's summary line: null when the clock does not limit the receipt.
export function describeClock(c) {
  if (!c?.expires) return null;
  const n = c.incomplete ? 'more reads than the watch follows' : `${c.reads}${c.capped ? '+' : ''} read(s)`;
  return `reads the real clock (${n}${firstSite(c) ? `, e.g. ${firstSite(c)}` : ''}): counts until ${fmtWhen(c.expires)}`;
}

// Why a receipt no longer counts because of the clock, or null.
export function clockProblem(c, now = Date.now()) {
  if (!c?.expires || now < Date.parse(c.expires)) return null;
  return `it read the real clock${firstSite(c) ? ` (${firstSite(c)})` : ''}, so its pass expired at ${fmtWhen(c.expires)}`;
}
