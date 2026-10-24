import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitOf, diffNameStatus, mergeBase, repoName, repoRoot, treeOf } from './git.mjs';
import { defaultTests, runnerOf } from './runners.mjs';
import { ensureKey, signStatement } from './sign.mjs';
import { allocReceipt, buildStatement, toolchain, writeReceipt } from './store.mjs';
import { commandLine, firstUsefulLine, list, matcher, quoteArg, relativize, spawnCapture, stripAnsi, toPosix, UsageError } from './util.mjs';

// Shared plumbing for the two PR checks (goalpost, prove-red).

// Test helpers and fixtures belong with the tests, not with the code under test (pytest's are in conftest.py).
const SUPPORT_DIR = /(^|\/)(test|tests|__tests__|__mocks__|__fixtures__|fixtures|__snapshots__)\//;
const SUPPORT_NAME = /(^|[-_.])(test|tests|spec|fixture|fixtures|mock|mocks|conftest)([-_.]|$)/i;
export const isSupportFile = (p) => SUPPORT_DIR.test(p) || SUPPORT_NAME.test(path.posix.basename(p).replace(/\.[^.]+$/, ''));

// Files whose change between base and head can make a test fail for setup reasons.
export const SETUP_RE =
  /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|schema\.prisma|tsconfig[^/]*\.json|jest\.config\.[^/]+|vite(st)?\.config\.[^/]+|babel\.config\.[^/]+|\.babelrc|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|setup\.(py|cfg)|tox\.ini|pytest\.ini|conftest\.py)$/;

export function loadContext(opts, command, kind) {
  if (!command.length) throw new UsageError(`${kind} needs the test command after --, e.g. -- npx jest {files}`);
  const root = repoRoot(opts.repo || process.cwd());
  const baseRef = opts.base || 'origin/main';
  const headRef = opts.head || 'HEAD';
  const head = commitOf(root, headRef);
  const base = commitOf(root, baseRef);
  const mb = mergeBase(root, base, head);
  const cwdRel = toPosix(opts.cwd || '').replace(/^\.\/?/, '').replace(/\/+$/, '');
  return {
    kind,
    root,
    name: repoName(root),
    baseRef,
    headRef,
    base,
    head,
    mb,
    headTree: treeOf(root, head),
    cwdRel,
    gate: opts.gate || `${kind}${cwdRel ? `-${path.posix.basename(cwdRel)}` : ''}`,
    isTest: matcher(opts.tests ? list(opts.tests) : defaultTests(command)),
    inCwd: (p) => !cwdRel || p.startsWith(`${cwdRel}/`),
    changes: diffNameStatus(root, mb, head),
    depsFrom: path.resolve(opts.depsFrom || root),
    command,
    // Recorded on the receipt. Only the variable name of --fresh-db: its url can hold a password.
    setup: opts.setup || null,
    teardown: opts.teardown || null,
    freshDbVar: opts.freshDb ? String(opts.freshDb).split('=')[0] : null,
    startedAt: new Date(),
  };
}

export function writeInto(root, rel, buf) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
}

function buildLine(command, files, extra) {
  if (command.length === 1) {
    const filesText = files.map(quoteArg).join(' ');
    const base = command[0].includes('{files}') ? command[0].replace('{files}', filesText) : `${command[0]} ${filesText}`;
    return extra.length ? `${base} ${extra.map(quoteArg).join(' ')}` : base;
  }
  const argv = command.flatMap((a) => (a === '{files}' ? files : [a]));
  return commandLine([...argv, ...(command.includes('{files}') ? [] : files), ...extra]);
}

const tail = (buf) => firstUsefulLine(stripAnsi(buf.toString('utf8')).split('\n').slice(-15).join('\n'));

