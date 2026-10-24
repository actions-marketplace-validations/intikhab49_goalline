import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportTree } from './git.mjs';
import { sha256 } from './util.mjs';

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

export function lockDigest(dir) {
  const parts = [];
  for (const f of LOCKFILES) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    parts.push(`${f}:${sha256(f.endsWith('.lockb') ? buf : buf.toString('utf8').replace(/\r\n/g, '\n'))}`);
  }
  return parts.length ? sha256(parts.join('\n')) : null;
}

// node_modules folders of a checkout (root and workspaces), never looking inside one.
export function findNodeModules(root, maxDepth = 3) {
  const found = [];
  const walk = (rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules' && (e.isDirectory() || e.isSymbolicLink())) found.push(childRel);
      else if (e.isDirectory() && !e.name.startsWith('.') && depth < maxDepth) walk(childRel, depth + 1);
    }
  };
  walk('', 0);
  return found;
}

const removeLink = (p) => {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EISDIR') throw err;
    fs.rmdirSync(p); // a directory junction or symlink: removes the link, not its target
  }
};

const removeFile = (p) => {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    fs.chmodSync(p, 0o666);
    fs.unlinkSync(p);
  }
};

// Delete a tree without ever following a symlink or junction. Scratch dirs link to a real
// checkout's node_modules, so a delete that followed links would wipe that checkout.
export function safeRemoveTree(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return removeLink(target);
  if (!st.isDirectory()) return removeFile(target);
  for (const name of fs.readdirSync(target)) safeRemoveTree(path.join(target, name));
  fs.rmdirSync(target);
}

// Scratch copies live in the temp folder, not under ~/.receipts: Jest configs whose testMatch
// starts with <rootDir> find no tests at all when the path has a folder starting with a dot.
export const scratchRoot = () => process.env.GOALLINE_SCRATCH || process.env.RECEIPTS_SCRATCH || path.join(os.tmpdir(), 'goalline-scratch');

export function removeScratch(dir) {
  const root = fs.realpathSync.native(scratchRoot()) + path.sep;
  if (!fs.realpathSync.native(dir).startsWith(root)) throw new Error(`refusing to delete ${dir}: not under ${root}`);
  safeRemoveTree(dir);
  for (const ext of ['.json', '.xml']) fs.rmSync(`${dir}.results${ext}`, { force: true });
}

// Fill `toDir` with links to each installed package in `fromDir`. Workspace packages are links
// back into the source checkout (npm, yarn and pnpm all do this); those are pointed at the
// scratch copy's own folder instead, or the scratch would test against the checkout's version.
function linkModules(fromDir, toDir, depsFrom, scratch, workspace) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const e of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, e.name);
    const to = path.join(toDir, e.name);
    if (e.name.startsWith('@') && e.isDirectory()) {
      linkModules(from, to, depsFrom, scratch, workspace);
      continue;
    }
    if (e.isFile()) {
      fs.copyFileSync(from, to);
      continue;
    }
    let target = from;
    if (e.isSymbolicLink()) {
      const rel = path.relative(depsFrom, fs.realpathSync.native(from));
      const inCheckout = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      if (inCheckout && !rel.split(path.sep).includes('node_modules') && fs.existsSync(path.join(scratch, rel))) {
        target = path.join(scratch, rel);
        workspace.push(rel.split(path.sep).join('/'));
      }
    }
    fs.symlinkSync(target, to, 'junction');
  }
}

// A throwaway copy of commit `sha`, using the packages installed in `depsFrom` without copying them.
// The real path is used so test runners report the same file paths we look up.
export function prepareScratch({ root, sha, label, depsFrom }) {
  fs.mkdirSync(scratchRoot(), { recursive: true });
  const dir = path.join(fs.realpathSync.native(scratchRoot()), `${label}-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(dir);
  exportTree(root, sha, dir);
  const workspace = [];
  const from = depsFrom ? fs.realpathSync.native(depsFrom) : null;
  for (const rel of from ? findNodeModules(from) : []) {
    const to = path.join(dir, rel);
    if (!fs.existsSync(path.dirname(to)) || fs.existsSync(to)) continue;
    linkModules(path.join(from, rel), to, from, dir, workspace);
  }
  return { dir, workspace, depsMatch: lockDigest(depsFrom || dir) === lockDigest(dir) };
}
