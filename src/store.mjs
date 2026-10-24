import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { home, VERSION } from './util.mjs';

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const TEST_RESULT_TYPE = 'https://in-toto.io/attestation/test-result/v0.1';

export const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
export const treeDir = (tree) => path.join(home(), 'store', tree.slice(0, 2), tree);

export const toolchain = () => ({
  node: process.versions.node,
  os: `${os.platform()} ${os.release()}`,
  arch: os.arch(),
});

// An in-toto test-result statement about one git tree. Our own fields ride in a
// configuration entry named "receipts" so the statement stays a valid test-result.
export function buildStatement({ name, tree, head, clean, result, ext, url, passed = [], warned = [], failed = [] }) {
  const digest = { gitTree: tree };
  if (clean) digest.gitCommit = head;
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name, digest }],
    predicateType: TEST_RESULT_TYPE,
    predicate: {
      result,
      configuration: [{ name: 'receipts', annotations: { tool: `goalline/${VERSION}`, ...ext } }],
      ...(url ? { url } : {}),
      passedTests: passed,
      warnedTests: warned,
      failedTests: failed,
    },
  };
}

export function allocReceipt(tree, gate) {
  const dir = path.join(treeDir(tree), safe(gate));
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`);
  return { file: `${base}.dsse.json`, log: `${base}.log.gz` };
}

export function writeReceipt(slot, envelope, log) {
  if (log) fs.writeFileSync(slot.log, zlib.gzipSync(log));
  fs.writeFileSync(slot.file, `${JSON.stringify(envelope, null, 2)}\n`);
}

export function listReceipts(tree) {
  const root = treeDir(tree);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const gateDir of fs.readdirSync(root)) {
    const dir = path.join(root, gateDir);
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.dsse.json')) out.push({ gateDir, file: path.join(dir, f) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

// Every receipt for one gate, on any code: { tree, gateDir, file }, newest first.
export function listGateReceipts(gate) {
  const store = path.join(home(), 'store');
  if (!fs.existsSync(store)) return [];
  const out = [];
  for (const prefix of fs.readdirSync(store)) {
    const prefixDir = path.join(store, prefix);
    if (!fs.statSync(prefixDir).isDirectory()) continue;
    for (const tree of fs.readdirSync(prefixDir)) {
      const dir = path.join(prefixDir, tree, safe(gate));
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.dsse.json')) out.push({ tree, gateDir: safe(gate), file: path.join(dir, f) });
    }
  }
  return out.sort((a, b) => path.basename(b.file).localeCompare(path.basename(a.file)));
}

export const extOf = (statement) =>
  statement?.predicate?.configuration?.find((c) => c.name === 'receipts')?.annotations || {};
