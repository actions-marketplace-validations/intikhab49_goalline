#!/usr/bin/env node
// A tiny stand-in for Jest used by the fixtures: the test('title', fn) API, a Jest-style
// summary line, and Jest's --json --outputFile result shape (failures carry the stack, as in Jest).
// Like ts-jest, it refuses to run a file listed in fake-ts-errors.json ({ "test/x.mjs": "TS2739:
// ..." }) unless the config (--config <file> or --config=<file>, the last one wins) turns ts-jest's
// diagnostics off. The config's globals are set on globalThis, as Jest does.
// Started through fake-vitest.mjs it takes Vitest's flags instead: it needs --run (Vitest would sit
// in watch mode without it), writes the result file only with --reporter=json and
// --outputFile.json=<file>, and refuses a Jest config, as Vitest cannot load one.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const vitest = Boolean(globalThis.fakeVitest);
const files = [];
let outputFile = null;
let configFile = null;
let run = false;
const reporters = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--outputFile=')) outputFile = a.slice('--outputFile='.length);
  else if (a.startsWith('--outputFile.json=')) outputFile = a.slice('--outputFile.json='.length);
  else if (a === '--run') run = true;
  else if (a.startsWith('--reporter=')) reporters.push(a.slice('--reporter='.length));
  else if (a === '--config') configFile = args[++i];
  else if (a.startsWith('--config=')) configFile = a.slice('--config='.length);
  else if (!a.startsWith('--')) files.push(a);
}
if (vitest && !run) {
  console.log('fake-vitest: no --run, so Vitest would sit in watch mode');
  process.exit(1);
}
if (vitest && configFile) {
  console.log(`fake-vitest: cannot load ${configFile} as a Vite config`);
  process.exit(1);
}
if (vitest && !reporters.includes('json')) outputFile = null;
let config = configFile ? createRequire(import.meta.url)(path.resolve(configFile)) : {};
if (typeof config === 'function') config = await config();
const { 'ts-jest': tsJest, ...globals } = config?.globals || {};
Object.assign(globalThis, globals);
const diagnosticsOff = tsJest?.diagnostics === false;
const tsErrors = !diagnosticsOff && fs.existsSync('fake-ts-errors.json') ? JSON.parse(fs.readFileSync('fake-ts-errors.json', 'utf8')) : {};

const testResults = [];
let passed = 0;
let failed = 0;
let skipped = 0;
let broken = 0;
for (const file of files) {
  // Vitest writes paths with forward slashes on every system.
  const abs = vitest ? path.resolve(file).split(path.sep).join('/') : path.resolve(file);
  const tsError = tsErrors[file.split(path.sep).join('/')];
  if (tsError) {
    broken++;
    const message = `  ● Test suite failed to run\n\n    ${file}:1:1 - error ${tsError}`;
    console.log(`FAIL ${file}\n${message}`);
    testResults.push({ name: abs, status: 'failed', message, assertionResults: [] });
    continue;
  }
  const tests = [];
  const describing = [];
  globalThis.describe = (name, fn) => {
    describing.push(name);
    fn();
    describing.pop();
  };
  globalThis.test = (title, fn) => tests.push({ title, fn, ancestors: [...describing] });
  globalThis.test.skip = (title) => tests.push({ title, skip: true, ancestors: [...describing] });
  // test.each(table)(title, fn): one test per row, named as Jest names them (%i, %s, %#...).
  const caseTitle = (title, args, row) => {
    let k = 0;
    return title.replace(/%[sdifjoOp#]/g, (tok) => (tok === '%#' ? String(row) : String(args[k++])));
  };
  globalThis.test.each = (table) => (title, fn) =>
    table.forEach((row, i) => {
      const args = Array.isArray(row) ? row : [row];
      tests.push({ title: caseTitle(title, args, i), fn: () => fn(...args), ancestors: [...describing] });
    });
  globalThis.test.skip.each = (table) => (title) =>
    table.forEach((row, i) => tests.push({ title: caseTitle(title, Array.isArray(row) ? row : [row], i), skip: true, ancestors: [...describing] }));
  globalThis.it = globalThis.test;
  try {
    await import(pathToFileURL(abs).href);
  } catch (err) {
    broken++;
    const message = `  ● Test suite failed to run\n\n    ${err.message}`;
    console.log(`FAIL ${file}\n${message}`);
    testResults.push({ name: abs, status: 'failed', message, assertionResults: [] });
    continue;
  }
  const assertionResults = [];
  for (const t of tests) {
    const base = { title: t.title, fullName: [...t.ancestors, t.title].join(' '), ancestorTitles: t.ancestors };
    if (t.skip) {
      skipped++;
      assertionResults.push({ ...base, status: vitest ? 'skipped' : 'pending', failureMessages: [] });
      continue;
    }
    try {
      await t.fn();
      passed++;
      assertionResults.push({ ...base, status: 'passed', failureMessages: [] });
    } catch (err) {
      failed++;
      assertionResults.push({ ...base, status: 'failed', failureMessages: [String(err.stack || err.message)] });
      console.log(`  ● ${t.title}\n\n    ${err.message}`);
    }
  }
  const status = assertionResults.some((r) => r.status === 'failed') ? 'failed' : 'passed';
  testResults.push({ name: abs, status, message: '', assertionResults });
}
const parts = [failed && `${failed} failed`, skipped && `${skipped} skipped`, `${passed} passed`].filter(Boolean);
if (vitest) console.log(`      Tests  ${parts.join(' | ')} (${passed + failed + skipped})`);
else console.log(`Tests:       ${parts.join(', ')}, ${passed + failed + skipped} total`);
if (outputFile) fs.writeFileSync(outputFile, JSON.stringify({ testResults }));
process.exitCode = failed || broken ? 1 : 0;
