import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readClock, startClock } from '../src/clock.mjs';
import { inputProblems, libpqUrl, normalizePgDump, parseInputs, redact } from '../src/inputs.mjs';
import { failedTestNames, parseSummary, readJestJson, readJunitXml, testSignals, testTitles } from '../src/parse.mjs';
import { jsCrashSite, pyCrashSite, pySummary } from '../src/runners.mjs';
import { safeRemoveTree, scratchRoot } from '../src/scratch.mjs';
import { findTests, transplant } from '../src/transplant.mjs';
import { failureSummary, globToRegExp, relativize } from '../src/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'goalline.mjs');
const FAKE = path.join(here, 'fake-jest.mjs');
const FAKE_VITEST = path.join(here, 'fake-vitest.mjs');
const TMP = fs.realpathSync.native(os.tmpdir());
const RHOME = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
const SCRATCH = fs.mkdtempSync(path.join(TMP, 'receipts-scratch-'));
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const cliEnv = (extra, cwd, ...args) => {
  const env = { ...process.env, ...GIT_ENV, GOALLINE_HOME: RHOME, GOALLINE_SCRATCH: SCRATCH, ...extra };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
};
const cliIn = (home, cwd, ...args) => cliEnv({ GOALLINE_HOME: home }, cwd, ...args);
const cli = (cwd, ...args) => cliIn(RHOME, cwd, ...args);
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();
const write = (dir, rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const commit = (dir, msg) => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
};
const receiptFiles = (home) =>
  fs.readdirSync(path.join(home, 'store'), { recursive: true }).filter((f) => f.endsWith('.dsse.json')).map((f) => path.join(home, 'store', f));
const statementOf = (file) => JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).payload, 'base64').toString('utf8'));

const ADD = 'export const add = (a, b) => a + b;\n';
const ADD_TEST = [
  "import { add } from '../src/add.mjs';",
  "test('adds two numbers', () => {",
  '  const got = add(2, 3);',
  '  if (got !== 5) throw new Error(`Expected: 5\\nReceived: ${got}`);',
  '});',
  '',
].join('\n');

function repo(files = { 'src/add.mjs': ADD, 'test/add.test.mjs': ADD_TEST }) {
  const dir = fs.mkdtempSync(path.join(TMP, 'receipts-fx-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, '.gitignore', 'node_modules/\n');
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  commit(dir, 'base');
  return dir;
}

function onBranch(dir, name, edits) {
  git(dir, 'checkout', '-q', '-b', name, 'main');
  for (const [rel, text] of Object.entries(edits)) {
    if (text === null) fs.rmSync(path.join(dir, rel));
    else write(dir, rel, text);
  }
  commit(dir, name);
}

const runGate = (dir, home = RHOME) => cliIn(home, dir, 'run', '--gate', 'unit', '--no-machine', '--', 'node', FAKE, 'test/add.test.mjs');
const goalpost = (dir) => cli(dir, 'goalpost', '--base', 'main', '--quiet', '--', 'node', FAKE, '{files}');
const proveRed = (dir) => cli(dir, 'prove-red', '--base', 'main', '--quiet', '--', 'node', FAKE, '{files}');
const MOVED_EDITS = {
  'src/add.mjs': 'export const add = (a, b) => a + b + 1;\n',
  'test/add.test.mjs': ADD_TEST.replaceAll('5', '6'),
};

test('a receipt verifies only for the exact code it ran on', () => {
  const dir = repo();
  const r = runGate(dir);
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /unit PASSED · 1\/1 passed/);
  let v = cli(dir, 'verify', '--require', 'unit');
  assert.equal(v.code, 0, v.all);
  assert.match(v.out, /unit\s+VERIFIED/);
  write(dir, 'src/add.mjs', `${ADD}// edited\n`);
  v = cli(dir, 'verify', '--require', 'unit');
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /unit\s+MISSING/);
  write(dir, 'src/add.mjs', ADD);
  assert.equal(cli(dir, 'verify', '--require', 'unit').code, 0);
});

test('a same-size edit in the second git last wrote its index still changes the fingerprint', () => {
  // git trusts a file's cached size and mtime only when the file is older than the index; in the
  // index's own second it reads the file. Only size and whole-second mtime count here, on any OS.
  const dir = repo();
  git(dir, 'config', 'core.checkStat', 'minimal');
  git(dir, 'config', 'core.trustctime', 'false');
  assert.equal(runGate(dir).code, 0);
  const file = path.join(dir, 'src/add.mjs');
  const second = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(file, second, second);
  git(dir, 'update-index', '--refresh');
  fs.utimesSync(path.join(dir, '.git', 'index'), second, second);
  write(dir, 'src/add.mjs', ADD.replace('a + b', 'b + a'));
  fs.utimesSync(file, second, second);
  const v = cli(dir, 'verify', '--require', 'unit');
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /unit\s+MISSING/);
});

// A probe that prints a file (a stand-in for a database's schema), and a gate that rewrites it.
const READ_PROBE = path.join(TMP, 'goalline-read-probe.mjs');
fs.writeFileSync(READ_PROBE, "import fs from 'node:fs';\nprocess.stdout.write(fs.readFileSync(process.argv[2]));\n");
const BUMP = path.join(TMP, 'goalline-bump.mjs');
fs.writeFileSync(BUMP, "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'migrated during the run\\n');\n");
// The URL is never read: it is there to show a password does not reach the receipt.
const probeOf = (file) => `db=node "${READ_PROBE}" "${file}" postgresql://app:s3cret@db.invalid/app`;
const schemaFile = (text) => {
  const file = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-db-')), 'schema.sql');
  fs.writeFileSync(file, text);
  return file;
};

test('--input: a receipt counts only while the same probe reads the same, and never when it changed during the run', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo();
  const schema = schemaFile('create table users (id int);\r\n');
  const input = probeOf(schema);
  const gate = (...extra) => cliIn(home, dir, 'run', '--gate', 'api', '--no-machine', '--input', input, ...extra, '--', 'node', FAKE, 'test/add.test.mjs');
  let r = gate();
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /api PASSED · .* · db [0-9a-f]{7}/);
  const stored = JSON.stringify(receiptFiles(home).map(statementOf));
  assert.match(stored, /postgresql:\/\/app:\*\*\*@db\.invalid/);
  assert.doesNotMatch(stored, /s3cret/);

  const verify = (...extra) => cliIn(home, dir, 'verify', '--require', 'api', ...extra);
  let v = verify();
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /it depends on input db: check it with --input db=node /);
  v = verify('--input', input);
  assert.equal(v.code, 0, v.all);
  assert.match(v.out, /api\s+VERIFIED/);
  assert.match(v.out, /· db [0-9a-f]{7}\n/);
  // Line endings aside, it is the same schema (read on another OS, say).
  fs.writeFileSync(schema, 'create table users (id int);\n');
  assert.equal(verify('--input', input).code, 0);
  v = verify('--input', `db=node "${READ_PROBE}" "${schema}"`);
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /input db was read with node .*, not node /);

  fs.writeFileSync(schema, 'create table users (id bigint);\n');
  v = verify('--input', input);
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /db has changed since \([0-9a-f]{7} then, [0-9a-f]{7} now\)/);
  r = gate('--reuse');
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /api: runs: the earlier pass on this code does not count \(db has changed since/);
  assert.doesNotMatch(r.err, /REUSED/);
  assert.match(gate('--reuse').err, /api REUSED/);

  r = cliIn(home, dir, 'run', '--gate', 'migrations', '--no-machine', '--input', input, '--', `node "${BUMP}" "${schema}"`);
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /INPUT CHANGED DURING THE RUN \(db\), so this receipt will not verify/);
  v = cliIn(home, dir, 'verify', '--require', 'migrations', '--input', input);
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /db changed during the run/);
});

test('rules say which gates an input applies to; one they name that no --input reads, or a probe that fails, proves nothing', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo();
  const input = probeOf(schemaFile('create table users (id int);\n'));
  const rules = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-rules-')), 'rules.json');
  fs.writeFileSync(rules, JSON.stringify({ inputs: { 'api-*': ['db'] } }));
  const run = (gate, ...extra) => cliIn(home, dir, 'run', '--gate', gate, '--no-machine', '--rules', rules, ...extra, '--', 'node', FAKE, 'test/add.test.mjs');
  const verify = (gate, ...extra) => cliIn(home, dir, 'verify', '--require', gate, ...extra);

  // unit does not depend on the database, so its receipt never needs the probe.
  assert.equal(run('unit', '--input', input).code, 0);
  assert.equal(verify('unit').code, 0);

  let r = run('api-users');
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /api-users: input db could not be read \(no --input reads it\); this run will not count as proof/);
  let v = verify('api-users', '--input', input);
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /input db could not be read for that run \(no --input reads it\)/);
  assert.equal(run('api-users', '--input', input).code, 0);
  assert.equal(verify('api-users', '--input', input).code, 0);

  const missing = path.join(TMP, 'goalline-no-such-schema.sql');
  r = run('api-orders', '--input', probeOf(missing));
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /input db could not be read \(the probe exited 1: /);
  v = verify('api-orders', '--input', probeOf(missing));
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /input db could not be read for that run \(the probe exited 1/);
});

test('db=pg reads the schema without the lines pg_dump changes on every dump; Prisma URLs and passwords are handled', () => {
  const dump = (key, server, client, type) =>
    ['--', '-- PostgreSQL database dump', '--', '', `\\restrict ${key}`, '', `-- Dumped from database version ${server}`, `-- Dumped by pg_dump version ${client}`, '',
      'SET statement_timeout = 0;', '', `CREATE TABLE public.users (\n    id ${type} NOT NULL\n);`, '', '--', '-- PostgreSQL database dump complete', '--', '', `\\unrestrict ${key}`, ''].join('\n');
  const a = normalizePgDump(dump('aB3xQ', '16.4 (Ubuntu 16.4-1.pgdg24.04+1)', '16.4', 'integer'));
  const b = normalizePgDump(dump('Zq9Lm', '16.10 (Ubuntu 16.10-0ubuntu0.24.04.1)', '17.6', 'integer'));
  assert.equal(a.text, b.text);
  assert.equal(b.server, '16.10');
  assert.match(a.text, /^server 16\n/);
  assert.doesNotMatch(a.text, /restrict|Dumped/);
  assert.notEqual(normalizePgDump(dump('aB3xQ', '16.4', '16.4', 'bigint')).text, a.text);
  assert.notEqual(normalizePgDump(dump('aB3xQ', '17.0', '17.6', 'integer')).text, a.text);
  assert.match(normalizePgDump(dump('k', '9.6.24', '16.4', 'integer')).text, /^server 9\.6\n/);

  assert.equal(libpqUrl('postgresql://u:p@h:5432/app?schema=public&sslmode=require&connection_limit=5'), 'postgresql://u:p@h:5432/app?sslmode=require');
  assert.equal(libpqUrl('postgres://h/app?schema=public'), 'postgres://h/app');
  assert.equal(libpqUrl('host=h dbname=app'), 'host=h dbname=app');
  assert.equal(redact('pg_dump postgresql://u:s3cr3t@h/app --schema-only'), 'pg_dump postgresql://u:***@h/app --schema-only');
  assert.equal(redact('mysqldump mysql://root@h/x'), 'mysqldump mysql://root@h/x');
  assert.deepEqual(parseInputs(['db=pg', 'flags=echo a=b']), { db: 'pg', flags: 'echo a=b' });
  assert.throws(() => parseInputs(['db']), /--input needs name=<probe>/);
  assert.throws(() => parseInputs(['db=pg', 'db=pg:TEST_DB_URL']), /--input db is given twice/);
  assert.deepEqual(inputProblems({ db: { probe: 'pg', sha256: 'a'.repeat(64), atEnd: 'a'.repeat(64) } }, { db: { probe: 'pg', sha256: 'a'.repeat(64) } }), []);
});

