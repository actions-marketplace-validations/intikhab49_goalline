import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedPaths, repoName, repoRoot, workdirTree, workingTree } from './git.mjs';
import { cpuWindow, foreignRunners, freeMb, startSampler } from './machine.mjs';
import { countPatterns, failedTestNames, parsePatterns, parseSummary } from './parse.mjs';
import { checkBuilds, findCarry, fingerprintOutputs, inconclusiveReason, loadRules, logReuse, logTrial, proofOn, recheckBuilds } from './reuse.mjs';
import { lockDigest } from './scratch.mjs';
import { ensureKey, signStatement, trustedKeys } from './sign.mjs';
import { allocReceipt, buildStatement, toolchain, writeReceipt } from './store.mjs';
import { commandLine, fmtDuration, fmtWhen, list, sha256, short, spawnCapture, stripAnsi, toPosix, UsageError } from './util.mjs';

const ENV_PLAIN = ['TZ', 'CI', 'NODE_ENV'];

function envRecord(extraKeys) {
  const env = {};
  for (const k of ENV_PLAIN) if (process.env[k] !== undefined) env[k] = process.env[k];
  // Extra keys can hold secrets (DATABASE_URL), so only a hash is kept: enough to tell runs apart.
  for (const k of list(extraKeys)) if (process.env[k] !== undefined) env[k] = `sha256:${sha256(process.env[k]).slice(0, 16)}`;
  return env;
}

