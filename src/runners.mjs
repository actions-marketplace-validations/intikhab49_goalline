import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJestJson, readJunitXml } from './parse.mjs';
import { clip, failureSummary, relativize, stripAnsi } from './util.mjs';

// The test runners that give per-test results, each found by its word in the command: the arguments
// that make it write its results to a file, how that file is read, where a failed test crashed and
// how its failure reads. Any other runner is run one file at a time and judged by its exit code.

const JS_TESTS = ['**/*.{spec,test}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/*.e2e-spec.{js,ts}', '**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs}'];
const PYTHON_TESTS = ['**/test_*.py', '**/*_test.py'];

// Where a TypeError or ReferenceError was thrown: 'code', 'test', or null for any other failure. The
// first stack frame inside the project decides; Node's own frames and node_modules are skipped.
const JS_TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;
export function jsCrashSite(failure) {
  const lines = stripAnsi(failure || '').split('\n');
  if (!/^\s*(TypeError|ReferenceError):/.test(lines.find((l) => l.trim()) || '')) return null;
  for (const line of lines) {
    if (!/^\s*at\s/.test(line)) continue;
    let where = (/\((.+):\d+:\d+\)\s*$/.exec(line) || /^\s*at\s+(.+):\d+:\d+\s*$/.exec(line))?.[1];
    if (!where) continue;
    if (where.startsWith('file:')) {
      try {
        where = fileURLToPath(where);
      } catch {
        continue;
      }
    }
    where = where.split('\\').join('/');
    if (where.startsWith('node:') || where.includes('/node_modules/') || !where.includes('/')) continue;
    return JS_TEST_FILE.test(where) ? 'test' : 'code';
  }
  return null;
}

// Python's errors for a value that lacks what the code reads from it: a missing attribute, key or
// name, or the wrong type. IndexError is left out: a list that is too short is more often behaviour.
const PY_CRASH = new Set(['TypeError', 'AttributeError', 'NameError', 'UnboundLocalError', 'KeyError']);
// A call that no longer fits the new signature fails at the call site, in the old test, before the
// new code runs at all: the old test lacks what the code now needs, so it counts as a crash in it.
const PY_SIGNATURE =
  /missing \d+ required (?:positional|keyword-only) arguments?|got an unexpected keyword argument|takes (?:from \d+ to )?\d+ positional arguments? but \d+ (?:were|was) given|got multiple values for argument|takes no arguments/;
const PY_TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test|conftest|tests)\.py$|(^|\/)tests?\//;
const PY_FRAME = /^(\S[^\n]*?\.py):\d+:(?: [^\n]*)?$|^\s*File "([^"\n]+\.py)", line \d+/gm;

// pytest's message for an error in a fixture wraps the exception: failed on setup with "KeyError: 'x'".
const unwrapPy = (message) => stripAnsi(message || '').replace(/^failed on (?:setup|teardown) with "([\s\S]*)"$/, '$1');