test('db=pg on a live PostgreSQL: the same schema verifies, a migration does not', { skip: !process.env.GOALLINE_TEST_PG && 'set GOALLINE_TEST_PG to a database URL' }, () => {
  const url = process.env.GOALLINE_TEST_PG;
  const psql = (sql) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qc', sql]);
  psql('DROP TABLE IF EXISTS goalline_probe; CREATE TABLE goalline_probe (id int);');
  try {
    const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
    const dir = repo();
    const r = cliIn(home, dir, 'run', '--gate', 'api', '--no-machine', '--input', 'db=pg:GOALLINE_TEST_PG', '--', 'node', FAKE, 'test/add.test.mjs');
    assert.equal(r.code, 0, r.all);
    assert.match(r.err, /· db [0-9a-f]{7}/);
    assert.match(statementOf(receiptFiles(home)[0]).predicate.configuration[0].annotations.inputs.db.server, /^\d+(\.\d+)*$/);
    // A second pg_dump writes a new random \restrict key: still the same schema.
    let v = cliIn(home, dir, 'verify', '--require', 'api', '--input', 'db=pg:GOALLINE_TEST_PG');
    assert.equal(v.code, 0, v.all);
    psql('ALTER TABLE goalline_probe ADD COLUMN name text;');
    v = cliIn(home, dir, 'verify', '--require', 'api', '--input', 'db=pg:GOALLINE_TEST_PG');
    assert.equal(v.code, 1, v.all);
    assert.match(v.out, /db has changed since/);
  } finally {
    psql('DROP TABLE IF EXISTS goalline_probe;');
  }
});

// The project's code reads the clock in src/stamp.mjs, and in a test through a date library. The
// third test only reads a fake clock and lets a library read the real one for itself.
const CLOCK_FILES = {
  'src/stamp.mjs': "export const today = () => new Date().toISOString().slice(0, 10);\n",
  'test/stamp.test.mjs': "import { today } from '../src/stamp.mjs';\ntest('today is a date', () => { if (today().length !== 10) throw new Error('bad'); });\n",
  'node_modules/dayjs/package.json': '{ "name": "dayjs", "main": "index.js" }\n',
  'node_modules/dayjs/index.js': 'module.exports = () => new Date();\n',
  'test/dayjs.test.mjs': "import dayjs from 'dayjs';\ntest('dayjs reads the clock', () => { if (!(dayjs() instanceof Date)) throw new Error('bad'); });\n",
  'node_modules/stopwatch/package.json': '{ "name": "stopwatch", "main": "index.js" }\n',
  'node_modules/stopwatch/index.js': 'module.exports = () => Date.now();\n',
  'test/frozen.test.mjs': [
    "import stopwatch from 'stopwatch';",
    "test('a fake clock, and a library that times itself', () => {",
    '  const Real = Date;',
    '  globalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [0])); } static now() { return 0; } };',
    "  try { if (new Date().getTime() !== 0 || Date.now() !== 0) throw new Error('not frozen'); } finally { globalThis.Date = Real; }",
    "  if (typeof stopwatch() !== 'number' || new Date(0).getTime() !== 0) throw new Error('bad');",
    '});',
    '',
  ].join('\n'),
};
// The newest receipt's clock record: receipt file names start with the time they were made.
const newest = (home) => receiptFiles(home).sort((a, b) => path.basename(a).localeCompare(path.basename(b))).at(-1);
const clockOf = (home) => statementOf(newest(home)).predicate.configuration[0].annotations.clock;

test('clock: a pass that read the real clock counts until midnight (or --clock-ttl); fake clocks and libraries timing themselves do not count', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const rules = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-rules-')), 'rules.json');
  fs.writeFileSync(rules, JSON.stringify({ ignore: ['**/*.md'], areas: { src: ['src/**'], tests: ['test/**'] }, gates: { '*': ['src', 'tests'] } }));
  const dir = repo({ ...CLOCK_FILES });
  const gate = (name, file, ...extra) => cliIn(home, dir, 'run', '--gate', name, '--no-machine', ...extra, '--', 'node', FAKE, file);
  const verify = (name) => cliIn(home, dir, 'verify', '--require', name);

  let r = gate('frozen', 'test/frozen.test.mjs', '--clock-ttl', '0');
  assert.equal(r.code, 0, r.all);
  assert.doesNotMatch(r.err, /real clock/);
  assert.deepEqual(clockOf(home), { watched: true, reads: 0, sites: [] });
  assert.equal(verify('frozen').code, 0, 'a gate that never read the clock does not expire');

  const startedAt = Date.now();
  r = gate('stamp', 'test/stamp.test.mjs');
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /stamp PASSED · .* · reads the real clock \(1 read\(s\), e\.g\. src\/stamp\.mjs:1\): counts until \d\d-\d\d 00:00/);
  let clock = clockOf(home);
  assert.deepEqual(clock.sites, [['src/stamp.mjs:1', 1]]);
  const midnight = new Date(startedAt);
  midnight.setHours(24, 0, 0, 0);
  assert.equal(clock.expires, midnight.toISOString());
  let v = verify('stamp');
  assert.equal(v.code, 0, v.all);
  assert.match(v.out, /stamp\s+VERIFIED .* reads the clock: counts until \d\d-\d\d 00:00/);

  // Carried over a change it can't depend on, the pass still expires when it would have.
  write(dir, 'README.md', '# readme\n');
  r = gate('stamp', 'test/stamp.test.mjs', '--rules', rules, '--trust-rules');
  assert.match(r.err, /stamp CARRIED/);
  assert.equal(clockOf(home).expires, clock.expires);

  r = gate('dayjs', 'test/dayjs.test.mjs');
  assert.deepEqual(clockOf(home).sites, [['test/dayjs.test.mjs:2', 1]], 'a date library reads the clock for its caller');

  r = gate('today', 'test/stamp.test.mjs', '--clock-ttl', '0');
  assert.equal(r.code, 0, r.all);
  v = verify('today');
  assert.equal(v.code, 1, v.all);
  assert.match(v.out, /it read the real clock \(src\/stamp\.mjs:1\), so its pass expired at \d\d-\d\d \d\d:\d\d/);
  r = gate('today', 'test/stamp.test.mjs', '--reuse');
  assert.match(r.err, /today: runs: the earlier pass on this code does not count \(it read the real clock/);
  // The rerun counts until midnight; only the expired pass can never prove anything again.
  const pruned = cliIn(home, dir, 'prune', '--dry-run').out;
  assert.match(pruned, /would remove .* today .*\(a pass that read the real clock, expired\)/);
  assert.equal(pruned.match(/would remove/g).length, 1, pruned);

  assert.equal(gate('x', 'test/stamp.test.mjs', '--clock-ttl', '5x').code, 64);
});

test("clock: Jest's vm contexts and worker threads are watched; only Node test runners are judged; --no-clock turns it off", () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo({
    ...CLOCK_FILES,
    'src/print.mjs': "console.log(new Date().toISOString());\n",
    // A Jest-style environment: the test runs in a vm context whose stacks print through source
    // maps (here: 100 lines on), then the process reads more than the watch follows, and a worker
    // thread reads too. A file outside the repository, and a fake clock, don't count.
    'test/contexts.cjs': [
      "const vm = require('vm');",
      "const path = require('path');",
      "const { Worker, isMainThread } = require('worker_threads');",
      'if (isMainThread) {',
      "  const env = path.join(__dirname, 'env.test.js');",
      '  const context = vm.createContext();',
      "  vm.runInContext('new Date(); Date.now(); Date();', context, { filename: env });",
      "  vm.runInContext('Error.prepareStackTrace = (e, cs) => [String(e), ...cs.map((c) => `    at ${c.getFileName()}:${c.getLineNumber() + 100}:1`)].join(\"\\\\n\"); Date.now();', context, { filename: env });",
      "  vm.runInContext('Date.now();', context, { filename: path.join(__dirname, '..', '..', 'elsewhere.js') });",
      "  vm.runInContext('Date = class extends Date { static now() { return 0; } }; Date.now();', context, { filename: env });",
      '  new Worker(__filename);',
      '  for (let i = 0; i < 1005; i++) Date.now();',
      '} else {',
      '  Date.now();',
      '}',
      '',
    ].join('\n'),
  });
  // Windows may name the same folder by its short 8.3 alias (C:\Users\LONGNA~1): reads still count.
  const alias = path.join(os.tmpdir(), path.relative(TMP, dir));
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--max-old-space-size=512';
  let clock;
  try {
    clock = startClock(alias);
  } finally {
    if (before === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = before;
  }
  assert.match(clock.env.NODE_OPTIONS, /^--max-old-space-size=512 --require "[^"\\]+clock-preload\.cjs"$/, 'kept, and without backslashes');
  const r = spawnSync(process.execPath, [path.join(dir, 'test', 'contexts.cjs')], { env: { ...process.env, ...clock.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const seen = readClock(clock);
  assert.ok(!fs.existsSync(clock.dir));
  const sites = Object.fromEntries(seen.flatMap((s) => s.sites));
  assert.deepEqual(sites, { 'test/env.test.js:1': 3, 'test/env.test.js:101': 1, 'test/contexts.cjs:12': 996, 'test/contexts.cjs:14': 1 }, JSON.stringify(seen));
  assert.equal(seen.reduce((n, s) => n + s.contexts, 0), 1);
  assert.ok(seen.some((s) => s.capped && s.reads === 1000), 'the watch stops following after 1000 reads');

  const gate = (name, ...cmd) => cliIn(home, dir, 'run', '--gate', name, '--no-machine', ...cmd);
  let g = gate('off', '--no-clock', '--', 'node', FAKE, 'test/stamp.test.mjs');
  assert.equal(g.code, 0, g.all);
  assert.deepEqual(clockOf(home), { watched: false, why: 'turned off (--no-clock)' });
  g = gate('script', '--', 'node', 'src/print.mjs');
  assert.equal(g.code, 0, g.all);
  assert.deepEqual(clockOf(home), { watched: false, why: 'no Jest, Vitest or node --test summary in the output' });
});

test("another test runner during the gate makes the run not idle; the gate's own processes and the tool's starters never count", async () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo();
  const machineOf = () => statementOf(receiptFiles(home).sort().at(-1)).predicate.configuration[0].annotations.machine;
  // A sibling process whose command line names jest, like another agent's test run, and one that
  // only looks like it: a verify (by the old command name) naming a gate called web-jest.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'jest'], { stdio: 'ignore' });
  const verifyLike = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'bin/receipts.mjs', 'verify', '--require', 'web-jest'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const busy = cliIn(home, dir, 'run', '--gate', 'unit', '--', 'node', FAKE, 'test/add.test.mjs');
    assert.equal(busy.code, 0, busy.all);
    assert.match(busy.err, /NOT idle/);
  } finally {
    other.kill();
    verifyLike.kill();
  }
  let m = machineOf();
  assert.equal(m.idle, false);
  assert.ok(m.foreignSeen.some((p) => p.pid === other.pid), JSON.stringify(m.foreignSeen));
  assert.ok(!m.foreignSeen.some((p) => p.pid === verifyLike.pid), 'a goalline verify is not a test run');
  assert.ok(Number.isInteger(m.cpuBusyStartPct), `cpu ${m.cpuBusyStartPct}`);
  // This test process and node --test above it started the tool; the fake jest run is the
  // gate's own child. None of them is another runner, whatever else the machine is doing.
  cliIn(home, dir, 'run', '--gate', 'unit', '--', 'node', FAKE, 'test/add.test.mjs');
  m = machineOf();
  assert.ok(!m.foreignSeen.some((p) => [process.pid, process.ppid].includes(p.pid) || /fake-jest/.test(p.cmd)), JSON.stringify(m.foreignSeen));
});

const ran = (r) => /Tests:\s+\d/.test(r.out);

test('--reuse skips a gate this exact code already passed, and records the time saved', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo();
  const gate = (...extra) => cliIn(home, dir, 'run', '--gate', 'unit', '--no-machine', '--reuse', ...extra, '--', 'node', FAKE, 'test/add.test.mjs');
  assert.ok(ran(gate()), 'the first run has nothing to reuse');
  const again = gate();
  assert.equal(again.code, 0, again.all);
  assert.ok(!ran(again), again.all);
  assert.match(again.err, /unit REUSED · this exact code already passed it \(1 run\(s\)/);
  assert.equal(receiptFiles(home).length, 1);
  assert.match(cliIn(home, dir, 'trial-report').out, /Reused instead of run: 1 gate run\(s\)/);
  write(dir, 'src/add.mjs', `${ADD}// changed\n`);
  assert.ok(ran(gate()), 'changed code runs again');

  // Two passes needed: the second run still runs, the third is reused.
  const twice = (...extra) => gate('--reuse-runs', '2', ...extra);
  assert.ok(ran(twice()));
  assert.ok(!ran(twice()));
  // An idle pass needed: runs without the machine check are never idle, so it runs.
  assert.ok(ran(gate('--reuse-runs', '2', '--reuse-idle')));
});

test('rules: a trial runs the gate and records whether carrying the earlier pass would have been right', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const rulesDir = fs.mkdtempSync(path.join(TMP, 'receipts-rules-'));
  const rules = path.join(rulesDir, 'rules.json');
  fs.writeFileSync(rules, JSON.stringify({ ignore: ['**/*.md'], areas: { src: ['src/**'], tests: ['test/**'], other: ['other/**'] }, gates: { unit: ['src', 'tests'] } }));
  const dir = repo();
  const gate = (...extra) => cliIn(home, dir, 'run', '--gate', 'unit', '--no-machine', '--rules', rules, ...extra, '--', 'node', FAKE, 'test/add.test.mjs');
  assert.ok(ran(gate()));

  // A change outside what the gate depends on: the trial still runs it, and agrees.
  write(dir, 'other/notes.txt', 'x');
  let r = gate();
  assert.ok(ran(r));
  assert.match(r.err, /rules trial · unit would have been carried from \w+; the real run PASSED: agrees/);

  // Trusted: an ignored file only, so the pass is carried and verify says so.
  write(dir, 'README.md', '# readme\n');
  r = gate('--trust-rules');
  assert.equal(r.code, 0, r.all);
  assert.ok(!ran(r), r.all);
  assert.match(r.err, /unit CARRIED · passed on \w+; the \d+ file\(s\) changed since are outside what it depends on/);
  const v = cliIn(home, dir, 'verify', '--require', 'unit');
  assert.equal(v.code, 0, v.all);
  assert.match(v.out, /unit\s+CARRIED\s+1\s+0\s+carried from tree/);

  // A file it depends on, or a file in no area at all: runs, even when trusted.
  write(dir, 'src/add.mjs', `${ADD}// changed\n`);
  r = gate('--trust-rules');
  assert.ok(ran(r));
  assert.match(r.err, /had to run: since the pass on \w+: src\/add\.mjs is in src, which unit depends on/);
  write(dir, 'tool.config.json', '{}');
  r = gate('--trust-rules');
  assert.ok(ran(r));
  assert.match(r.err, /tool\.config\.json is in no area, so it can affect anything/);
  assert.match(cliIn(home, dir, 'trial-report').out, /would have skipped 1 [\s\S]*agreed 1 time\(s\), and DISAGREED 0/);
});

