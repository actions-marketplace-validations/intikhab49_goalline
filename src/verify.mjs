import fs from 'node:fs';
import { repoName, repoRoot, workingTree } from './git.mjs';
import { describeCounts, describeMachine } from './run.mjs';
import { openEnvelope, trustedKeys } from './sign.mjs';
import { extOf, listReceipts } from './store.mjs';
import { fmtDuration, fmtWhen, list, short } from './util.mjs';

const major = (v) => String(v || '').split('.')[0];
const PROVEN = new Set(['VERIFIED', 'CHECKED', 'CARRIED']);

// Why a receipt can or can't stand in for running the gate again on this code. Without
// cur.tree, everything but the code is judged (used to carry a pass to other code).
export function judge(entry, cur, keys) {
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
  } catch {
    return { ...entry, gate: entry.gateDir, authentic: false, valid: false, reason: 'unreadable receipt file' };
  }
  const opened = openEnvelope(envelope, keys);
  if (!opened.ok) return { ...entry, gate: entry.gateDir, authentic: false, valid: false, reason: opened.reason };
  const st = opened.statement;
  const ext = extOf(st);
  const problems = [];
  if (cur.tree && st.subject?.[0]?.digest?.gitTree !== cur.tree) problems.push('made for different code');
  if (ext.kind === 'run') {
    if (ext.treeStable === false) problems.push(`code changed during the run (${(ext.changedDuringRun || []).slice(0, 3).join(', ')})`);
    if (major(ext.toolchain?.node) !== major(process.versions.node)) {
      problems.push(`ran on Node ${ext.toolchain?.node}, this is Node ${process.versions.node}`);
    }
  }
  const result = st.predicate?.result;
  if (result === 'FAILED') problems.push(ext.kind === 'run' ? `failed (exit ${ext.exitCode})` : 'failed');
  const warned = result === 'WARNED';
  if (warned) problems.push(ext.kind === 'run' ? `warnings: ${(ext.warnings || []).join(', ')}` : ext.summary || 'flagged');
  return {
    ...entry,
    gate: ext.gate || entry.gateDir,
    kind: ext.kind,
    st,
    ext,
    authentic: true,
    flagged: warned && problems.length === 1,
    valid: problems.length === 0,
    reason: problems.join('; '),
  };
}

// What a required gate still needs before it counts as proven.
function stillNeeded(r) {
  if (r.verdict === 'NOT IDLE') return 'one passing run on an idle machine';
  if (r.verdict === 'FLAGGED') return 'a run without warnings';
  if (r.verdict.startsWith('ONLY')) return `${r.need - r.runs} more passing run(s)${r.idleNeeded && !r.idle ? ', one on an idle machine' : ''}`;
  return r.need > 1 ? `${r.need} passing runs` : 'a passing run';
}

const parseRequire = (s) =>
  list(s).map((x) => {
    const [gate, n] = x.split(':');
    return { gate, count: Math.max(1, Number(n) || 1) };
  });

function latestText(r) {
  const e = r.ext;
  if (e.kind === 'carried') {
    return `carried from tree ${short(e.carriedFrom)} (${e.changed.length} file(s) changed since, none it depends on) · ${describeCounts(e.counts)} · ${fmtWhen(e.startedAt)}`;
  }
  if (e.kind === 'run') {
    return `${describeCounts(e.counts)} · ${fmtWhen(e.startedAt)} · ${fmtDuration(e.durationMs)} · ${describeMachine(e.machine)}`;
  }
  return `${e.summary || r.st.predicate.result} · ${fmtWhen(e.startedAt)}`;
}

