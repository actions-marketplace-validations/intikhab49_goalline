import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { git } from './git.mjs';
import { listGateReceipts, listReceipts, safe } from './store.mjs';
import { fmtDuration, fmtWhen, globToRegExp, home, matcher, short } from './util.mjs';
import { judge } from './verify.mjs';

// Rule #1: anything unknown means run again. Reuse only ever stands in for clean passes.

// The earlier runs of `gate` on `tree` that can stand in for running it again, newest first,
// or null when there aren't enough: `runs` valid receipts, one made on an idle machine if `idle`.
// `inputs` are fresh readings of what the gate depends on outside the code; null skips that check.
export function proofOn(tree, gate, { runs = 1, idle = false, keys, inputs = {} }) {
  const valid = listReceipts(tree)
    .map((e) => judge(e, { tree, inputs }, keys))
    .filter((r) => r.valid && r.gate === gate && r.kind === 'run')
    .reverse();
  if (valid.length < runs) return null;
  if (idle && !valid.some((r) => r.ext.machine?.idle === true)) return null;
  return valid;
}

// Why the newest pass of `gate` on `tree` can't stand in for a run (a changed input, another
// Node), or null when there is no such pass.
export function whyNotReused(tree, gate, { keys, inputs = {} }) {
  const passes = listReceipts(tree)
    .map((e) => judge(e, { tree, inputs }, keys))
    .filter((r) => r.authentic && r.gate === gate && r.kind === 'run' && r.st.predicate?.result === 'PASSED' && !r.valid);
  return passes.at(-1)?.reason || null;
}

// A rules file names areas of the repo and the areas each gate depends on:
//   { "neverReuse": ["npm-ci", "*build*"], "outputs": { "web-build": ["apps/web/.next/BUILD_ID"] },
//     "uses": { "browser": ["web-build"] }, "ignore": ["**/*.md"],
//     "areas": { "api": ["apps/api/**"], "types": ["packages/**"] }, "gates": { "api-*": ["api", "types"] },
//     "inputs": { "api-*": ["db"] } }
// A changed file in no area at all (a lockfile, CI config, anything new) can affect every gate.
export function loadRules(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const never = (raw.neverReuse || []).map(globToRegExp);
  const outputs = Object.entries(raw.outputs || {}).map(([pattern, paths]) => ({ re: globToRegExp(pattern), paths }));
  const uses = Object.entries(raw.uses || {}).map(([pattern, gates]) => ({ re: globToRegExp(pattern), gates }));
  const inputs = raw.inputs ? Object.entries(raw.inputs).map(([pattern, names]) => ({ re: globToRegExp(pattern), names })) : null;
  return {
    file,
    // The gates whose build a gate tests (a browser suite starts the built app): their output on
    // disk must be what a passing run of them made from the same code.
    usesFor: (gate) => uses.find((u) => u.re.test(gate))?.gates || [],
    // Install and build gates: later gates use what they make, so a skipped one would leave them
    // testing a missing or older build. Reused only while the output it made is still in place.
    neverReuse: (gate) => never.some((re) => re.test(gate)),
    outputsFor: (gate) => outputs.find((o) => o.re.test(gate))?.paths || [],
    // The --inputs (a database schema...) each gate depends on; null when the rules don't say.
    inputsFor: (gate) => (inputs ? inputs.find((i) => i.re.test(gate))?.names || [] : null),
    ignore: matcher(raw.ignore || []),
    areas: Object.entries(raw.areas || {}).map(([name, globs]) => ({ name, match: matcher(globs) })),
    gates: Object.entries(raw.gates || {}).map(([pattern, areas]) => ({ pattern, re: globToRegExp(pattern), areas })),
  };
}

// The first changed file that can affect `gate`, and why; null when none can.
export function whatAffects(rules, gate, paths) {
  const rule = rules.gates.find((g) => g.re.test(gate));
  if (!rule) return { reason: `no rule names the gate "${gate}"` };
  for (const p of paths) {
    if (rules.ignore(p)) continue;
    const areas = rules.areas.filter((a) => a.match(p)).map((a) => a.name);
    if (!areas.length) return { path: p, reason: `${p} is in no area, so it can affect anything` };
    const hit = areas.find((a) => rule.areas.includes(a));
    if (hit) return { path: p, reason: `${p} is in ${hit}, which ${gate} depends on` };
  }
  return null;
}