test('rules trial: a run that failed because of the machine is inconclusive, not a disagreement', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const rulesDir = fs.mkdtempSync(path.join(TMP, 'receipts-rules-'));
  const rules = path.join(rulesDir, 'rules.json');
  fs.writeFileSync(rules, JSON.stringify({ areas: { src: ['src/**'], tests: ['test/**'], other: ['other/**'] }, gates: { unit: ['src', 'tests'] } }));
  const dir = repo();
  const gate = (...cmd) => cliIn(home, dir, 'run', '--gate', 'unit', '--no-machine', '--rules', rules, '--', ...cmd);
  assert.equal(gate('node', FAKE, 'test/add.test.mjs').code, 0);
  // A change the gate does not depend on, and a run that dies of the machine, not the code.
  write(dir, 'other/oom.mjs', "console.log('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');\nprocess.exit(134);\n");
  const r = gate('node', 'other/oom.mjs');
  assert.equal(r.code, 134, r.all);
  assert.match(r.err, /the real run FAILED: inconclusive \(the test process ran out of memory\)/);
  const report = cliIn(home, dir, 'trial-report').out;
  assert.match(report, /agreed 0 time\(s\), and DISAGREED 0 time\(s\)/);
  assert.match(report, /Inconclusive 1 time\(s\)[\s\S]*unit on \w+: the test process ran out of memory/);
});

test('rules: install and build gates named in neverReuse always run, even on the same code', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const rules = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-rules-')), 'rules.json');
  fs.writeFileSync(rules, JSON.stringify({ neverReuse: ['npm-ci', '*build*'], areas: { src: ['src/**'] }, gates: { '*': ['src'] } }));
  const dir = repo();
  for (const gate of ['npm-ci', 'web-build', 'unit']) {
    const run = () => cliIn(home, dir, 'run', '--gate', gate, '--no-machine', '--reuse', '--rules', rules, '--', 'node', FAKE, 'test/add.test.mjs');
    assert.ok(ran(run()));
    const again = run();
    if (gate === 'unit') assert.ok(!ran(again), 'an ordinary gate is reused');
    else {
      assert.ok(ran(again), `${gate} must run again`);
      assert.match(again.err, new RegExp(`${gate}: never reused`));
    }
  }
});

test('rules: an install or build is reused on the same code only while its output is still the one it made', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const tools = fs.mkdtempSync(path.join(TMP, 'receipts-tools-'));
  const rules = path.join(tools, 'rules.json');
  fs.writeFileSync(rules, JSON.stringify({ neverReuse: ['build'], outputs: { build: ['out/build.txt'] }, areas: { src: ['src/**'] }, gates: {} }));
  // Each build writes a different file, like a build id. out/ is ignored, so the code stays the same.
  const script = path.join(tools, 'build.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs';\nfs.mkdirSync('out', { recursive: true });\nfs.writeFileSync('out/build.txt', String(Math.random()));\n");
  const dir = repo();
  write(dir, '.gitignore', 'node_modules/\nout/\n');
  commit(dir, 'ignore build output');
  const build = () => cliIn(home, dir, 'run', '--gate', 'build', '--no-machine', '--reuse', '--rules', rules, '--', 'node', script);

  let r = build();
  assert.match(r.err, /build: runs: no earlier pass on this exact code/);
  assert.match(r.err, /build PASSED/);
  r = build();
  assert.match(r.err, /build REUSED · this exact code already passed it, and its output \(out\/build\.txt\) is still the one that run made/);
  write(dir, 'out/build.txt', 'made by some other build');
  r = build();
  assert.match(r.err, /build: runs: its output has changed since that pass/);
  assert.match(r.err, /build PASSED/);
  fs.rmSync(path.join(dir, 'out'), { recursive: true });
  r = build();
  assert.match(r.err, /build: runs: its output is missing \(out\/build\.txt\)/);
});

test('rules: a gate that tests a build counts only if that build was made from the same code', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const tools = fs.mkdtempSync(path.join(TMP, 'receipts-tools-'));
  const rules = path.join(tools, 'rules.json');
  fs.writeFileSync(rules, JSON.stringify({ neverReuse: ['build'], outputs: { build: ['out/build.txt'] }, uses: { browser: ['build'] }, areas: { src: ['src/**'] }, gates: {} }));
  const script = path.join(tools, 'build.mjs');
  fs.writeFileSync(script, "import fs from 'node:fs';\nfs.mkdirSync('out', { recursive: true });\nfs.writeFileSync('out/build.txt', String(Math.random()));\n");
  const dir = repo();
  write(dir, '.gitignore', 'node_modules/\nout/\n');
  commit(dir, 'ignore build output');
  const build = () => cliIn(home, dir, 'run', '--gate', 'build', '--no-machine', '--rules', rules, '--', 'node', script);
  const browser = (...command) => cliIn(home, dir, 'run', '--gate', 'browser', '--no-machine', '--rules', rules, '--', ...(command.length ? command : ['node', FAKE, 'test/add.test.mjs']));
  const verify = () => cliIn(home, dir, 'verify', '--require', 'browser');

  // Nothing built yet: the suite runs, but its pass can't count for this code.
  let r = browser();
  assert.match(r.err, /browser: WARNING: the build output is missing \(out\/build\.txt\)\. This run will not count for this code/);
  assert.match(r.err, /browser WARNED/);
  assert.match(verify().out, /Run only: browser \(a run without warnings\)/);

  // Built from this code: it counts, and the receipt names the build run it tested.
  build();
  r = browser();
  assert.match(r.err, /browser PASSED/);
  assert.equal(verify().code, 0);
  const latest = statementOf(receiptFiles(home).filter((f) => f.includes(`${path.sep}browser${path.sep}`)).sort().at(-1));
  assert.match(latest.predicate.configuration[0].annotations.builds.checked.build, /\.dsse\.json$/);

  // Another build overwrote it (the code itself is unchanged): it no longer counts.
  write(dir, 'out/build.txt', 'built from some other code');
  r = browser();
  assert.match(r.err, /the build output on disk was not made by its passing run on this code/);
  assert.match(r.err, /browser WARNED/);

  // Rebuilt, then changed while the suite ran: it doesn't count either.
  build();
  r = browser('node', script);
  assert.match(r.err, /build: the build output changed during the run/);
  assert.match(r.err, /browser WARNED/);
});

test('verify says exactly which gates to run, and nothing once everything is proven', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo();
  const verify = () => cliIn(home, dir, 'verify', '--require', 'unit,lint:2');
  const gate = (name) => cliIn(home, dir, 'run', '--gate', name, '--no-machine', '--', 'node', FAKE, 'test/add.test.mjs');
  assert.match(verify().out, /Run only: lint \(2 passing runs\), unit \(a passing run\)\. Every other required gate is proven: do not re-run it\./);
  gate('unit');
  gate('lint');
  assert.match(verify().out, /Run only: lint \(1 more passing run\(s\)\)\./);
  gate('lint');
  const v = verify();
  assert.equal(v.code, 0, v.all);
  assert.match(v.out, /All required gates are proven for this exact code\. Nothing to re-run\./);
});

test('rules: a wrong rule shows up as a disagreement, and the report says not to trust it', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const rules = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-rules-')), 'rules.json');
  // Wrong on purpose: the gate's tests import src/, but the rule says it depends on tests/ only.
  fs.writeFileSync(rules, JSON.stringify({ areas: { src: ['src/**'], tests: ['test/**'] }, gates: { unit: ['tests'] } }));
  const dir = repo();
  const gate = () => cliIn(home, dir, 'run', '--gate', 'unit', '--no-machine', '--rules', rules, '--', 'node', FAKE, 'test/add.test.mjs');
  assert.ok(ran(gate()));
  write(dir, 'src/add.mjs', 'export const add = (a, b) => a - b;\n');
  const r = gate();
  assert.equal(r.code, 1);
  assert.match(r.err, /would have been carried from \w+; the real run FAILED: DISAGREES/);
  const report = cliIn(home, dir, 'trial-report').out;
  assert.match(report, /DISAGREED 1 time\(s\)/);
  assert.match(report, /Do not trust the rules/);
});

test('a receipt made on uncommitted work verifies once that exact work is committed', () => {
  const dir = repo();
  write(dir, 'src/add.mjs', 'export const add = (a, b) => b + a;\n');
  assert.equal(runGate(dir).code, 0);
  commit(dir, 'swap operands');
  const v = cli(dir, 'verify', '--require', 'unit');
  assert.equal(v.code, 0, v.all);
  assert.match(v.out, /= commit/);
});

test('a failing run keeps its exit code and its receipt does not verify', () => {
  const dir = repo();
  write(dir, 'src/add.mjs', 'export const add = (a, b) => a - b;\n');
  const r = runGate(dir);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /unit FAILED/);
  const v = cli(dir, 'verify', '--require', 'unit');
  assert.equal(v.code, 1);
  assert.match(v.out, /REJECTED[\s\S]*failed \(exit 1\)/);
});

test('the gate still runs, with its own exit code, when no receipt can be saved', () => {
  // GOALLINE_HOME is a file, so the key folder can't be created (like a sandbox with no write access).
  const blocked = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-blocked-')), 'home');
  fs.writeFileSync(blocked, 'not a folder');
  const dir = repo();
  const ok = runGate(dir, blocked);
  assert.equal(ok.code, 0, ok.all);
  assert.match(ok.out, /Tests:\s+1 passed, 1 total/);
  assert.match(ok.err, /no receipt will be saved/);
  write(dir, 'src/add.mjs', 'export const add = (a, b) => a - b;\n');
  assert.equal(runGate(dir, blocked).code, 1);
});

test('an edited receipt is rejected', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo();
  write(dir, 'src/add.mjs', 'export const add = (a, b) => a - b;\n');
  assert.equal(runGate(dir, home).code, 1);
  const [file] = receiptFiles(home);
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  statement.predicate.result = 'PASSED';
  envelope.payload = Buffer.from(JSON.stringify(statement)).toString('base64');
  fs.writeFileSync(file, JSON.stringify(envelope));
  const v = cliIn(home, dir, 'verify', '--require', 'unit');
  assert.equal(v.code, 1);
  assert.match(v.out, /the receipt was edited/);
});