// --fresh-db VAR=url-with-{db}: a database name for this run alone, given to --setup, the tests and
// --teardown in VAR (and in GOALLINE_DB, or RECEIPTS_DB by its old name), and as {db} in the setup and teardown commands. The tool
// never creates or drops a database itself: --setup and --teardown do, so any database works.
export function freshDb(opts, label) {
  if (!opts.freshDb) return { db: null, env: {} };
  const spec = String(opts.freshDb);
  const eq = spec.indexOf('=');
  if (eq < 1 || !spec.includes('{db}', eq)) {
    throw new UsageError('--fresh-db needs VAR=url with {db} in the url, e.g. DATABASE_URL=postgresql://user@localhost:5432/{db}');
  }
  const db = `receipts_${label}_${randomBytes(4).toString('hex')}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return { db, env: { [spec.slice(0, eq)]: spec.slice(eq + 1).replaceAll('{db}', db), GOALLINE_DB: db, RECEIPTS_DB: db } };
}

// Run --setup, then the tests, then --teardown, all in the scratch copy. A setup that fails means
// nothing could be judged, never a red or a green. Teardown runs whatever happened.
export async function runWithSetup({ opts, scratch, cwdRel, db, env, quiet }, runBody) {
  const cwd = path.join(scratch, cwdRel);
  const stream = quiet ? null : process.stderr;
  const fill = (s) => (db ? String(s).replaceAll('{db}', db) : String(s));
  try {
    if (opts.setup) {
      console.error(`goalline: setup: ${fill(opts.setup)}`);
      const r = await spawnCapture(fill(opts.setup), { cwd, env, out: stream, err: stream });
      if (r.code !== 0) return { suites: new Map(), noResults: `the setup command exited ${r.code}: ${tail(r.output)}` };
    }
    return await runBody();
  } finally {
    if (opts.teardown) {
      const r = await spawnCapture(fill(opts.teardown), { cwd, env, out: stream, err: stream });
      if (r.code !== 0) console.error(`goalline: teardown exited ${r.code}: ${tail(r.output)}${db ? ` (database ${db} may be left behind)` : ''}`);
    }
  }
}

// Run test files inside a scratch copy. Jest, Vitest and pytest give per-test results through a
// result file (runners.mjs); any other runner is run one file at a time and judged per file by its
// exit code. Each failed test gets where it crashed (crash) and what failed (why), with the scratch
// folder taken out of every message. `extra` goes to the runner after its own arguments.
export async function runTests({ scratch, cwdRel, files, command, quiet, env = {}, extra = [] }) {
  const cwd = path.join(scratch, cwdRel);
  const rels = files.map((f) => toPosix(path.relative(cwd, path.join(scratch, f))));
  const stream = quiet ? null : process.stderr;
  const runner = runnerOf(command);
  if (!runner) {
    const suites = new Map();
    for (const [i, f] of files.entries()) {
      const r = await spawnCapture(buildLine(command, [rels[i]], []), { cwd, env, out: stream, err: stream });
      suites.set(f, { status: r.code === 0 ? 'passed' : 'failed', message: relativize(tail(r.output), scratch), tests: [], fileLevel: true });
    }
    return { suites };
  }
  const resultFile = `${scratch}.results${runner.ext}`;
  const line = buildLine(command, rels, [...runner.args(resultFile), ...extra]);
  const r = await spawnCapture(line, { cwd, env: { ...env, ...runner.env?.(cwd, env) }, out: stream, err: stream });
  if (!fs.existsSync(resultFile)) return { suites: new Map(), noResults: `the test command exited ${r.code} without results: ${relativize(tail(r.output), scratch)}` };
  const suites = runner.read(resultFile, { scratch, files });
  fs.rmSync(resultFile, { force: true });
  for (const s of suites.values()) {
    s.message = relativize(s.message, scratch);
    for (const t of s.tests) {
      if (t.status !== 'failed') Object.assign(t, { crash: null, why: '' });
      else {
        // The crash site is read from the paths as the runner printed them; the summary (clipped to
        // one line) only after the scratch folder is out, or the clip could cut a path in half.
        t.crash = runner.crashSite(t, scratch);
        t.message = relativize(t.message, scratch);
        t.failure = relativize(t.failure, scratch);
        t.why = runner.summary(t);
      }
    }
  }
  return { suites };
}

export function tally(kinds) {
  const t = {};
  for (const k of kinds) t[k] = (t[k] || 0) + 1;
  return t;
}

// Sign a receipt for the head commit recording what the check found; keep the report beside it.
export function recordCheck(ctx, { result, summary, report, markdown, details, passed = [], failed = [] }) {
  const key = ensureKey();
  const slot = allocReceipt(ctx.headTree, ctx.gate);
  const finishedAt = new Date();
  const ext = {
    kind: ctx.kind,
    gate: ctx.gate,
    summary,
    base: ctx.baseRef,
    baseCommit: ctx.base,
    mergeBase: ctx.mb,
    head: ctx.head,
    cwd: ctx.cwdRel || '.',
    command: commandLine(ctx.command),
    ...(ctx.setup ? { setup: ctx.setup } : {}),
    ...(ctx.teardown ? { teardown: ctx.teardown } : {}),
    ...(ctx.freshDbVar ? { freshDb: ctx.freshDbVar } : {}),
    startedAt: ctx.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - ctx.startedAt,
    toolchain: toolchain(),
    details,
  };
  const statement = buildStatement({
    name: ctx.name,
    tree: ctx.headTree,
    head: ctx.head,
    clean: true,
    result,
    ext,
    url: pathToFileURL(slot.log).href,
    passed,
    failed,
  });
  writeReceipt(slot, signStatement(statement, key), Buffer.from(report));
  const md = slot.file.replace(/\.dsse\.json$/, '.md');
  if (markdown) fs.writeFileSync(md, markdown);
  return { file: slot.file, markdown: markdown ? md : null };
}