export function cmdVerify(opts) {
  const root = repoRoot(opts.repo || process.cwd());
  const cur = workingTree(root);
  const keys = trustedKeys();
  const judged = listReceipts(cur.tree).map((e) => judge(e, cur, keys));
  const required = parseRequire(opts.require);
  const needIdle = new Set(list(opts.idle));
  const gates = new Map();
  for (const r of judged) {
    if (!gates.has(r.gate)) gates.set(r.gate, []);
    gates.get(r.gate).push(r);
  }
  for (const g of [...required.map((q) => q.gate), ...needIdle]) if (!gates.has(g)) gates.set(g, []);

  let ok = true;
  const rows = [];
  for (const [gate, rs] of [...gates].sort(([a], [b]) => a.localeCompare(b))) {
    const valid = rs.filter((r) => r.valid);
    const idle = valid.filter((r) => r.ext.machine?.idle === true).length;
    const flagged = rs.filter((r) => r.flagged);
    const need = required.find((q) => q.gate === gate)?.count ?? 1;
    const isCheck = rs.some((r) => r.kind && r.kind !== 'run' && r.kind !== 'carried');
    // Proven only by passes carried over from other code under the rules: shown as such.
    const carried = valid.length > 0 && valid.every((r) => r.kind === 'carried');
    let verdict;
    if (valid.length >= need && (!needIdle.has(gate) || idle > 0)) verdict = isCheck ? 'CHECKED' : carried ? 'CARRIED' : 'VERIFIED';
    else if (valid.length && valid.length < need) verdict = `ONLY ${valid.length}/${need}`;
    else if (valid.length) verdict = 'NOT IDLE';
    else if (flagged.length) verdict = 'FLAGGED';
    else if (rs.length) verdict = 'REJECTED';
    else verdict = 'MISSING';
    const isRequired = required.some((q) => q.gate === gate) || needIdle.has(gate);
    if (isRequired && !PROVEN.has(verdict)) ok = false;
    const shown = valid.at(-1) || flagged.at(-1);
    rows.push({
      gate,
      verdict,
      need,
      idleNeeded: needIdle.has(gate),
      required: isRequired,
      runs: valid.length,
      idle,
      latest: shown ? latestText(shown) : '-',
      problems: [...new Set(rs.filter((r) => !r.valid).map((r) => r.reason))],
      receipts: rs.map((r) => ({ file: r.file, valid: r.valid, reason: r.reason || undefined })),
    });
  }
  const strict = required.length > 0 || needIdle.size > 0;
  const code = strict && !ok ? 1 : 0;

  if (opts.json) {
    console.log(JSON.stringify({ repo: repoName(root), tree: cur.tree, head: cur.head, clean: cur.clean, ok, gates: rows }, null, 2));
    return code;
  }
  const where = cur.clean ? `= commit ${short(cur.head)}` : `(uncommitted work on top of ${short(cur.head)})`;
  const out = [`goalline verify · ${repoName(root)} · tree ${short(cur.tree)} ${where}`, ''];
  if (!rows.length) out.push('  No receipts for this exact code yet.');
  else {
    const w = Math.max(4, ...rows.map((r) => r.gate.length));
    const v = Math.max(7, ...rows.map((r) => r.verdict.length));
    out.push(`  ${'GATE'.padEnd(w)}  ${'VERDICT'.padEnd(v)}  RUNS  IDLE  LATEST`);
    for (const r of rows) {
      out.push(`  ${r.gate.padEnd(w)}  ${r.verdict.padEnd(v)}  ${String(r.runs).padEnd(4)}  ${String(r.idle).padEnd(4)}  ${r.latest}`);
      // On a proven gate these are other runs on the same code that were not counted (a flaky
      // gate shows here); the LATEST column is the run that counts.
      const label = PROVEN.has(r.verdict) ? 'also on this code, not counted' : 'not usable';
      for (const p of r.problems.slice(0, 3)) out.push(`  ${''.padEnd(w)}  ${''.padEnd(v)}  ${label}: ${p}`);
    }
  }
  if (strict) {
    const bad = rows.filter((r) => r.required && !PROVEN.has(r.verdict));
    if (ok) out.push('', 'All required gates are proven for this exact code. Nothing to re-run.');
    else {
      out.push('', `Not proven: ${bad.map((r) => `${r.gate} (${r.verdict})`).join(', ')}`);
      out.push(`Run only: ${bad.map((r) => `${r.gate} (${stillNeeded(r)})`).join(', ')}. Every other required gate is proven: do not re-run it.`);
    }
  }
  console.log(out.join('\n'));
  return code;
}