// One digest per output path, relative to the repo root: a file's content, or every file under a
// folder (links are not followed). null = missing, or too big to read quickly.
export function fingerprintOutputs(root, rels) {
  return Object.fromEntries(rels.map((rel) => [rel, digestPath(path.join(root, rel))]));
}

function digestPath(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isFile()) return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  if (!st.isDirectory()) return null;
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        files += 1;
        bytes += buf.length;
        if (files > 20000 || bytes > 512 * 1024 * 1024) throw new Error('too big');
        hash.update(`${rel}${e.name}\0`).update(buf).update('\0');
      }
    }
  };
  try {
    walk(abs, '');
  } catch {
    return null;
  }
  return hash.digest('hex');
}

// Before a gate that tests other gates' builds: is each build on disk the one a passing run of
// that gate made from this exact code? `checked` names the run behind each build that is.
export function checkBuilds({ root, tree, gate, rules, keys }) {
  const builders = rules.usesFor(gate);
  if (!builders.length) return null;
  const checked = {};
  const problems = [];
  for (const builder of builders) {
    const outs = rules.outputsFor(builder);
    if (!outs.length) {
      problems.push(`${builder} lists no outputs in the rules, so its build can't be checked`);
      continue;
    }
    const now = fingerprintOutputs(root, outs);
    const missing = outs.filter((o) => !now[o]);
    if (missing.length) {
      problems.push(`the ${builder} output is missing (${missing.join(', ')})`);
      continue;
    }
    // A build is judged by its output on disk, not by what its run read from a database.
    const passes = proofOn(tree, builder, { keys, inputs: null }) || [];
    const made = passes.find((r) => r.ext.outputs && outs.every((o) => r.ext.outputs[o] === now[o]));
    if (made) checked[builder] = { receipt: path.basename(made.file), outputs: now };
    else problems.push(passes.length ? `the ${builder} output on disk was not made by its passing run on this code` : `no passing ${builder} run on this code`);
  }
  return { builders, checked, problems };
}

// After the run: a build that changed while the gate ran was not the one it started on.
export function recheckBuilds(root, builds, rules) {
  const problems = [...builds.problems];
  for (const [builder, { outputs }] of Object.entries(builds.checked)) {
    const now = fingerprintOutputs(root, rules.outputsFor(builder));
    if (Object.keys(outputs).some((o) => now[o] !== outputs[o])) problems.push(`the ${builder} output changed during the run`);
  }
  return problems;
}

const changedBetween = (root, a, b) =>
  String(git(root, ['diff', '--name-only', '--no-renames', a, b]).stdout).split('\n').map((s) => s.trim()).filter(Boolean);

// An earlier pass of `gate` on other code, whose differences from `tree` the rules say can't
// affect it. Looks at the newest `limit` earlier codes that have a pass.
export function findCarry({ root, repo, tree, gate, req, rules, limit = 20 }) {
  const trees = [...new Set(listGateReceipts(gate).map((e) => e.tree))].filter((t) => t !== tree).slice(0, limit);
  let why = 'no earlier pass of this gate to carry';
  for (const from of trees) {
    const proof = proofOn(from, gate, req);
    if (!proof || proof[0].st.subject?.[0]?.name !== repo) continue;
    let changed;
    try {
      changed = changedBetween(root, from, tree);
    } catch {
      continue; // code this repo doesn't have
    }
    const blocker = whatAffects(rules, gate, changed);
    if (!blocker) return { from, proof, changed };
    if (why.startsWith('no earlier')) why = `since the pass on ${short(from)}: ${blocker.reason}`;
  }
  return { why };
}