export function describeCounts(c) {
  if (!c) return 'no test summary (judged by exit code)';
  const extra = [c.failed && `${c.failed} failed`, c.flaky && `${c.flaky} flaky`, c.skipped && `${c.skipped} skipped`].filter(Boolean);
  return `${c.passed}/${c.total} passed${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

export function describeMachine(m) {
  if (!m) return 'machine not checked';
  if (m.idle === null) return 'idle unknown';
  const others = Math.max(m.foreignAtStart ?? 0, m.foreignMax);
  return m.idle
    ? `idle (${(m.freeMbStart / 1024).toFixed(1)} GB free, no other test runners)`
    : `NOT idle (${m.freeMbStart} MB free at start, ${others} other test runner(s))`;
}

export async function cmdRun(opts, command) {
  if (!opts.gate) throw new UsageError('run needs --gate <name>');
  if (!command.length) throw new UsageError('run needs the command after --');
  const patterns = parsePatterns(opts.count);
  const line = commandLine(command);
  const watch = !opts.noMachine;
  // The CPU load is measured across the fingerprinting below (git's own work included), so it
  // costs no extra wait unless that took under half a second.
  const cpu = watch ? cpuWindow() : null;
  let root;
  let key;
  let before;
  try {
    root = repoRoot(opts.repo || process.cwd());
    key = ensureKey();
    before = workingTree(root);
  } catch (err) {
    // A wrapper must never stop the gate it wraps: run it plainly and say why there is no receipt.
    console.error(`goalline: ${opts.gate}: no receipt will be saved (${err.message}); running the gate anyway`);
    return (await spawnCapture(line, { shell: opts.shell || true })).code;
  }
  // An earlier pass on this exact code, or, with trusted rules, on code whose changes since can't
  // affect this gate, stands in for running it again. Any doubt, or any error here, runs it.
  let trial = null;
  let rules = null;
  if (opts.reuse || opts.rules) {
    try {
      rules = opts.rules ? loadRules(opts.rules) : null;
      const reuse = tryReuse({ opts, root, key, before, rules });
      if (reuse?.skipped) return 0;
      trial = reuse?.trial ?? null;
    } catch (err) {
      console.error(`goalline: ${opts.gate}: could not check for an earlier pass (${err.message}); running the gate`);
    }
  }
  // A gate that tests other gates' builds (rules "uses") proves nothing about this code unless
  // those builds were made from it: checked now, and again after the run.
  let builds = null;
  if (rules?.usesFor(opts.gate).length) {
    try {
      builds = checkBuilds({ root, tree: before.tree, gate: opts.gate, rules, keys: trustedKeys() });
    } catch (err) {
      builds = { builders: rules.usesFor(opts.gate), checked: {}, problems: [`its builds could not be checked (${err.message})`] };
    }
    if (builds.problems.length) {
      console.error(`goalline: ${opts.gate}: WARNING: ${builds.problems.join('; ')}. This run will not count for this code; build it first.`);
    }
  }
  const idleMb = Number(opts.idleMb ?? 1600);
  const freeMbStart = freeMb();
  const cpuBusyStartPct = cpu ? await cpu.stop(500) : null;
  const sampler = watch ? startSampler({ everyMs: Number(opts.sampleEvery ?? 30) * 1000 }) : null;

  const startedAt = new Date();
  // Other test runners are looked for while the gate starts. Its own processes are children of
  // this one, so they never count.
  const foreignCheck = watch ? foreignRunners() : null;
  const { code: exitCode, output, truncated } = await spawnCapture(line, { shell: opts.shell || true });
  const finishedAt = new Date();
  const foreignAtStart = foreignCheck ? await foreignCheck : null;
  const samples = await sampler?.stop();
  try {
    const { result, inconclusive } = saveRun({ opts, root, key, before, rules, builds, line, patterns, exitCode, output, truncated, startedAt, finishedAt, samples, watch, idleMb, freeMbStart, cpuBusyStartPct, foreignAtStart });
    if (trial) recordTrial({ opts, root, before, trial, result, inconclusive, ms: finishedAt - startedAt });
  } catch (err) {
    console.error(`goalline: ${opts.gate}: the gate ran (exit ${exitCode}) but its receipt could not be saved (${err.message})`);
  }
  return exitCode;
}

function tryReuse({ opts, root, key, before, rules }) {
  if (opts.trustRules && !opts.rules) throw new UsageError('--trust-rules needs --rules <file>');
  const gate = opts.gate;
  const req = { runs: Math.max(1, Number(opts.reuseRuns) || 1), idle: !!opts.reuseIdle, keys: trustedKeys() };
  if (rules?.neverReuse(gate)) {
    // Later gates use what it makes: reused on this exact code only while that output is still
    // the one an earlier pass made, never carried to other code.
    const outs = rules.outputsFor(gate);
    if (!opts.reuse || !outs.length) {
      console.error(`goalline: ${gate}: never reused (neverReuse in ${opts.rules}, no outputs listed): later gates use what it makes`);
      return null;
    }
    const proof = proofOn(before.tree, gate, req);
    const now = fingerprintOutputs(root, outs);
    const same = proof?.find((r) => r.ext.outputs && outs.every((o) => now[o] && r.ext.outputs[o] === now[o]));
    if (!same) {
      const missing = outs.filter((o) => !now[o]);
      const why = !proof
        ? 'no earlier pass on this exact code'
        : missing.length
          ? `its output is missing (${missing.join(', ')})`
          : 'its output has changed since that pass';
      console.error(`goalline: ${gate}: runs: ${why}`);
      return null;
    }
    console.error(
      `\ngoalline: ${gate} REUSED · this exact code already passed it, and its output (${outs.join(', ')}) is still the one that run made · not run again, about ${fmtDuration(same.ext.durationMs)} saved`,
    );
    logReuse({ kind: 'exact', repo: repoName(root), gate, tree: before.tree, savedMs: same.ext.durationMs });
    return { skipped: true };
  }
  if (opts.reuse) {
    const proof = proofOn(before.tree, gate, req);
    if (proof) {
      const e = proof[0].ext;
      console.error(
        `\ngoalline: ${gate} REUSED · this exact code already passed it (${proof.length} run(s); latest ${fmtWhen(e.startedAt)}: ${describeCounts(e.counts)}, ${describeMachine(e.machine)}) · not run again, about ${fmtDuration(e.durationMs)} saved`,
      );
      logReuse({ kind: 'exact', repo: repoName(root), gate, tree: before.tree, savedMs: e.durationMs });
      return { skipped: true };
    }
  }
  if (!rules) return null;
  const carry = findCarry({ root, repo: repoName(root), tree: before.tree, gate, req, rules });
  if (!carry.from || !opts.trustRules) return { trial: carry };

  // Trusted: write a CARRIED receipt for this code per pass carried over, so verify shows it.
  const rulesDigest = sha256(fs.readFileSync(opts.rules));
  for (const src of carry.proof) {
    const e = src.ext;
    const ext = {
      kind: 'carried',
      gate,
      carriedFrom: carry.from,
      sourceReceipt: path.basename(src.file),
      rules: { file: opts.rules, sha256: rulesDigest },
      changed: carry.changed.slice(0, 50),
      command: e.command,
      counts: e.counts,
      machine: e.machine ? { idle: e.machine.idle } : null,
      sourceStartedAt: e.startedAt,
      startedAt: new Date().toISOString(),
      toolchain: toolchain(),
      head: before.head,
      clean: before.clean,
    };
    const statement = buildStatement({ name: repoName(root), tree: before.tree, head: before.head, clean: before.clean, result: 'PASSED', ext });
    writeReceipt(allocReceipt(before.tree, gate), signStatement(statement, key), null);
  }
  const saved = carry.proof[0].ext.durationMs;
  console.error(
    `\ngoalline: ${gate} CARRIED · passed on ${short(carry.from)}; the ${carry.changed.length} file(s) changed since are outside what it depends on (${opts.rules}) · not run again, about ${fmtDuration(saved)} saved`,
  );
  logReuse({ kind: 'carried', repo: repoName(root), gate, tree: before.tree, from: carry.from, savedMs: saved });
  return { skipped: true };
}

// Rules trial: the gate ran anyway; record whether carrying the earlier pass would have been right.
// A run that failed because of the machine (inconclusive) is neither.
function recordTrial({ opts, root, before, trial, result, inconclusive, ms }) {
  const wouldSkip = Boolean(trial.from);
  const agree = wouldSkip && !inconclusive ? result === 'PASSED' : null;
  logTrial({ repo: repoName(root), gate: opts.gate, tree: before.tree, wouldSkip, from: trial.from, changed: trial.changed?.slice(0, 10), why: trial.why, actual: result, agree, ...(inconclusive ? { inconclusive } : {}), ms });
  const verdict = inconclusive ? `inconclusive (${inconclusive})` : agree ? 'agrees' : 'DISAGREES';
  console.error(
    wouldSkip
      ? `goalline: rules trial · ${opts.gate} would have been carried from ${short(trial.from)}; the real run ${result}: ${verdict}`
      : `goalline: rules trial · ${opts.gate} had to run: ${trial.why}`,
  );
}

function saveRun({ opts, root, key, before, rules, builds, line, patterns, exitCode, output, truncated, startedAt, finishedAt, samples, watch, idleMb, freeMbStart, cpuBusyStartPct, foreignAtStart }) {
  const after = { tree: workdirTree(root, before.realIndex) };

  const text = stripAnsi(output.toString('utf8'));
  const summary = parseSummary(text);
  const isTest = summary.runner !== 'unknown';
  const hits = countPatterns(text, patterns);
  const warnings = [];
  if (isTest && summary.total === 0) warnings.push('no tests ran');
  if (summary.flaky) warnings.push(`${summary.flaky} flaky`);
  for (const [label, n] of Object.entries(hits)) if (n) warnings.push(`${n}x ${label}`);
  const buildProblems = builds ? recheckBuilds(root, builds, rules) : [];
  for (const p of buildProblems) warnings.push(`build: ${p}`);
  const result = exitCode !== 0 || summary.failed > 0 ? 'FAILED' : warnings.length ? 'WARNED' : 'PASSED';
  const treeStable = before.tree === after.tree;
  const machine = watch
    ? {
        idle:
          foreignAtStart && samples.unknown === 0
            ? freeMbStart >= idleMb && foreignAtStart.length === 0 && samples.foreignMax === 0
            : null,
        idleMb,
        freeMbStart,
        freeMbMin: samples.freeMbMin,
        cpuBusyStartPct,
        foreignAtStart: foreignAtStart ? foreignAtStart.length : null,
        foreignMax: samples.foreignMax,
        foreignSeen: [...(foreignAtStart || []), ...samples.foreignSeen].slice(0, 5),
        samples: samples.samples,
      }
    : null;
  const ext = {
    kind: 'run',
    gate: opts.gate,
    command: line,
    cwd: toPosix(path.relative(root, process.cwd())) || '.',
    exitCode,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    counts: isTest ? summary : null,
    patterns: hits,
    warnings,
    machine,
    toolchain: toolchain(),
    env: envRecord(opts.envKeys),
    head: before.head,
    clean: before.clean,
    treeStable,
    treeAtEnd: after.tree,
    changedDuringRun: treeStable ? [] : changedPaths(root, before.tree, after.tree).slice(0, 20),
    lockDigest: lockDigest(root),
    logSha256: sha256(output),
    logTruncated: truncated,
    // Which passing build run made each build this gate tested, and any build problem.
    ...(builds ? { builds: { checked: Object.fromEntries(Object.entries(builds.checked).map(([b, c]) => [b, c.receipt])), problems: buildProblems } } : {}),
    // What an install or build made, so a later run on this exact code can tell it is still there.
    ...(rules?.outputsFor(opts.gate).length ? { outputs: fingerprintOutputs(root, rules.outputsFor(opts.gate)) } : {}),
  };
  const slot = allocReceipt(before.tree, opts.gate);
  const statement = buildStatement({
    name: repoName(root),
    tree: before.tree,
    head: before.head,
    clean: before.clean,
    result,
    ext,
    url: pathToFileURL(slot.log).href,
    failed: result === 'FAILED' ? failedTestNames(text, summary.runner) : [],
  });
  writeReceipt(slot, signStatement(statement, key), output);

  const notes = [
    describeCounts(isTest ? summary : null),
    describeMachine(machine),
    fmtDuration(ext.durationMs),
    `tree ${short(before.tree)}${before.clean ? ` = commit ${short(before.head)}` : ' (uncommitted work)'}`,
  ];
  if (warnings.length) notes.push(`warnings: ${warnings.join(', ')}`);
  if (!treeStable) notes.push(`CODE CHANGED DURING THE RUN (${ext.changedDuringRun.slice(0, 3).join(', ')}), so this receipt will not verify`);
  console.error(`\ngoalline: ${opts.gate} ${result} · ${notes.join(' · ')}\ngoalline: saved ${slot.file}`);
  return { result, inconclusive: result === 'FAILED' ? inconclusiveReason({ exitCode, counts: isTest ? summary : null, text }) : null };
}
