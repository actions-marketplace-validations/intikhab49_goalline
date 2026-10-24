import fs from 'node:fs';
import path from 'node:path';
import { toPosix, UsageError } from './util.mjs';

const count = (s, label) => {
  const m = s.match(new RegExp(`(\\d+) ${label}`));
  return m ? Number(m[1]) : 0;
};
const last = (text, re) => [...text.matchAll(re)].pop();
const PYTEST_COUNT = '\\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?|rerun)';
const PYTEST_SUMMARY = new RegExp(`^(?:=+ )?((?:${PYTEST_COUNT}, )*${PYTEST_COUNT}|no tests ran) in \\d+(?:\\.\\d+)?s(?: \\(\\d+:\\d\\d:\\d\\d\\))?(?: =+)?$`, 'gm');

// Read the final summary of a Jest, Vitest, pytest, Playwright or node --test run. runner 'unknown' =
// not a test run (lint, build), judged by exit code alone.
export function parseSummary(text) {
  const jest = last(text, /^Tests:\s+(.+)$/gm);
  if (jest) {
    const s = jest[1];
    const suites = last(text, /^Test Suites:\s+(.+)$/gm)?.[1] || '';
    return {
      runner: 'jest',
      passed: count(s, 'passed'),
      failed: count(s, 'failed'),
      skipped: count(s, 'skipped') + count(s, 'todo'),
      flaky: 0,
      total: count(s, 'total'),
      suitesFailed: count(suites, 'failed'),
      suitesTotal: count(suites, 'total'),
    };
  }
  // "      Tests  2 failed | 5 passed | 1 skipped (8)" under " Test Files  1 failed | 2 passed (3)".
  const vitest = last(text, /^\s*Tests\s{2,}(.+?)\s*\((\d+)\)\s*$/gm);
  if (vitest) {
    const s = vitest[1];
    const files = last(text, /^\s*Test Files\s{2,}(.+?)\s*\((\d+)\)\s*$/gm);
    return {
      runner: 'vitest',
      passed: count(s, 'passed'),
      failed: count(s, 'failed'),
      skipped: count(s, 'skipped') + count(s, 'todo'),
      flaky: 0,
      total: Number(vitest[2]),
      suitesFailed: files ? count(files[1], 'failed') : 0,
      suitesTotal: files ? Number(files[2]) : 0,
    };
  }
  // "===== 1 failed, 5 passed, 1 skipped, 2 errors in 0.31s =====" (the = signs go with -q), or
  // "no tests ran in 0.01s". An error (in collection, setup or teardown) counts as a failed test.
  const py = last(text, PYTEST_SUMMARY);
  if (py) {
    const s = py[1];
    const r = {
      runner: 'pytest',
      passed: count(s, 'passed') + count(s, 'xpassed'),
      failed: count(s, 'failed') + count(s, 'errors?'),
      skipped: count(s, 'skipped') + count(s, 'xfailed'),
      flaky: count(s, 'rerun'),
    };
    r.total = r.passed + r.failed + r.skipped;
    return r;
  }
  if (/^\s+\d+ passed \(/m.test(text) || /^\s+\d+ failed\s*$/m.test(text)) {
    const pw = (label) => Number(last(text, new RegExp(`^\\s+(\\d+) ${label}\\b`, 'gm'))?.[1] || 0);
    const r = {
      runner: 'playwright',
      passed: pw('passed'),
      failed: pw('failed'),
      flaky: pw('flaky'),
      skipped: pw('skipped') + pw('did not run') + pw('interrupted'),
    };
    r.total = r.passed + r.failed + r.flaky + r.skipped;
    return r;
  }
  // node --test's summary: "ℹ tests 9" from its spec reporter, "# tests 9" from its TAP one, which
  // Node 20 and 22 use whenever the output is not a terminal (as here, where goalline reads it).
  const nt = (label) => {
    const m = last(text, new RegExp(`^(?:ℹ|#) ${label}\\s+(\\d+)$`, 'gm'));
    return m ? Number(m[1]) : null;
  };
  if (nt('tests') !== null) {
    return {
      runner: 'node-test',
      passed: nt('pass') ?? 0,
      failed: nt('fail') ?? 0,
      skipped: (nt('skipped') ?? 0) + (nt('todo') ?? 0) + (nt('cancelled') ?? 0),
      flaky: 0,
      total: nt('tests'),
    };
  }
  return { runner: 'unknown', passed: 0, failed: 0, skipped: 0, flaky: 0, total: 0 };
}

// Jest uses the same bullet over logged output ("● Console") and over notices like
// "● Validation Warning:"; neither is a failed test.
const NOT_A_TEST = /^(?:Console|.*\bWarning:?)$/;

const FAILED_RE = {
  playwright: /^\s*✘\s+\d+\s+(.+?)(?:\s+\(\d[\d.]*m?s\))?$/gm,
  // pytest's short summary: "FAILED tests/test_a.py::test_x - assert 1 == 2", "ERROR tests/test_b.py".
  pytest: /^(?:FAILED|ERROR) (.+?)(?: - .*)?$/gm,
  // " FAIL  test/a.test.ts > group > name", or " FAIL  test/b.test.ts [ test/b.test.ts ]" for a file.
  vitest: /^\s*FAIL\s+(.+?)(?:\s+\[ .+ \])?\s*$/gm,
};

export function failedTestNames(text, runner, max = 50) {
  const names = new Set();
  for (const m of text.matchAll(FAILED_RE[runner] || /^\s{2}● (.+)$/gm)) {
    if (names.size >= max) break;
    const name = m[1].trim();
    if (!FAILED_RE[runner] && NOT_A_TEST.test(name)) continue;
    names.add(name);
  }
  return [...names];
}

export function parsePatterns(specs = []) {
  return specs.map((s) => {
    const eq = s.indexOf('=');
    if (eq < 1) throw new UsageError(`--count needs label=regex, got "${s}"`);
    return { label: s.slice(0, eq), re: new RegExp(s.slice(eq + 1), 'g') };
  });
}

export function countPatterns(text, patterns) {
  return Object.fromEntries(patterns.map((p) => [p.label, (text.match(p.re) || []).length]));
}

// Jest's --json output, keyed by file path relative to `root`.
export function readJestJson(file, root) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const suites = new Map();
  for (const s of j.testResults || []) {
    suites.set(toPosix(path.relative(root, s.name || s.testFilePath || '')), {
      status: s.status,
      message: s.message || s.failureMessage || '',
      tests: (s.assertionResults || []).map((t) => ({
        title: t.title,
        name: t.fullName || [...(t.ancestorTitles || []), t.title].join(' › '),
        status: t.status,
        failure: (t.failureMessages || []).join('\n'),
      })),
    });
  }
  return suites;
}

