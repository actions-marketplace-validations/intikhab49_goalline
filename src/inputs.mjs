// What a gate depends on that the git tree does not hold, such as the schema of the database its
// tests ran against. Each input is read by a probe, a command whose output is hashed right before and
// right after the gate. A receipt counts only while a fresh probe of each of its inputs reads the same.
//   --input db=pg              the schema PostgreSQL reports, for $DATABASE_URL (or the PG* variables)
//   --input db=pg:TEST_DB_URL  the same, for the database in $TEST_DB_URL
//   --input cache="<command>"  any command: its output, line endings and trailing spaces aside
import { spawnSync } from 'node:child_process';
import { sha256, short, UsageError } from './util.mjs';

const NAME = /^[A-Za-z0-9_.-]+$/;
const PG = /^pg(?::([A-Za-z_][A-Za-z0-9_]*))?$/;
const TIMEOUT_MS = 120_000;

// --input name=<probe>, once per input: { name: probe }.
export function parseInputs(values) {
  const inputs = {};
  for (const v of values || []) {
    const eq = String(v).indexOf('=');
    const name = eq > 0 ? v.slice(0, eq) : '';
    const probe = eq > 0 ? v.slice(eq + 1).trim() : '';
    if (!NAME.test(name) || !probe) throw new UsageError(`--input needs name=<probe>, e.g. --input db=pg (got "${v}")`);
    if (inputs[name]) throw new UsageError(`--input ${name} is given twice`);
    inputs[name] = probe;
  }
  return inputs;
}

// The probes for one gate: every --input, unless rules list the inputs each gate depends on. An input
// the rules list that no --input reads is kept as null, so the receipt shows it was never read.
export function gateProbes(given, gate, rules) {
  const names = rules?.inputsFor(gate);
  if (!names) return given;
  return Object.fromEntries(names.map((n) => [n, given[n] ?? null]));
}

// A password in a URL never goes on a receipt.
export const redact = (probe) => probe.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]*):[^@\s/]*@/gi, '$1:***@');

// Bytes as latin1, so no two outputs read the same; then line endings and trailing spaces aside.
const normalize = (buf) => Buffer.from(buf).toString('latin1').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
const lastLine = (buf) => Buffer.from(buf || '').toString('utf8').trim().split('\n').pop() || '';

function output(r, what) {
  if (r.error?.code === 'ETIMEDOUT') throw new Error(`${what} took over ${TIMEOUT_MS / 1000}s`);
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? `${what} is not installed` : r.error.message);
  if (r.status !== 0) throw new Error(`${what} exited ${r.status}: ${lastLine(r.stderr)}`);
  return r.stdout;
}

const run = (cmd, args, opts) => spawnSync(cmd, args, { maxBuffer: 512 * 1024 * 1024, timeout: TIMEOUT_MS, windowsHide: true, ...opts });

// One reading: { probe, sha256 } (plus what a preset adds), or { probe, error }.
export function readInput(probe) {
  if (!probe) return { probe: null, error: 'no --input reads it' };
  const shown = redact(probe);
  try {
    const got = PG.test(probe) ? readPg(probe) : { text: normalize(output(run(probe, [], { shell: true }), 'the probe')) };
    return { probe: shown, sha256: sha256(Buffer.from(got.text, 'latin1')), ...(got.server ? { server: got.server } : {}) };
  } catch (err) {
    return { probe: shown, error: err.message.split('\n')[0] };
  }
}

export const readInputs = (probes) => Object.fromEntries(Object.entries(probes).map(([name, probe]) => [name, readInput(probe)]));

// Prisma's own URL parameters (schema=public...) are not libpq's, and pg_dump refuses them.
const NOT_LIBPQ = new Set(['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout', 'statement_cache_size', 'sslaccept', 'sslidentity']);
export function libpqUrl(url) {
  const q = url.indexOf('?');
  if (!/^postgres(ql)?:\/\//i.test(url) || q === -1) return url;
  const kept = url.slice(q + 1).split('&').filter((kv) => kv && !NOT_LIBPQ.has(kv.split('=')[0]));
  return kept.length ? `${url.slice(0, q)}?${kept.join('&')}` : url.slice(0, q);
}

// The schema as PostgreSQL reports it: pg_dump --schema-only, without owners and grants, and
// without the lines that differ on every dump (pg_dump's own version, the random \restrict key).
// The server counts by its major version, as Node does.
export function normalizePgDump(text) {
  const lines = normalize(Buffer.from(text, 'latin1')).split('\n');
  const server = lines.map((l) => /^-- Dumped from database version (\S+)/.exec(l)?.[1]).find(Boolean) || null;
  const kept = lines.filter((l) => !/^\\(un)?restrict\s/.test(l) && !/^-- (Dumped (from database|by pg_dump) version|Started on|Completed on) /.test(l));
  const major = !server ? '?' : Number(server.split('.')[0]) >= 10 ? server.split('.')[0] : server.split('.').slice(0, 2).join('.');
  return { server, text: `server ${major}\n${kept.join('\n')}` };
}

function readPg(probe) {
  const name = PG.exec(probe)[1];
  const url = name ? process.env[name] : process.env.DATABASE_URL;
  if (name && !url) throw new Error(`${name} is not set`);
  const args = ['--schema-only', '--no-owner', '--no-privileges', ...(url ? [`--dbname=${libpqUrl(url)}`] : [])];
  return normalizePgDump(output(run('pg_dump', args, {}), 'pg_dump').toString('latin1'));
}

// Why a receipt's inputs keep it from counting now, given fresh readings (`now`); none = it counts.
export function inputProblems(recorded, now) {
  const out = [];
  for (const [name, rec] of Object.entries(recorded || {})) {
    const cur = now[name];
    if (rec.error) out.push(`input ${name} could not be read for that run (${rec.error})`);
    else if ('atEnd' in rec && rec.atEnd !== rec.sha256) out.push(`${name} changed during the run`);
    else if (!cur) out.push(`it depends on input ${name}: check it with --input ${name}=${rec.probe}`);
    else if (cur.probe !== rec.probe) out.push(`input ${name} was read with ${rec.probe}, not ${cur.probe}`);
    else if (cur.error) out.push(`input ${name} can't be read now (${cur.error})`);
    else if (cur.sha256 !== rec.sha256) out.push(`${name} has changed since (${short(rec.sha256)} then, ${short(cur.sha256)} now)`);
  }
  return out;
}

// For a one-line summary: "db 1a2b3c4", or what is wrong with it.
export const describeInputs = (inputs) =>
  Object.entries(inputs || {}).map(([name, r]) => (r.error ? `${name} unreadable (${r.error})` : `${name} ${short(r.sha256)}`)).join(', ');
