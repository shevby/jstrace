'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { instrumentSource } = require('../src/instrument');
const { readLogs } = require('../../test/helpers');

/**
 * Instruments a source as `x.js` in a temp folder and runs it in this process with a fresh
 * runtime, awaiting what it exports.
 * @param {import('node:test').TestContext} t
 * @param {string} source
 * @param {import('./runtime').RuntimeOptions} [options] besides `logs` (`<temp>/logs`) and `root`
 * @returns {Promise<{ dir: string, logs: string, exports: unknown }>}
 */
async function run(t, source, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstrace-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs');
  const { code } = instrumentSource(source, { file: path.join(dir, 'x.js'), options: { logs, root: dir, ...options } });
  delete (/** @type {any} */ (globalThis).__jt);
  const module = { exports: /** @type {unknown} */ ({}) };
  new Function('require', 'module', 'exports', code)(require, module, module.exports);
  const exports = await module.exports;
  delete (/** @type {any} */ (globalThis).__jt);
  return { dir, logs, exports };
}

/**
 * Runs a source (see `run`) and reads the one log it wrote.
 * @param {import('node:test').TestContext} t
 * @param {string} source
 * @param {import('./runtime').RuntimeOptions} [options]
 * @returns {Promise<import('../../test/helpers').Log & { dir: string }>}
 */
async function trace(t, source, options) {
  const { dir, logs } = await run(t, source, options);
  const found = readLogs(logs);
  assert.equal(found.length, 1);
  return { dir, ...found[0] };
}

/**
 * Events without what differs between runs (times, the temp folder).
 * @param {Record<string, any>[]} events
 * @returns {Record<string, any>[]}
 */
function stable(events) {
  return events.map(({ time, file, ...rest }) => rest);
}

test('calls nest, and each ends with a return or a throw', async (t) => {
  const { name, events, tree, dir } = await trace(
    t,
    `function inner(a, b) { if (b === 0) throw new Error('zero'); return a / b; }
function outer(n) { try { return inner(n, 0); } catch (e) { return inner(n, 2); } }
const none = () => {};
outer(4); none();`,
  );
  assert.match(name, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z-\d+\.jsonl$/);
  const [start, ...rest] = events;
  assert.deepEqual([start.type, start.pid, start.argv, start.cwd], ['start', process.pid, process.argv, process.cwd()]);
  assert.ok(rest.every((event) => event.file === undefined || event.file === path.join(dir, 'x.js')));
  assert.deepEqual(stable(rest), [
    { type: 'load', id: 1, parent: null, depth: 0 },
    { type: 'call', id: 2, parent: null, depth: 0, name: 'outer', line: 2, column: 0, args: { n: 4 } },
    { type: 'call', id: 3, parent: 2, depth: 1, name: 'inner', line: 1, column: 0, args: { a: 4, b: 0 } },
    { type: 'throw', call: 3, parent: 3, error: '[Error: zero]' },
    { type: 'call', id: 4, parent: 2, depth: 1, name: 'inner', line: 1, column: 0, args: { a: 4, b: 2 } },
    { type: 'return', call: 4, parent: 4, value: 2 },
    { type: 'return', call: 2, parent: 2, value: 2 },
    { type: 'call', id: 5, parent: null, depth: 0, name: 'none', line: 3, column: 13, args: {} },
    { type: 'return', call: 5, parent: 5 },
  ]);
  assert.match(tree[0], /^jstrace: process \d+ started \d{4}-.*Z: /);
  assert.deepEqual(tree.slice(1), [
    'load x.js',
    'outer(n: 4) #2  x.js:2',
    '  inner(a: 4, b: 0) #3  x.js:1',
    '    ← throws "[Error: zero]"',
    '  inner(a: 4, b: 2) #4  x.js:1',
    '    ← 2',
    '  ← 2',
    'none() #5  x.js:3',
    '  ← undefined',
  ]);
});

test('values are logged safely, within maxDepth and maxString', async (t) => {
  const { events } = await trace(
    t,
    `function f(v) { return v; }
class Point { constructor(x) { this.x = x; } }
const o = { n: 1 }; o.self = o;
[undefined, NaN, -Infinity, 10n, Symbol('s'), f, Point, class {}, 'abcdefgh', o, new Point(1),
  new (class Empty {})(), Object.create(null), { a: { b: { c: 1 } } }, [1, [2, [3]]], new Map([['k', 1]]),
  new Set([1]), new Date(0), /x/g, new TypeError('bad'), new Uint8Array([1, 2]), new ArrayBuffer(4),
  Promise.resolve(), { get g() { return 1; }, set s(v) {} }, { ['__proto__']: 1 }].map((v) => f(v));`,
    { maxDepth: 2, maxString: 5, maxRepeat: 0 },
  );
  const logged = events.filter((event) => event.type === 'call' && event.name === 'f').map((event) => event.args.v);
  assert.deepEqual(logged, [
    '[undefined]', '[NaN]', '[-Infinity]', '[10n]', '[Symbol(s)]', '[Function f]', '[class Point]', '[class (anonymous)]',
    'abcde…(+3)', { n: 1, self: '[Circular]' }, { '[Point]': { x: 1 } }, '[Empty]', {}, { a: { b: '[Object]' } },
    [1, [2, '[Array(1)]']], { '[Map(1)]': [['k', 1]] }, { '[Set(1)]': [1] }, '[Date 1970-01-01T00:00:00.000Z]',
    '[RegExp /x/g]', '[TypeError: bad]', '[Uint8Array(2) 1,2]', '[ArrayBuffer(4)]', '[Promise]',
    { g: '[Getter]', s: '[Setter]' }, { ['__proto__']: 1 },
  ]);
  const returned = events.filter((event) => event.type === 'return' && event.value !== undefined);
  assert.ok(returned.some((event) => event.value === 'abcde…(+3)'));
});

