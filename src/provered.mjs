import { freshDb, isSupportFile, loadContext, recordCheck, runTests, runWithSetup, SETUP_RE, writeInto } from './checks.mjs';
import { readAt } from './git.mjs';
import { testTitles } from './parse.mjs';
import { prepareScratch, removeScratch } from './scratch.mjs';
import { firstUsefulLine, list, matcher, short } from './util.mjs';

const WHY = {
  RED: 'fails on the base code',
  GREEN: 'passes on the base code too, so it does not test this change',
  SETUP: "can't run on the base code",
  SKIPPED: 'skipped',
  UNKNOWN: 'no result',
};
const ORDER = ['GREEN', 'UNKNOWN', 'SETUP', 'SKIPPED', 'RED'];

function judge(f, run) {
  const n = Math.max(1, f.titles.length);
  const label = f.whole ? `${f.path} (new file)` : `${f.path} (${f.titles.length} new test(s))`;
  const s = run.suites.get(f.path);
  if (!s) return [{ file: f.path, name: label, kind: 'UNKNOWN', why: run.noResults || 'the test runner did not report this file', n }];
  if (s.fileLevel) return [{ file: f.path, name: label, kind: s.status === 'failed' ? 'RED' : 'GREEN', why: s.status === 'failed' ? s.message : '', n }];
  if (s.status === 'failed' && !s.tests.length) return [{ file: f.path, name: label, kind: 'SETUP', why: firstUsefulLine(s.message), n }];
  const isNew = (t) => f.whole || f.titles.includes(t.title);
  return s.tests.filter(isNew).map((t) => ({
    file: f.path,
    name: t.name,
    kind: t.status === 'failed' ? 'RED' : t.status === 'passed' ? 'GREEN' : 'SKIPPED',
    why: t.why,
    n: 1,
  }));
}

function markdown(ctx, rows, flagged, summary) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  return [
    `### Prove-red: ${flagged ? (rows.some((r) => r.kind === 'GREEN') ? 'FLAGGED' : 'NOT JUDGED') : 'PROVEN'}`,
    '',
    `The new tests from head \`${short(ctx.head)}\`, run on the base code \`${short(ctx.mb)}\`. A new test should fail there; one that passes does not test this change.`,
    '',
    '| Test | Result | Detail |',
    '|---|---|---|',
    ...sorted.slice(0, 40).map((r) => `| ${esc(r.name)} | ${r.kind === 'GREEN' || r.kind === 'UNKNOWN' ? '⚠️ ' : ''}${r.kind} | ${esc(r.why || WHY[r.kind])} |`),
    ...(sorted.length > 40 ? [`| ...and ${sorted.length - 40} more | | |`] : []),
    '',
    `**${summary}.**`,
    '',
  ].join('\n');
}