// Where a Python error was raised, from the last frame of the traceback inside the project. pytest
// writes project files relative to its rootdir (the traceback has had the scratch folder taken out),
// so an absolute path or one under site-packages belongs to Python or a library.
export function pyCrashSite(message, traceback) {
  const text = unwrapPy(message);
  const kind = /^([A-Za-z_][\w.]*):/.exec(text)?.[1];
  if (!PY_CRASH.has(kind)) return null;
  if (kind === 'TypeError' && PY_SIGNATURE.test(text)) return 'code';
  const frames = [...stripAnsi(traceback || '').matchAll(PY_FRAME)].map((m) => (m[1] || m[2]).split('\\').join('/'));
  for (const where of frames.reverse()) {
    if (/^(?:[A-Za-z]:)?\//.test(where) || where.startsWith('<') || /(^|\/)(site|dist)-packages\//.test(where)) continue;
    return PY_TEST_FILE.test(where) ? 'test' : 'code';
  }
  return null;
}

// pytest's own words for a failed assert, "assert 6 == 5", with the line that says where a value came
// from ("where 6 = add(2, 3)"): which side is the expectation is up to the test. Otherwise the error.
export function pySummary(message) {
  const lines = unwrapPy(message)
    .replace(/^AssertionError: (?=assert )/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const where = lines.find((l) => /^\+\s+where /.test(l));
  return clip(where ? `${lines[0]} (${where.replace(/^\+\s+/, '')})` : lines[0] || '');
}

// The code under test is the scratch copy's, but a package installed in editable mode (pip install -e
// .) imports from the real checkout. So the scratch copy goes first on the import path: the folder the
// tests run in (as python -m pytest does) and its src folder when that holds Python code.
function pythonPath(cwd, env) {
  const src = path.join(cwd, 'src');
  let hasCode = false;
  try {
    hasCode = fs.readdirSync(src, { withFileTypes: true }).some((e) => (e.isDirectory() ? fs.existsSync(path.join(src, e.name, '__init__.py')) : e.name.endsWith('.py')));
  } catch {}
  const was = env.PYTHONPATH ?? process.env.PYTHONPATH;
  return { PYTHONPATH: [...(hasCode ? [src] : []), cwd, ...(was ? [was] : [])].join(path.delimiter) };
}

const jest = {
  name: 'jest',
  word: /\bjest\b/i,
  tests: JS_TESTS,
  ext: '.json',
  args: (out) => ['--ci', '--runTestsByPath', '--json', `--outputFile=${out}`],
  read: (out, { scratch }) => readJestJson(out, scratch),
  crashSite: (t) => jsCrashSite(t.failure),
  summary: (t) => failureSummary(t.failure),
  transplant: true,
};

// Vitest writes the same result file as Jest. --run keeps it out of watch mode, and the default
// reporter keeps its usual output on the screen beside the file.
const vitest = {
  ...jest,
  name: 'vitest',
  word: /\bvitest\b/i,
  args: (out) => ['--run', '--reporter=default', '--reporter=json', `--outputFile.json=${out}`],
};

// pytest writes JUnit XML; junit_family=xunit1 keeps each test's file in it. One old file that no
// longer imports must not stop the others from running.
const pytest = {
  name: 'pytest',
  word: /\bpytest\b/i,
  tests: PYTHON_TESTS,
  ext: '.xml',
  args: (out) => [`--junitxml=${out}`, '-o', 'junit_family=xunit1', '--continue-on-collection-errors'],
  read: (out, { files }) => readJunitXml(out, files),
  crashSite: (t, scratch) => pyCrashSite(t.message, relativize(t.failure, scratch)),
  summary: (t) => pySummary(t.message),
  env: pythonPath,
  transplant: false,
};

export const runnerOf = (command) => [jest, vitest, pytest].find((r) => command.some((a) => r.word.test(a))) || null;
export const defaultTests = (command) => (runnerOf(command) || jest).tests;

// pytest's own rule for which files hold tests: python_files (by default test_*.py and *_test.py)
// under testpaths, from the first config file with a pytest section, looked for as pytest does, from
// the folder the tests run in up to the repository root. pytest collects any file named on its
// command line, so goalline must not name the wrong ones: jinja's src/jinja2/tests.py is code whose
// functions are named test_odd, and its examples/ hold scripts named test_*.py.
const PY_CONFIGS = [
  ['pytest.ini', null],
  ['.pytest.ini', null],
  ['pyproject.toml', /^\[tool\.pytest(?:\.ini_options)?\]$/],
  ['tox.ini', /^\[pytest\]$/],
  ['setup.cfg', /^\[tool:pytest\]$/],
];

// The lines of a config file's pytest section, or null without one (a pytest.ini counts even empty).
function pytestSection(text, header) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => (header || /^\[pytest\]$/).test(l.trim()));
  if (start === -1) return header ? null : [];
  const end = lines.findIndex((l, i) => i > start && /^\s*\[[^\]]+\]\s*$/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

// One option's values: a TOML string or array (over several lines too), or an ini value whose
// indented lines continue it. Several patterns in one string are split on whitespace.
function optionValues(lines, key, toml) {
  const i = lines.findIndex((l) => new RegExp(`^${key}\\s*=`).test(l.trim()));
  if (i === -1) return null;
  let text = lines[i].slice(lines[i].indexOf('=') + 1);
  if (toml) {
    for (let j = i + 1; text.trim().startsWith('[') && !text.includes(']') && j < lines.length; j++) text += `\n${lines[j]}`;
    const strings = [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    return strings.flatMap((s) => s.split(/\s+/)).filter(Boolean);
  }
  for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) text += `\n${lines[j]}`;
  return text.replace(/\s[#;].*$/gm, '').split(/\s+/).filter(Boolean);
}

// Test-file globs for a pytest command. read(rel) gives a file's text at the commit judged, or null.
export function pytestGlobs(read, cwd = '') {
  const dirs = [];
  for (let d = cwd.replace(/^\.?\/*|\/+$/g, ''); ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
    dirs.push(d);
    if (!d) break;
  }
  for (const dir of dirs) {
    for (const [name, header] of PY_CONFIGS) {
      const text = read(dir ? `${dir}/${name}` : name);
      if (text == null) continue;
      const lines = pytestSection(text, header);
      if (!lines) continue;
      const toml = name.endsWith('.toml');
      const files = optionValues(lines, 'python_files', toml) || ['test_*.py', '*_test.py'];
      const at = (p) => (dir ? `${dir}/${p}` : p);
      const paths = (optionValues(lines, 'testpaths', toml) || []).map((p) => p.replace(/^\.\/|\/+$/g, '')).filter((p) => p && p !== '.');
      if (!paths.length) return files.map((f) => `${dir ? `${dir}/` : ''}**/${f}`);
      return paths.flatMap((p) => (p.endsWith('.py') ? [at(p)] : files.map((f) => `${at(p)}/**/${f}`)));
    }
  }
  return ['**/test_*.py', '**/*_test.py'];
}

// The globs that say which changed files are tests: --tests, else the runner's own rules.
export const testGlobs = (command, { read, cwd } = {}) => (runnerOf(command) === pytest && read ? pytestGlobs(read, cwd) : defaultTests(command));