const logLine = (name, row) => fs.appendFileSync(path.join(home(), name), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
export const logReuse = (row) => logLine('reuse.jsonl', row);
export const logTrial = (row) => logLine('rules-trial.jsonl', row);

// A failed run that says nothing about the code: the test process ran out of memory or crashed, or
// every one of its tests failed (the database or the setup was down). The reason, else null.
export function inconclusiveReason({ exitCode, counts, text = '' }) {
  if (/JavaScript heap out of memory|FATAL ERROR:.*Allocation failed/.test(text)) return 'the test process ran out of memory';
  if (exitCode === null || [134, 137, 139].includes(exitCode) || exitCode < 0 || exitCode >= 0xc0000000) return `the test process crashed (exit ${exitCode})`;
  if (counts && counts.total > 1 && counts.passed === 0 && counts.failed === counts.total) return `every test failed (${counts.total}), which points at the machine or its setup`;
  return null;
}

// Trial rows logged before inconclusive runs were recorded: judged again from the failed receipt
// (and its log) for that gate on that code.
function inconclusiveFromStore(r) {
  for (const { gateDir, file } of listReceipts(r.tree)) {
    if (gateDir !== safe(r.gate)) continue;
    try {
      const statement = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).payload, 'base64').toString('utf8'));
      if (statement.predicate.result !== 'FAILED') continue;
      const a = statement.predicate.configuration[0].annotations;
      const log = file.replace(/\.dsse\.json$/, '.log.gz');
      const text = fs.existsSync(log) ? gunzipSync(fs.readFileSync(log)).toString('utf8') : '';
      const why = inconclusiveReason({ exitCode: a.exitCode, counts: a.counts, text });
      if (why) return why;
    } catch {
      // An unreadable receipt proves nothing either way.
    }
  }
  return null;
}

const readLog = (name) => {
  const file = path.join(home(), name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

// What reuse saved, and how the rules trial is going: may the rules be trusted yet?
export function cmdTrialReport() {
  const reused = readLog('reuse.jsonl');
  const trial = readLog('rules-trial.jsonl');
  const saved = reused.reduce((a, r) => a + (r.savedMs || 0), 0);
  const lines = ['goalline trial-report', ''];
  lines.push(`Reused instead of run: ${reused.length} gate run(s), about ${fmtDuration(saved)} saved.`);
  for (const kind of ['exact', 'carried']) {
    const rs = reused.filter((r) => r.kind === kind);
    if (rs.length) lines.push(`  ${kind === 'exact' ? 'same code' : 'carried by the rules'}: ${rs.length} (${fmtDuration(rs.reduce((a, r) => a + (r.savedMs || 0), 0))})`);
  }
  const would = trial.filter((r) => r.wouldSkip);
  // A real run that failed because of the machine neither agrees nor disagrees with the rules.
  for (const r of would) if (r.agree === false && !r.inconclusive) r.inconclusive = inconclusiveFromStore(r);
  const inconclusive = would.filter((r) => r.inconclusive);
  const disagree = would.filter((r) => r.agree === false && !r.inconclusive);
  lines.push('', `Rules trial: ${trial.length} gate run(s) checked${trial.length ? ` since ${fmtWhen(trial[0].at)}` : ''}.`);
  lines.push(`  The rules would have skipped ${would.length} (about ${fmtDuration(would.reduce((a, r) => a + (r.ms || 0), 0))}).`);
  lines.push(`  The real run agreed ${would.length - disagree.length - inconclusive.length} time(s), and DISAGREED ${disagree.length} time(s).`);
  for (const r of disagree.slice(0, 10)) {
    lines.push(`    ${r.gate} on ${short(r.tree)}: passed on ${short(r.from)}, but ran ${r.actual} here; changed: ${(r.changed || []).slice(0, 3).join(', ')}`);
  }
  if (inconclusive.length) {
    lines.push(`  Inconclusive ${inconclusive.length} time(s): the real run failed because of the machine, not the code, so it counts neither way:`);
    for (const r of inconclusive.slice(0, 10)) lines.push(`    ${r.gate} on ${short(r.tree)}: ${r.inconclusive}`);
  }
  const conclusive = would.length - inconclusive.length;
  const reasons = {};
  for (const r of trial.filter((t) => !t.wouldSkip)) {
    const area = String(r.why || '').replace(/^since the pass on \w+: \S+ /, '');
    reasons[area] = (reasons[area] || 0) + 1;
  }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) lines.push('', 'Why the others had to run:', ...top.map(([why, n]) => `  ${n}x ${why}`));
  lines.push(
    '',
    disagree.length
      ? 'Do not trust the rules: a skip would have hidden a different result. Fix the rules, then keep the trial running.'
      : conclusive >= 20
        ? 'No disagreements in 20+ would-be skips: the rules can be trusted (--trust-rules).'
        : `No disagreements yet; keep the trial running until there are at least 20 would-be skips (now ${conclusive}).`,
  );
  console.log(lines.join('\n'));
  return 0;
}
