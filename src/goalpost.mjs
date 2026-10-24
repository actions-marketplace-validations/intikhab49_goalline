import fs from 'node:fs';
import path from 'node:path';
import { freshDb, loadContext, recordCheck, runTests, runWithSetup, tally, writeInto } from './checks.mjs';
import { git, readAt } from './git.mjs';
import { describeSignals, testSignals, testTitles } from './parse.mjs';
import { runnerOf } from './runners.mjs';
import { prepareScratch, removeScratch } from './scratch.mjs';
import { transplant } from './transplant.mjs';
import { firstUsefulLine, short } from './util.mjs';

// Results that need a person to look: the old tests fail, don't run, crash, or couldn't be judged.
const FLAG = new Set(['MOVED', 'BROKE', 'CRASHED', 'UNKNOWN']);

// An old test that only crashed inside the new code (an error like a TypeError whose last frame in
// the project is not a test file: runners.mjs) never reached its expectations: the old fixtures or
// mocks lack something the new code now needs. That is CRASHED, not MOVED. A crash in the test
// itself stays MOVED, because there the result the code returns changed shape.

// The verdict of a transplanted run: only the old tests that were put back count. An assertion that
// fails is a moved expectation, with its exact values. A crash in the test file means an old body
// names something the new file no longer has, so nothing is claimed and the file stays CRASHED.
function judgeTransplant(c, run, t) {
  const s = run.suites.get(c.now);
  if (!s || !s.tests.length) return null;
  const ran = s.tests.filter((x) => t.matchers.some((re) => re.test(x.name)));
  if (!ran.length) return null;
  const failed = ran.filter((x) => x.status === 'failed');
  const changed = failed.filter((x) => x.crash === null);
  const how = 'run inside the new test file with their old bodies (the old file crashed inside the new code)';
  const missing = t.missing.length ? `; ${t.missing.length} old test(s) have no counterpart in the new file` : '';
  const info = { tests: ran.length, missing: t.missing.length };
  if (changed.length) {
    return {
      kind: 'MOVED',
      note: `${changed.length} of ${ran.length} old tests fail when ${how}${missing}`,
      failing: changed.map((x) => ({ name: x.name, why: x.why })),
      transplant: info,
    };
  }
  if (ran.every((x) => x.status === 'passed')) return { kind: 'HELD', note: `all ${ran.length} old test(s) pass when ${how}${missing}`, transplant: info };
  return null;
}

// A TypeScript error that is not a missing module or export: the old file no longer compiles against
// the new types, which says nothing yet about the behaviour its tests check. A missing module or
// export means the subject itself was deleted or moved, and running the file again cannot help.
const SUBJECT_GONE = new Set(['TS2305', 'TS2307', 'TS2614', 'TS2724']);
export const typeError = (note) => {
  const code = /error (TS\d+)/.exec(note || '')?.[1];
  return code && !SUBJECT_GONE.has(code) ? code : null;
};

// The retry runs those files again under a generated config: the project's own Jest config (the one
// the command names with --config, else the default one) with ts-jest's type check off in every
// transform and project. rootDir is made absolute, so the config keeps meaning what it meant where
// it lives, although the wrapper sits in the command's directory.
const UNTYPED_CONFIG = 'goalline-untyped.jest.config.cjs';
const untypedSource = (original) => `// Written by goalline goalpost (retry with the type check off): the project's own Jest config with
// ts-jest's type check off, so old tests that only fail to compile against the new types can still run.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ORIGINAL = ${JSON.stringify(original)};

async function load(file) {
  if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const mod = await import(pathToFileURL(file).href);
  return mod.default ?? mod;
}

async function projectConfig() {
  if (ORIGINAL) {
    const file = path.resolve(__dirname, ORIGINAL);
    return { file, config: await load(file) };
  }
  for (const name of ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.json']) {
    const file = path.join(__dirname, name);
    if (fs.existsSync(file)) return { file, config: await load(file) };
  }
  const file = path.join(__dirname, 'package.json');
  return { file, config: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).jest || {} : {} };
}

function typesOff(config, base) {
  const out = { ...config, rootDir: path.resolve(base, config.rootDir || '.') };
  if (out.transform) {
    out.transform = Object.fromEntries(
      Object.entries(out.transform).map(([pattern, entry]) => {
        const [name, options] = Array.isArray(entry) ? entry : [entry, {}];
        return [pattern, typeof name === 'string' && name.includes('ts-jest') ? [name, { ...options, diagnostics: false }] : entry];
      }),
    );
  }
  if (Array.isArray(out.projects)) out.projects = out.projects.map((p) => (p && typeof p === 'object' ? typesOff(p, base) : p));
  out.globals = { ...out.globals, 'ts-jest': { ...(out.globals || {})['ts-jest'], diagnostics: false } };
  return out;
}

module.exports = async () => {
  let { file, config } = await projectConfig();
  if (typeof config === 'function') config = await config();
  return typesOff(config, path.dirname(file));
};
`;