test('goalpost: tests that were only extended hold', () => {
  const dir = repo();
  onBranch(dir, 'extend', {
    'test/add.test.mjs': `${ADD_TEST}test('adds negatives', () => { if (add(-1, -2) !== -3) throw new Error('bad'); });\n`,
  });
  const r = goalpost(dir);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /HELD\s+test\/add\.test\.mjs/);
});

test('goalpost: code and its test edited together are flagged as moved', () => {
  const dir = repo();
  onBranch(dir, 'moved', MOVED_EDITS);
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/add\.test\.mjs/);
  assert.match(r.out, /✗ adds two numbers: Expected 5, received 6/);
  assert.match(r.out, /FLAGGED/);
  assert.match(cli(dir, 'verify').out, /goalpost\s+FLAGGED/);
});

test('goalpost: a deleted test file is run too', () => {
  const dir = repo();
  onBranch(dir, 'delete', { 'src/add.mjs': 'export const add = (a, b) => a * b;\n', 'test/add.test.mjs': null });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/add\.test\.mjs \(deleted by this change\)/);
});

test('goalpost: old tests that no longer load are flagged as broke', () => {
  const dir = repo();
  onBranch(dir, 'rename', {
    'src/add.mjs': 'export const sum = (a, b) => a + b;\n',
    'test/add.test.mjs': "import { sum } from '../src/add.mjs';\ntest('sums two numbers', () => { if (sum(2, 3) !== 5) throw new Error('bad'); });\n",
  });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /BROKE\s+test\/add\.test\.mjs/);
  assert.match(r.out, /export named 'add'/);
});

// The head's types changed so the old test file no longer compiles (fake-ts-errors.json plays
// ts-jest's diagnostics); whether its behaviour changed is a separate question.
const TS_ERRORS = (code, text) => JSON.stringify({ 'test/add.test.mjs': `${code}: ${text}` });
const TYPES_ONLY = {
  'test/add.test.mjs': `${ADD_TEST}// the fixtures gained a field\n`,
  'fake-ts-errors.json': TS_ERRORS('TS2739', "Type '{}' is missing the following properties from type 'Sum': label"),
};

test('goalpost judges an old file that only fails to compile with the type check off, unless --no-retry-untyped', () => {
  const dir = repo();
  onBranch(dir, 'types', TYPES_ONLY);
  const r = goalpost(dir);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /HELD\s+test\/add\.test\.mjs/);
  assert.match(r.out, /judged with the type check off \(the old file no longer compiles: TS2739\)/);
  const off = cli(dir, 'goalpost', '--base', 'main', '--quiet', '--no-retry-untyped', '--', 'node', FAKE, '{files}');
  assert.equal(off.code, 2, off.all);
  assert.match(off.out, /BROKE\s+test\/add\.test\.mjs/);
});

test('goalpost still flags a behaviour change hidden behind a compile error', () => {
  const dir = repo();
  onBranch(dir, 'types-moved', { ...MOVED_EDITS, 'fake-ts-errors.json': TYPES_ONLY['fake-ts-errors.json'] });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/add\.test\.mjs/);
  assert.match(r.out, /✗ adds two numbers: Expected 5, received 6/);
  assert.match(r.out, /type check off/);
});

test('goalpost leaves a missing module BROKE: the subject itself is gone, so it is not run again', () => {
  const dir = repo();
  onBranch(dir, 'gone', { 'test/add.test.mjs': `${ADD_TEST}// edited\n`, 'fake-ts-errors.json': TS_ERRORS('TS2307', "Cannot find module '../src/add.mjs'") });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /BROKE\s+test\/add\.test\.mjs/);
  assert.doesNotMatch(r.all, /running them again with the type check off/);
});

test("the type-check-off retry keeps the command's own --config", () => {
  // The old test passes only with the value the project's config sets. A retry that dropped the
  // command's --config, or handed Jest two configs, would lose it and see a behaviour change.
  const CONFIGURED_TEST = [
    "import { add } from '../src/add.mjs';",
    "test('adds the configured value', () => {",
    '  const got = add(2, globalThis.fixtureValue);',
    '  if (got !== 7) throw new Error(`Expected: 7\\nReceived: ${got}`);',
    '});',
    '',
  ].join('\n');
  const dir = repo({ 'src/add.mjs': ADD, 'test/add.test.mjs': CONFIGURED_TEST, 'test/fake.config.cjs': 'module.exports = { globals: { fixtureValue: 5 } };\n' });
  onBranch(dir, 'types-config', { 'test/add.test.mjs': `${CONFIGURED_TEST}// edited\n`, 'fake-ts-errors.json': TYPES_ONLY['fake-ts-errors.json'] });
  const r = cli(dir, 'goalpost', '--base', 'main', '--quiet', '--', 'node', FAKE, '--config', 'test/fake.config.cjs', '{files}');
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /HELD\s+test\/add\.test\.mjs/);
});

// An old test whose fixture lacks something the new code now needs crashes inside the new code
// before any of its expectations: that is no verdict on behaviour.
const LABEL = 'export const label = (user) => user.name;\n';
const LABEL_TEST = [
  "import { label } from '../src/label.mjs';",
  "test('labels a user', () => {",
  "  const got = label({ name: 'Ana' }).toUpperCase();",
  "  if (got !== 'ANA') throw new Error(`Expected: ANA\\nReceived: ${got}`);",
  '});',
  '',
].join('\n');

test('an old test that crashes inside the new code is CRASHED, not MOVED', () => {
  const dir = repo({ 'src/label.mjs': LABEL, 'test/label.test.mjs': LABEL_TEST });
  onBranch(dir, 'needs-role', {
    'src/label.mjs': 'export const label = (user) => `${user.name} (${user.role.title})`;\n',
    'test/label.test.mjs': LABEL_TEST.replace("{ name: 'Ana' }", "{ name: 'Ana', role: { title: 'Editor' } }").replace("'ANA'", "'ANA (EDITOR)'"),
  });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /CRASHED\s+test\/label\.test\.mjs/);
  assert.match(r.out, /crash inside the new code before reaching their expectations/);
  assert.match(r.out, /NOT JUDGED/);
});

test('failure summaries read values on the next line, and never mistake a stack frame for one', () => {
  const stack = '\n\n    at Object.<anonymous> (src/components/members.spec.tsx:12:5)';
  assert.equal(failureSummary(`expect(element).toHaveValue(ADMIN)\n\nExpected the element to have value:\n  ADMIN\nReceived:\n  ${stack}`), 'Expected ADMIN, received (empty)');
  assert.equal(failureSummary(`Error: Expected: 5\nReceived: 6${stack}`), 'Expected 5, received 6');
  assert.equal(failureSummary(`expect(received).toBe(expected) // Object.is equality\n\nExpected: "a"\nReceived: "b"${stack}`), 'Expected "a", received "b"');
  assert.equal(failureSummary(`expect(jest.fn()).toHaveBeenCalledWith(...expected)\n\nExpected: "/teams?team=team-9"\n\nNumber of calls: 0${stack}`), 'Expected a call with "/teams?team=team-9", got 0 call(s)');
});

test('findTests finds describe/it/test blocks through JSX text, regexes, comments and strings', () => {
  const src = [
    "import { render } from 'x';",
    '// it(\'not a test\', () => {})',
    "const s = 'it(\"not a test either\", () => {})';",
    "describe('Panel', () => {",
    "  it('shows the owner\\'s name', () => {",
    "    render(<p className=\"a\">Don't {name} here</p>);",
    '    expect(text).toMatch(/a[/)]b\\/c/);',
    '  });',
    "  describe(`inner`, () => {",
    "    test.only('counts', async () => { await x(); }, 10_000);",
    "    it.each([1, 2])('each %i', (n) => {});",
    '  });',
    '});',
    "it('top', () => expect(1 / 2).toBe(0.5));",
  ].join('\n');
  const blocks = findTests(src, { jsx: true });
  const tests = blocks.filter((b) => b.kind === 'test').map((b) => b.path.join(' > '));
  assert.deepEqual(tests, ["Panel > shows the owner's name", 'Panel > inner > counts', 'Panel > inner > each %i', 'top']);
  const counts = blocks.find((b) => b.title === 'counts');
  assert.equal(src.slice(counts.fn.start, counts.fn.end), 'async () => { await x(); }');
});

test('transplant puts the old body into the new test with the same full title, and skips the rest', () => {
  const oldSrc = "describe('A', () => {\n  it('keeps', () => { old(); });\n  it('gone', () => { gone(); });\n});\n";
  const newSrc = "const fixture = 1;\ndescribe('A', () => {\n  it('keeps', () => { fresh(); });\n  it('added', () => { added(); });\n});\n";
  const t = transplant(oldSrc, newSrc);
  assert.deepEqual(t.transplanted, [['A', 'keeps']]);
  assert.deepEqual(t.missing, [['A', 'gone']]);
  assert.equal(t.source, "const fixture = 1;\ndescribe('A', () => {\n  it('keeps', () => { old(); });\n  it.skip('added', () => { added(); });\n});\n");
});

test('transplant handles .each blocks and matches every case name Jest gives them', () => {
  const oldSrc = "it.each([1, 5])('queries for %i teams', (n) => { old(n); });\n";
  const newSrc = "it.each([1, 5])('queries for %i teams', (n) => { fresh(n); });\ntest.each`a\n${1}`('adds $a', ({ a }) => {});\n";
  const t = transplant(oldSrc, newSrc);
  assert.deepEqual(t.transplanted, [['queries for %i teams']]);
  assert.match(t.source, /^it\.each\(\[1, 5\]\)\('queries for %i teams', \(n\) => \{ old\(n\); \}\);/);
  assert.match(t.source, /test\.skip\.each`a\n\$\{1\}`\('adds \$a'/);
  assert.ok(t.matchers[0].test('queries for 1 teams') && t.matchers[0].test('queries for 5 teams'));
  assert.ok(!t.matchers[0].test('queries for 1 team'));
});

// The no-N+1 story: an it.each test whose old database fixture lacks a delegate the new code reads.
const COUNT_TEST = (fields, expected) =>
  [
    "import { queryCount } from '../src/count.mjs';",
    `const db = (o = {}) => ({ teams: []${fields}, ...o });`,
    `it.each([1, 5])('uses a constant number of queries for %i teams', (n) => {`,
    '  const got = queryCount(db(), n);',
    `  if (got !== ${expected}) throw new Error(\`Expected: ${expected}\\nReceived: \${got}\`);`,
    '});',
    '',
  ].join('\n');

test('the transplant reaches an it.each expectation behind a crash: expected 5, received 7', () => {
  const dir = repo({ 'src/count.mjs': 'export const queryCount = () => 5;\n', 'test/count.test.mjs': COUNT_TEST('', 5) });
  onBranch(dir, 'two-more-queries', {
    'src/count.mjs': 'export const queryCount = (db) => 5 + db.access.groupBy();\n',
    'test/count.test.mjs': COUNT_TEST(', access: { groupBy: () => 2 }', 7),
  });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/count\.test\.mjs/);
  assert.match(r.out, /✗ uses a constant number of queries for 1 teams: Expected 5, received 7/);
});

// An old test whose module-level fixture builder lacks a field the new code needs crashes inside
// the new code; the new file's builder has the field. Transplanted, the old expectation can speak.
const BUILDER_TEST = (fields, expected) =>
  [
    "import { label } from '../src/label.mjs';",
    `const user = (o = {}) => ({ name: 'Ana'${fields}, ...o });`,
    "describe('label', () => {",
    "  it('labels a user', () => {",
    '    const got = label(user());',
    `    if (got !== '${expected}') throw new Error(\`Expected: ${expected}\\nReceived: \${got}\`);`,
    '  });',
    '});',
    '',
  ].join('\n');

test('the transplant proves an old test that only crashed on its old fixture still holds', () => {
  const dir = repo({ 'src/label.mjs': LABEL, 'test/label.test.mjs': BUILDER_TEST('', 'Ana') });
  onBranch(dir, 'hidden-role', {
    'src/label.mjs': "export const label = (user) => (user.role.hidden ? '' : user.name);\n",
    'test/label.test.mjs': BUILDER_TEST(', role: { hidden: false }', 'Ana'),
  });
  const r = goalpost(dir);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /HELD\s+test\/label\.test\.mjs/);
  assert.match(r.out, /all 1 old test\(s\) pass when run inside the new test file with their old bodies/);
  const off = cli(dir, 'goalpost', '--base', 'main', '--quiet', '--no-transplant', '--', 'node', FAKE, '{files}');
  assert.match(off.out, /CRASHED\s+test\/label\.test\.mjs/);
});

