// goalline's clock watch. `goalline run` preloads it into every Node process of a gate
// (NODE_OPTIONS=--require). It counts the reads of the real clock (Date.now(), new Date(), Date())
// made by the project's own code, in this realm and in every vm context created after it (Jest's
// test environments), and writes them to GOALLINE_CLOCK_DIR. A read counts when the first frame
// behind it is a file in the repository outside node_modules, directly or through a date library
// (dayjs() is the caller's read). A library's own read, such as a test runner timing a test, does
// not count. Fake timers replace Date: a fake clock's reads count only while its time came from the
// real one (Jest and Vitest start it there unless told a time), since the test still depends on the
// day it runs.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { fileURLToPath } = require('url');

// Installs the watch in one realm: its Date and Date.now report each read, with a way to get the
// call sites behind it. Self-contained, because vm contexts get it as source.
function patch(report) {
  const g = globalThis;
  const RealDate = g.Date;
  const mark = Symbol.for('goalline.clock');
  if (typeof RealDate !== 'function' || RealDate[mark]) return false;
  const Err = g.Error;
  const realNow = RealDate.now;
  // The call sites above fn past the first `skip`, at most `limit` of them; taken only when the
  // watch asks.
  const capture = (fn, skip = 0) => (limit) => {
    const prepare = Err.prepareStackTrace;
    const before = Err.stackTraceLimit;
    Err.prepareStackTrace = (_, callSites) => callSites;
    Err.stackTraceLimit = limit + skip;
    const holder = {};
    try {
      Err.captureStackTrace(holder, fn);
      return skip ? holder.stack.slice(skip) : holder.stack;
    } catch {
      return [];
    } finally {
      Err.prepareStackTrace = prepare;
      Err.stackTraceLimit = before;
    }
  };
  // The same stack as the realm prints it (source-mapped under Jest), for the line to show.
  const printed = (fn) => () => {
    const holder = {};
    try {
      Err.captureStackTrace(holder, fn);
      return String(holder.stack);
    } catch {
      return '';
    }
  };
  // sinon's fake Dates (behind Jest's and Vitest's fake timers), built on this realm's Date. A fake
  // clock's reads count while its time came from the real one: it started within a day of it, or
  // was set or reset there since. Ticking it on keeps that; setting it to another time ends it.
  const DAY = 86400000;
  const fromReal = new WeakMap();
  const fakes = new WeakSet();
  const wrappers = new WeakSet();
  const isClock = (c) => c !== null && typeof c === 'object' && typeof c.now === 'number';
  const judge = (clock) => fromReal.set(clock, Math.abs(clock.now - realNow.call(RealDate)) <= DAY);
  const watchClock = (clock) => {
    if (fromReal.has(clock)) return;
    judge(clock);
    // Wrapped as they are, or as the clock gets them: one seen as it is made has neither yet.
    for (const name of ['setSystemTime', 'reset']) {
      const wrap = (fn) =>
        typeof fn !== 'function'
          ? fn
          : function () {
              try {
                return Reflect.apply(fn, this, arguments);
              } finally {
                judge(clock);
              }
            };
      let current = wrap(clock[name]);
      Object.defineProperty(clock, name, { get: () => current, set: (fn) => (current = wrap(fn)), configurable: true, enumerable: true });
    }
  };
  const wrapNow = (date, fakeNow) => {
    const now = function now() {
      const t = Reflect.apply(fakeNow, this, arguments);
      if (fromReal.get(date.clock) === true) report(capture(now), printed(now), true);
      return t;
    };
    wrappers.add(now);
    return now;
  };
  // A fake Date and its clock as fake timers install them, shown by the watch of require (Jest's).
  const adopt = (date, clock) => {
    if (typeof date !== 'function' || !isClock(clock)) return;
    watchClock(clock);
    const fn = date.now;
    if (typeof fn === 'function' && !wrappers.has(fn)) date.now = wrapNow(date, fn);
  };
  // Whether new Date(t) is a fake Date's own `new Date()` or `Date()`, which make new Date(clock.now).
  const fakeRead = (date, t) => {
    if (date === Counted || typeof date !== 'function') return false;
    try {
      if (date.isFake !== true) return false;
      const clock = date.clock;
      return isClock(clock) && t === clock.now && fromReal.get(clock) === true;
    } catch {
      return false;
    }
  };

  function construct(target, args, newTarget) {
    if (args.length === 0) report(capture(construct), printed(construct));
    // A fake's read is made in a frame of the fake's own, which the report steps over.
    else if (args.length === 1 && typeof args[0] === 'number' && fakeRead(newTarget === Counted ? g.Date : newTarget, args[0])) {
      report(capture(construct, 1), printed(construct), true);
    }
    return Reflect.construct(target, args, newTarget);
  }
  function apply(target, thisArg, args) {
    report(capture(apply), printed(apply));
    return Reflect.apply(target, thisArg, args);
  }
  function now() {
    report(capture(now), printed(now));
    return realNow.call(RealDate);
  }
  // sinon's class-based fake Date extends this one, so it is seen as it is made (Vitest's copy, too):
  // marked isFake, it then gets its now(), wrapped here, and its clock, watched from its start.
  function set(target, prop, value, receiver) {
    const sub = receiver !== Counted && typeof receiver === 'function';
    if (sub && prop === 'now' && typeof value === 'function' && fakes.has(receiver) && !wrappers.has(value)) {
      value = wrapNow(receiver, value);
    }
    const done = Reflect.set(target, prop, value, receiver);
    if (sub && prop === 'isFake' && value === true && !fakes.has(receiver)) {
      fakes.add(receiver);
      try {
        let clock = receiver.clock;
        Object.defineProperty(receiver, 'clock', {
          get: () => clock,
          set: (c) => {
            clock = c;
            if (isClock(c)) watchClock(c);
          },
          configurable: true,
          enumerable: true,
        });
      } catch {
        // A fake that can't take it is judged only if the watch of require sees it installed.
      }
    }
    return done;
  }
  const Counted = new Proxy(RealDate, { construct, apply, set });
  const hidden = (value) => ({ value, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(RealDate, 'now', hidden(now));
  Object.defineProperty(RealDate, mark, hidden(true));
  Object.defineProperty(RealDate, Symbol.for('goalline.clock.adopt'), hidden(adopt));
  Object.defineProperty(RealDate.prototype, 'constructor', hidden(Counted));
  Object.defineProperty(g, 'Date', hidden(Counted));
  return true;
}

function watch(dir) {
  const isWin = process.platform === 'win32';
  const norm = (p) => (isWin ? p.replace(/\\/g, '/').toLowerCase() : p);
  // Real paths on both sides: Jest reports C:\Users\Long Name where the root may say C:\Users\LONGNA~1.
  const reals = new Map();
  const real = (p) => {
    let r = reals.get(p);
    if (r === undefined) {
      try {
        r = fs.realpathSync.native(p);
      } catch {
        r = p;
      }
      reals.set(p, r);
    }
    return r;
  };
  const root = real(path.resolve(process.env.GOALLINE_CLOCK_ROOT || process.cwd()));
  const ROOT = `${norm(root)}/`;
  const SELF = norm(real(__filename));
  // Date libraries read the clock for the code that calls them.
  const DATE_LIBS = new Set(['dayjs', 'moment', 'moment-timezone', 'luxon', 'date-fns', 'date-fns-tz', 'chrono-node',
    'timeago.js', 'spacetime', 'cron-parser', '@js-joda/core', '@js-temporal/polyfill', 'temporal-polyfill']);
  // Said of a read of a fake clock whose time came from the real one.
  const FAKE = ' under fake timers with no fixed time';
  const MAX_READS = 1000; // enough to know; later reads are not attributed ("1000+")
  // Reads looked at before the watch gives up (incomplete). Each costs about 5-10 microseconds;
  // Jest itself makes about 80 per test file.
  const MAX_CHECKS = 1000000;
  const out = path.join(dir, `${process.pid}-${require('worker_threads').threadId}.json`);
  const sites = new Map();
  let reads = 0;
  let checks = 0;
  let contexts = 0;
  let incomplete = false;
  let busy = false;

  const save = () => {
    const top = [...sites].sort((a, b) => b[1] - a[1]).slice(0, 10);
    try {
      fs.writeFileSync(out, JSON.stringify({ reads, capped: reads >= MAX_READS, incomplete, checks, contexts, sites: top }));
    } catch {
      // The run is over, or the folder is gone: nothing to tell.
    }
  };

  const fileOf = (callSite) => {
    let f = callSite && typeof callSite.getFileName === 'function' ? callSite.getFileName() : null;
    if (!f) return null;
    if (f.startsWith('file:')) {
      try {
        f = fileURLToPath(f.split('?')[0]);
      } catch {
        return null;
      }
    }
    return path.isAbsolute(f) ? f : null; // node:internal frames, eval'd code
  };
  const packageOf = (n) => {
    const i = n.lastIndexOf('/node_modules/');
    if (i === -1) return null;
    const [a, b] = n.slice(i + 14).split('/');
    return a.startsWith('@') ? `${a}/${b}` : a;
  };
  // Whose read it is: the first frame that is not Node's, this file's or a date library's decides.
  // A project file gives its site, any other file null; undefined when no frame decided.
  const whose = (callSites) => {
    for (const s of callSites) {
      const f = fileOf(s);
      if (!f) continue;
      const n = norm(real(f));
      if (n === SELF) continue;
      const pkg = packageOf(n);
      if (pkg) {
        if (DATE_LIBS.has(pkg)) continue;
        return null;
      }
      return n.startsWith(ROOT) ? { file: real(f), line: s.getLineNumber() } : null;
    }
    return undefined;
  };
  // "src/today.ts:3": the line as the realm prints it, when that frame is the same file.
  const siteOf = (who, printed) => {
    let line = who.line;
    if (reads <= 20) {
      for (const l of printed().split('\n').slice(1)) {
        const m = /\(?([^()]+?):(\d+):\d+\)?\s*$/.exec(l.replace(/^\s*at\s+/, ''));
        if (!m) continue;
        let f = m[1];
        if (f.startsWith('file:')) {
          try {
            f = fileURLToPath(f.split('?')[0]);
          } catch {
            continue;
          }
        }
        if (path.isAbsolute(f) && norm(real(f)) === norm(who.file)) {
          line = Number(m[2]);
          break;
        }
      }
    }
    return `${path.relative(root, who.file).split(path.sep).join('/')}:${line}`;
  };

  const report = (capture, printed, fake = false) => {
    if (busy || incomplete || reads >= MAX_READS) return;
    busy = true;
    try {
      if (++checks > MAX_CHECKS) {
        incomplete = true;
        save();
        return;
      }
      // The caller alone settles most reads (a test runner's own, or the project's); a date
      // library or Node's own frames in front need the frames behind them.
      let who = whose(capture(1));
      if (who === undefined) who = whose(capture(30));
      if (!who) return;
      reads += 1;
      const at = siteOf(who, printed) + (fake ? FAKE : '');
      sites.set(at, (sites.get(at) || 0) + 1);
      // Written as it goes: a test worker can be killed without running its exit handlers.
      if (reads === 1 || reads % 50 === 0 || reads === MAX_READS) save();
    } catch {
      // The watch must never break the code it watches.
    } finally {
      busy = false;
    }
  };

  patch(report);
  // Jest and jsdom run tests in vm contexts with Dates of their own: each one gets the watch too.
  const source = new vm.Script(`(${patch})`, { filename: __filename });
  const createContext = vm.createContext;
  vm.createContext = function (...args) {
    const context = createContext.apply(this, args);
    try {
      if (source.runInContext(context)(report)) contexts += 1;
    } catch {
      // A context that can't take the watch is left as it is.
    }
    return context;
  };
  // Jest's fake timers come from sinon's package through require. Each clock it installs is shown to
  // the watch of the realm whose Date it took, since sinon's older fake Date (a function, Jest 29's)
  // is not built on that Date and would go unseen.
  const ADOPT = Symbol.for('goalline.clock.adopt');
  const hooked = new WeakSet();
  const hookInstall = (impl) => {
    const install = impl && impl.install;
    if (typeof install !== 'function') return;
    impl.install = function (...args) {
      const clock = install.apply(this, args);
      try {
        const adopt = clock && clock._Date && clock._Date[ADOPT];
        if (typeof adopt === 'function') adopt(clock.Date, clock);
      } catch {
        // The fake timers work as they would without the watch.
      }
      return clock;
    };
  };
  // Seen as sinon's file finishes compiling. Not around require itself: Node decides whether to warn
  // of a deprecated module by whether the first frame that asks for it is under node_modules, and a
  // frame of the watch's own there would change its answer. Own properties only: a module still
  // loading in a require cycle warns of any other it is asked for.
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
  const Module = require('module');
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename, ...rest) {
    const result = Reflect.apply(compile, this, [content, filename, ...rest]);
    try {
      const exports = this.exports;
      if (typeof filename === 'string' && /[\\/]@sinonjs[\\/]fake-timers[\\/]/.test(filename) && exports !== null &&
        typeof exports === 'object' && own(exports, 'withGlobal') && typeof exports.withGlobal === 'function' && !hooked.has(exports)) {
        hooked.add(exports);
        const withGlobal = exports.withGlobal;
        exports.withGlobal = function (...a) {
          const impl = withGlobal.apply(this, a);
          hookInstall(impl);
          return impl;
        };
        hookInstall(exports);
      }
    } catch {
      // A module that can't be looked at is left as it is.
    }
    return result;
  };
  Module.syncBuiltinESMExports();
  process.on('exit', save);
  save();
}

if (process.env.GOALLINE_CLOCK_DIR) watch(process.env.GOALLINE_CLOCK_DIR);
