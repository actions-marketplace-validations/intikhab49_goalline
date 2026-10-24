// goalline guard: a stop check for coding agents (a Claude Code Stop hook, or any agent loop). Before
// the agent may say it is done, the old versions of the tests its work edited or deleted run against
// that work, uncommitted files included. An old expectation that no longer holds blocks the stop
// (exit 2; the message goes back to the agent) until the behaviour is restored or the change is
// acknowledged with a reason. The reasons form a ledger the reviewer reads: goalline guard --report.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACKS, added, reasonFor } from './acks.mjs';
import { git, readAt, repoRoot, workingTree } from './git.mjs';
import { UsageError } from './util.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'goalline.mjs');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

// A Claude Code hook gets its event as JSON on stdin (cwd, stop_hook_active...). Read only with --hook,
// so a plain terminal run never waits on stdin.
function hookInput() {
  try {
    const s = fs.readFileSync(0, 'utf8');
    return s.trim() ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

function defaultBase(root) {
  const head = git(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { allowFail: true });
  if (head.code === 0 && String(head.stdout).trim()) return String(head.stdout).trim();
  for (const b of ['main', 'master']) if (git(root, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`], { allowFail: true }).code === 0) return b;
  throw new UsageError('could not tell the base branch; pass --base <branch>');
}

// The work as it stands, uncommitted files included, as a commit goalpost can check. It is a loose
// object: no branch, index or file in the checkout changes.
function snapshot(root) {
  const wt = workingTree(root);
  if (wt.clean) return wt.head;
  const ident = ['-c', 'user.name=goalline guard', '-c', 'user.email=guard@goalline.invalid'];
  return String(git(root, [...ident, 'commit-tree', wt.tree, '-p', wt.head, '-m', 'goalline guard: snapshot of the working tree']).stdout).trim();
}

const keyOf = (f) => `${f.path}::${f.test}`;
const acked = (acks, f) => reasonFor(acks, [f.path], f.test) !== null;

// The acknowledgements this work made: the file as it stands, less the entries already on the base,
// which explained earlier changes (acks.mjs). Without a base to compare with, all of them.
function ownAcks(root, base, rel, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const mb = base ? String(git(root, ['merge-base', base, 'HEAD'], { allowFail: true }).stdout).trim() : '';
  return added(text, mb ? (readAt(root, mb, rel)?.toString('utf8') ?? null) : null);
}

export async function cmdGuard(opts, command) {
  const input = opts.hook ? hookInput() : {};
  const root = repoRoot(path.resolve(opts.repo || input.cwd || process.cwd()));
  const acksRel = opts.acks || ACKS;
  const acksFile = path.join(root, acksRel);

  if (opts.ack !== undefined) {
    if (typeof opts.ack !== 'string' || typeof opts.why !== 'string' || !opts.why.trim()) {
      throw new UsageError('--ack "<test file>::<test name>" (or just the file) needs --why "<one line for the reviewer>"');
    }
    const all = readJson(acksFile, []);
    all.push({ test: opts.ack, why: opts.why.trim(), at: new Date().toISOString() });
    writeJson(acksFile, all);
    console.log(`goalline guard: acknowledged ${opts.ack}. It goes into the reviewer's ledger (goalline guard --report).`);
    return 0;
  }
  if (opts.report) {
    let base = opts.base;
    try {
      base ||= defaultBase(root);
    } catch {
      // No base to tell old entries from: the ledger shows them all.
    }
    const acks = ownAcks(root, base, acksRel, acksFile);
    const lines = ['### Changed test expectations, acknowledged by the agent', ''];
    if (!acks.length) lines.push('None.');
    else lines.push('| Test | Why |', '|---|---|', ...acks.map((a) => `| \`${a.test.replace(/\|/g, '\\|')}\` | ${a.why.replace(/\|/g, '\\|')} |`));
    console.log(lines.join('\n'));
    return 0;
  }
  if (!command.length) throw new UsageError('guard needs the test command after --, e.g. goalline guard -- npx jest {files}');

  const base = opts.base || defaultBase(root);
  const head = snapshot(root);
  const acks = ownAcks(root, base, acksRel, acksFile);
  const pass = (k) => (opts[k] === undefined ? [] : [`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(opts[k])]);
  const r = spawnSync(
    process.execPath,
    [BIN, 'goalpost', '--repo', root, '--base', base, '--head', head, '--gate', 'guard', '--no-fail', '--quiet', ...pass('cwd'), ...pass('tests'), ...pass('depsFrom'), '--', ...command],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const receipt = /^receipt: (.+)$/m.exec(r.stdout || '')?.[1];
  // The guard must never trap an agent because of its own failure: no verdict, no block.
  if (!receipt) {
    console.error(`goalline guard: the check could not run (${(r.stderr || r.stdout || '').trim().split('\n').pop()}); not blocking.`);
    return 0;
  }
  const statement = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(receipt, 'utf8')).payload, 'base64').toString('utf8'));
  const files = statement.predicate.configuration[0].annotations.details.files;
  const findings = [];
  for (const f of files) {
    if (f.kind === 'MOVED') for (const test of f.failing?.length ? f.failing : ['*']) findings.push({ path: f.path, test });
    else if (f.kind === 'BROKE') findings.push({ path: f.path, test: '*' });
  }
  const open = findings.filter((f) => !acked(acks, f));
  const report = (r.stdout || '').split(/\nreceipt: /)[0].trim();
  if (!open.length) {
    if (findings.length) console.error(`goalline guard: ${findings.length} changed test expectation(s), all acknowledged.`);
    return 0;
  }

  // A stuck agent must not be trapped forever: the same unacknowledged set blocks --max-blocks times.
  const stateFile = path.resolve(root, String(git(root, ['rev-parse', '--git-path', 'goalline-guard.json']).stdout).trim());
  const state = readJson(stateFile, {});
  const set = open.map(keyOf).sort().join('\n');
  const count = state.set === set ? state.count + 1 : 1;
  writeJson(stateFile, { set, count });
  const max = Number(opts.maxBlocks ?? 3);
  if (count > max) {
    console.error(`goalline guard: WARNING: stopping with ${open.length} unacknowledged changed test expectation(s), after blocking ${max} times. A person must review them.`);
    return 0;
  }

  const ackLine = (f) => `  goalline guard --ack "${keyOf(f).replace(/::\*$/, '')}" --why "<why this change is intended>"`;
  console.error(
    [
      `goalline guard: ${open.length} old test expectation(s) no longer hold on your changes. Do not stop yet.`,
      '',
      report,
      '',
      'For each one: restore the behaviour the old test expects, or, if the change is intended, say why',
      '(the reason goes to the reviewer):',
      ...open.map(ackLine),
      '',
      'Editing the test to match is not enough: the check runs the OLD version of the test.',
    ].join('\n'),
  );
  return 2;
}