test('the transplant turns a crash into the exact moved expectation', () => {
  const dir = repo({ 'src/label.mjs': LABEL, 'test/label.test.mjs': BUILDER_TEST('', 'Ana') });
  onBranch(dir, 'role-title', {
    'src/label.mjs': 'export const label = (user) => `${user.name} (${user.role.title})`;\n',
    'test/label.test.mjs': BUILDER_TEST(", role: { title: 'Editor' }", 'Ana (Editor)'),
  });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/label\.test\.mjs/);
  assert.match(r.out, /✗ label labels a user: Expected Ana, received Ana \(Editor\)/);
});

test('the transplant follows a test file that was renamed', () => {
  const dir = repo({ 'src/label.mjs': LABEL, 'test/label.test.mjs': BUILDER_TEST('', 'Ana') });
  git(dir, 'checkout', '-q', '-b', 'renamed-file', 'main');
  git(dir, 'mv', 'test/label.test.mjs', 'test/user-label.test.mjs');
  write(dir, 'src/label.mjs', "export const label = (user) => (user.role.hidden ? '' : user.name);\n");
  write(dir, 'test/user-label.test.mjs', BUILDER_TEST(', role: { hidden: false }', 'Ana'));
  commit(dir, 'renamed-file');
  const r = goalpost(dir);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /HELD\s+test\/label\.test\.mjs \(now test\/user-label\.test\.mjs\)/);
  assert.match(r.out, /all 1 old test\(s\) pass when run inside the new test file/);
});

test('an old test with no counterpart in the new file is not transplanted and stays CRASHED', () => {
  const dir = repo({ 'src/label.mjs': LABEL, 'test/label.test.mjs': BUILDER_TEST('', 'Ana') });
  onBranch(dir, 'renamed-test', {
    'src/label.mjs': "export const label = (user) => (user.role.hidden ? '' : user.name);\n",
    'test/label.test.mjs': BUILDER_TEST(', role: { hidden: false }', 'Ana').replace('labels a user', 'labels a visible user'),
  });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /CRASHED\s+test\/label\.test\.mjs/);
});

test('an old test that crashes in the test itself is MOVED: the result changed shape', () => {
  const dir = repo({ 'src/label.mjs': LABEL, 'test/label.test.mjs': LABEL_TEST });
  onBranch(dir, 'new-shape', {
    'src/label.mjs': 'export const label = (user) => ({ text: user.name });\n',
    'test/label.test.mjs': LABEL_TEST.replace('.toUpperCase()', '.text.toUpperCase()'),
  });
  const r = goalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/label\.test\.mjs/);
  assert.match(r.out, /toUpperCase is not a function/);
});

// The PR comment card. A list that grew is a change the test only added lines for: low risk. A
// rewritten expectation needs a look. An added early return is never low risk.
const LIST = "export const models = () => ['a', 'b'];\n";
const LIST_TEST = (entries, extra = '') =>
  [
    "import { models } from '../src/models.mjs';",
    "test('lists every model', () => {",
    ...(extra ? [extra] : []),
    '  const expected = [',
    ...entries.map((e) => `    '${e}',`),
    '  ];',
    '  const got = models().join();',
    "  if (got !== expected.join()) throw new Error(`Expected: ${expected.join()}\\nReceived: ${got}`);",
    '});',
    '',
  ].join('\n');
const card = (r) => fs.readFileSync(/^PR comment: (.+)$/m.exec(r.out)[1].trim(), 'utf8');