export async function cmdProveRed(opts, command) {
  const ctx = loadContext(opts, command, 'prove-red');
  const { db, env } = freshDb(opts, 'prove_red');
  const isSupport = opts.support ? matcher(list(opts.support)) : isSupportFile;
  const textAt = (ref, p) => (readAt(ctx.root, ref, p) || Buffer.alloc(0)).toString('utf8');
  // The tests this change adds: whole new files, or new test titles inside edited files.
  const files = ctx.changes
    .filter((c) => ['A', 'M', 'R', 'C', 'T'].includes(c.status) && ctx.isTest(c.path) && ctx.inCwd(c.path))
    .map((c) => {
      const titles = [...testTitles(textAt(ctx.head, c.path))];
      if (c.status === 'A' || c.status === 'C') return { path: c.path, whole: true, titles };
      const before = testTitles(textAt(ctx.mb, c.from || c.path));
      return { path: c.path, whole: false, titles: titles.filter((t) => !before.has(t)) };
    })
    .filter((f) => f.whole || f.titles.length);
  const header = `goalline prove-red · ${ctx.name} · new tests from head ${short(ctx.head)}, run on the base code ${short(ctx.mb)} (${ctx.baseRef})${ctx.cwdRel ? ` · ${ctx.cwdRel}` : ''}`;

  if (!files.length) {
    const summary = 'no new tests';
    const report = `${header}\n\nNothing to check: this change adds no new tests here.\n`;
    const saved = recordCheck(ctx, { result: 'PASSED', summary, report, details: { tests: [] } });
    process.stdout.write(`${report}\nreceipt: ${saved.file}\n`);
    return 0;
  }

  const setupChanged = ctx.changes.filter((c) => SETUP_RE.test(c.path)).map((c) => c.path);
  const sc = prepareScratch({ root: ctx.root, sha: ctx.mb, label: 'prove-red', depsFrom: ctx.depsFrom });
  try {
    // Base code, head tests: bring over every test file and test helper the change added or edited.
    for (const c of ctx.changes) {
      if (c.status === 'D' || !(ctx.isTest(c.path) || isSupport(c.path))) continue;
      const buf = readAt(ctx.root, ctx.head, c.path);
      if (buf) writeInto(sc.dir, c.path, buf);
    }
    console.error(`goalline: running ${files.length} test file(s) with new tests on the base code...`);
    const run = await runWithSetup({ opts, scratch: sc.dir, cwdRel: ctx.cwdRel, db, env, quiet: opts.quiet }, () =>
      runTests({ scratch: sc.dir, cwdRel: ctx.cwdRel, files: files.map((f) => f.path), command, quiet: opts.quiet, env }),
    );
    const rows = files.flatMap((f) => judge(f, run));
    const count = (k) => rows.filter((r) => r.kind === k).reduce((a, r) => a + r.n, 0);
    const total = rows.reduce((a, r) => a + r.n, 0);
    const green = count('GREEN');
    const unknown = count('UNKNOWN');
    const flagged = green + unknown > 0;
    const parts = [
      count('RED') && `${count('RED')} red`,
      count('SETUP') && `${count('SETUP')} can't run on base`,
      green && `${green} green`,
      count('SKIPPED') && `${count('SKIPPED')} skipped`,
      unknown && `${unknown} unknown`,
    ].filter(Boolean);
    const summary = `${total} new test(s): ${parts.join(', ')}`;

    const lines = [header, ''];
    for (const kind of ORDER) {
      const rs = rows.filter((r) => r.kind === kind);
      const shown = kind === 'RED' ? rs.slice(0, 10) : rs;
      for (const r of shown) lines.push(`  ${kind.padEnd(7)} ${r.name}`, `          ${WHY[kind]}${r.why ? `: ${r.why}` : ''}`);
      if (rs.length > shown.length) lines.push(`  ...and ${rs.length - shown.length} more red`);
    }
    let verdict = [`PROVEN (${summary}). Every new test fails on the base code.`, count('SETUP') && "Tests that can't run on base fail before they assert anything, which is weaker evidence."];
    if (green) verdict = [`FLAGGED (${summary}).`, `${green} new test(s) pass on the base code too, so they prove nothing about this change.`, unknown && `${unknown} could not be judged.`];
    else if (unknown) verdict = [`NOT JUDGED (${summary}).`, `${unknown} new test(s) could not be run, so nothing is proven either way.`];
    lines.push('', verdict.filter(Boolean).join(' '));
    if (!sc.depsMatch || setupChanged.length) {
      const what = setupChanged.length ? ` (${setupChanged.slice(0, 5).join(', ')})` : '';
      lines.push(`note: setup differs between base and head${what}${sc.depsMatch ? '' : '; node_modules come from the head checkout'}, so a red can come from setup rather than behaviour.`);
    }
    const report = `${lines.join('\n')}\n`;
    const saved = recordCheck(ctx, {
      result: flagged ? 'WARNED' : 'PASSED',
      summary,
      report,
      markdown: markdown(ctx, rows, flagged, summary),
      details: { tests: rows.map(({ file, name, kind, why }) => ({ file, name, kind, why })), setupChanged },
      passed: rows.filter((r) => r.kind === 'RED' || r.kind === 'SETUP').map((r) => r.name),
      failed: rows.filter((r) => r.kind === 'GREEN' || r.kind === 'UNKNOWN').map((r) => r.name),
    });
    process.stdout.write(`${report}\nreceipt: ${saved.file}\nPR comment: ${saved.markdown}\n`);
    return flagged && !opts.noFail ? 2 : 0;
  } finally {
    if (opts.keep) console.error(`goalline: kept the scratch copy at ${sc.dir}`);
    else removeScratch(sc.dir);
  }
}
