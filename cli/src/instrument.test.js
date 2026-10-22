'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { instrumentSource, isInstrumented, parse } = require('./instrument');
const { APP_OUTPUT, copyFixture } = require('../../test/helpers');

/** Where the runtime logs the code these tests run. */
const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'jstrace-logs-'));
after(() => fs.rmSync(LOGS, { recursive: true, force: true }));

/**
 * Instruments a source with the runtime, logging to a temp folder.
 * @param {string} source
 * @param {{ ignore: string[] }} [externalCalls]
 * @returns {string}
 */
function instrument(source, externalCalls) {
  return instrumentSource(source, { file: '/x.js', options: { logs: LOGS }, externalCalls }).code;
}

/**
 * Runs a CommonJS source and gives what it exports (awaited, if it's a promise).
 * @param {string} source
 * @returns {Promise<unknown>}
 */
async function evaluate(source) {
  delete (/** @type {any} */ (globalThis).__jt); // a fresh runtime per run
  const module = { exports: /** @type {unknown} */ ({}) };
  new Function('require', 'module', 'exports', source.replace(/^#!.*/, ''))(require, module, module.exports);
  return await module.exports;
}

/**
 * Asserts that instrumenting a source changes neither what it does nor its lines.
 * @param {string} source
 * @param {{ ignore: string[] }} [externalCalls]
 * @returns {Promise<string>} the instrumented code
 */
async function same(source, externalCalls) {
  const code = instrument(source, externalCalls);
  assert.equal(code.split(/\r\n?|\n/).length, source.split(/\r\n?|\n/).length);
  assert.deepEqual(await evaluate(code), await evaluate(source));
  return code;
}

/**
 * The names the instrumenter gives a source's functions, in order.
 * @param {string} source
 * @returns {string[]}
 */
function names(source) {
  return instrumentSource(source, { file: '/x.js' }).functions.map(([name]) => name);
}

test('function forms keep working', async () => {
  await same(`'use strict';
function add(a, b) { return a + b; }
const twice = (f) => (x) => f(f(x));
const pair = (a, b) => ({ a, b });
const seq = (a) => (a, a + 1);
function early(x) { if (x) return; return 'late'; }
function destructure({ a, b: [c] }, ...rest) { return [a, c, rest.length]; }
function defaults(f = () => 4) { return f(); }
function hoisted() { return inner(); function inner() { return 'inner'; } }
function thrower() { throw new Error('boom'); }
function caught() { try { thrower(); } catch (e) { return e.message; } }
module.exports = [add(1, 2), twice((x) => x * 2)(3), pair(1, 2), seq(1), early(1), early(0),
  destructure({ a: 1, b: [2] }, 3, 4), defaults(), hoisted(), caught()];`);
});

test('classes keep working', async () => {
  await same(`class A {
  field = () => this.x;
  static s = function () { return 's'; };
  #p() { return 'p'; }
  constructor(x) { this.x = x; }
  get g() { return this.x; }
  set g(v) { this.x = v; }
  p() { return this.#p(); }
  ['comp' + 'uted']() { return 'c'; }
  static make() { return new this(1); }
}
class B extends A { constructor() { super(2); } p() { return super.p() + 'b'; } }
const b = new B();
b.g = 5;
module.exports = [A.make().x, b.g, b.field(), b.p(), b.computed(), A.s()];`);
});

test('async functions and generators keep working', async () => {
  await same(`async function one() { await null; return 1; }
const two = async () => (await one()) + (await one());
async function fails() { await null; throw new Error('no'); }
async function recovers() { try { await fails(); } catch (e) { return e.message; } }
function* gen(n) { const got = yield n; yield; yield* [got, 'x']; return 'done'; }
const it = gen(1);
const steps = [it.next(), it.next('back'), it.next(), it.next(), it.next(), it.next()];
module.exports = (async () => [await two(), await recovers(), steps])();`);
});

test('with externalCalls, every form of call keeps working, evaluated once and in order', async () => {
  const code = await same(`'use strict';
const order = [];
const log = (x, label) => (order.push(label), x);
class A {
  #p() { return 'p' + this.x; }
  constructor(x) { this.x = x; }
  m(y) { return this.x + y; }
  p() { return this.#p(); }
  static make() { return new this(1); }
}
class B extends A { constructor() { super(2); } m(y) { return super.m(y) * 10; } }
const a = new A(3);
const o = { a, get g() { order.push('g'); return a; } };
const key = 'm';
let missing = null;
function tag(parts) { return parts.join('|'); }
const results = [
  a.m(1), a[key](2), log(o, 'o').g.m(3), (a.m)(4), (0, String)(8), new B().m(1), a.p(),
  [3, 1, 2].map((x) => x * 2).filter(Boolean).sort().join(','),
  Promise.resolve(1)
    .then((x) => x + 1)
    ['constructor'].name,
  o.a?.m(5), missing?.m(6), o.nope?.(), eval('1 + 1'), (function () { return this; })(), (() => 'arrow')(),
  tag\`a\${1}b\`, Math.max(...[1, 5, 2]), JSON.parse(JSON.stringify({ deep: [1] })), String(7), 'abc'.toUpperCase(),
];
const errors = [() => missing.m(), () => missing(), () => a.nope()].map((f) => { try { f(); } catch (e) { return e.constructor.name; } });
module.exports = [results, order, errors];`, { ignore: [] });
  assert.match(code, /__jtm\.cm\(\d+,a\)\.m\(1\)/);
  assert.match(code, /__jtm\.cf\(\d+,log\)\(o, 'o'\)/);
  assert.match(code, /\(a\.m\)\(4\)/, 'left alone, as it keeps this');
  assert.match(code, /eval\('1 \+ 1'\)/, 'left alone, as a direct eval');
  assert.match(code, /o\.a\?\.m\(5\)/, 'left alone, as an optional chain');
  assert.match(code, /super\.m\(y\)/);
  assert.match(code, /this\.#p\(\)/);
});

test('with externalCalls, calls are named as written, where the callee is, and ignored by pattern', () => {
  const source = `const fs = require('fs');
fs.readFileSync('x');
console.log(1);
list.items.push(2);
fetch(url)
  .then(cb);
list[0](); list[i](); (a || b)(); [1].map(f);`;
  const { calls } = instrumentSource(source, { file: '/x.js', externalCalls: { ignore: ['require', 'console.*', '*.push'] } });
  assert.deepEqual(calls, [
    ['fs.readFileSync', 2, 3, []],
    ['fetch().then', 6, 3, []],
    ['fetch', 5, 0, []],
    ['list[0]', 7, 5, []],
    ['list[…]', 7, 16, []],
    ['(…)', 7, 22, []],
    ['….map', 7, 38, []],
  ]);
  assert.deepEqual(instrumentSource(source, { file: '/x.js' }).calls, []);
});

test('a shebang, directives, a module return and line endings stay as they are', async () => {
  const code = await same(`#!/usr/bin/env node\n'use strict'\n"another";\nfunction f() { 'use strict'\n return 1 }\nmodule.exports = f();\nreturn;\nmodule.exports = 2;`);
  assert.match(code, /^#!\/usr\/bin\/env node\n'use strict'\n"another";;var __jt=/);
  assert.match(code, /function f\(\) \{ 'use strict';const __jtc=/);
  assert.match(code, /\nreturn;\n/);
  await same(`'use strict';\r\nconst f = () => 1;\r\nmodule.exports = f();\r\n`);
  await same('');
  await same('﻿module.exports = (function () { return 1; })();');
});

test('names come from the code', () => {
  assert.deepEqual(
    names(`function f() {}
const g = function () {};
const h = function named() {};
let i; i = () => {};
const o = { m() {}, get p() {}, q: () => {}, 'r s': function () {} };
exports.e = function () {};
Foo.prototype.bar = function () {};
this.t = () => {};
function d(cb = () => {}) {}
const C = class { m() {} };
class K { static s() {} #p() {} get g() {} set g(v) {} constructor() {} [k]() {} }
[1].map((x) => x);
const p = (function () {});`),
    [
      'f', 'g', 'named', 'i', 'o.m', 'get o.p', 'o.q', 'o.r s', 'exports.e', 'Foo->bar', 'this.t', 'd', 'cb',
      'C->m', 'K->s', 'K->#p', 'K->get g', 'K->set g', 'K->constructor', 'K->[k]', '<anonymous@12:9>', 'p',
    ],
  );
});

test('positions and parameters are those of the original source', () => {
  const { functions } = instrumentSource(`class A {\n  m(a, { b, c: [d] }, ...e) {}\n}\nconst f = (x = 1) => x;`, { file: '/x.js' });
  assert.deepEqual(functions, [
    ['A->m', 2, 2, ['a', 'b', 'd', 'e']],
    ['f', 4, 10, ['x']],
  ]);
});

test('an ES module fails to parse, and injected code is recognized', () => {
  assert.throws(() => instrument('export const x = 1;'), SyntaxError);
  assert.ok(!isInstrumented('const x = 1;'));
  assert.ok(isInstrumented(instrument('const x = 1;')));
});

test('injected text stays on its line, even with line separators in names', () => {
  const source = `const o = { 'a\u2028b'() {} };\nmodule.exports = 1;`;
  const code = instrument(source);
  assert.equal(code.split(/\r\n?|[\n\u2028\u2029]/).length, source.split(/\r\n?|[\n\u2028\u2029]/).length);
  parse(code);
});

/**
 * A runtime that records every call instrumented code makes, as JSON lines in
 * `options.out` (one file for every process), files named relative to `options.dir`.
 * Self-contained, as the prelude embeds it.
 * @param {NodeJS.Require} require
 * @param {{ out: string, dir: string }} options
 * @returns {import('../runtime/runtime').Runtime}
 */
function createRecorder(require, options) {
  const fs = require('fs');
  /** @param {unknown} value */
  const plain = (value) => (value === null || (typeof value !== 'object' && typeof value !== 'function') ? value : typeof value);
  /** @param {unknown[]} event */
  const write = (event) => fs.appendFileSync(options.out, JSON.stringify([process.pid, ...event]) + '\n');
  return {
    load(file, functions) {
      write(['load', require('path').relative(options.dir, file).replace(/\\/g, '/')]);
      return {
        enter(index, args) {
          const name = functions[index][0];
          write(['enter', name, args.map(plain)]);
          return {
            ret: (value) => (write(['ret', name, plain(value)]), value),
            throw: (error) => (write(['throw', name, String(error)]), error),
            exit: () => write(['exit', name]),
            sa: (value) => (write(['sa', name]), value),
            sy: (value) => (write(['sy', name, plain(value)]), value),
            r: (value) => (write(['r', name]), value),
          };
        },
        cf: (index, fn) => fn,
        cm: (index, object) => object,
      };
    },
  };
}

test('the instrumented app fixture prints the same, and tells the runtime everything', (t) => {
  const dir = copyFixture(t, 'app');
  const out = path.join(dir, 'events.jsonl');
  const files = fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.c?js$/.test(file) && !file.endsWith('esm.js'));
  for (const file of files) {
    const absolute = path.join(dir, file);
    const { code } = instrumentSource(fs.readFileSync(absolute, 'utf8'), { file: absolute, options: { out, dir }, runtime: createRecorder });
    fs.writeFileSync(absolute, code);
  }
  const stdout = execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' });
  assert.equal(stdout, APP_OUTPUT);

  /** @type {[number, string, ...unknown[]][]} */
  const events = fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const main = events.filter(([pid]) => pid === events[0][0]).map(([, ...event]) => event);
  const child = events.filter(([pid]) => pid !== events[0][0]).map(([, ...event]) => event);
  /**
   * The events about one function.
   * @param {unknown[][]} list
   * @param {string} name
   */
  const of = (list, name) => list.filter((event) => event[1] === name).map((event) => [event[0], ...event.slice(2)]);

  assert.deepEqual(main.filter(([type]) => type === 'load').map(([, file]) => file), [
    'index.js', 'lib/math.js', 'lib/shapes.js', 'lib/tasks.js', 'lib/util.cjs', 'lib/vendor.min.js', 'node_modules/greeter/index.js',
  ]);
  assert.deepEqual(child.filter(([type]) => type === 'load').map(([, file]) => file), ['child.js', 'lib/math.js']);
  assert.deepEqual(of(main, 'factorial').filter(([type]) => type !== 'exit'), [
    ['enter', [5]], ['enter', [4]], ['enter', [3]], ['enter', [2]], ['enter', [1]],
    ['ret', 1], ['ret', 2], ['ret', 6], ['ret', 24], ['ret', 120],
  ]);
  assert.deepEqual(of(main, 'divide'), [['enter', [1, 0]], ['throw', 'Error: division by zero'], ['exit']]);
  assert.deepEqual(of(main, 'safeDivide').map(([type]) => type), ['enter', 'ret', 'exit']);
  assert.deepEqual(of(main, 'total').map(([type]) => type), ['enter', 'sa', 'r', 'sa', 'r', 'sa', 'r', 'ret', 'exit']);
  assert.deepEqual(of(main, 'ids'), [
    ['enter', [3]], ['sy', 'id1'], ['r'], ['sy', 'id2'], ['r'], ['sy', 'id3'], ['r'], ['exit'],
  ]);
  assert.deepEqual(of(main, 'Shape->set scale'), [['enter', [2]], ['exit']]);
  assert.deepEqual(of(child, 'square'), [['enter', [4]], ['ret', 16], ['exit']]);
});