test('the PR card sorts changes: a rewritten expectation needs a look, a list that only grew is low risk', () => {
  let dir = repo();
  onBranch(dir, 'moved', MOVED_EDITS);
  let c = card(goalpost(dir));
  assert.match(c, /^### Goalpost: 1 test file\(s\) need a look/);
  assert.match(c, /\*\*Needs a look\*\*[\s\S]*`test\/add\.test\.mjs`\n  - ✗ adds two numbers: Expected 5, received 6/);

  dir = repo({ 'src/models.mjs': LIST, 'test/models.test.mjs': LIST_TEST(['a', 'b']) });
  onBranch(dir, 'grew', { 'src/models.mjs': "export const models = () => ['a', 'b', 'c'];\n", 'test/models.test.mjs': LIST_TEST(['a', 'b', 'c']) });
  const r = goalpost(dir);
  assert.match(r.out, /old tests fail on the new code \(low risk: the test only gained lines\)/);
  c = card(r);
  assert.match(c, /^### Goalpost: 1 low-risk change\(s\), nothing that needs a look/);
  assert.match(c, /\*\*Low risk\*\*[\s\S]*`test\/models\.test\.mjs`\n  - ✗ lists every model: Expected a,b, received a,b,c/);
  assert.doesNotMatch(c, /Needs a look/);

  dir = repo({ 'src/models.mjs': LIST, 'test/models.test.mjs': LIST_TEST(['a', 'b']) });
  onBranch(dir, 'early-return', { 'src/models.mjs': "export const models = () => ['a', 'b', 'c'];\n", 'test/models.test.mjs': LIST_TEST(['a', 'b'], '  return;') });
  c = card(goalpost(dir));
  assert.match(c, /^### Goalpost: 1 test file\(s\) need a look/);
});

const mergePr = (dir, n, branch, title, edits) => {
  onBranch(dir, branch, edits);
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${n} from me/${branch}`, '-m', title);
};

test('history reports what goalpost would have flagged on the merged PRs, read from the merge commits', () => {
  const dir = repo({ 'src/add.mjs': ADD, 'test/add.test.mjs': ADD_TEST, 'src/models.mjs': LIST, 'test/models.test.mjs': LIST_TEST(['a', 'b']) });
  mergePr(dir, 1, 'moved', 'Add one more', MOVED_EDITS);
  mergePr(dir, 2, 'grew', 'A third model', { 'src/models.mjs': "export const models = () => ['a', 'b', 'c'];\n", 'test/models.test.mjs': LIST_TEST(['a', 'b', 'c']) });
  write(dir, 'README.md', 'docs\n');
  commit(dir, 'Write the docs (#3)');
  const out = fs.mkdtempSync(path.join(TMP, 'receipts-history-'));
  const r = cli(dir, 'history', '--from-git', '--base', 'main', '--no-machine', '--out', out, '--', 'node', FAKE, '{files}');
  assert.equal(r.code, 0, r.all);
  const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(report, /the last 3 merged PRs/);
  // Each check's receipt goes in the history's own store, never the caller's.
  assert.equal(receiptFiles(path.join(out, 'store')).length, 2);
  assert.match(report, /Changed an existing test file[^|]*\| 2 \|/);
  assert.match(report, /\*\*Needs a look\*\*[^|]*\| \*\*1\*\* \|/);
  assert.match(report, /Low risk only[^|]*\| 1 \|/);
  assert.match(report, /### #1 Add one more\n\n- `test\/add\.test\.mjs`\n  - ✗ adds two numbers: Expected 5, received 6/);
  assert.match(report, /## Low risk only\n\n- #2 A third model: `test\/models\.test\.mjs`/);
  assert.doesNotMatch(report, /#3/);

  // A second run resumes: every PR is already judged, so nothing runs again.
  const again = cli(dir, 'history', '--from-git', '--base', 'main', '--no-machine', '--out', out, '--', 'node', FAKE, '{files}');
  assert.equal(again.code, 0, again.all);
  assert.doesNotMatch(again.err, /^#\d+ merge/m);
  assert.equal(fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8').trim().split('\n').length, 3);

  // Results written before goalpost marked additions-only changes are marked from the diff.
  const rows = path.join(out, 'results.jsonl');
  fs.writeFileSync(rows, fs.readFileSync(rows, 'utf8').replaceAll(/,"additionsOnly":(true|false)/g, ''));
  const summary = cli(dir, 'history', '--from-git', '--base', 'main', '--out', out, '--summary', '--', 'node', FAKE, '{files}');
  assert.equal(summary.code, 0, summary.all);
  assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /Low risk only[^|]*\| 1 \|/);
});

const guard = (dir, ...args) => cli(dir, 'guard', '--base', 'main', ...args, '--', 'node', FAKE, '{files}');

test('guard blocks an agent whose uncommitted work moved an old expectation, until it says why', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'agent');
  for (const [rel, text] of Object.entries(MOVED_EDITS)) write(dir, rel, text);
  const before = git(dir, 'status', '--porcelain');
  let r = guard(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.err, /1 old test expectation\(s\) no longer hold on your changes/);
  assert.match(r.err, /✗ adds two numbers: Expected 5, received 6/);
  assert.match(r.err, /goalline guard --ack "test\/add\.test\.mjs::adds two numbers" --why/);
  // The check never touches the checkout: same changes, no new commit on the branch.
  assert.equal(git(dir, 'status', '--porcelain'), before);
  assert.equal(git(dir, 'rev-list', '--count', 'main..agent'), '0');

  r = cli(dir, 'guard', '--ack', 'test/add.test.mjs::adds two numbers', '--why', 'the add now counts the carry, as the task asks');
  assert.equal(r.code, 0, r.all);
  r = guard(dir);
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /1 changed test expectation\(s\), all acknowledged/);
  assert.match(cli(dir, 'guard', '--report').out, /\| `test\/add\.test\.mjs::adds two numbers` \| the add now counts the carry, as the task asks \|/);
});

test('guard lets the stop through when the old tests hold, and never blocks because of its own failure', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'agent');
  write(dir, 'test/add.test.mjs', `${ADD_TEST}test('adds negatives', () => { if (add(-1, -2) !== -3) throw new Error('bad'); });\n`);
  assert.equal(guard(dir).code, 0);
  const r = cli(dir, 'guard', '--base', 'no-such-branch', '--', 'node', FAKE, '{files}');
  assert.equal(r.code, 0, r.all);
  assert.match(r.err, /the check could not run .*; not blocking/);
});

test('guard reads the Claude Code hook event, and stops blocking a stuck agent after --max-blocks', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'agent');
  for (const [rel, text] of Object.entries(MOVED_EDITS)) write(dir, rel, text);
  const hook = () =>
    spawnSync(process.execPath, [CLI, 'guard', '--hook', '--base', 'main', '--max-blocks', '1', '--', 'node', FAKE, '{files}'], {
      cwd: TMP,
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: dir, stop_hook_active: false }),
      env: { ...process.env, ...GIT_ENV, GOALLINE_HOME: RHOME, GOALLINE_SCRATCH: SCRATCH },
      encoding: 'utf8',
    });
  let r = hook();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Expected 5, received 6/);
  r = hook();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: stopping with 1 unacknowledged changed test expectation\(s\), after blocking 1 times/);
});

test('goalpost: an added skip is reported as a signal', () => {
  const dir = repo();
  onBranch(dir, 'skip', { 'test/add.test.mjs': ADD_TEST.replace("test('adds", "test.skip('adds") });
  const r = goalpost(dir);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /HELD/);
  assert.match(r.out, /signals: 1 skip\/only added/);
});

const SUB_TEST = "import { sub } from '../src/sub.mjs';\ntest('sub exists', () => { if (typeof sub !== 'function') throw new Error('no sub'); });\n";

test('prove-red: new tests that fail on base pass; ones that pass on base are flagged', () => {
  const dir = repo({ 'src/sub.mjs': 'export const sub = (a, b) => a + b;\n', 'test/sub.test.mjs': SUB_TEST });
  onBranch(dir, 'fix', {
    'src/sub.mjs': 'export const sub = (a, b) => a - b;\n',
    'test/helpers.mjs': 'export const expectEqual = (got, want) => { if (got !== want) throw new Error(`Expected: ${want}\\nReceived: ${got}`); };\n',
    'test/sub.test.mjs': [
      "import { sub } from '../src/sub.mjs';",
      "import { expectEqual } from './helpers.mjs';",
      "test('sub exists', () => { if (typeof sub !== 'function') throw new Error('no sub'); });",
      "test('subtracts', () => expectEqual(sub(5, 3), 2));",
      "test('sub is still a function', () => expectEqual(typeof sub, 'function'));",
      '',
    ].join('\n'),
  });
  const r = proveRed(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /RED\s+subtracts\s+fails on the base code: Expected 2, received 8/);
  assert.match(r.out, /GREEN\s+sub is still a function/);
  assert.doesNotMatch(r.out, /sub exists/);
});

test('prove-red: tests for a brand-new module cannot run on base', () => {
  const dir = repo();
  onBranch(dir, 'feature', {
    'src/mul.mjs': 'export const mul = (a, b) => a * b;\n',
    'test/mul.test.mjs': "import { mul } from '../src/mul.mjs';\ntest('multiplies', () => { if (mul(2, 3) !== 6) throw new Error('bad'); });\n",
  });
  const r = proveRed(dir);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /SETUP\s+test\/mul\.test\.mjs \(new file\)/);
  assert.match(r.out, /PROVEN/);
});

const DB_TEST = [
  "import fs from 'node:fs';",
  "import { add } from '../src/add.mjs';",
  "test('adds with a migrated database', () => {",
  '  const db = process.env.GOALLINE_DB;',
  "  if (!process.env.TEST_DB_URL.endsWith(`/${db}`)) throw new Error('no database url for this run');",
  "  if (!fs.existsSync(`${db}.migrated`)) throw new Error('the setup did not run');",
  '  if (add(2, 3) !== 6) throw new Error(`Expected: 6\\nReceived: ${add(2, 3)}`);',
  '});',
  '',
].join('\n');

test('prove-red and goalpost give each run its own database, set up before the tests and torn down after', () => {
  const dir = repo();
  onBranch(dir, 'db', { 'src/add.mjs': 'export const add = (a, b) => a + b + 1;\n', 'test/db.test.mjs': DB_TEST });
  const marker = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-teardown-')), 'dropped.txt');
  const withDb = (setup) => [
    '--fresh-db', 'TEST_DB_URL=postgresql://app:s3cret@localhost:5432/{db}',
    '--setup', setup,
    '--teardown', `node -e "require('fs').writeFileSync(process.argv[1], process.env.RECEIPTS_DB + ' {db}')" "${marker}"`,
  ];
  const r = cli(dir, 'prove-red', '--base', 'main', '--quiet', ...withDb(`node -e "require('fs').writeFileSync('{db}.migrated', 'ok')"`), '--', 'node', FAKE, '{files}');
  assert.equal(r.code, 0, r.all);
  // Red for the right reason: the test reached its assertion, so the url and the setup were there.
  assert.match(r.out, /RED\s+adds with a migrated database\s+fails on the base code: Expected 6, received 5/);
  assert.match(fs.readFileSync(marker, 'utf8'), /^(receipts_prove_red_[0-9a-f]{8}) \1$/);
  const receipt = receiptFiles(RHOME).map((f) => fs.readFileSync(f, 'utf8')).map((t) => Buffer.from(JSON.parse(t).payload, 'base64').toString('utf8')).find((s) => s.includes('"freshDb"'));
  assert.match(receipt, /"freshDb": ?"TEST_DB_URL"/);
  assert.doesNotMatch(receipt, /s3cret/);

  // A setup that fails judges nothing, and the teardown still runs.
  fs.rmSync(marker);
  const bad = cli(dir, 'prove-red', '--base', 'main', '--quiet', ...withDb('node -e "process.exit(3)"'), '--', 'node', FAKE, '{files}');
  assert.equal(bad.code, 2, bad.all);
  assert.match(bad.out, /NOT JUDGED/);
  assert.match(bad.out, /the setup command exited 3/);
  assert.ok(fs.existsSync(marker));
});

test('removing a scratch copy never deletes through a node_modules link', () => {
  const victim = fs.mkdtempSync(path.join(TMP, 'receipts-victim-'));
  write(victim, 'keep.txt', 'keep');
  const scratch = fs.mkdtempSync(path.join(TMP, 'receipts-scratch-'));
  write(scratch, 'a/b.txt', 'x');
  fs.symlinkSync(victim, path.join(scratch, 'node_modules'), 'junction');
  safeRemoveTree(scratch);
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'keep');
});

test('a goalpost run links the real node_modules and leaves it intact', () => {
  const dir = repo();
  write(dir, 'node_modules/sentinel/keep.txt', 'keep');
  onBranch(dir, 'moved', MOVED_EDITS);
  assert.equal(goalpost(dir).code, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'node_modules/sentinel/keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(SCRATCH), []);
});

test('goalpost tests the head version of workspace packages, not the checkout version', () => {
  // npm workspaces link node_modules/@fx/lib back to packages/lib in the checkout. If the scratch
  // copy kept that link, it would test against whatever the checkout has, not the change.
  const LIB_TEST = (want) =>
    `import { greeting } from '@fx/lib';\ntest('greets', () => { if (greeting !== '${want}') throw new Error(\`Expected: ${want}\\nReceived: \${greeting}\`); });\n`;
  const dir = repo({
    'packages/lib/package.json': '{ "name": "@fx/lib", "type": "module", "main": "index.mjs" }\n',
    'packages/lib/index.mjs': "export const greeting = 'hi';\n",
    'test/greet.test.mjs': LIB_TEST('hi'),
  });
  fs.mkdirSync(path.join(dir, 'node_modules', '@fx'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'packages', 'lib'), path.join(dir, 'node_modules', '@fx', 'lib'), 'junction');
  onBranch(dir, 'ws', { 'packages/lib/index.mjs': "export const greeting = 'hello';\n", 'test/greet.test.mjs': LIB_TEST('hello') });
  git(dir, 'checkout', '-q', 'main'); // the checkout (and its packages/lib) is now the old version
  const r = cli(dir, 'goalpost', '--base', 'main', '--head', 'ws', '--quiet', '--', 'node', FAKE, '{files}');
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/greet\.test\.mjs/);
  assert.match(r.out, /Expected hi, received hello/);
  assert.equal(fs.readFileSync(path.join(dir, 'packages', 'lib', 'index.mjs'), 'utf8'), "export const greeting = 'hi';\n");
});

test('scratch copies never sit under a folder whose name starts with a dot', () => {
  // Jest configs whose testMatch starts with <rootDir> find no tests under such folders.
  const saved = process.env.RECEIPTS_SCRATCH;
  const savedNew = process.env.GOALLINE_SCRATCH;
  delete process.env.RECEIPTS_SCRATCH;
  delete process.env.GOALLINE_SCRATCH;
  try {
    const parts = fs.realpathSync.native(os.tmpdir()).split(path.sep);
    assert.ok(scratchRoot().startsWith(os.tmpdir()));
    assert.ok(!parts.some((p) => p.startsWith('.')), `temp folder ${os.tmpdir()} has a dot folder`);
  } finally {
    if (saved !== undefined) process.env.RECEIPTS_SCRATCH = saved;
    if (savedNew !== undefined) process.env.GOALLINE_SCRATCH = savedNew;
  }
});

test('parses Jest and Playwright summaries', () => {
  const j = parseSummary('Test Suites: 1 failed, 69 passed, 70 total\nTests:       2 failed, 1 skipped, 904 passed, 907 total\n');
  assert.deepEqual([j.runner, j.passed, j.failed, j.skipped, j.total], ['jest', 904, 2, 1, 907]);
  const p = parseSummary('  1 flaky\n    [chromium] › a.spec.ts:3:1 › x\n  53 passed (3.2m)\n');
  assert.deepEqual([p.runner, p.passed, p.flaky, p.total], ['playwright', 53, 1, 54]);
  assert.equal(parseSummary('Compiled successfully\n').runner, 'unknown');
});

test("Jest's Console and Warning headers are never failed tests", () => {
  const text = '  ● Console\n\n    console.log\n  ● Validation Warning:\n  ● Edit › saves\n  ● Test suite failed to run\n';
  assert.deepEqual(failedTestNames(text, 'jest'), ['Edit › saves', 'Test suite failed to run']);
});

test('a passing run lists no failed tests, even when the tests log', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo({ 'src/add.mjs': ADD, 'test/add.test.mjs': `console.log('  ● Console\\n\\n    console.log\\n      hi');\n${ADD_TEST}` });
  assert.equal(runGate(dir, home).code, 0);
  write(dir, 'src/add.mjs', 'export const add = (a, b) => a - b;\n');
  assert.equal(runGate(dir, home).code, 1);
  const byResult = Object.fromEntries(receiptFiles(home).map((f) => statementOf(f).predicate).map((p) => [p.result, p.failedTests]));
  assert.deepEqual(byResult, { PASSED: [], FAILED: ['adds two numbers'] });
});

const FLAKY_TEST = [
  "import fs from 'node:fs';",
  "test('passes on the second try', () => {",
  '  const f = process.env.FLAKY_FILE;',
  "  const n = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0);",
  '  fs.writeFileSync(f, String(n + 1));',
  "  if (n === 0) throw new Error('first try fails');",
  '});',
  '',
].join('\n');

test('prune keeps the flake record and removes only what can never prove anything, or what the filters name', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo({ 'test/flaky.test.mjs': FLAKY_TEST });
  process.env.FLAKY_FILE = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-flaky-')), 'count');
  try {
    const run = () => cliIn(home, dir, 'run', '--gate', 'unit', '--no-machine', '--', 'node', FAKE, 'test/flaky.test.mjs');
    assert.equal(run().code, 1);
    assert.equal(run().code, 0);
  } finally {
    delete process.env.FLAKY_FILE;
  }
  const [first] = receiptFiles(home).sort();
  fs.writeFileSync(path.join(path.dirname(first), 'broken.dsse.json'), 'not a receipt');

  // No filters: only the unreadable file goes. The failed run on the same code stays.
  let p = cliIn(home, dir, 'prune');
  assert.equal(p.code, 0, p.all);
  assert.match(p.out, /removed .*unit .*\(unreadable receipt\)/);
  assert.match(p.out, /Removed 1 receipt\(s\).*Kept 2\./);
  const v = cliIn(home, dir, 'verify', '--require', 'unit');
  assert.equal(v.code, 0, v.all);
  // The failed run on the same code is shown as not counted, not as the run in use.
  assert.match(v.out, /unit\s+VERIFIED[\s\S]*also on this code, not counted: failed \(exit 1\)/);
  assert.doesNotMatch(v.out, /not usable/);

  // A dry run names what matches every filter and deletes nothing.
  p = cliIn(home, dir, 'prune', '--gate', 'unit', '--before', '2999-01-01', '--dry-run');
  assert.match(p.out, /Would remove 2 receipt\(s\)/);
  assert.equal(receiptFiles(home).length, 2);
  assert.match(cliIn(home, dir, 'prune', '--gate', 'other').out, /Nothing to remove/);

  p = cliIn(home, dir, 'prune', '--gate', 'unit', '--older-than', '0m');
  assert.match(p.out, /Removed 2 receipt\(s\).*Kept 0\./);
  assert.deepEqual(fs.readdirSync(path.join(home, 'store')), []);
  assert.equal(cliIn(home, dir, 'prune', '--older-than', 'soon').code, 64);
});

test('globs and weakened-test signals', () => {
  const spec = globToRegExp('**/*.{spec,test}.{ts,tsx}');
  assert.ok(spec.test('apps/web/src/app/(app)/schedule/page.spec.tsx'));
  assert.ok(spec.test('a.test.ts'));
  assert.ok(!spec.test('apps/web/src/latest.ts'));
  const s = testSignals(
    "test('a', () => { expect(1).toBe(1); expect(2).toBe(2); });\ntest('b', () => {});",
    "test.skip('a', () => { expect(1).toBe(1); });",
  );
  assert.deepEqual([s.skipsAdded, s.assertDelta, s.removedTitles], [1, -1, ['b']]);
});

test('Python test signals: test functions, asserts and skip markers', () => {
  const before = 'def test_a():\n    assert f() == 1\n    assert g() == 2\n\n\nclass TestB:\n    def test_b(self):\n        self.assertEqual(h(), 3)\n';
  const after = '@pytest.mark.skip\ndef test_a():\n    assert f() == 1\n';
  assert.deepEqual([...testTitles(before)], ['test_a', 'test_b']);
  const s = testSignals(before, after);
  assert.deepEqual([s.skipsAdded, s.assertDelta, s.removedTitles], [1, -2, ['test_b']]);
});

test('parses pytest and Vitest summaries, and the tests they say failed', () => {
  const pyOut = 'FAILED tests/test_calc.py::test_add - assert 5 == 4\nFAILED tests/test_calc.py::TestGroup::test_dict - AssertionError: assert {...\nERROR tests/test_gone.py\n';
  const py = parseSummary(`${pyOut}====== 6 failed, 2 passed, 1 skipped, 1 xfailed, 2 errors in 0.26s ======\n`);
  assert.deepEqual([py.runner, py.passed, py.failed, py.skipped, py.total], ['pytest', 2, 8, 2, 12]);
  assert.deepEqual([parseSummary('3 passed, 1 warning in 1.02s\n').runner, parseSummary('no tests ran in 0.01s\n').total], ['pytest', 0]);
  assert.equal(parseSummary('Checked 120 files in 1.2s\n2 files changed in 0.5s\n').runner, 'unknown');
  assert.deepEqual(failedTestNames(pyOut, 'pytest'), ['tests/test_calc.py::test_add', 'tests/test_calc.py::TestGroup::test_dict', 'tests/test_gone.py']);
  const vt = parseSummary(' Test Files  2 failed (2)\n      Tests  5 failed | 3 passed | 1 skipped (9)\n   Start at  06:20:22\n');
  assert.deepEqual([vt.runner, vt.passed, vt.failed, vt.skipped, vt.total, vt.suitesFailed], ['vitest', 3, 5, 1, 9, 2]);
  const vtOut = ' FAIL  test/gone.test.js [ test/gone.test.js ]\nError: Cannot find module\n FAIL  test/calc.test.js > cart > nested > equals\n';
  assert.deepEqual(failedTestNames(vtOut, 'vitest'), ['test/gone.test.js', 'test/calc.test.js > cart > nested > equals']);
});

test('reads pytest results: tests by node id, files that no longer import, crash sites and assert values', () => {
  // Real pytest 9 output (--junitxml with junit_family=xunit1) for a package at C:\work\pkg, run there.
  const xml = path.join(here, 'pytest-junit.xml');
  const files = ['pkg/tests/test_calc.py', 'pkg/tests/test_gone.py'];
  const check = (suites) => {
    assert.deepEqual([...suites.keys()].sort(), files);
    const gone = suites.get('pkg/tests/test_gone.py');
    assert.deepEqual([gone.status, gone.tests.length], ['failed', 0]);
    assert.match(gone.message, /^ImportError: cannot import name 'removed_thing' from 'calc'/);
    const t = Object.fromEntries(suites.get('pkg/tests/test_calc.py').tests.map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(t), [
      'test_add',
      'test_total_crash_in_code',
      'test_crash_in_test',
      'test_param[1-1-2]',
      'test_param[2-3-6]',
      'TestGroup::test_method',
      'TestGroup::test_dict',
      'test_fixture_error',
      'test_skipped',
      'test_xfail',
      'test_raises',
      'test_lib_crash_in_test',
      'test_lib_crash_in_code',
    ]);
    assert.equal(t['test_param[1-1-2]'].title, 'test_param');
    const statuses = Object.values(t).map((x) => x.status);
    assert.deepEqual(statuses, ['failed', 'failed', 'failed', 'failed', 'passed', 'passed', 'failed', 'failed', 'skipped', 'skipped', 'failed', 'failed', 'failed']);
    const site = (name) => pyCrashSite(t[name].message, t[name].failure);
    // A KeyError raised in the code, an AttributeError in the test, a fixture whose old call the new
    // signature refuses, two plain failures, and a TypeError raised inside Python's json module,
    // called by the test and by the code: the last frame in the project decides.
    const sites = ['test_total_crash_in_code', 'test_crash_in_test', 'test_fixture_error', 'test_add', 'test_raises', 'test_lib_crash_in_test', 'test_lib_crash_in_code'].map(site);
    assert.deepEqual(sites, ['code', 'test', 'code', null, null, 'test', 'code']);
    assert.equal(pySummary(t.test_add.message), 'assert 5 == 4 (where 5 = add(2, 2))');
    assert.equal(pySummary(t['TestGroup::test_dict'].message), "assert {'a': 1, 'b': 2} == {'a': 1, 'b': 3}");
    assert.equal(pySummary(t.test_fixture_error.message), "TypeError: Cart.__init__() missing 1 required positional argument: 'owner'");
  };
  check(readJunitXml(xml, files));
  // junit_family=xunit2 drops the file attribute: the module path in classname still places each test.
  const xunit2 = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-junit-')), 'xunit2.xml');
  fs.writeFileSync(xunit2, fs.readFileSync(xml, 'utf8').replace(/ (file|line)="[^"]*"/g, ''));
  check(readJunitXml(xunit2, files));

  // --tb=native gives Python's own traceback, with absolute paths: pytest's and pluggy's frames are in
  // site-packages, and the scratch copy's come out relative once its folder is taken out.
  const root = path.join(TMP, 'pkg');
  const frame = (file, line, fn) => `  File "${file}", line ${line}, in ${fn}\n    code\n`;
  const native = (last) =>
    relativize(
      `Traceback (most recent call last):\n${frame(path.join(TMP, 'py', 'Lib', 'site-packages', '_pytest', 'python.py'), 167, 'pytest_pyfunc_call')}${frame(path.join(root, 'tests', 'test_calc.py'), 9, 'test_total')}${last}KeyError: 'qty'\n`,
      root,
    );
  assert.equal(pyCrashSite("KeyError: 'qty'", native(frame(path.join(root, 'src', 'calc', '__init__.py'), 5, 'total'))), 'code');
  assert.equal(pyCrashSite("KeyError: 'qty'", native('')), 'test');
});

test("reads Vitest results: Jest's file shape, with forward slashes and chai's wording", () => {
  // The shape and messages of a real Vitest 5 run, under a root of this machine.
  const root = path.join(TMP, 'vitest-fixture');
  const posix = root.split(path.sep).join('/');
  const frames = (line) => `\n    at ${posix}/test/calc.test.js:${line}:21\n    at ${pathToFileURL(root).href}/node_modules/vitest/dist/chunks/run.js:1632:35`;
  const result = (fullName, status, failure) => ({ title: fullName.split(' ').pop(), fullName, status, failureMessages: failure ? [failure] : [] });
  const results = {
    testResults: [
      {
        name: `${posix}/test/calc.test.js`,
        status: 'failed',
        message: '',
        assertionResults: [
          result('adds', 'failed', `AssertionError: expected 5 to be 4 // Object.is equality${frames(5)}`),
          result('cart nested equals', 'failed', `AssertionError: expected { a: 1, b: [ 1, 2 ] } to deeply equal { a: 1, b: [ 1, 2, 3 ] }${frames(10)}`),
          result('cart crashes', 'failed', `TypeError: Cannot read properties of undefined (reading 'value')\n    at ${posix}/src/calc.js:2:76\n    at Array.reduce (<anonymous>)\n    at total (${posix}/src/calc.js:2:39)${frames(14)}`),
          result('cart reads', 'failed', `TypeError: Cannot read properties of undefined (reading 'length')${frames(18)}`),
          result('cart later', 'skipped'),
        ],
      },
      { name: `${posix}/test/gone.test.js`, status: 'failed', message: `Cannot find module '../src/removed.js' imported from ${posix}/test/gone.test.js`, assertionResults: [] },
    ],
  };
  const file = path.join(fs.mkdtempSync(path.join(TMP, 'receipts-vitest-')), 'results.json');
  fs.writeFileSync(file, JSON.stringify(results));
  const suites = readJestJson(file, root);
  assert.deepEqual([...suites.keys()], ['test/calc.test.js', 'test/gone.test.js']);
  const t = Object.fromEntries(suites.get('test/calc.test.js').tests.map((x) => [x.name, x]));
  assert.equal(failureSummary(t.adds.failure), 'Expected 4, received 5');
  assert.equal(failureSummary(t['cart nested equals'].failure), 'Expected { a: 1, b: [ 1, 2, 3 ] }, received { a: 1, b: [ 1, 2 ] }');
  assert.deepEqual([t['cart crashes'], t['cart reads'], t.adds].map((x) => jsCrashSite(x.failure)), ['code', 'test', null]);
  assert.equal(relativize(suites.get('test/gone.test.js').message, root), "Cannot find module '../src/removed.js' imported from test/gone.test.js");
});

// Vitest: Jest's result file, asked for with Vitest's own flags (test/fake-vitest.mjs checks them).
const VITEST_ADD_TEST = (n) =>
  [
    "import { add } from '../src/add.mjs';",
    "test('adds two numbers', () => {",
    '  const got = add(2, 3);',
    `  if (got !== ${n}) throw new Error(\`expected \${got} to be ${n} // Object.is equality\`);`,
    '});',
    '',
  ].join('\n');
const vitestGoalpost = (dir) => cli(dir, 'goalpost', '--base', 'main', '--quiet', '--', 'node', FAKE_VITEST, '{files}');
const noScratchIn = (text) => [SCRATCH, SCRATCH.split(path.sep).join('/'), SCRATCH.split('\\').join('\\\\')].every((p) => !text.includes(p));

test('goalpost on Vitest: run with --run, values read as Vitest words them, and the transplant without the Jest config', () => {
  let dir = repo({ 'src/add.mjs': ADD, 'test/add.test.mjs': VITEST_ADD_TEST(5) });
  onBranch(dir, 'moved', { 'src/add.mjs': 'export const add = (a, b) => a + b + 1;\n', 'test/add.test.mjs': VITEST_ADD_TEST(6) });
  let r = vitestGoalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/add\.test\.mjs/);
  assert.match(r.out, /✗ adds two numbers: Expected 5, received 6/);

  // An old test that crashed on its old fixture runs inside the new file, as with Jest. The
  // type-check-off config is a Jest config, so Vitest is never handed it.
  dir = repo({ 'src/label.mjs': LABEL, 'test/label.test.mjs': BUILDER_TEST('', 'Ana') });
  onBranch(dir, 'role-title', {
    'src/label.mjs': 'export const label = (user) => `${user.name} (${user.role.title})`;\n',
    'test/label.test.mjs': BUILDER_TEST(", role: { title: 'Editor' }", 'Ana (Editor)'),
  });
  r = vitestGoalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+test\/label\.test\.mjs/);
  assert.match(r.out, /✗ label labels a user: Expected Ana, received Ana \(Editor\)/);

  // An old test whose module moved away: the note names it without the scratch folder.
  dir = repo({ 'src/sub.mjs': 'export const sub = (a, b) => a - b;\n', 'test/sub.test.mjs': SUB_TEST });
  onBranch(dir, 'moved-module', {
    'src/sub.mjs': null,
    'src/math/sub.mjs': 'export const sub = (a, b) => a - b;\n',
    'test/sub.test.mjs': SUB_TEST.replace('../src/sub.mjs', '../src/math/sub.mjs'),
  });
  r = vitestGoalpost(dir);
  assert.match(r.out, /BROKE\s+test\/sub\.test\.mjs\n\s+the old file no longer runs: Cannot find module 'src[\\/]sub\.mjs' imported from test[\\/]sub\.test\.mjs/);
  assert.ok(noScratchIn(r.all), r.all);

  // A failing test whose error names a file in full: that comes out relative too.
  const READS = (at) => `import fs from 'node:fs';\ntest('reads one', () => { if (fs.readFileSync(new URL('${at}', import.meta.url), 'utf8') !== '1') throw new Error('bad'); });\n`;
  dir = repo({ 'test/one.txt': '1', 'test/reads.test.mjs': READS('./one.txt') });
  onBranch(dir, 'moved-data', { 'test/one.txt': null, 'test/data/one.txt': '1', 'test/reads.test.mjs': READS('./data/one.txt') });
  r = vitestGoalpost(dir);
  assert.match(r.out, /✗ reads one: Error: ENOENT: no such file or directory, open 'test[\\/]one\.txt'/);
  assert.ok(noScratchIn(r.all), r.all);
});

// pytest, for real when this machine has it.
const PYTHON = ['python', 'python3'].find((py) => spawnSync(py, ['-m', 'pytest', '--version'], { encoding: 'utf8', windowsHide: true }).status === 0);
const needsPytest = { skip: PYTHON ? false : 'needs Python with pytest' };
const pyGoalpost = (dir) => cli(dir, 'goalpost', '--base', 'main', '--quiet', '--', PYTHON, '-m', 'pytest', '{files}');
const PY_ADD = 'def add(a, b):\n    return a + b\n';
const PY_ADD_TEST = 'from calc import add\n\n\ndef test_adds():\n    assert add(2, 3) == 5\n';
const PY_MOVED = { 'src/calc/__init__.py': 'def add(a, b):\n    return a + b + 1\n', 'tests/test_calc.py': PY_ADD_TEST.replace('== 5', '== 6') };
const pyRepo = (files = {}) => repo({ 'src/calc/__init__.py': PY_ADD, 'tests/test_calc.py': PY_ADD_TEST, ...files });

test('goalpost on pytest: a moved expectation, with the values pytest printed', needsPytest, () => {
  const dir = pyRepo();
  onBranch(dir, 'moved', PY_MOVED);
  const r = pyGoalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+tests\/test_calc\.py/);
  assert.match(r.out, /✗ test_adds: assert 6 == 5 \(where 6 = add\(2, 3\)\)/);
  assert.match(card(r), /\*\*Needs a look\*\*[\s\S]*`tests\/test_calc\.py`\n  - ✗ test_adds: assert 6 == 5/);
});

