// goalline history: what goalpost would have flagged on a repository's merged pull requests. Each PR
// is judged on its merge commit against its first parent (the change exactly as it landed), one at a
// time and only while the machine is idle. With --first-heads it is also judged as first opened (its
// head when the PR was created, from GitHub), because review often fixes a real catch before the merge.
//
//   goalline history [--repo .] [--gh owner/name | --from-git] [--limit 200] [--cwd apps/web]
//                    [--tests <globs>] [--out goalline-history] [--first-heads] [--deps-root <dir>]
//                    [--max-minutes 8] [--only 12,15] [--no-machine] [--plan | --summary] -- npx jest {files}
//   goalline history --config <file.json>   (several areas, and the options below)
//
// The config file names the clone, the GitHub repo, where results go, and one entry per area:
//   { "gh": "owner/name", "repo": "<clone>", "out": "<dir>",
//     "areas": [{ "name": "web", "cwd": "apps/web", "tests": "apps/web/src/**/*.spec.ts,apps/web/src/**/*.spec.tsx",
//                 "command": "npx jest {files}", "extra": ["--fresh-db", "..."],
//                 "prisma": "<optional schema path under cwd: the client is generated from the head's schema first>" }],
//     "claims": "<optional board file: wait while its last WINDOW line is not RELEASED>",
//     "minFreeMb": 1600, "depsRoot": "<dir: one npm ci per lockfile>", "firstHeads": true, "minBatteryPct": 35 }
// Results: <out>/results.jsonl (one line per PR, phase and area; resumable), <out>/report.md (what it
// would have flagged, for a person), and <out>/summary.md (every flag, with labels from labels.json).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onlyAdded, typeError } from './goalpost.mjs';
import { foreignRunners } from './machine.mjs';
import { testGlobs } from './runners.mjs';
import { commandLine, list, matcher, UsageError } from './util.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'goalline.mjs');
const MAX = 64 * 1024 * 1024;

// owner/name from the origin remote's GitHub url, or null.
function ghFromRemote(repo) {
  try {
    const url = execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url)?.[1] || null;
  } catch {
    return null;
  }
}

function configFrom(opts, command) {
  if (opts.config) return JSON.parse(fs.readFileSync(opts.config, 'utf8'));
  if (!command.length) throw new UsageError('history needs the test command after --, e.g. goalline history -- npx jest {files}');
  const repo = path.resolve(opts.repo || process.cwd());
  return {
    repo,
    gh: opts.gh || (opts.fromGit ? null : ghFromRemote(repo)),
    fromGit: Boolean(opts.fromGit),
    base: opts.base,
    out: opts.out || 'goalline-history',
    areas: [{ name: opts.area || 'tests', cwd: opts.cwd || '', tests: opts.tests, command: commandLine(command), ...(opts.prisma ? { prisma: opts.prisma } : {}) }],
    minFreeMb: Number(opts.idleMb ?? 1600),
    depsRoot: opts.depsRoot,
    firstHeads: Boolean(opts.firstHeads),
  };
}

