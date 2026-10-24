// What a change says about its moved test expectations: .goalpost-acks.json at the repository root,
// written by goalline guard --ack. Only the entries the change itself added count: one already on the
// base explained an earlier change to that test, not this one.
import { readAt } from './git.mjs';

export const ACKS = '.goalpost-acks.json';

const entries = (text) => {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list.filter((a) => a && typeof a.test === 'string' && typeof a.why === 'string' && a.why.trim()) : [];
  } catch {
    return [];
  }
};
const same = (a, b) => a.test === b.test && a.why === b.why && a.at === b.at;

// The entries of `text` that `baseText` (null: no such file there) does not have.
export const added = (text, baseText) => {
  const before = baseText == null ? [] : entries(baseText);
  return entries(text ?? '[]').filter((a) => !before.some((b) => same(a, b)));
};

// The change's own entries: those in the file at `head` that the file at `base` lacks.
export function acksAt(root, base, head, file = ACKS) {
  const at = (ref) => readAt(root, ref, file)?.toString('utf8') ?? null;
  return added(at(head), at(base));
}

// The reasons, on one line since they go into cards and annotations. A file is named by its old path
// or its new one; a test by "<file>::<test name>", and a whole file by its path (or "<file>::*").
const line = (a) => (a ? a.why.trim().replace(/\s+/g, ' ') : null);
export const ownReason = (acks, paths, test) => line(acks.find((a) => paths.some((p) => a.test === `${p}::${test}`)));
export const fileReason = (acks, paths) => line(acks.find((a) => paths.some((p) => a.test === p || a.test === `${p}::*`)));

// The reason for one failing test of a file ('*': the file itself): its own entry, else the file's.
export const reasonFor = (acks, paths, test) => (test === '*' ? null : ownReason(acks, paths, test)) ?? fileReason(acks, paths);