test('goalpost on pytest: a list that only grew is low risk; an added skip marker never is', needsPytest, () => {
  const MODELS_TEST = (entries, extra = '') =>
    ['import pytest', 'from calc import models', '', '', `${extra}def test_lists_every_model():`, '    expected = [', ...entries.map((e) => `        "${e}",`), '    ]', '    assert models() == expected', ''].join('\n');
  const grew = (extra) => ({ 'src/calc/__init__.py': 'def models():\n    return ["a", "b", "c"]\n', 'tests/test_models.py': MODELS_TEST(['a', 'b', 'c'], extra) });
  const base = { 'src/calc/__init__.py': 'def models():\n    return ["a", "b"]\n', 'tests/test_models.py': MODELS_TEST(['a', 'b']) };
  let dir = repo(base);
  onBranch(dir, 'grew', grew(''));
  const c = card(pyGoalpost(dir));
  assert.match(c, /^### Goalpost: 1 low-risk change\(s\), nothing that needs a look/);
  assert.match(c, /`tests\/test_models\.py`\n  - ✗ test_lists_every_model: assert \['a', 'b', 'c'\] == \['a', 'b'\]/);
  dir = repo(base);
  onBranch(dir, 'grew-skipped', grew('@pytest.mark.skip\n'));
  assert.match(card(pyGoalpost(dir)), /^### Goalpost: 1 test file\(s\) need a look/);
});

test('goalpost on pytest: an old file that no longer imports is BROKE, and the other old files still run', needsPytest, () => {
  const DATA_TEST = (at) => `from pathlib import Path\n\n\ndef test_reads():\n    assert (Path(__file__).parent / ${at}).read_text() == "1"\n`;
  const dir = pyRepo({
    'src/calc/__init__.py': `${PY_ADD}\n\ndef mul(a, b):\n    return a * b\n`,
    'tests/test_mul.py': 'from calc import mul\n\n\ndef test_muls():\n    assert mul(2, 3) == 6\n',
    'tests/test_data.py': DATA_TEST('"one.txt"'),
    'tests/one.txt': '1',
  });
  onBranch(dir, 'rename', {
    'src/calc/__init__.py': 'def plus(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n',
    'tests/test_calc.py': 'from calc import plus\n\n\ndef test_adds():\n    assert plus(2, 3) == 5\n',
    'tests/test_mul.py': 'from calc import mul\n\n\ndef test_muls():\n    assert mul(2, 3) == 6\n\n\ndef test_by_zero():\n    assert mul(2, 0) == 0\n',
    'tests/one.txt': null,
    'tests/data/one.txt': '1',
    'tests/test_data.py': DATA_TEST('"data" / "one.txt"'),
  });
  const r = pyGoalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /BROKE\s+tests\/test_calc\.py\n\s+the old file no longer runs: ImportError: cannot import name 'add' from 'calc' \(src[\\/]calc[\\/]__init__\.py\)/);
  assert.match(r.out, /HELD\s+tests\/test_mul\.py\n\s+all 1 old test\(s\) still pass/);
  // The data file moved: Python names the missing path in full, and it comes out relative.
  assert.match(r.out, /MOVED\s+tests\/test_data\.py\n.+\n\s+✗ test_reads: FileNotFoundError: \[Errno 2\] No such file or directory: 'tests[\\/]+one\.txt'/);
  assert.ok(noScratchIn(r.all), r.all);
});

test('goalpost on pytest: an old test module the change split into a package of the same name still runs', needsPytest, () => {
  const dir = pyRepo();
  onBranch(dir, 'split', {
    'src/calc/__init__.py': PY_MOVED['src/calc/__init__.py'],
    'tests/test_calc.py': null,
    'tests/test_calc/__init__.py': '',
    'tests/test_calc/test_add.py': PY_MOVED['tests/test_calc.py'],
  });
  // Python would import the new tests/test_calc/ package under the old file's name.
  const r = pyGoalpost(dir);
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+tests\/test_calc\.py \(now tests\/test_calc\/test_add\.py\)\n.+\n\s+✗ test_adds: assert 6 == 5 \(where 6 = add\(2, 3\)\)/);
});