const unescapeXml = (s) =>
  s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi, (_, hex, dec, name) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[name.toLowerCase()],
  );
const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], unescapeXml(m[2] ?? m[3])]));

// The <testcase> elements of a JUnit XML file, each with its attributes and its <failure>, <error>
// and <skipped> results (attributes and text). pytest writes it with ElementTree: no CDATA.
export function junitCases(xml) {
  const cases = [];
  let current = null;
  let result = null;
  let from = 0;
  for (const m of xml.matchAll(/<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g)) {
    if (result) result.text += xml.slice(from, m.index);
    from = m.index + m[0].length;
    const [, close, name, attrs = '', selfClosing] = m;
    if (name === 'testcase') {
      current = close ? null : { ...attrsOf(attrs), results: [] };
      if (current) cases.push(current);
      if (selfClosing) current = null;
    } else if (current && ['failure', 'error', 'skipped'].includes(name)) {
      result = close ? null : { kind: name, ...attrsOf(attrs), text: '' };
      if (result) current.results.push(result);
      if (selfClosing) result = null;
    }
  }
  for (const c of cases) for (const r of c.results) r.text = unescapeXml(r.text);
  return cases;
}

// The file a test belongs to, among the requested ones (paths from the repository root), and the
// dotted module path pytest wrote for it. pytest's paths are relative to its rootdir, so the file is
// the requested one whose path ends with the test's. Without a file attribute (junit_family=xunit2)
// the module path in classname (or in name, for a file that failed to collect) is matched instead.
function ownerOf(c, files) {
  if (c.file) {
    const rel = c.file.split('\\').join('/');
    const file = files.find((f) => f === rel || f.endsWith(`/${rel}`));
    return file ? { file, module: rel.replace(/\.py$/, '').split('/').join('.') } : null;
  }
  const id = c.classname || c.name || '';
  for (const file of files) {
    const parts = file.replace(/\.py$/, '').split('/');
    for (let i = 0; i < parts.length; i++) {
      const module = parts.slice(i).join('.');
      if (id === module || id.startsWith(`${module}.`)) return { file, module };
    }
  }
  return null;
}