// The command's own Jest config, taken out of the command so the retry passes only the wrapper:
// Jest must never see two configs. Only options after the jest word count (npx has its own -c).
function splitConfig(command) {
  if (command.length === 1) {
    const at = command[0].search(/\bjest\b/i);
    if (at < 0) return { command, config: null };
    const re = /(\s)(?:--config|-c)(?:=|\s+)("[^"]*"|'[^']*'|\S+)/;
    const m = re.exec(command[0].slice(at));
    if (!m) return { command, config: null };
    return { command: [command[0].slice(0, at) + command[0].slice(at).replace(re, '$1')], config: m[2].replace(/^["']|["']$/g, '') };
  }
  const out = [];
  let config = null;
  let jest = false;
  for (let i = 0; i < command.length; i++) {
    const a = command[i];
    if (jest && (a === '--config' || a === '-c')) config = command[++i];
    else if (jest && a.startsWith('--config=')) config = a.slice('--config='.length);
    else out.push(a);
    if (/\bjest\b/i.test(a)) jest = true;
  }
  return { command: out, config };
}

function judge(c, run) {
  const s = run.suites.get(c.runAs ?? c.path);
  if (!s) return { kind: 'UNKNOWN', note: run.noResults || 'the test runner did not report this file' };
  if (s.fileLevel) {
    return s.status === 'passed'
      ? { kind: 'HELD', note: 'the old file still passes' }
      : { kind: 'MOVED', note: `the old file fails on the new code: ${s.message}` };
  }
  if (s.status === 'failed' && !s.tests.length) return { kind: 'BROKE', note: `the old file no longer runs: ${firstUsefulLine(s.message)}` };
  const failing = s.tests.filter((t) => t.status === 'failed');
  if (failing.length) {
    const why = failing.map((t) => ({ name: t.name, why: t.why }));
    if (failing.every((t) => t.crash === 'code')) {
      return {
        kind: 'CRASHED',
        note: `${failing.length} of ${s.tests.length} old tests crash inside the new code before reaching their expectations: the old fixtures or mocks lack something it now needs`,
        failing: why,
      };
    }
    return { kind: 'MOVED', note: `${failing.length} of ${s.tests.length} old tests fail on the new code`, failing: why };
  }
  const passed = s.tests.filter((t) => t.status === 'passed').length;
  return passed ? { kind: 'HELD', note: `all ${passed} old test(s) still pass` } : { kind: 'EMPTY', note: 'no old tests ran' };
}

// Added lines that can switch a test off without removing anything: an early return, a dead branch,
// a skip, a focus or an expected failure, in JavaScript or Python. Those never count as low risk.
const DISABLING =
  /^\+\s*return\b|\bif\s*\(\s*(false|0|!1)\s*\)|^\+\s*if\s+(False|0)\s*:|\b(it|test|describe)\.(skip|only|todo|skipIf|runIf|fails)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.(skip|xfail)\s*\(|@unittest\.(skip|expectedFailure)|\bself\.skipTest\s*\(/;

export function onlyAdded(root, mb, head, oldPath, newPath) {
  const paths = newPath !== oldPath ? [oldPath, newPath] : [oldPath];
  const r = git(root, ['diff', '-U0', '-M', mb, head, '--', ...paths], { allowFail: true });
  const body = String(r.stdout).split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));
  return r.code === 0 && body.length > 0 && body.every((l) => l.startsWith('+') && !DISABLING.test(l));
}

// The PR comment: what changed, sorted by how much it needs a reviewer, with the exact old and new
// values; the full table follows, folded.
function markdown(ctx, cands, verdict) {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const file = (c) => `\`${c.path}\`${c.now ? (c.now !== c.path ? ` (now \`${c.now}\`)` : '') : ' (deleted)'}`;
  const tests = (c) => (c.verdict.failing || []).map((f) => `  - ✗ ${f.name}${f.why ? `: ${f.why}` : ''}`);
  const moved = cands.filter((c) => c.verdict.kind === 'MOVED');
  const look = [...moved.filter((c) => !c.additionsOnly), ...cands.filter((c) => c.verdict.kind === 'BROKE')];
  const low = moved.filter((c) => c.additionsOnly);
  const notJudged = cands.filter((c) => c.verdict.kind === 'CRASHED' || c.verdict.kind === 'UNKNOWN');
  const held = cands.filter((c) => c.verdict.kind === 'HELD' || c.verdict.kind === 'EMPTY');
  const title = look.length
    ? `${look.length} test file(s) need a look`
    : low.length
      ? `${low.length} low-risk change(s), nothing that needs a look`
      : notJudged.length
        ? 'nothing proven either way'
        : 'every old expectation still holds';
  const out = [
    `### Goalpost: ${title}`,
    '',
    `The old versions of the tests this change edited or deleted, run on the new code (merge-base \`${short(ctx.mb)}\` → head \`${short(ctx.head)}\`). An old test that now fails means behaviour changed and the test was edited to match.`,
    '',
  ];
  if (look.length) {
    out.push('**Needs a look**: the change also removed or rewrote lines of the old test.', '');
    for (const c of look) out.push(`- ${file(c)}${c.verdict.kind === 'BROKE' ? `: ${c.verdict.note}` : ''}`, ...tests(c));
    out.push('');
  }
  if (low.length) {
    out.push('**Low risk**: the test only gained lines, so every old line is still in it (a list that grew, a mock that was added).', '');
    for (const c of low) out.push(`- ${file(c)}`, ...tests(c));
    out.push('');
  }
  if (notJudged.length) out.push(`**Not judged**: ${notJudged.map((c) => `${file(c)} (${c.verdict.note})`).join('; ')}.`, '');
  if (held.length) out.push(`**Held**: ${held.length} old test file(s) still pass on the new code.`, '');
  const rows = cands.map((c) => {
    const detail = [c.verdict.note, ...(c.verdict.failing || []).slice(0, 3).map((f) => `✗ ${f.name}${f.why ? `: ${f.why}` : ''}`), describeSignals(c.signals)].filter(Boolean);
    return `| \`${c.path}\`${c.now ? '' : ' (deleted)'} | ${FLAG.has(c.verdict.kind) ? '⚠️ ' : ''}${c.verdict.kind}${c.additionsOnly && c.verdict.kind === 'MOVED' ? ' (low risk)' : ''} | ${esc(detail.join('<br>'))} |`;
  });
  out.push('<details><summary>Every file</summary>', '', '| Test file | Result | Detail |', '|---|---|---|', ...rows, '', '</details>', '', `**${verdict}**`, '');
  return out.join('\n');
}

export async function cmdGoalpost(opts, command) {
  const ctx = loadContext(opts, command, 'goalpost');
  const { db, env } = freshDb(opts, 'goalpost');
  const was = (c) => c.from || c.path;
  // The old versions of the tests this change edited or deleted are the goalposts.
  const cands = ctx.changes
    .filter((c) => ['M', 'D', 'T'].includes(c.status) || (c.status === 'R' && c.score < 100))
    .filter((c) => ctx.isTest(was(c)) && ctx.inCwd(was(c)))
    .map((c) => ({ path: was(c), now: c.status === 'D' ? null : c.path }));
  const newFiles = ctx.changes.filter((c) => c.status === 'A' && ctx.isTest(c.path) && ctx.inCwd(c.path)).length;
  const header = `goalline goalpost · ${ctx.name} · base ${ctx.baseRef} (merge-base ${short(ctx.mb)}) → head ${short(ctx.head)}${ctx.cwdRel ? ` · ${ctx.cwdRel}` : ''}`;
  const newNote = newFiles ? ` ${newFiles} new test file(s) are prove-red's job.` : '';

  if (!cands.length) {
    const summary = 'no existing tests edited or deleted';
    const report = `${header}\n\nNothing to check: this change edits or deletes no existing test files.${newNote}\n`;
    const saved = recordCheck(ctx, { result: 'PASSED', summary, report, details: { files: [] } });
    process.stdout.write(`${report}\nreceipt: ${saved.file}\n`);
    return 0;
  }

  const sc = prepareScratch({ root: ctx.root, sha: ctx.head, label: 'goalpost', depsFrom: ctx.depsFrom });
  try {
    const runner = runnerOf(command);
    // Python imports a test file by its name, so an old test_x.py whose change split it into a test_x/
    // package would import the new package instead. It runs as test_x__goalpost.py beside it, and its
    // results count under its own path.
    const shadowed = (p) => runner?.name === 'pytest' && p.endsWith('.py') && fs.existsSync(path.join(sc.dir, p.slice(0, -3), '__init__.py'));
    for (const c of cands) {
      const old = readAt(ctx.root, ctx.mb, c.path);
      c.runAs = shadowed(c.path) ? c.path.replace(/\.py$/, '__goalpost.py') : c.path;
      writeInto(sc.dir, c.runAs, old);
      const oldText = old.toString('utf8');
      // Every old line still in the new test (only lines added): a list that grew or a mock that was
      // added. A failure there is low risk; one where old lines were removed or rewritten needs a look.
      c.additionsOnly = Boolean(c.now) && onlyAdded(ctx.root, ctx.mb, ctx.head, c.path, c.now);
      c.signals = c.now
        ? testSignals(oldText, (readAt(ctx.root, ctx.head, c.now) || Buffer.alloc(0)).toString('utf8'))
        : { skipsAdded: 0, assertDelta: 0, removedTitles: [...testTitles(oldText)] };
    }
    // Old snapshots go with the old tests, or a rewritten snapshot would hide the change.
    for (const c of ctx.changes) {
      const p = was(c);
      if (c.status !== 'A' && /(^|\/)__snapshots__\//.test(p) && ctx.inCwd(p)) {
        const old = readAt(ctx.root, ctx.mb, p);
        if (old) writeInto(sc.dir, p, old);
      }
    }
    console.error(`goalline: running the old versions of ${cands.length} test file(s) on the new code...`);
    const run = await runWithSetup({ opts, scratch: sc.dir, cwdRel: ctx.cwdRel, db, env, quiet: opts.quiet }, () =>
      runTests({ scratch: sc.dir, cwdRel: ctx.cwdRel, files: cands.map((c) => c.runAs), command, quiet: opts.quiet, env }),
    );
    for (const c of cands) c.verdict = judge(c, run);

    // Old files that only failed to compile run again with the type check off (on by default for
    // Jest; --no-retry-untyped keeps them BROKE). Their verdict then comes from behaviour, with the
    // compile error noted. A config that cannot be wrapped (TypeScript, inline JSON) is not retried.
    const typed = opts.noRetryUntyped ? [] : cands.filter((c) => c.verdict.kind === 'BROKE' && typeError(c.verdict.note));
    const jestCwd = path.join(sc.dir, ctx.cwdRel);
    const own = splitConfig(command);
    // The wrapper is a Jest config: no other runner is ever given it.
    const wrappable =
      runner?.name === 'jest' && (own.config ? !/\.ts$/.test(own.config) && !own.config.trim().startsWith('{') : !fs.existsSync(path.join(jestCwd, 'jest.config.ts')));
    if (typed.length && wrappable) {
      fs.writeFileSync(path.join(jestCwd, UNTYPED_CONFIG), untypedSource(own.config));
      console.error(`goalline: ${typed.length} old file(s) fail only to compile; running them again with the type check off...`);
      const again = await runWithSetup({ opts, scratch: sc.dir, cwdRel: ctx.cwdRel, db, env, quiet: opts.quiet }, () =>
        runTests({ scratch: sc.dir, cwdRel: ctx.cwdRel, files: typed.map((c) => c.path), command: own.command, quiet: opts.quiet, env, extra: [`--config=${UNTYPED_CONFIG}`] }),
      );
      for (const c of typed) {
        const v = judge(c, again);
        if (!['HELD', 'MOVED', 'CRASHED'].includes(v.kind)) continue;
        const code = typeError(c.verdict.note);
        c.verdict = { ...v, note: `${v.note}, judged with the type check off (the old file no longer compiles: ${code})`, typesOff: code };
      }
    }

    // The assertion transplant (on by default for Jest and Vitest; --no-transplant): an old file whose
    // tests only crashed inside the new code runs again as the new file (where it now lives, if it was
    // renamed) with the old tests' bodies, under Jest's type-check-off config when it can be used (old
    // bodies keep their old types).
    const plans = [];
    for (const c of opts.noTransplant || !runner?.transplant ? [] : cands.filter((x) => x.verdict.kind === 'CRASHED' && x.now)) {
      const oldSrc = readAt(ctx.root, ctx.mb, c.path);
      const newSrc = readAt(ctx.root, ctx.head, c.now);
      if (!oldSrc || !newSrc) continue;
      const t = transplant(oldSrc.toString('utf8'), newSrc.toString('utf8'), { jsx: /\.[jt]sx$/.test(c.now) });
      if (!t.transplanted.length) continue;
      writeInto(sc.dir, c.now, t.source);
      plans.push({ c, t });
    }
    if (plans.length) {
      if (wrappable) fs.writeFileSync(path.join(jestCwd, UNTYPED_CONFIG), untypedSource(own.config));
      console.error(`goalline: ${plans.length} old file(s) crashed inside the new code; running their old tests inside the new test files...`);
      const third = await runWithSetup({ opts, scratch: sc.dir, cwdRel: ctx.cwdRel, db, env, quiet: opts.quiet }, () =>
        runTests({
          scratch: sc.dir,
          cwdRel: ctx.cwdRel,
          files: plans.map((p) => p.c.now),
          command: wrappable ? own.command : command,
          quiet: opts.quiet,
          env,
          extra: wrappable ? [`--config=${UNTYPED_CONFIG}`] : [],
        }),
      );
      for (const { c, t } of plans) {
        const v = judgeTransplant(c, third, t);
        if (v) c.verdict = { ...v, ...(c.verdict.typesOff ? { typesOff: c.verdict.typesOff } : {}) };
      }
    }

    const flagged = cands.filter((c) => FLAG.has(c.verdict.kind)).length;
    const moved = cands.filter((c) => c.verdict.kind === 'MOVED' || c.verdict.kind === 'BROKE').length;
    const unknown = flagged - moved;
    const summary = Object.entries(tally(cands.map((c) => c.verdict.kind)))
      .map(([k, n]) => `${n} ${k.toLowerCase()}`)
      .join(', ');
    let verdict = `HELD (${summary}). Every old test still passes on the new code.`;
    if (moved) {
      verdict = `FLAGGED (${summary}). Old tests no longer pass on the new code: behaviour changed and the tests were edited to match. A person should confirm that was intended.${unknown ? ` ${unknown} file(s) could not be judged.` : ''}`;
    } else if (unknown) verdict = `NOT JUDGED (${summary}). The old tests could not be run, or crashed inside the new code before reaching their expectations, so nothing is proven either way.`;
    const lines = [header, '', `Old versions of ${cands.length} edited or deleted test file(s), run on the new code.${newNote}`, ''];
    for (const c of cands) {
      const where = c.now ? (c.now !== c.path ? ` (now ${c.now})` : '') : ' (deleted by this change)';
      const lowRisk = c.verdict.kind === 'MOVED' && c.additionsOnly ? ' (low risk: the test only gained lines)' : '';
      lines.push(`  ${c.verdict.kind.padEnd(7)} ${c.path}${where}`, `          ${c.verdict.note}${lowRisk}`);
      const failing = c.verdict.failing || [];
      for (const f of failing.slice(0, 5)) lines.push(`            ✗ ${f.name}${f.why ? `: ${f.why}` : ''}`);
      if (failing.length > 5) lines.push(`            ...and ${failing.length - 5} more`);
      const sig = describeSignals(c.signals);
      if (sig) lines.push(`          signals: ${sig}`);
    }
    lines.push('', verdict);
    if (!sc.depsMatch) lines.push(`note: node_modules come from ${ctx.depsFrom}, whose lockfile differs from the head commit.`);
    const report = `${lines.join('\n')}\n`;
    const saved = recordCheck(ctx, {
      result: flagged ? 'WARNED' : 'PASSED',
      summary,
      report,
      markdown: markdown(ctx, cands, verdict),
      details: {
        files: cands.map((c) => ({
          path: c.path,
          now: c.now,
          kind: c.verdict.kind,
          note: c.verdict.note,
          failing: (c.verdict.failing || []).map((f) => f.name),
          failingWhy: (c.verdict.failing || []).map((f) => f.why || ''),
          signals: c.signals,
          additionsOnly: c.additionsOnly,
          ...(c.verdict.typesOff ? { typesOff: c.verdict.typesOff } : {}),
          ...(c.verdict.transplant ? { transplant: c.verdict.transplant } : {}),
        })),
      },
      passed: cands.filter((c) => c.verdict.kind === 'HELD').map((c) => c.path),
      failed: cands.filter((c) => FLAG.has(c.verdict.kind)).map((c) => c.path),
    });
    process.stdout.write(`${report}\nreceipt: ${saved.file}\nPR comment: ${saved.markdown}\n`);
    return flagged && !opts.noFail ? 2 : 0;
  } finally {
    if (opts.keep) console.error(`goalline: kept the scratch copy at ${sc.dir}`);
    else removeScratch(sc.dir);
  }
}