test('goalpost on pytest: a crash inside the new code, or an old call the new signature refuses, is CRASHED; a crash in the test is MOVED', needsPytest, () => {
  const shop = (total, label, cart) => [`def total(items):\n    return ${total}\n`, `def label(${label}`, `class Cart:\n    def __init__(self):\n        self.${cart} = []\n`].join('\n\n');
  const dir = repo({
    'src/shop/__init__.py': shop('sum(i["price"] for i in items)', 'user):\n    return user["name"]\n', 'items'),
    'tests/test_total.py': 'from shop import total\n\n\ndef test_total():\n    assert total([{"price": 2}]) == 2\n',
    'tests/test_label.py': 'from shop import label\n\n\ndef test_label():\n    assert label({"name": "Ana"}) == "Ana"\n',
    'tests/test_cart.py': 'from shop import Cart\n\n\ndef test_empty():\n    assert Cart().items == []\n',
  });
  onBranch(dir, 'reshape', {
    'src/shop/__init__.py': shop('sum(i["price"] * i["qty"] for i in items)', 'user, role):\n    return f\'{user["name"]} ({role})\'\n', 'lines'),
    'tests/test_total.py': 'from shop import total\n\n\ndef test_total():\n    assert total([{"price": 2, "qty": 1}]) == 2\n',
    'tests/test_label.py': 'from shop import label\n\n\ndef test_label():\n    assert label({"name": "Ana"}, "Editor") == "Ana (Editor)"\n',
    'tests/test_cart.py': 'from shop import Cart\n\n\ndef test_empty():\n    assert Cart().lines == []\n',
  });
  // The same with Python's own traceback (--tb=native), whose paths are absolute.
  for (const r of [pyGoalpost(dir), cli(dir, 'goalpost', '--base', 'main', '--quiet', '--', PYTHON, '-m', 'pytest', '--tb=native', '{files}')]) {
    assert.equal(r.code, 2, r.all);
    assert.match(r.out, /CRASHED\s+tests\/test_total\.py\n.+\n\s+✗ test_total: KeyError: 'qty'/);
    assert.match(r.out, /CRASHED\s+tests\/test_label\.py\n.+\n\s+✗ test_label: TypeError: label\(\) missing 1 required positional argument: 'role'/);
    assert.match(r.out, /MOVED\s+tests\/test_cart\.py\n.+\n\s+✗ test_empty: AttributeError: 'Cart' object has no attribute 'items'/);
  }
});

test('goalpost on pytest runs the head code in the scratch copy, never a package installed from the checkout', needsPytest, () => {
  const dir = pyRepo();
  onBranch(dir, 'moved', PY_MOVED);
  git(dir, 'checkout', '-q', 'main');
  // An editable install (pip install -e .) makes the checkout's src importable from anywhere. The
  // checkout holds the base code here, so a run that imported it would see nothing move.
  const r = cliEnv({ PYTHONPATH: path.join(dir, 'src') }, dir, 'goalpost', '--base', 'main', '--head', 'moved', '--quiet', '--', PYTHON, '-m', 'pytest', '{files}');
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /MOVED\s+tests\/test_calc\.py/);
});

test('prove-red on pytest: each new test function and parameter case is judged on the base code, with the new conftest.py', needsPytest, () => {
  const dir = pyRepo({ 'src/calc/__init__.py': `${PY_ADD}\n\ndef sub(a, b):\n    return a + b\n`, 'pytest.ini': '[pytest]\n' });
  onBranch(dir, 'fix-sub', {
    'src/calc/__init__.py': `${PY_ADD}\n\ndef sub(a, b):\n    return a - b\n`,
    'conftest.py': 'import pytest\n\n\n@pytest.fixture\ndef pair():\n    return (5, 3)\n',
    'tests/test_calc.py': [
      'import pytest',
      'from calc import add, sub',
      '',
      '',
      'def test_adds():',
      '    assert add(2, 3) == 5',
      '',
      '',
      'def test_subtracts(pair):',
      '    assert sub(*pair) == 2',
      '',
      '',
      'def test_sub_is_callable():',
      '    assert callable(sub)',
      '',
      '',
      '@pytest.mark.parametrize("a,b,want", [(4, 4, 0), (0, 0, 0)])',
      'def test_sub_cases(a, b, want):',
      '    assert sub(a, b) == want',
      '',
    ].join('\n'),
  });
  const r = cli(dir, 'prove-red', '--base', 'main', '--quiet', '--', PYTHON, '-m', 'pytest', '{files}');
  assert.equal(r.code, 2, r.all);
  assert.match(r.out, /RED\s+test_subtracts\s+fails on the base code: assert 8 == 2 \(where 8 = sub\(\*\(5, 3\)\)\)/);
  assert.match(r.out, /RED\s+test_sub_cases\[4-4-0\]/);
  assert.match(r.out, /GREEN\s+test_sub_cases\[0-0-0\]/);
  assert.match(r.out, /GREEN\s+test_sub_is_callable/);
  assert.doesNotMatch(r.out, /test_adds/);
});

test("a pytest run elsewhere on the machine makes a gate's run not idle", needsPytest, async () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-home-'));
  const dir = repo();
  const other = spawn(PYTHON, ['-c', 'import time; time.sleep(60)', 'pytest'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const busy = cliIn(home, dir, 'run', '--gate', 'unit', '--', 'node', FAKE, 'test/add.test.mjs');
    assert.match(busy.err, /NOT idle/);
  } finally {
    other.kill();
  }
  const m = statementOf(receiptFiles(home)[0]).predicate.configuration[0].annotations.machine;
  assert.ok(m.foreignSeen.some((p) => p.pid === other.pid), JSON.stringify(m.foreignSeen));
});

test('history on a pytest repository finds its Python test files by default, and names a module that moved away', needsPytest, () => {
  const dir = pyRepo({ 'src/calc/old.py': 'def mul(a, b):\n    return a * b\n', 'tests/test_mul.py': 'from calc.old import mul\n\n\ndef test_muls():\n    assert mul(2, 3) == 6\n' });
  mergePr(dir, 1, 'moved', 'Add one more', PY_MOVED);
  mergePr(dir, 2, 'move-mul', 'Move mul', {
    'src/calc/old.py': null,
    'src/calc/ops.py': 'def mul(a, b):\n    return a * b\n',
    'tests/test_mul.py': 'from calc.ops import mul\n\n\ndef test_muls():\n    assert mul(2, 3) == 6\n',
  });
  const out = fs.mkdtempSync(path.join(TMP, 'receipts-history-'));
  const r = cli(dir, 'history', '--from-git', '--base', 'main', '--no-machine', '--out', out, '--', PYTHON, '-m', 'pytest', '{files}');
  assert.equal(r.code, 0, r.all);
  const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(report, /### #1 Add one more\n\n- `tests\/test_calc\.py`\n  - ✗ test_adds: assert 6 == 5 \(where 6 = add\(2, 3\)\)/);
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /\| #2 Move mul \| merge \| tests \| tests\/test_mul\.py \| SUBJECT-DELETED: new tests in the PR: none \|/);
});

test('the old name still works: the receipts command, RECEIPTS_HOME and RECEIPTS_SCRATCH', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'receipts-old-home-'));
  const dir = repo();
  const env = { ...process.env, ...GIT_ENV, RECEIPTS_HOME: home, RECEIPTS_SCRATCH: SCRATCH };
  delete env.GOALLINE_HOME;
  delete env.GOALLINE_SCRATCH;
  const old = path.join(here, '..', 'bin', 'receipts.mjs');
  const r = spawnSync(process.execPath, [old, 'run', '--gate', 'unit', '--no-machine', '--', 'node', FAKE, 'test/add.test.mjs'], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /goalline: unit PASSED/);
  assert.equal(receiptFiles(home).length, 1);
  assert.equal(statementOf(receiptFiles(home)[0]).predicate.configuration[0].annotations.tool, `goalline/${JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version}`);
  assert.match(spawnSync(process.execPath, [old, '--version'], { encoding: 'utf8' }).stdout, /^\d+\.\d+\.\d+/);
});