// Why a file could not be collected: the last exception pytest marked with E ("E   ImportError: ...").
function collectError(text) {
  const marked = text.split('\n').filter((l) => /^E\s/.test(l)).map((l) => l.slice(1).trim()).filter(Boolean);
  return [...marked].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt)\b/.test(l)) || marked.pop() || text.trim().split('\n')[0] || '';
}

// pytest's --junitxml output, keyed by the requested file each test belongs to. A test is named as in
// its node id after the file (TestCart::test_total, test_add[2-3]); its title is the function's name.
// A file that failed to import has no tests and says why in its message.
export function readJunitXml(file, files) {
  const suites = new Map();
  for (const c of junitCases(fs.readFileSync(file, 'utf8'))) {
    const owner = ownerOf(c, files);
    if (!owner) continue;
    if (!suites.has(owner.file)) suites.set(owner.file, { status: 'passed', message: '', tests: [] });
    const s = suites.get(owner.file);
    const bad = c.results.find((r) => r.kind === 'failure') || c.results.find((r) => r.kind === 'error');
    if (!c.classname) {
      // The file itself, not a test in it: an import that failed, or a skip of the whole module.
      if (bad) Object.assign(s, { status: 'failed', message: collectError(bad.text) });
      continue;
    }
    const classes = c.classname.startsWith(`${owner.module}.`) ? c.classname.slice(owner.module.length + 1).split('.') : [];
    s.tests.push({
      title: c.name.replace(/\[[\s\S]*\]$/, ''),
      name: [...classes, c.name].join('::'),
      status: bad ? 'failed' : c.results.some((r) => r.kind === 'skipped') ? 'skipped' : 'passed',
      message: bad ? bad.message || '' : '',
      failure: bad ? bad.text : '',
    });
    if (bad) s.status = 'failed';
  }
  return suites;
}

// JavaScript and Python alike: a file holds one or the other, so neither's patterns fire on the other.
const SKIP_RE =
  /\b(?:it|test|describe)\.(?:skip|only|todo|fixme|skipIf|runIf|fails)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.(?:skip|expectedFailure)|\bself\.skipTest\s*\(/g;
const ASSERT_RE = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|^\s*assert\b|\bself\.assert[A-Z]\w*\s*\(|\bpytest\.raises\s*\(/gm;
const TITLE_RE = /\b(?:it|test)(?:\.(?:only|skip|concurrent|failing|fixme))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
const PY_TITLE_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+(test\w*)[ \t]*\(/gm;

export function testTitles(source) {
  return new Set([...[...source.matchAll(TITLE_RE)].map((m) => m[2]), ...[...source.matchAll(PY_TITLE_RE)].map((m) => m[1])]);
}

// Cheap static signals of a weakened test file: skips added, assertions removed, tests removed.
export function testSignals(before, after) {
  const n = (t, re) => (t.match(re) || []).length;
  const a = testTitles(before);
  const b = testTitles(after);
  return {
    skipsAdded: Math.max(0, n(after, SKIP_RE) - n(before, SKIP_RE)),
    assertDelta: n(after, ASSERT_RE) - n(before, ASSERT_RE),
    removedTitles: [...a].filter((t) => !b.has(t)),
  };
}

export function describeSignals(s) {
  if (!s) return '';
  const parts = [];
  if (s.skipsAdded) parts.push(`${s.skipsAdded} skip/only added`);
  if (s.assertDelta < 0) parts.push(`${-s.assertDelta} fewer assertions`);
  if (s.removedTitles?.length) parts.push(`${s.removedTitles.length} test(s) removed: ${s.removedTitles.slice(0, 3).map((t) => `"${t}"`).join(', ')}`);
  return parts.join(' · ');
}
