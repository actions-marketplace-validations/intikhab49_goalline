import fs from 'node:fs';
import path from 'node:path';
import { extOf } from './store.mjs';
import { fmtWhen, home, short, UsageError } from './util.mjs';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseAge(s) {
  const m = /^(\d+)([mhd])$/.exec(String(s));
  if (!m) throw new UsageError(`--older-than needs a number and m, h or d, like 30d (got "${s}")`);
  return Number(m[1]) * UNIT_MS[m[2]];
}

function parseTime(s) {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new UsageError(`--before needs a date or time, like 2026-10-21T20:02Z (got "${s}")`);
  return t;
}

const dirs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

// Every receipt in the store, decoded just enough to decide about it. The signature is not
// checked: deleting a receipt needs no trust in it.
function readStore(store) {
  const out = [];
  for (const prefix of dirs(store)) {
    for (const tree of dirs(path.join(store, prefix))) {
      for (const gateDir of dirs(path.join(store, prefix, tree))) {
        const dir = path.join(store, prefix, tree, gateDir);
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.dsse.json')) continue;
          const file = path.join(dir, name);
          const entry = { file, log: file.replace(/\.dsse\.json$/, '.log.gz'), tree, gate: gateDir };
          try {
            const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
            const ext = extOf(JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')));
            entry.gate = ext.gate || gateDir;
            entry.at = Date.parse(ext.startedAt) || fs.statSync(file).mtimeMs;
            if (ext.kind === 'run' && ext.treeStable === false) entry.void = 'the code changed during the run';
          } catch {
            entry.at = fs.statSync(file).mtimeMs;
            entry.void = 'unreadable receipt';
          }
          out.push(entry);
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const sizeOf = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);

function removeEmptyUp(dir, stop) {
  while (dir.startsWith(stop) && dir !== stop && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

// Removes receipts that can never prove anything, plus the ones that match every filter given.
// A failed or flagged run is never removed because a later run on the same code passed: it is
// the record that the gate was flaky there.
export function cmdPrune(opts) {
  const store = path.join(home(), 'store');
  const filters = [];
  if (opts.olderThan !== undefined) {
    const cutoff = Date.now() - parseAge(opts.olderThan);
    filters.push({ label: `older than ${opts.olderThan}`, test: (r) => r.at < cutoff });
  }
  if (opts.before !== undefined) {
    const before = parseTime(opts.before);
    filters.push({ label: `before ${opts.before}`, test: (r) => r.at < before });
  }
  if (opts.tree !== undefined) filters.push({ label: `tree ${opts.tree}`, test: (r) => r.tree.startsWith(String(opts.tree)) });
  if (opts.gate !== undefined) filters.push({ label: `gate ${opts.gate}`, test: (r) => r.gate === opts.gate });

  const all = fs.existsSync(store) ? readStore(store) : [];
  const chosen = all
    .map((r) => ({ ...r, why: r.void || (filters.length && filters.every((f) => f.test(r)) ? filters.map((f) => f.label).join(', ') : null) }))
    .filter((r) => r.why);

  const lines = [`goalline prune · ${store}${opts.dryRun ? ' · dry run, nothing is deleted' : ''}`, ''];
  let bytes = 0;
  for (const r of chosen) {
    bytes += sizeOf(r.file) + sizeOf(r.log);
    lines.push(`  ${opts.dryRun ? 'would remove' : 'removed'}  ${short(r.tree)}  ${r.gate}  ${fmtWhen(r.at)}  (${r.why})`);
    if (!opts.dryRun) {
      fs.rmSync(r.file, { force: true });
      fs.rmSync(r.log, { force: true });
      removeEmptyUp(path.dirname(r.file), store);
    }
  }
  if (!chosen.length) lines.push('  Nothing to remove.');
  const kb = Math.ceil(bytes / 1024);
  lines.push('', `${opts.dryRun ? 'Would remove' : 'Removed'} ${chosen.length} receipt(s) (${kb} KB). Kept ${all.length - chosen.length}.`);
  if (!filters.length) lines.push('Only receipts that can never prove anything go without filters: add --older-than, --before, --tree or --gate for more.');
  console.log(lines.join('\n'));
  return 0;
}