test('maxLine cuts long arrays and objects short', async (t) => {
  const { events } = await trace(
    t,
    `function f(list, object) {}
f(Array.from({ length: 100 }, (_, i) => i), Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['k' + i, i])));`,
    { maxLine: 50 },
  );
  const { list, object } = events.find((event) => event.name === 'f')?.args;
  assert.ok(list.length < 30);
  assert.match(list.at(-1), /^…\+\d+ more$/);
  assert.equal(Number(/\d+/.exec(list.at(-1))?.[0]) + list.length - 1, 100);
  assert.deepEqual(object, { '…': '+100 more' }); // the list spent the budget
});

test('an async function resumes as a new root, a rejected await included', async (t) => {
  const { events, tree, dir } = await trace(
    t,
    `function note(text) { return text; }
async function fails() { await null; throw new Error('no'); }
async function main() { try { await fails(); } catch (e) { note(e.message); } return 'done'; }
module.exports = main();`,
  );
  assert.deepEqual(tree.slice(1), [
    'load x.js',
    'main() #2  x.js:3',
    '  fails() #3  x.js:2',
    '↻ fails() #3 resumed  x.js:2',
    '  ← throws "[Error: no]"',
    '↻ main() #2 resumed  x.js:3',
    '  note(text: "no") #6  x.js:1',
    '    ← "no"',
    '  ← "done"',
  ]);
  assert.deepEqual(events.find((event) => event.type === 'resume'), {
    type: 'resume', id: 4, call: 3, parent: null, depth: 0, name: 'fails', file: path.join(dir, 'x.js'), line: 2, column: 0,
    time: events.find((event) => event.type === 'resume')?.time,
  });
});

test('a generator resumes inside the caller of next(), and logs what it yields', async (t) => {
  const { tree } = await trace(
    t,
    `function note(text) { return text; }
function* gen() { const got = yield 1; yield note(got); yield 3; }
function run() { const it = gen(); it.next(); it.next('back'); it.return(5); }
function fail() { const it = gen(); it.next(); try { it.throw(new Error('in')); } catch (e) { return e.message; } }
run(); fail();`,
  );
  assert.deepEqual(tree.slice(2), [
    'run() #2  x.js:3',
    '  gen() #3  x.js:2',
    '    ← yields 1',
    '  ↻ gen() #3 resumed  x.js:2',
    '    note(text: "back") #5  x.js:1',
    '      ← "back"',
    '    ← yields "back"',
    '  ↻ gen() #3 resumed  x.js:2',
    '    ← undefined',
    '  ← undefined',
    'fail() #7  x.js:4',
    '  gen() #8  x.js:2',
    '    ← yields 1',
    '  ↻ gen() #8 resumed  x.js:2',
    '    ← throws "[Error: in]"',
    '  ← "in"',
  ]);
});

test('past maxRepeat, the calls of a function in a call are counted, not logged, with all they do', async (t) => {
  const { events, tree } = await trace(
    t,
    `function inner(i) { return i; }
function step(i) { return inner(i); }
function loop() { for (let i = 0; i < 5; i++) step(i); inner(9); }
async function wait(i) { await null; return i; }
async function main() { for (let i = 0; i < 4; i++) await wait(i); }
loop();
module.exports = main();`,
    { maxRepeat: 2 },
  );
  assert.deepEqual(tree.slice(1), [
    'load x.js',
    'loop() #2  x.js:3',
    '  step(i: 0) #3  x.js:2',
    '    inner(i: 0) #4  x.js:1',
    '      ← 0',
    '    ← 0',
    '  step(i: 1) #5  x.js:2',
    '    inner(i: 1) #6  x.js:1',
    '      ← 1',
    '    ← 1',
    '  inner(i: 9) #7  x.js:1',
    '    ← 9',
    '  … step() called 3 more times, not logged  x.js:2',
    '  ← undefined',
    'main() #8  x.js:5',
    '  wait(i: 0) #9  x.js:4',
    '↻ wait() #9 resumed  x.js:4',
    '  ← 0',
    '↻ main() #8 resumed  x.js:5',
    '  wait(i: 1) #12  x.js:4',
    '↻ wait() #12 resumed  x.js:4',
    '  ← 1',
    '↻ main() #8 resumed  x.js:5',
    '  … wait() called 1 more time, not logged  x.js:4',
    '  … main() resumed 2 more times, not logged  x.js:5',
    '  ← undefined',
  ]);
  assert.deepEqual(stable(events.filter((event) => event.type === 'skip')), [
    { type: 'skip', parent: 2, name: 'step', line: 2, column: 0, count: 3 },
    { type: 'skip', parent: 14, name: 'wait', line: 4, column: 0, count: 1 },
    { type: 'skip', parent: 14, name: 'main', line: 5, column: 0, count: 2, resumes: true },
  ]);
  assert.deepEqual(stable(events.filter((event) => event.type === 'return' && event.call === 8)), [{ type: 'return', call: 8, parent: 14 }]);
});

