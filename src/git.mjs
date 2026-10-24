import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from './util.mjs';

const text = (r) => String(r.stdout).trim();
export const git = (repo, args, opts) => exec('git', ['-C', repo, ...args], opts);

export const repoRoot = (dir) => path.resolve(text(git(dir, ['rev-parse', '--show-toplevel'])));
export const commitOf = (repo, ref) => text(git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]));
export const treeOf = (repo, ref) => text(git(repo, ['rev-parse', '--verify', `${ref}^{tree}`]));
export const mergeBase = (repo, a, b) => text(git(repo, ['merge-base', a, b]));
export const commonDir = (repo) => path.resolve(repo, text(git(repo, ['rev-parse', '--git-common-dir'])));
export const repoName = (repo) => path.basename(path.dirname(commonDir(repo))) || path.basename(repo);

const tempIndex = (tag) => path.join(os.tmpdir(), `goalline-${tag}-${process.pid}-${Date.now().toString(36)}.index`);

// The content hash of the working directory as git would commit it: tracked files plus
// untracked, non-ignored ones. It equals HEAD's tree exactly when nothing is uncommitted,
// so a receipt made on uncommitted work still verifies once that exact work is committed.
export function workingTree(repo) {
  // One git call for all three: each git start costs a few hundred ms on a busy Windows machine.
  const [head, headTree, indexPath] = text(git(repo, ['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}', '--git-path', 'index'])).split('\n');
  const realIndex = path.resolve(repo, indexPath);
  const tree = workdirTree(repo, realIndex);
  return { head, headTree, tree, clean: tree === headTree, realIndex };
}

// The working directory's tree, built in a copy of the real index so git re-hashes only the
// files that changed since that index was written. The copy keeps the index's own mtime: git
// re-reads a file whose cached stat looks unchanged only when it is no older than the index,
// so a copy stamped now (as Linux copies are) hides a same-size edit made in the index's second.
export function workdirTree(repo, realIndex) {
  const idx = tempIndex('wt');
  try {
    // Stat before copying: if the index is replaced in between, the copy only looks older.
    const st = fs.statSync(realIndex, { throwIfNoEntry: false });
    if (st) {
      fs.copyFileSync(realIndex, idx);
      fs.utimesSync(idx, st.atime, st.mtime);
    }
    const env = { GIT_INDEX_FILE: idx };
    git(repo, ['add', '-A', '--', '.'], { env });
    return text(git(repo, ['write-tree'], { env }));
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

export const changedPaths = (repo, a, b) => text(git(repo, ['diff', '--name-only', a, b])).split('\n').filter(Boolean);

export function diffNameStatus(repo, a, b) {
  const parts = String(git(repo, ['diff', '--name-status', '-z', '-M', a, b]).stdout).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      out.push({ status: status[0], score: Number(status.slice(1)), from: parts[i++], path: parts[i++] });
    } else out.push({ status: status[0], path: parts[i++], from: null });
  }
  return out;
}

export function readAt(repo, ref, p) {
  const r = git(repo, ['cat-file', 'blob', `${ref}:${p}`], { allowFail: true });
  return r.code === 0 ? r.stdout : null;
}

// Write the files of commit `sha` into `dest` without touching the repo's index or checkout.
export function exportTree(repo, sha, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const idx = tempIndex('export');
  try {
    exec('git', ['--git-dir', commonDir(repo), '--work-tree', dest, 'checkout', sha, '--', '.'], {
      cwd: dest,
      env: { GIT_INDEX_FILE: idx },
    });
  } finally {
    fs.rmSync(idx, { force: true });
  }
}
