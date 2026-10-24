// The assertion transplant. An old test file whose tests only crashed inside the new code (its
// fixtures or mocks lack something the new code needs) is run again as the NEW test file, keeping
// its imports, fixtures, mocks and setup, with each test that kept its title given its OLD body
// back. The old expectations then meet the new code with setup that fits it: a behaviour change
// shows up as an exact "expected X, received Y" instead of a crash.
//
// Tests are found by a small scanner instead of a parser dependency. It knows strings, template
// literals, comments, regular expressions and (in .jsx/.tsx) JSX, which is all it takes to find
// describe/it/test calls with a literal title, and where each one's function argument starts and ends.

const BEFORE_EXPRESSION = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

function tokenize(src, jsx) {
  const tokens = [];
  const n = src.length;
  let i = 0;

  const startsExpression = () => {
    const p = tokens[tokens.length - 1];
    if (!p) return true;
    if (p.type === 'punct') return !')]}'.includes(p.value);
    return p.type === 'ident' && BEFORE_EXPRESSION.has(p.value);
  };
  const skipLineComment = () => {
    while (i < n && src[i] !== '\n') i++;
  };
  const skipBlockComment = () => {
    const end = src.indexOf('*/', i + 2);
    i = end < 0 ? n : end + 2;
  };
  const skipString = (quote) => {
    i++;
    while (i < n && src[i] !== quote) {
      if (src[i] === '\\') i++;
      i++;
    }
    i++;
  };
  // Code up to and including the bracket that closes the one just passed (template ${ }, JSX { }).
  const skipCode = (close) => {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') skipLineComment();
      else if (c === '/' && src[i + 1] === '*') skipBlockComment();
      else if (c === '"' || c === "'") skipString(c);
      else if (c === '`') skipTemplate();
      else {
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
          if (depth === 0 && c === close) {
            i++;
            return;
          }
          depth--;
        }
        i++;
      }
    }
  };
  const skipTemplate = () => {
    i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') i += 2;
      else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        skipCode('}');
      } else i++;
    }
    i++;
  };
  const skipRegex = () => {
    i++;
    let inClass = false;
    while (i < n && src[i] !== '\n') {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      i++;
      if (inClass) inClass = c !== ']';
      else if (c === '[') inClass = true;
      else if (c === '/') break;
    }
    while (i < n && /[a-z]/i.test(src[i])) i++;
  };
  // A JSX element, with its attributes and children; the text between tags is not code (it may
  // hold quotes), and { } inside it is.
  const skipJsx = () => {
    i++;
    if (src[i] === '>') {
      i++;
      return skipJsxChildren();
    }
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '>') {
        i += 2;
        return;
      }
      if (c === '>') {
        i++;
        return skipJsxChildren();
      }
      if (c === '{') {
        i++;
        skipCode('}');
      } else if (c === '"' || c === "'") skipString(c);
      else i++;
    }
  };
  const skipJsxChildren = () => {
    while (i < n) {
      const c = src[i];
      if (c === '<' && src[i + 1] === '/') {
        while (i < n && src[i] !== '>') i++;
        i++;
        return;
      }
      if (c === '<') skipJsx();
      else if (c === '{') {
        i++;
        skipCode('}');
      } else i++;
    }
  };

  while (i < n) {
    const c = src[i];
    const start = i;
    if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') skipLineComment();
    else if (c === '/' && src[i + 1] === '*') skipBlockComment();
    else if (c === '"' || c === "'") {
      skipString(c);
      tokens.push({ type: 'string', start, end: i });
    } else if (c === '`') {
      skipTemplate();
      tokens.push({ type: 'template', start, end: i });
    } else if (c === '/' && startsExpression()) {
      skipRegex();
      tokens.push({ type: 'regex', start, end: i });
    } else if (jsx && c === '<' && startsExpression() && /[A-Za-z>]/.test(src[i + 1] || '')) {
      skipJsx();
      tokens.push({ type: 'jsx', start, end: i });
    } else if (/[A-Za-z_$À-￿]/.test(c)) {
      while (i < n && /[\w$À-￿]/.test(src[i])) i++;
      tokens.push({ type: 'ident', value: src.slice(start, i), start, end: i });
    } else if (/[0-9]/.test(c)) {
      while (i < n && /[\w.]/.test(src[i])) i++;
      tokens.push({ type: 'number', start, end: i });
    } else if (c === '=' && src[i + 1] === '>') {
      i += 2;
      tokens.push({ type: 'punct', value: '=>', start, end: i });
    } else {
      i++;
      tokens.push({ type: 'punct', value: c, start, end: i });
    }
  }
  return tokens;
}