export async function cmdHistory(opts, command) {
  const cfg = configFrom(opts, command);
  const out = path.resolve(cfg.out);
  fs.mkdirSync(out, { recursive: true });
  // --rejudge-types writes to its own file, so results.jsonl stays the record of the first run;
  // --results <file> sends an experiment to a file of its own.
  const resultsFile = path.join(out, opts.results || (opts.rejudgeTypes ? 'results-typesoff.jsonl' : 'results.jsonl'));
  const typesOffSummaryFile = opts.results ? path.join(out, `${String(opts.results).replace(/\.jsonl$/, '')}.summary.md`) : path.join(out, 'summary-typesoff.md');
  const labelsFile = path.join(out, 'labels.json');
  const git = (...args) => execFileSync('git', ['-C', cfg.repo, ...args], { encoding: 'utf8', maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tryGit = (...args) => {
    try {
      return git(...args);
    } catch {
      return null;
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // --max-minutes: stop cleanly before the budget runs out, so the history can run in chunks that
  // each fit a caller's time limit. The next run resumes from results.jsonl.
  const startedAt = Date.now();
  const budgetMs = opts.maxMinutes ? Number(opts.maxMinutes) * 60_000 : Infinity;
  const pauseIfOver = (needMs = 0) => {
    if (budgetMs - (Date.now() - startedAt) > needMs) return;
    writeSummary();
    console.error('paused: the --max-minutes budget is used. Run the same command again to resume.');
    process.exit(4);
  };
  const readRows = (file = resultsFile) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const keyOf = (pr, phase, area) => `${pr}:${area}${phase === 'first' ? '@first' : ''}`;
  // Which files hold tests at a commit: --tests, else the runner's rules (pytest's own config then).
  const testsOf = (area, at) => {
    if (area.tests) return matcher(list(area.tests));
    const listed = new Map();
    const read = (rel) => {
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      if (!listed.has(dir)) listed.set(dir, new Set((tryGit('ls-tree', '--name-only', `${at}:${dir}`) || '').split('\n')));
      return listed.get(dir).has(rel.slice(rel.lastIndexOf('/') + 1)) ? tryGit('show', `${at}:${rel}`) : null;
    };
    return matcher(testGlobs([area.command], { read, cwd: area.cwd || '' }));
  };

  async function waitIdle() {
    if (opts.noMachine) return;
    for (let waited = 0; ; waited++) {
      const freeMb = Math.round(os.freemem() / 1024 / 1024);
      const board = cfg.claims && fs.existsSync(cfg.claims) ? fs.readFileSync(cfg.claims, 'utf8') : '';
      const window = board.split('\n').filter((l) => /WINDOW (ACTIVE|RESERVED|RELEASED)/.test(l)).pop() || 'RELEASED';
      const others = (await foreignRunners()) || [];
      if (freeMb >= (cfg.minFreeMb ?? 1600) && window.includes('RELEASED') && others.length === 0) return;
      if (waited % 10 === 0) console.error(`waiting for an idle machine (free ${freeMb} MB, other runners ${others.length}, board ${window.includes('RELEASED') ? 'quiet' : 'busy'})`);
      pauseIfOver(60_000);
      await sleep(60_000);
    }
  }

  // The charge, when the machine runs on battery below minBatteryPct; otherwise null.
  function batteryLow() {
    if (!cfg.minBatteryPct || process.platform !== 'win32') return null;
    const ps = '$b = Get-CimInstance Win32_Battery | Select-Object -First 1; $s = Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1; "$($b.EstimatedChargeRemaining) $($s.PowerOnline)"';
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
    const [pct, online] = (r.stdout || '').trim().split(/\s+/);
    if (!pct || online === 'True') return null;
    return Number(pct) < cfg.minBatteryPct ? Number(pct) : null;
  }

  function stopIfLow() {
    const pct = batteryLow();
    if (pct === null) return;
    writeSummary();
    console.error(`stopped: the battery is at ${pct}% with no charger. Run the same command again to resume.`);
    process.exit(3);
  }

  // One install per lockfile, shared by every commit that has it, made on first use in a detached
  // worktree of the clone. The clone's own node_modules can be from any older lockfile.
  const failedLocks = new Map();
  async function depsFor(head) {
    if (!cfg.depsRoot) return null;
    const lock = tryGit('rev-parse', `${head}:package-lock.json`);
    if (!lock) throw new Error(`no package-lock.json at ${head.slice(0, 7)}`);
    const id = lock.slice(0, 12);
    if (failedLocks.has(id)) throw new Error(failedLocks.get(id));
    const dir = path.join(path.resolve(cfg.depsRoot), id);
    if (fs.existsSync(path.join(dir, '.history-installed'))) return dir;
    stopIfLow();
    await waitIdle();
    pauseIfOver(5 * 60_000);
    if (!fs.existsSync(dir)) git('worktree', 'add', '--detach', dir, head);
    console.error(`installing the packages of lockfile ${id} (${head.slice(0, 7)})...`);
    const started = Date.now();
    const r = spawnSync('npm ci --no-audit --no-fund', { cwd: dir, shell: true, encoding: 'utf8', maxBuffer: MAX });
    fs.writeFileSync(path.join(out, `deps-${id}.log`), `${r.stdout || ''}${r.stderr || ''}`);
    if (r.status !== 0) {
      failedLocks.set(id, `npm ci failed for lockfile ${id}: see deps-${id}.log`);
      throw new Error(failedLocks.get(id));
    }
    fs.writeFileSync(path.join(dir, '.history-installed'), `${head}\n`);
    console.error(`installed ${id} in ${Math.round((Date.now() - started) / 1000)}s`);
    return dir;
  }

  // The generated Prisma client lives in node_modules, so it is made again from the schema of the
  // code under test whenever that differs from the schema it was last made from.
  function preparePrisma(dir, area, head) {
    const rel = `${area.cwd}/${area.prisma}`;
    const blob = tryGit('rev-parse', `${head}:${rel}`);
    if (!blob) return;
    const mark = path.join(dir, '.history-prisma');
    if (fs.existsSync(mark) && fs.readFileSync(mark, 'utf8').trim() === blob) return;
    fs.writeFileSync(path.join(dir, rel), execFileSync('git', ['-C', cfg.repo, 'show', `${head}:${rel}`], { maxBuffer: MAX }));
    const r = spawnSync(`npx prisma generate --schema "${area.prisma}"`, { cwd: path.join(dir, area.cwd), shell: true, encoding: 'utf8', maxBuffer: MAX });
    if (r.status !== 0) throw new Error(`prisma generate failed: ${`${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').slice(-2).join(' | ')}`);
    fs.writeFileSync(mark, `${blob}\n`);
  }

  // When each merged PR was opened, its commits and its force pushes: enough to find its first head.
  function prMeta() {
    const [owner, name] = cfg.gh.split('/');
    const query = `query($owner: String!, $name: String!, $after: String) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: MERGED, first: 50, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            number createdAt headRefOid
            commits(first: 100) { nodes { commit { oid committedDate } } }
            timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 50) { nodes { ... on HeadRefForcePushedEvent { createdAt beforeCommit { oid } } } }
          }
        }
      }
    }`;
    const meta = new Map();
    for (let after = null; ; ) {
      const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, ...(after ? ['-f', `after=${after}`] : [])];
      const page = JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: MAX })).data.repository.pullRequests;
      for (const n of page.nodes) meta.set(n.number, n);
      if (!page.pageInfo.hasNextPage) return meta;
      after = page.pageInfo.endCursor;
    }
  }

  // The PR's head when it was opened: its last commit made by then (a minute of slack for the push).
  // A force push can replace those commits; then the head just before the first force push is used.
  function firstHead(m) {
    const opened = Date.parse(m.createdAt);
    const made = m.commits.nodes.map((n) => n.commit).filter((c) => Date.parse(c.committedDate) <= opened + 60_000);
    const pushes = m.timelineItems.nodes.filter((n) => n.beforeCommit && Date.parse(n.createdAt) > opened);
    if (made.length) return { sha: made[made.length - 1].oid, how: pushes.length ? 'commit dates; force-pushed later' : 'commit dates' };
    if (pushes.length) return { sha: pushes[0].beforeCommit.oid, how: 'the head before the first force push' };
    return null;
  }

  function haveCommit(sha, pr) {
    const has = () => tryGit('cat-file', '-e', `${sha}^{commit}`) !== null;
    if (has()) return true;
    tryGit('fetch', '-q', 'origin', `+refs/pull/${pr}/head`);
    if (has()) return true;
    tryGit('fetch', '-q', 'origin', sha);
    return has();
  }

  // A test that no longer runs because the module it imports was deleted (or moved away) is not a
  // moved goalpost: the question is whether whatever replaced the module is tested, so it gets its
  // own label, with the PR's new test files listed next to it.
  function subjectGone(file, changes, area) {
    const gone = (target) => changes.some(([s, a]) => /^[DR]/.test(s) && (a === target || a.startsWith(`${target}.`) || a.startsWith(`${target}/index.`) || a.startsWith(`${target}/__init__.`)));
    // Python: "No module named 'pkg.mod'" for pkg/mod.py or pkg/mod/, from the root, src/ or the area.
    const mod = /No module named '([\w.]+)'/.exec(file.note || '')?.[1];
    if (mod) return [...new Set(['', 'src/', area.cwd ? `${area.cwd}/` : '', area.cwd ? `${area.cwd}/src/` : ''])].some((at) => gone(`${at}${mod.split('.').join('/')}`));
    const spec = /Cannot find module '([^']+)'/.exec(file.note || '')?.[1];
    if (!spec) return false;
    const target = spec.startsWith('.') ? path.posix.join(path.posix.dirname(file.path), spec) : spec.startsWith('@/') ? `${area.cwd}/src/${spec.slice(2)}` : null;
    return !!target && gone(target);
  }

  async function judgeRow(row, area, ph, changes, isTest) {
    stopIfLow();
    await waitIdle();
    pauseIfOver(90_000);
    const started = Date.now();
    let deps;
    try {
      deps = await depsFor(ph.head);
      if (deps && area.prisma) preparePrisma(deps, area, ph.head);
    } catch (e) {
      row.error = e.message;
      console.error(`#${row.pr} ${row.phase} ${row.area}: ${row.error}`);
      return;
    }
    const gate = `history-${area.name}${ph.phase === 'first' ? '-first' : ''}`;
    const r = spawnSync(
      process.execPath,
      [
        BIN, 'goalpost', '--repo', cfg.repo, '--base', ph.base, '--head', ph.head, ...(area.cwd ? ['--cwd', area.cwd] : []), ...(area.tests ? ['--tests', area.tests] : []),
        '--gate', gate, '--no-fail', '--quiet', ...(deps ? ['--deps-from', deps] : []), ...(area.extra || []), '--', area.command,
      ],
      { encoding: 'utf8', env: { ...process.env, GOALLINE_HOME: path.join(out, 'store'), RECEIPTS_HOME: path.join(out, 'store') }, maxBuffer: MAX },
    );
    const receipt = /^receipt: (.+)$/m.exec(r.stdout || '')?.[1];
    if (!receipt) {
      row.error = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ');
    } else {
      const st = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(receipt, 'utf8')).payload, 'base64').toString('utf8'));
      const ext = st.predicate.configuration[0].annotations;
      row.result = st.predicate.result;
      row.summary = ext.summary;
      row.files = ext.details.files.map((f) => ({
        path: f.path,
        now: f.now,
        kind: f.kind,
        failing: f.failing,
        ...(f.failingWhy ? { failingWhy: f.failingWhy } : {}),
        note: f.note,
        ...(f.kind === 'MOVED' ? { additionsOnly: Boolean(f.additionsOnly) } : {}),
        ...(f.typesOff ? { typesOff: f.typesOff } : {}),
        ...(f.transplant ? { transplant: f.transplant } : {}),
      }));
      const added = changes.filter(([s, a]) => s === 'A' && isTest(a)).map(([, a]) => a);
      for (const f of row.files) {
        if (f.kind === 'BROKE' && subjectGone(f, changes, area)) Object.assign(f, { kind: 'SUBJECT-DELETED', replacementTests: added });
      }
      row.depsNote = /note: node_modules come from/.test(r.stdout);
    }
    row.seconds = Math.round((Date.now() - started) / 1000);
    console.error(`#${row.pr} ${row.phase} ${row.area}: ${row.summary || row.error} (${row.seconds}s)`);
  }

  // summary-typesoff.md: what became of each old file that failed only to compile, once it ran with
  // the type check off, and its new flags to label (labels in labels-typesoff.json).
  function writeTypesOffSummary() {
    const esc = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
    const after = new Map(readRows().map((r) => [keyOf(r.pr, r.phase, r.area), r]));
    const labelsPath = path.join(out, 'labels-typesoff.json');
    const labels = fs.existsSync(labelsPath) ? JSON.parse(fs.readFileSync(labelsPath, 'utf8')) : {};
    const counts = {};
    const flags = [];
    for (const r of readRows(path.join(out, 'results.jsonl'))) {
      for (const f of r.files || []) {
        if (f.kind !== 'BROKE' || !typeError(f.note)) continue;
        const a = after.get(keyOf(r.pr, r.phase, r.area));
        const g = a && (a.files || []).find((x) => x.path === f.path);
        const now = a ? (g ? g.kind : 'missing') : 'not run yet';
        const k = `${r.phase || 'merge'}|${now}`;
        counts[k] = (counts[k] || 0) + 1;
        if (now === 'MOVED') flags.push({ r: a, f: g, label: labels[`${a.pr}:${a.phase || 'merge'}:${a.area}:${g.path}`] || {} });
      }
    }
    const lines = [
      '# Compile-broken old tests, judged with the type check off',
      '',
      'Every old test file that failed only to compile against the new types (TYPE-ONLY in summary.md), run again with goalpost --retry-untyped.',
      '',
      '| Phase | Now | Files |',
      '|---|---|---|',
      ...Object.keys(counts).sort().map((k) => `| ${k.split('|')[0]} | ${k.split('|')[1]} | ${counts[k]} |`),
      '',
      '## Now MOVED: old expectations that fail on the new code',
      '',
      '| PR | Phase | Area | File | Old tests failing | Label | Why |',
      '|---|---|---|---|---|---|---|',
      ...flags.map(({ r, f, label }) => `| #${r.pr} ${esc(r.title).slice(0, 50)} | ${r.phase} | ${r.area} | ${f.path} | ${esc((f.failing || []).slice(0, 3).join('; '))} | ${esc(label.label)} | ${esc(label.why)} |`),
    ];
    fs.writeFileSync(typesOffSummaryFile, `${lines.join('\n')}\n`);
    console.error(`summary: ${typesOffSummaryFile}`);
  }

  // report.md: for a person deciding whether to adopt goalpost. What a "test file changed" alarm
  // would have flagged against what goalpost flags, PR by PR, with the exact old and new values.
  function writeReport() {
    const rows = readRows().filter((r) => (r.phase || 'merge') === 'merge');
    const byPr = new Map();
    for (const r of rows) byPr.set(r.pr, [...(byPr.get(r.pr) || []), r]);
    const files = (rs) => rs.flatMap((r) => (r.files || []).map((f) => ({ r, f })));
    const needs = (x) => (x.f.kind === 'MOVED' && !x.f.additionsOnly) || x.f.kind === 'BROKE' || x.f.kind === 'SUBJECT-DELETED';
    // Rows written before goalpost marked additions-only changes get the mark from the diff.
    for (const r of rows) {
      for (const f of r.files || []) {
        if (f.kind === 'MOVED' && !('additionsOnly' in f)) f.additionsOnly = Boolean(f.now) && onlyAdded(cfg.repo, r.base, r.head, f.path, f.now);
      }
    }
    const lowRisk = (x) => x.f.kind === 'MOVED' && x.f.additionsOnly;
    const unjudged = (x) => x.f.kind === 'CRASHED' || x.f.kind === 'UNKNOWN';
    const groups = { look: [], low: [], held: [], unjudged: [] };
    for (const [pr, rs] of byPr) {
      if (!rs.some((r) => r.edited > 0)) continue;
      const fs_ = files(rs);
      const g = fs_.some(needs) ? 'look' : fs_.some(lowRisk) ? 'low' : fs_.some(unjudged) || rs.some((r) => r.error) ? 'unjudged' : 'held';
      groups[g].push({ pr, rs, fs: fs_ });
    }
    const all = files(rows);
    const secs = rows.map((r) => r.seconds).filter(Boolean).sort((a, b) => a - b);
    const minutes = Math.round(secs.reduce((a, b) => a + b, 0) / 60);
    const touched = groups.look.length + groups.low.length + groups.held.length + groups.unjudged.length;
    const title = (rs) => String(rs[0].title || '').replace(/\n/g, ' ');
    const fails = (f) => {
      const all = (f.failing || []).map((name, i) => `  - ✗ ${name}${f.failingWhy?.[i] ? `: ${f.failingWhy[i]}` : ''}`);
      return all.length > 3 ? [...all.slice(0, 3), `  - and ${all.length - 3} more`] : all;
    };
    const lines = [
      `# What goalpost would have flagged: the last ${byPr.size} merged PRs${cfg.gh ? ` of ${cfg.gh}` : ''}`,
      '',
      'Each PR was checked as it was merged: the old versions of the tests it edited or deleted, run on its new code.',
      '',
      '| | PRs |',
      '|---|---|',
      `| Changed an existing test file (a "test file changed" alarm fires on every one) | ${touched} |`,
      `| **Needs a look**: an old expectation no longer holds, and the PR removed or rewrote lines of that test | **${groups.look.length}** |`,
      `| Low risk only: an old test fails, but the PR only added lines to it (a list that grew, a mock that was added) | ${groups.low.length} |`,
      `| Every old expectation still holds | ${groups.held.length} |`,
      `| Could not be judged (the old tests crashed inside the new code, or did not run) | ${groups.unjudged.length} |`,
      '',
      `Old test files run: ${all.length}, of which ${all.filter((x) => x.f.kind === 'HELD' || x.f.kind === 'EMPTY').length} still pass. Machine time: about ${minutes} min${secs.length ? ` (median ${secs[Math.floor(secs.length / 2)]} s per check)` : ''}.`,
      '',
    ];
    if (groups.look.length) {
      lines.push('## Needs a look', '');
      for (const { pr, rs, fs: fs_ } of groups.look) {
        lines.push(`### #${pr} ${title(rs)}`, '');
        for (const x of fs_.filter(needs)) lines.push(`- \`${x.f.path}\`${x.f.kind === 'MOVED' ? '' : `: ${x.f.note}`}`, ...fails(x.f));
        lines.push('');
      }
    }
    if (groups.low.length) {
      lines.push('## Low risk only', '');
      for (const { pr, rs, fs: fs_ } of groups.low) lines.push(`- #${pr} ${title(rs)}: ${fs_.filter(lowRisk).map((x) => `\`${x.f.path}\``).join(', ')}`);
      lines.push('');
    }
    if (groups.unjudged.length) {
      lines.push('## Could not be judged', '');
      for (const { pr, rs, fs: fs_ } of groups.unjudged) lines.push(`- #${pr} ${title(rs)}: ${fs_.filter(unjudged).map((x) => `\`${x.f.path}\``).join(', ') || rs.find((r) => r.error)?.error || ''}`);
      lines.push('');
    }
    fs.writeFileSync(path.join(out, 'report.md'), `${lines.join('\n')}\n`);
    console.error(`report: ${path.join(out, 'report.md')}`);
  }

  // summary.md: the naive rule against goalpost per phase, and every flag listed with its label.
  function writeSummary() {
    if (opts.rejudgeTypes) return writeTypesOffSummary();
    writeReport();
    const rows = readRows();
    const labels = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, 'utf8')) : {};
    const esc = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
    const kinds = (r) => (r.files || []).map((f) => f.kind);
    const isFlag = (k) => k === 'MOVED' || k === 'BROKE';
    const lines = [
      '# Goalpost on merged PRs',
      '',
      'Phase **merge**: the merge commit against its first parent (the change as it landed). Phase **first**: the PR head when the PR was opened, against its merge-base (before review fixes).',
      '',
      '| Phase | Area | PR-areas scanned | Touched an existing test (naive flag) | Goalpost flagged | Subject deleted | Held | Not judged / error | First head skipped |',
      '|---|---|---|---|---|---|---|---|---|',
    ];
    for (const phase of ['merge', 'first']) {
      for (const area of cfg.areas) {
        const rs = rows.filter((r) => (r.phase || 'merge') === phase && r.area === area.name);
        if (!rs.length) continue;
        const touched = rs.filter((r) => r.edited > 0);
        const flagged = touched.filter((r) => kinds(r).some(isFlag));
        const subject = touched.filter((r) => !kinds(r).some(isFlag) && kinds(r).includes('SUBJECT-DELETED'));
        const held = touched.filter((r) => r.files && kinds(r).every((k) => k === 'HELD' || k === 'EMPTY'));
        const other = touched.length - flagged.length - subject.length - held.length;
        lines.push(`| ${phase} | ${area.name} | ${rs.length} | ${touched.length} | ${flagged.length} | ${subject.length} | ${held.length} | ${other} | ${rs.filter((r) => r.skipped).length} |`);
      }
    }
    const flags = [];
    for (const r of rows) {
      for (const f of r.files || []) {
        if (isFlag(f.kind) || f.kind === 'SUBJECT-DELETED') flags.push({ r, f, label: labels[`${r.pr}:${r.phase || 'merge'}:${r.area}:${f.path}`] || {} });
      }
    }
    const tally = {};
    for (const { r, label } of flags) {
      const k = `${r.phase || 'merge'}|${label.label || 'unlabelled'}`;
      tally[k] = (tally[k] || 0) + 1;
    }
    lines.push('', '## Labels', '', '| Phase | Label | Flagged files |', '|---|---|---|');
    for (const k of Object.keys(tally).sort()) lines.push(`| ${k.split('|')[0]} | ${k.split('|')[1]} | ${tally[k]} |`);
    lines.push(
      '',
      '## Flags to label',
      '',
      'INTENDED: the PR meant to change this behaviour and the test edit matches it. REAL: an unintended change or a weakened test that was merged. CAUGHT IN REVIEW (phase first): real, and review fixed it before the merge. TYPE-ONLY: the old file no longer compiles against the new types or signatures, so its behaviour was not judged. A why starting UNDOCUMENTED marks an intended change the PR text does not mention. NOISE: the tool or the setup, not the code. Subject deleted: REPLACED+TESTED or REPLACED, UNTESTED.',
      '',
      '| PR | Phase | Area | File | Result | Label | Why |',
      '|---|---|---|---|---|---|---|',
    );
    for (const { r, f, label } of flags) {
      const detail = f.kind === 'SUBJECT-DELETED' ? `new tests in the PR: ${(f.replacementTests || []).join(', ') || 'none'}` : (f.failing || []).slice(0, 3).join('; ') || (f.note || '').slice(0, 160);
      lines.push(`| #${r.pr} ${esc(r.title).slice(0, 60)} | ${r.phase || 'merge'} | ${r.area} | ${f.path} | ${f.kind}: ${esc(detail)} | ${esc(label.label)} | ${esc(label.why)} |`);
    }
    fs.writeFileSync(path.join(out, 'summary.md'), `${lines.join('\n')}\n`);
    console.error(`summary: ${path.join(out, 'summary.md')}`);
  }

  if (opts.summary) {
    writeSummary();
    return 0;
  }

  const done = new Set(readRows().map((r) => keyOf(r.pr, r.phase, r.area)));
  // --rejudge-types: only the rows whose old files failed just to compile are run again.
  const retype = opts.rejudgeTypes
    ? new Set(readRows(path.join(out, 'results.jsonl')).filter((r) => (r.files || []).some((f) => f.kind === 'BROKE' && typeError(f.note))).map((r) => keyOf(r.pr, r.phase, r.area)))
    : null;
  const todo = (key) => !done.has(key) && (!retype || retype.has(key));
  const only = opts.only ? new Set(String(opts.only).split(',').map(Number)) : null;
  // GitHub's answers are kept in <out>, so a run (or the next chunk) still works while GitHub cannot
  // be reached. Every successful fetch refreshes the copy.
  function cached(name, fetch) {
    const file = path.join(out, `${name}.cache.json`);
    try {
      const value = fetch();
      fs.writeFileSync(file, JSON.stringify(value));
      return value;
    } catch (e) {
      if (!fs.existsSync(file)) throw e;
      console.error(`${name}: GitHub could not be reached (${String(e.message).split('\n')[0]}); using the copy saved ${fs.statSync(file).mtime.toISOString()}`);
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }
  const limit = String(opts.limit || (opts.config ? 500 : 200));
  // Merged PRs from the merge commits on the base branch: "Merge pull request #N from ..." (with the
  // title on its second line) or a squash merge "Title (#N)". Works offline and without GitHub.
  function prsFromGit() {
    const branch = cfg.base || (tryGit('rev-parse', '--abbrev-ref', 'origin/HEAD') || 'main');
    const log = git('log', '--first-parent', `--max-count=${Number(limit) * 3}`, '--format=%H%x00%cI%x00%s%x00%b%x1e', branch);
    const found = [];
    for (const entry of log.split('\x1e')) {
      const [oid, mergedAt, subject = '', body = ''] = entry.trim().split('\0');
      if (!oid) continue;
      const merge = /^Merge pull request #(\d+) from (\S+)/.exec(subject);
      const squash = /^(.*) \(#(\d+)\)$/.exec(subject);
      if (merge) found.push({ number: Number(merge[1]), title: body.split('\n').find((l) => l.trim()) || subject, headRefName: merge[2], mergedAt, mergeCommit: { oid } });
      else if (squash) found.push({ number: Number(squash[2]), title: squash[1], headRefName: null, mergedAt, mergeCommit: { oid } });
      if (found.length >= Number(limit)) break;
    }
    return found;
  }
  const listFromGh = () =>
    cached(`merged-prs-${limit}`, () =>
      JSON.parse(execFileSync('gh', ['pr', 'list', '-R', cfg.gh, '--state', 'merged', '--limit', limit, '--json', 'number,title,mergeCommit,mergedAt,headRefName'], { encoding: 'utf8', maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'] })),
    );
  let prsAll;
  if (cfg.fromGit || !cfg.gh) prsAll = prsFromGit();
  else {
    try {
      prsAll = listFromGh();
    } catch (e) {
      console.error(`history: GitHub could not list the merged PRs (${String(e.message).split('\n')[0]}); reading them from the merge commits instead.`);
      prsAll = prsFromGit();
    }
  }
  const prs = prsAll.filter((p) => p.mergeCommit && (!only || only.has(p.number)));
  const firstHeads = cfg.firstHeads && cfg.gh && !cfg.fromGit;
  if (cfg.firstHeads && !firstHeads) console.error('history: --first-heads needs GitHub (--gh); judging merge commits only.');
  const meta = firstHeads ? new Map(cached('pr-meta', () => [...prMeta()])) : new Map();

  const planned = [];
  for (const pr of prs) {
    // A resumed run skips finished PRs before any git work, so each chunk starts quickly.
    const pending = (phase) => cfg.areas.some((a) => todo(keyOf(pr.number, phase, a.name)));
    if (!pending('merge') && !(firstHeads && pending('first'))) continue;
    const merge = pr.mergeCommit.oid;
    const parent = tryGit('rev-parse', `${merge}^1`);
    if (!parent) {
      console.error(`#${pr.number}: merge commit ${merge.slice(0, 7)} is not in the clone; fetch first`);
      continue;
    }
    const phases = pending('merge') ? [{ phase: 'merge', base: parent, head: merge }] : [];
    if (firstHeads && pending('first')) {
      const m = meta.get(pr.number);
      const fh = m && firstHead(m);
      if (!fh) phases.push({ phase: 'first', skip: 'the head when opened is unknown' });
      else if (fh.sha === m.headRefOid) phases.push({ phase: 'first', skip: 'no commits after the PR was opened' });
      else if (!haveCommit(fh.sha, pr.number)) phases.push({ phase: 'first', skip: `the head when opened (${fh.sha.slice(0, 7)}) can no longer be fetched` });
      else phases.push({ phase: 'first', base: parent, head: fh.sha, how: fh.how });
    }
    for (const ph of phases) {
      const from = ph.skip ? null : git('merge-base', ph.base, ph.head);
      const changes = ph.skip ? [] : git('diff', '--name-status', '-M', from, ph.head).split('\n').filter(Boolean).map((l) => l.split('\t'));
      for (const area of cfg.areas) {
        if (!todo(keyOf(pr.number, ph.phase, area.name))) continue;
        const isTest = ph.skip ? () => false : testsOf(area, from);
        // An existing test file edited or deleted (renames count only with edits, as in goalpost):
        // the naive rule "this PR touched a test" fires here.
        const editedStatus = (s) => /^[MDT]/.test(s) || (/^R\d+$/.test(s) && Number(s.slice(1)) < 100);
        const edited = changes.filter(([s, a]) => editedStatus(s) && isTest(a)).map(([, a]) => a);
        const row = { pr: pr.number, title: pr.title, branch: pr.headRefName, mergedAt: pr.mergedAt, phase: ph.phase, area: area.name, base: from, head: ph.head || null, edited: edited.length };
        if (ph.how) row.firstHeadFrom = ph.how;
        if (ph.skip) row.skipped = ph.skip;
        if (opts.plan) {
          planned.push(row);
          continue;
        }
        if (edited.length) await judgeRow(row, area, ph, changes, isTest);
        fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      }
    }
  }

  if (opts.plan) {
    console.log(`plan: ${prs.length} merged PR(s); nothing was run.`);
    for (const phase of ['merge', 'first']) {
      for (const area of cfg.areas) {
        const rs = planned.filter((r) => r.phase === phase && r.area === area.name);
        if (!rs.length) continue;
        const touched = rs.filter((r) => r.edited > 0);
        const skipped = rs.filter((r) => r.skipped).length;
        console.log(`  ${phase} ${area.name}: ${touched.length} of ${rs.length} PRs edited or deleted an existing test file (${touched.reduce((a, r) => a + r.edited, 0)} files)${skipped ? `; ${skipped} first heads skipped` : ''}: goalpost runs on these.`);
      }
    }
    // --deps-root installs npm lockfiles only, so a repository without one has none to count.
    const locks = new Set(planned.filter((r) => r.edited > 0).map((r) => tryGit('rev-parse', `${r.head}:package-lock.json`)?.slice(0, 12)).filter(Boolean));
    if (locks.size) console.log(`  lockfiles to install: ${locks.size}`);
    return 0;
  }
  writeSummary();
  return 0;
}