test('past maxRepeat, the resumes of a generator are counted, not logged, and its return still is', async (t) => {
  const { tree } = await trace(t, 'function* count() { for (let i = 0; i < 5; i++) yield i; return 9; }\nfunction run() { return [...count()].length; }\nrun();', { maxRepeat: 2 });
  assert.deepEqual(tree.slice(2), [
    'run() #2  x.js:2',
    '  count() #3  x.js:1',
    '    ← yields 0',
    '  ↻ count() #3 resumed  x.js:1',
    '    ← yields 1',
    '  ↻ count() #3 resumed  x.js:1',
    '    ← yields 2',
    '    … count() resumed 3 more times, not logged  x.js:1',
    '    ← 9',
    '  ← 5',
  ]);
});

test('maxRepeat 0 logs every call', async (t) => {
  const { events } = await trace(t, 'function f() {}\nfunction loop() { for (let i = 0; i < 30; i++) f(); }\nloop();', { maxRepeat: 0 });
  assert.equal(events.filter((event) => event.type === 'call' && event.name === 'f').length, 30);
  assert.equal(events.filter((event) => event.type === 'skip').length, 0);
});

test('calls skipped at the top level are reported when the process exits', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstrace-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs');
  const source = 'function f(i) { return i; }\nfor (let i = 0; i < 25; i++) f(i);\nsetTimeout(() => f(-1), 1);';
  fs.writeFileSync(path.join(dir, 'x.js'), instrumentSource(source, { file: path.join(dir, 'x.js'), options: { logs, root: dir } }).code);
  execFileSync(process.execPath, ['x.js'], { cwd: dir });
  const [log] = readLogs(logs);
  const calls = log.events.filter((event) => event.type === 'call' && event.name === 'f');
  assert.deepEqual(calls.map((event) => event.args.i), [...Array(20).keys(), -1], 'maxRepeat is 20 by default; the callback counts its own');
  assert.deepEqual(stable(log.events.slice(-1)), [{ type: 'skip', parent: null, name: 'f', line: 1, column: 0, count: 5 }]);
  assert.equal(log.tree[log.tree.length - 1], '… f() called 5 more times, not logged  x.js:1');
});

test('JSTRACE_OUT moves the logs', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jstrace-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  process.env.JSTRACE_OUT = out;
  try {
    const { logs } = await run(t, 'function f() {} f();');
    assert.ok(!fs.existsSync(logs));
  } finally {
    delete process.env.JSTRACE_OUT;
  }
  assert.deepEqual(readLogs(out)[0].tree.slice(1), ['load x.js', 'f() #2  x.js:1', '  ← undefined']);
});

test('globalThis.__jstraceFs writes the logs when it is set', async (t) => {
  /** @type {string[]} */
  const opened = [];
  /** @type {string[]} */
  const written = [];
  /** @type {any} */ (globalThis).__jstraceFs = {
    mkdirSync() {},
    openSync: (/** @type {string} */ file) => opened.push(file),
    writeSync: (/** @type {number} */ fd, /** @type {string} */ text) => written.push(`${fd} ${text}`),
  };
  try {
    const { logs } = await run(t, 'function f() {} f();');
    assert.ok(!fs.existsSync(logs));
    assert.deepEqual(opened.map((file) => path.extname(file)), ['.jsonl', '.txt']);
    assert.ok(written.includes('2 f() #2  x.js:1\n'));
  } finally {
    delete (/** @type {any} */ (globalThis).__jstraceFs);
  }
});

test('when the logs cannot be written, tracing stops with a message and the program goes on', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const { dir, exports } = await run(t, 'function f(x) { return x * 2; } module.exports = f(2);', { logs: __filename + '/logs' });
  assert.equal(exports, 4);
  assert.equal(error.mock.callCount(), 1);
  assert.match(String(error.mock.calls[0].arguments[0]), /^jstrace: can't write logs to .*, so tracing stops: /);
  assert.deepEqual(fs.readdirSync(dir), []);
});