const unquote = (raw) => raw.slice(1, -1).replace(/\\(.)/g, (_, ch) => ({ n: '\n', t: '\t', r: '\r' })[ch] ?? ch);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Jest's names for the cases of an .each block: printf tokens and $variables filled from the table.
const eachCases = (title) => escapeRe(title).replace(/%[sdifjoOpc#]/g, '.*?').replace(/\\\$[\w.]+/g, '.*?');

// Every describe/it/test call with a literal title (.each blocks included): its kind, title, the
// describe titles around it (`path`, with `eachMask` marking .each titles), the callee's range, and
// its function argument's range.
export function findTests(src, { jsx = false } = {}) {
  const t = tokenize(src, jsx);
  const blocks = [];
  for (let k = 0; k < t.length; k++) {
    const tok = t[k];
    if (tok.type !== 'ident' || !['describe', 'it', 'test'].includes(tok.value)) continue;
    if (t[k - 1]?.type === 'punct' && t[k - 1].value === '.') continue;
    let j = k + 1;
    const modifiers = [];
    while (t[j]?.value === '.' && t[j + 1]?.type === 'ident') {
      modifiers.push(t[j + 1].value);
      j += 2;
    }
    if (modifiers.some((m) => m !== 'only' && m !== 'skip' && m !== 'each')) continue;
    const each = modifiers.includes('each');
    const calleeEnd = t[j - 1].end;
    if (each) {
      // The table: a tagged template, each`...`, or a call, each(...).
      if (t[j]?.type === 'template') j++;
      else if (t[j]?.value === '(') {
        for (let d = 0; j < t.length; j++) {
          const v = t[j].type === 'punct' ? t[j].value : null;
          if (v === '(' || v === '[' || v === '{') d++;
          else if ((v === ')' || v === ']' || v === '}') && --d === 0) {
            j++;
            break;
          }
        }
      } else continue;
    }
    const titleTok = t[j + 1];
    if (t[j]?.value !== '(' || !titleTok || (titleTok.type !== 'string' && titleTok.type !== 'template') || t[j + 2]?.value !== ',') continue;
    const raw = src.slice(titleTok.start, titleTok.end);
    if (titleTok.type === 'template' && raw.includes('${')) continue;
    let depth = 0;
    let m = j + 3;
    for (; m < t.length; m++) {
      const v = t[m].type === 'punct' ? t[m].value : null;
      if (v === '(' || v === '[' || v === '{') depth++;
      else if (v === ')' || v === ']' || v === '}') {
        if (depth === 0) break;
        depth--;
      } else if (v === ',' && depth === 0) break;
    }
    if (m === j + 3 || m >= t.length) continue;
    blocks.push({
      kind: tok.value === 'describe' ? 'describe' : 'test',
      name: tok.value,
      each,
      title: unquote(raw),
      callee: { start: tok.start, end: calleeEnd },
      fn: { start: t[j + 3].start, end: t[m - 1].end },
    });
  }
  for (const b of blocks) {
    const around = blocks.filter((d) => d.kind === 'describe' && d !== b && d.fn.start <= b.callee.start && b.callee.start < d.fn.end).sort((x, y) => x.fn.start - y.fn.start);
    b.path = [...around.map((d) => d.title), b.title];
    b.eachMask = [...around.map((d) => d.each), b.each];
  }
  return blocks;
}

// The NEW file with the OLD body put back into every test that kept its full title (describe titles
// included, and found once in each version). New tests with no old counterpart are skipped.
// Returns the hybrid source, the transplanted test paths, the old tests with no counterpart, and a
// matcher per transplanted test for the names Jest reports (one name per case of an .each block).
export function transplant(oldSrc, newSrc, { jsx = false } = {}) {
  const key = (b) => b.path.join('\u0000');
  const tests = (src) => findTests(src, { jsx }).filter((b) => b.kind === 'test');
  const olds = tests(oldSrc);
  const news = tests(newSrc);
  const counts = (list) => list.reduce((acc, b) => acc.set(key(b), (acc.get(key(b)) || 0) + 1), new Map());
  const oldCount = counts(olds);
  const newCount = counts(news);
  const oldByKey = new Map(olds.map((b) => [key(b), b]));
  const edits = [];
  const transplanted = [];
  const matchers = [];
  for (const b of news) {
    const o = oldByKey.get(key(b));
    if (o && oldCount.get(key(b)) === 1 && newCount.get(key(b)) === 1) {
      edits.push({ start: b.fn.start, end: b.fn.end, text: oldSrc.slice(o.fn.start, o.fn.end) });
      transplanted.push(b.path);
      matchers.push(new RegExp(`^${b.path.map((p, i) => (b.eachMask[i] ? eachCases(p) : escapeRe(p))).join(' ')}$`));
    } else edits.push({ start: b.callee.start, end: b.callee.end, text: `${b.name}.skip${b.each ? '.each' : ''}` });
  }
  let source = newSrc;
  for (const e of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, e.start) + e.text + source.slice(e.end);
  const missing = olds.filter((o) => !transplanted.some((p) => p.join('\u0000') === key(o))).map((o) => o.path);
  return { source, transplanted, missing, matchers };
}
