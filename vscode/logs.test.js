'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../cli/src/cli');
const { copyFixture } = require('../test/helpers');
const logs = require('./logs');

const ROOT = path.resolve('/project');
const file = (/** @type {string} */ rel) => path.join(ROOT, rel);

/** A small log by hand: a load, nested calls, a throw, an async call going on in a resume, a generator, and a line cut short. */
const LOG = [
  { type: 'start', pid: 7, argv: ['node', file('src/app.js'), '--fast'], cwd: ROOT, started: '2026-10-22T12:19:17.035Z', time: 0 },
  { type: 'load', id: 1, parent: null, depth: 0, file: file('src/app.js'), time: 0.1 },
  { type: 'call', id: 2, parent: 1, depth: 1, name: 'main', file: file('src/app.js'), line: 3, column: 0, args: {}, time: 1 },
  { type: 'call', id: 3, parent: 2, depth: 2, name: 'divide', file: file('src/app.js'), line: 9, column: 2, args: { a: 1, b: 0 }, time: 2 },
  { type: 'throw', call: 3, parent: 3, error: '[Error: division by zero]', time: 3 },
  { type: 'call', id: 4, parent: 2, depth: 2, name: 'later', file: file('src/app.js'), line: 12, column: 0, args: { value: 'x' }, time: 4 },
  { type: 'return', call: 2, parent: 2, time: 5 },
  { type: 'resume', id: 5, call: 4, parent: null, depth: 0, name: 'later', file: file('src/app.js'), line: 12, column: 0, time: 6 },
  { type: 'return', call: 4, parent: 5, value: 'X', time: 7 },
  { type: 'call', id: 6, parent: null, depth: 0, name: 'ids', file: file('src/app.js'), line: 20, column: 0, args: { count: 1 }, time: 8 },
  { type: 'yield', call: 6, parent: 6, value: 'id1', time: 9 },
]
  .map((event) => JSON.stringify(event))
  .concat('{"type":"call","id":7,"par')
  .join('\n');

test('parseLog builds the call trees and links each end to its node and call', () => {
  const trace = logs.parseLog(LOG);
  assert.equal(trace.start?.pid, 7);
  assert.deepEqual(trace.roots.map((node) => node.event.id), [1, 5, 6]);
  const [load, resume, ids] = trace.roots;
  const main = load.children[0];
  assert.deepEqual(main.children.map((node) => node.event.id), [3, 4]);
  const [divide, later] = main.children;
  assert.equal(divide.parent, main);
  assert.equal(divide.outcome?.type, 'throw');
  assert.equal(later.end, undefined, 'it suspended without ending');
  assert.equal(later.outcome?.value, 'X', 'it returned in its resume');
  assert.deepEqual(later.resumes, [resume]);
  assert.equal(resume.end?.value, 'X');
  assert.equal(ids.end?.type, 'yield');
  assert.equal(ids.outcome, undefined);
  assert.equal(trace.nodes.size, 6, 'the line cut short is skipped');
});

test('labels, descriptions and hovers read like the .txt tree', () => {
  const trace = logs.parseLog(LOG);
  const [load, resume, ids] = trace.roots;
  const [divide, later] = load.children[0].children;
  assert.equal(logs.logLabel(trace, 'x.jsonl', ROOT), 'src/app.js --fast');
  assert.match(logs.logDescription(trace), /^2026-10-2\d \d\d:\d\d:17  pid 7$/);
  assert.equal(logs.logLabel(logs.parseLog(''), file('.jstrace/logs/a.jsonl'), ROOT), 'a.jsonl');

  assert.equal(logs.nodeLabel(load, ROOT), 'load src/app.js');
  assert.equal(logs.nodeLabel(divide, ROOT), 'divide(a: 1, b: 0)');
  assert.equal(logs.nodeLabel(resume, ROOT), '↻ later() resumed');
  assert.equal(logs.nodeDescription(divide), '← throws "[Error: division by zero]"');
  assert.equal(logs.nodeDescription(load.children[0]), '← undefined');
  assert.equal(logs.nodeDescription(later), '← "X"');
  assert.equal(logs.nodeDescription(resume), '← "X"');
  assert.equal(logs.nodeDescription(ids), '← yields "id1"');
  assert.equal(logs.nodeDescription(load), '');

  const long = logs.parseLog(JSON.stringify({ type: 'call', id: 1, parent: null, name: 'f', file: file('a.js'), line: 1, column: 0, args: { s: 'x'.repeat(500) } }));
  const label = logs.nodeLabel(long.roots[0], ROOT);
  assert.equal(label.length, 120);
  assert.ok(label.endsWith('…)'));

  const hover = logs.nodeTooltip(divide, ROOT);
  assert.match(hover, /\*\*divide\(\)\*\* #3/);
  assert.match(hover, /src\/app\.js:9/);
  assert.match(hover, /"a": 1,\n {2}"b": 0/);
  assert.match(hover, /Threw:/);
  assert.match(logs.nodeTooltip(resume, ROOT), /Part of call #4/);

  const ticks = logs.parseLog(JSON.stringify({ type: 'call', id: 1, parent: null, name: 'f', file: file('a.js'), line: 1, column: 0, args: { s: '```' } }));
  assert.match(logs.nodeTooltip(ticks.roots[0], ROOT), /^````json$/m, "a value's backticks can't close the code block");
});

test('an external call shows its arguments by position, and that it is not traced', () => {
  const trace = logs.parseLog(
    [
      { type: 'call', id: 1, parent: null, depth: 0, name: 'fs.readFileSync', file: file('a.js'), line: 2, column: 3, args: ['x.txt', 'utf8'], external: true, time: 1 },
      { type: 'return', call: 1, parent: 1, value: 'text', time: 2 },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n'),
  );
  const [call] = trace.roots;
  assert.equal(logs.nodeLabel(call, ROOT), 'fs.readFileSync("x.txt", "utf8")');
  assert.deepEqual(logs.search(trace, 'readfile utf8 a.js:2', ROOT), [call]);
  assert.match(logs.nodeTooltip(call, ROOT), /Not traced .*: called here/);
  const { text } = logs.nodeDetails(call, ROOT);
  assert.match(text, /\/\/ Not traced/);
  assert.match(text, /"arguments": \[\n {4}"x\.txt",/);
});

test('rows group the calls of a function, with those not logged', () => {
  const call = (/** @type {number} */ id, /** @type {string} */ name, /** @type {number} */ line, /** @type {object} */ more = {}) =>
    ({ type: 'call', id, parent: 1, depth: 1, name, file: file('a.js'), line, column: 0, args: { id }, ...more });
  const trace = logs.parseLog(
    [
      { type: 'call', id: 1, parent: null, depth: 0, name: 'loop', file: file('a.js'), line: 1, column: 0, args: {} },
      call(2, 'step', 5), { type: 'return', call: 2, parent: 2, value: 1 },
      call(3, 'other', 9), { type: 'return', call: 3, parent: 3 },
      call(4, 'step', 5), { type: 'throw', call: 4, parent: 4, error: '[Error: x]' },
      call(5, 'step', 5), { type: 'return', call: 5, parent: 5, value: 3 },
      { type: 'skip', parent: 1, name: 'step', file: file('a.js'), line: 5, column: 0, count: 7 },
      { type: 'skip', parent: 1, name: 'gone', file: file('a.js'), line: 12, column: 0, count: 1 },
      { type: 'return', call: 1, parent: 1 },
    ].map((event) => JSON.stringify(event)).join('\n'),
  );
  const loop = trace.roots[0];
  const describe = (/** @type {import('./logs').Row[]} */ rows) =>
    rows.map((row) => (row.kind === 'group' ? `${logs.groupLabel(row)} | ${logs.groupDescription(row)}` : row.kind === 'skip' ? logs.skipLabel(row.event) : logs.nodeLabel(/** @type {any} */ (row.node), ROOT)));
  assert.deepEqual(describe(logs.rows(loop.children, loop.skips, 3)), ['step() ×10 | 7 not logged, 1 threw', 'other(id: 3)', '… gone() ×1 not logged']);
  assert.deepEqual(logs.rows(loop.children, loop.skips, 3)[0].nodes?.map((node) => node.event.id), [2, 4, 5]);
  assert.deepEqual(describe(logs.rows(loop.children, [], 4)), ['step(id: 2)', 'other(id: 3)', 'step(id: 4)', 'step(id: 5)'], 'fewer than min');
  assert.deepEqual(describe(logs.rows(loop.children, loop.skips, 0)), ['step(id: 2)', 'other(id: 3)', 'step(id: 4)', 'step(id: 5)', '… step() ×7 not logged', '… gone() ×1 not logged'], '0: no groups');
  const [group, , skip] = logs.rows(loop.children, loop.skips, 3);
  assert.match(logs.rowTooltip(group, ROOT), /called 10 times here[^]*3 logged, 7 not: past `maxRepeat`/);
  assert.match(logs.rowTooltip(skip, ROOT), /\*\*gone\(\)\*\* called 1 more time here, not logged/);
  const resumes = { type: 'skip', parent: 1, name: 'loop', file: file('a.js'), line: 1, column: 0, count: 4, resumes: true };
  assert.equal(logs.skipLabel(resumes), '… loop() resumed ×4 not logged');
  assert.match(logs.rowTooltip({ kind: 'skip', event: resumes, key: '' }, ROOT), /resumed 4 more times here, not logged/);
});

test('timeRows lists nodes and skips in the order they happened, in pages past the size', () => {
  const trace = logs.parseLog([
    { type: 'start', pid: 1, started: '2026-01-01T10:15:00.000Z', time: 0 },
    { type: 'call', id: 1, parent: null, depth: 0, name: 'a', file: 'x.js', line: 1, column: 0, args: {}, time: 1 },
    { type: 'call', id: 2, parent: 1, depth: 1, name: 'b', file: 'x.js', line: 2, column: 0, args: {}, time: 2 },
    { type: 'skip', parent: 1, name: 'b', file: 'x.js', line: 2, column: 0, count: 2, time: 3 },
    { type: 'return', call: 1, parent: 1, time: 4 },
    { type: 'call', id: 3, parent: null, depth: 0, name: 'c', file: 'x.js', line: 3, column: 0, args: {}, time: 3000 },
  ].map((event) => JSON.stringify(event)).join('\n'));
  assert.deepEqual(logs.timeRows(trace, 4).map((row) => [row.kind, row.event.name]), [['node', 'a'], ['node', 'b'], ['skip', 'b'], ['node', 'c']]);

  const pages = logs.timeRows(trace, 3);
  assert.deepEqual(pages.map((row) => [row.kind, logs.pageLabel(row), row.rows?.length]), [['page', '1–3', 3], ['page', '4–4', 1]]);

  const local = new Date(2026, 0, 1, 8, 5, 9, 7);
  assert.equal(logs.clockTime(/** @type {any} */ ({ start: { started: local.toISOString() } }), { time: 1000.6 }), '08:05:10.007');
  assert.equal(logs.clockTime(/** @type {any} */ ({ start: undefined }), { time: 12.5 }), '12.5 ms', 'no start time to count from');
  const [first, second] = [trace.timeline[0].event, trace.timeline[3].event];
  assert.equal(logs.pageDescription(trace, pages[0]), `${logs.clockTime(trace, first)} – ${logs.clockTime(trace, trace.timeline[2].event)}`);
  assert.equal(logs.pageDescription(trace, pages[1]), `${logs.clockTime(trace, second)} – ${logs.clockTime(trace, second)}`);
});

test('details show where and when a call ran, its arguments and how it ended', () => {
  const trace = logs.parseLog(LOG);
  const [load, resume, ids] = trace.roots;
  const [divide, later] = load.children[0].children;

  const thrown = logs.nodeDetails(divide, ROOT);
  assert.equal(thrown.name, 'divide #3.jsonc');
  const lines = thrown.text.split('\n');
  assert.deepEqual(lines.slice(0, 4), [
    '// divide(a: 1, b: 0)  #3',
    `// src/app.js:9  (${file('src/app.js')})`,
    '// called at 2 ms, took 1 ms',
    '// in: load src/app.js → main() #2 → divide() #3',
  ]);
  assert.deepEqual(JSON.parse(lines.slice(4).join('\n')), { arguments: { a: 1, b: 0 }, threw: '[Error: division by zero]' });

  const part = logs.nodeDetails(resume, ROOT);
  assert.equal(part.name, 'later #4.jsonc', 'a resume shows its call');
  assert.match(part.text, /^\/\/ resumed 1 time: #5$/m);
  assert.match(part.text, /^\/\/ this part: ↻ #5 at 6 ms, in: ↻ later\(\) #4$/m);
  assert.deepEqual(JSON.parse(part.text.replace(/^\/\/.*\n/gm, '')), { arguments: { value: 'x' }, returned: 'X' });
  assert.equal(logs.nodeDetails(later, ROOT).text, part.text.replace(/^\/\/ this part.*\n/m, ''));

  const generator = logs.nodeDetails(ids, ROOT);
  assert.match(generator.text, /still running when the log ended/);
  assert.deepEqual(JSON.parse(generator.text.replace(/^\/\/.*\n/gm, '')), { arguments: { count: 1 }, yielded: ['id1'] });
  assert.match(logs.nodeDetails(load, ROOT).text, /^\/\/ load src\/app\.js {2}#1\n/);

  const anonymous = logs.parseLog(JSON.stringify({ type: 'call', id: 1, parent: null, name: '<anonymous@1:2>', file: file('a.js'), line: 1, column: 1, args: {} }));
  assert.equal(logs.nodeDetails(anonymous.roots[0], ROOT).name, '_anonymous@1_2_ #1.jsonc');
});

test('a group details each of its calls', () => {
  const call = (/** @type {number} */ id, /** @type {number} */ n) => ({ type: 'call', id, parent: null, depth: 0, name: 'sq', file: file('a.js'), line: 3, column: 0, args: { n } });
  const trace = logs.parseLog(
    [
      call(1, 1), { type: 'return', call: 1, parent: 1, value: 1 }, call(2, 2), { type: 'throw', call: 2, parent: 2, error: 'no' },
      { type: 'skip', parent: null, name: 'sq', file: file('a.js'), line: 3, column: 0, count: 5 },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n'),
  );
  const { name, text } = logs.groupDetails(logs.rows(trace.roots, trace.skips, 5)[0], ROOT);
  assert.equal(name, 'sq ×7.jsonc');
  assert.match(text, /^\/\/ sq\(\) ×7: 2 logged, 5 not \(past maxRepeat\)\n/);
  assert.deepEqual(JSON.parse(text.replace(/^\/\/.*\n/gm, '')), [
    { call: 1, arguments: { n: 1 }, returned: 1 },
    { call: 2, arguments: { n: 2 }, threw: 'no' },
  ]);
});

test('a call site finds the callee by the name it is written with', () => {
  assert.deepEqual(
    ['factorial', 'Cart->add', 'counter.increment', 'Shape->constructor', 'Shape->get scale', 'A->#hidden', '<anonymous@6:42>', 'A->[Symbol.iterator]'].map(logs.callName),
    ['factorial', 'add', 'increment', 'Shape', 'scale', '#hidden', '', ''],
  );
  assert.equal(logs.columnOf("  lines.push(`factorial(5) = ${math.factorial(5)}`);", 'factorial'), 36, 'the call, not the text before it');
  assert.equal(logs.columnOf('  return n * factorial(n - 1);', 'factorial'), 13);
  assert.equal(logs.columnOf('  const t = cart.total;', 'total'), 17, 'a getter, through a dot');
  assert.equal(logs.columnOf('  const s = new Shape(1);', 'Shape'), 16);
  assert.equal(logs.columnOf('  x.#hidden();', '#hidden'), 4);
  assert.equal(logs.columnOf('  const factorials = 1; run();', 'factorial'), 2, 'no name there: the first character');
  assert.equal(logs.columnOf('    items.map(callback);', ''), 4);
});

test('search finds the calls and loads with every word, in names, arguments, values and files', () => {
  const trace = logs.parseLog(LOG);
  const ids = (/** @type {string} */ query) => logs.search(trace, query, ROOT).map((node) => node.event.id);
  assert.deepEqual(ids('DIVIDE'), [3], 'case is ignored');
  assert.deepEqual(ids('divide b: 0'), [3], 'every word, in any order');
  assert.deepEqual(ids('divide zero'), [3], 'what it threw');
  assert.deepEqual(ids('"X"'), [4], 'what it returned, even in a resume; the resume itself is left out');
  assert.deepEqual(ids('app.js:12'), [4], 'where it is');
  assert.deepEqual(ids('src/app'), [1, 2, 3, 4, 6], 'loads too, in the order they ran');
  assert.deepEqual(ids('divide later'), []);
  assert.deepEqual(ids('  '), [], 'nothing to look for');
  assert.deepEqual(logs.highlights('divide(a: 1, b: 0)', 'b: DIV'), [[0, 3], [13, 15]]);
});

test('searchAt finds the calls made from a line, or of a function defined on it', () => {
  const trace = logs.parseLog([
    { type: 'start', pid: 7, argv: ['node', file('a.js')], cwd: ROOT, started: '2026-10-22T12:19:17.035Z', time: 0 },
    { type: 'call', id: 1, parent: null, depth: 0, name: 'main', file: file('a.js'), line: 1, column: 0, args: {}, time: 1 },
    { type: 'call', id: 2, parent: 1, depth: 1, name: 'add', file: file('b.js'), line: 4, column: 0, args: {}, site: { file: file('a.js'), line: 2 }, time: 2 },
    { type: 'resume', id: 3, call: 2, parent: null, depth: 0, name: 'add', file: file('b.js'), line: 4, column: 0, time: 3 },
    { type: 'call', id: 4, parent: 1, depth: 1, name: 'fs.readFileSync', external: true, file: file('a.js'), line: 2, column: 5, args: [], time: 4 },
    { type: 'call', id: 5, parent: 1, depth: 1, name: 'add', file: file('b.js'), line: 4, column: 0, args: {}, site: { file: file('a.js'), line: 3 }, time: 5 },
  ].map((event) => JSON.stringify(event)).join('\n'));
  const ids = (/** @type {string} */ at, /** @type {number} */ line) => logs.searchAt(trace, at, line).map((node) => node.event.id);
  assert.deepEqual(ids(file('a.js'), 2), [2, 4], 'called from it, and external calls made on it');
  assert.deepEqual(ids(file('b.js'), 4), [2, 5], 'calls of the function defined on it, not its resumes');
  assert.deepEqual(ids(file('a.js'), 1), [1]);
  assert.deepEqual(ids(file('b.js'), 2), [], 'another file');
  if (process.platform === 'win32') assert.deepEqual(ids(file('a.js').toLowerCase(), 2), [2, 4], 'case is ignored on Windows');
});

test('the line of code a call was made on is searched, and shown in its hover and details', () => {
  const trace = logs.parseLog([
    { type: 'call', id: 1, parent: null, depth: 0, name: 'sum', file: file('a.js'), line: 1, column: 0, args: { list: [1] }, site: { file: file('b.js'), line: 3, code: 'const total = sum(items,\n rate);' }, time: 1 },
    { type: 'call', id: 2, parent: null, depth: 0, name: 'JSON.parse', external: true, file: file('b.js'), line: 4, column: 5, args: ['{}'], code: 'JSON.parse(rawConfig)', time: 2 },
    { type: 'call', id: 3, parent: null, depth: 0, name: 'old', file: file('a.js'), line: 2, column: 0, args: {}, site: { file: file('b.js'), line: 5 }, time: 3 },
  ].map((event) => JSON.stringify(event)).join('\n'));
  const ids = (/** @type {string} */ query) => logs.search(trace, query, ROOT).map((node) => node.event.id);
  assert.deepEqual(ids('items'), [1], 'a variable passed to it');
  assert.deepEqual(ids('sum total'), [1]);
  assert.deepEqual(ids('rawconfig'), [2], 'an external call has its own');
  const [sum, parse, old] = trace.roots;
  assert.match(logs.nodeTooltip(sum, ROOT), /Called as:\n\n```javascript\nconst total = sum\(items, rate\);\n```/, 'on one line');
  assert.match(logs.nodeDetails(parse, ROOT).text, /^\/\/ called as: JSON\.parse\(rawConfig\)$/m);
  assert.doesNotMatch(logs.nodeTooltip(old, ROOT), /Called as/, 'none in an older log');
});

test('steps go through a run in the order it ran, into, over or out of calls, and back', () => {
  const trace = logs.parseLog(LOG);
  const node = (/** @type {number} */ id) => /** @type {import('./logs').TraceNode} */ (trace.nodes.get(id));
  /** @param {number} id @param {'into' | 'back' | 'over' | 'backOver' | 'out'} how */
  const from = (id, how) => logs.step(trace, node(id), how)?.event.id;
  // load #1 > main #2 > (divide #3, later #4); ↻ later #5; ids #6
  assert.deepEqual([from(2, 'into'), from(3, 'into'), from(4, 'into'), from(6, 'into')], [3, 4, 5, undefined], 'into: the next one, whatever it ran in');
  assert.deepEqual([from(3, 'back'), from(5, 'back'), from(1, 'back')], [2, 4, undefined]);
  assert.deepEqual([from(1, 'over'), from(2, 'over'), from(3, 'over'), from(4, 'over')], [5, 5, 4, 5], 'over: past what ran inside');
  assert.deepEqual([from(4, 'backOver'), from(3, 'backOver'), from(5, 'backOver'), from(6, 'backOver')], [3, 2, 1, 5], 'back over: the previous one here, or the caller');
  assert.deepEqual([from(3, 'out'), from(2, 'out'), from(1, 'out')], [2, 1, undefined], 'out: the caller');
});

test('readMore reads a log as it grows, a line at a time', (t) => {
  const dir = copyFixture(t, 'app');
  const log = path.join(dir, 'x.jsonl');
  const start = JSON.stringify({ type: 'start', pid: 1, argv: [], cwd: dir, started: '2026-01-01T00:00:00.000Z', time: 0 });
  const call = JSON.stringify({ type: 'call', id: 1, parent: null, depth: 0, name: 'f', file: file('a.js'), line: 1, column: 0, args: { s: 'é😀' }, time: 1 });
  const cut = Buffer.from(call).length - 4; // inside the emoji
  fs.writeFileSync(log, Buffer.concat([Buffer.from(`${start}\n`), Buffer.from(call).subarray(0, cut)]));
  /** @type {import('./logs').Tail} */
  const tail = { trace: logs.parseLog(''), offset: 0 };
  assert.equal(logs.readMore(log, tail), true);
  assert.equal(tail.offset, start.length + 1, 'the line being written waits');
  assert.equal(tail.trace.nodes.size, 0);
  assert.equal(logs.readMore(log, tail), false, 'nothing complete added');

  fs.appendFileSync(log, Buffer.concat([Buffer.from(call).subarray(cut), Buffer.from(`\n${JSON.stringify({ type: 'return', call: 1, parent: 1, value: 2, time: 2 })}\n`)]));
  const trace = tail.trace;
  assert.equal(logs.readMore(log, tail), true);
  assert.equal(tail.trace, trace, 'the same trees, grown');
  assert.equal(tail.trace.roots[0].event.args.s, 'é😀');
  assert.equal(tail.trace.roots[0].outcome?.value, 2);

  fs.writeFileSync(log, `${start}\n`);
  assert.equal(logs.readMore(log, tail), true);
  assert.notEqual(tail.trace, trace, 'a log that got shorter is read again');
  assert.equal(tail.trace.nodes.size, 0);
});

test("isRunning tells whether a log's process still runs", () => {
  const now = Date.now();
  const running = logs.parseLog(JSON.stringify({ type: 'start', pid: process.pid }));
  assert.equal(logs.isRunning(running, now, now), true);
  assert.equal(logs.isRunning(running, now - 31 * 60 * 1000, now), false, 'not changed for 30 minutes: its pid may be taken');
  const { pid } = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(logs.isRunning(logs.parseLog(JSON.stringify({ type: 'start', pid })), now, now), false);
  assert.equal(logs.isRunning(logs.parseLog(''), now, now), false);
  const ended = logs.parseLog([{ type: 'start', pid: process.pid }, { type: 'end', code: 0 }].map((event) => JSON.stringify(event)).join('\n'));
  assert.equal(logs.isRunning(ended, now, now), false, 'it logged its end: a copied log whose pid is taken here');
});

test("a log from another machine shows this project's files (4.19)", () => {
  const text = [
    { type: 'start', pid: 7, argv: ['C:\\node.exe', 'C:\\Users\\a\\app\\src\\main.js', '-v'], cwd: 'C:\\Users\\a\\app', root: 'c:\\users\\a\\app', started: '2026-10-23T10:00:00.000Z', time: 0 },
    { type: 'load', id: 1, parent: null, depth: 0, file: 'src/main.js', time: 1 },
    { type: 'call', id: 2, parent: 1, depth: 1, name: 'f', file: 'src/lib.js', line: 2, column: 0, args: {}, site: { file: 'src/main.js', line: 5 }, time: 2 },
    { type: 'call', id: 3, parent: 1, depth: 1, name: 'g', file: 'C:\\Users\\a\\global\\g.js', line: 1, column: 0, args: {}, time: 3 },
    { type: 'end', code: 0, time: 4 },
  ].map((event) => JSON.stringify(event)).join('\n');
  const trace = logs.parseLog(text, ROOT);
  const [f, g] = trace.roots[0].children.map((node) => node.event);
  assert.deepEqual([trace.roots[0].event.file, f.file, f.site.file], [file('src/main.js'), file('src/lib.js'), file('src/main.js')]);
  assert.equal(g.file, 'C:\\Users\\a\\global\\g.js', 'outside the project, as it was');
  assert.equal(logs.logLabel(trace, 'x.jsonl', ROOT), 'src/main.js -v', 'the script relative to where the project was, ignoring case');
  assert.deepEqual(logs.searchAt(trace, file('src/main.js'), 5), [trace.nodes.get(2)]);
  const { txt } = logs.mergeLogs([{ file: 'x.jsonl', text, name: 'app' }], ROOT);
  assert.match(txt, /f\(\) #2 {2}src\/lib\.js:2 {2}\(from src\/main\.js:5\)/);
  assert.match(txt, /jstrace: process 7 ended with code 0\n$/);
});

test('relativePath keeps a path outside the project as it is', () => {
  assert.equal(logs.relativePath(ROOT, file('a/b.js')), 'a/b.js');
  const outside = path.resolve('/elsewhere/c.js');
  assert.equal(logs.relativePath(ROOT, outside), outside);
});

test('listLogs lists newest first, and clearLogs deletes each log with its .txt, and the names', (t) => {
  const dir = copyFixture(t, 'app');
  const folder = path.join(dir, '.jstrace', 'logs');
  assert.deepEqual(logs.listLogs(folder), [], 'no folder, no logs');
  fs.mkdirSync(folder, { recursive: true });
  for (const name of ['2026-01-01T00-00-00.000Z-1', '2026-02-01T00-00-00.000Z-2']) {
    fs.writeFileSync(path.join(folder, `${name}.jsonl`), '');
    fs.writeFileSync(path.join(folder, `${name}.txt`), '');
  }
  fs.writeFileSync(path.join(folder, 'notes.md'), '');
  assert.deepEqual(logs.listLogs(folder).map((log) => path.basename(log)), ['2026-02-01T00-00-00.000Z-2.jsonl', '2026-01-01T00-00-00.000Z-1.jsonl']);
  logs.setName(logs.listLogs(folder)[0], 'server');
  assert.equal(logs.clearLogs(folder), 2);
  assert.deepEqual(fs.readdirSync(folder), ['notes.md']);
});

test('deleteLog deletes one log with its .txt, and only its name', (t) => {
  const dir = copyFixture(t, 'app');
  const folder = path.join(dir, '.jstrace', 'logs');
  fs.mkdirSync(folder, { recursive: true });
  const [one, two] = ['2026-01-01T00-00-00.000Z-1', '2026-02-01T00-00-00.000Z-2'].map((name) => path.join(folder, `${name}.jsonl`));
  for (const log of [one, two]) {
    fs.writeFileSync(log, '');
    fs.writeFileSync(logs.textOf(log), '');
    logs.setName(log, path.basename(log));
  }
  logs.deleteLog(one);
  assert.deepEqual(fs.readdirSync(folder).sort(), [path.basename(two), path.basename(logs.textOf(two)), 'names.json']);
  assert.deepEqual(logs.readNames(folder), { [path.basename(two)]: path.basename(two) });
  logs.deleteLog(two);
  logs.deleteLog(two); // gone already
  assert.deepEqual(logs.readNames(folder), {});
});

test('processes are named in their log folder, by default after their script', (t) => {
  const dir = copyFixture(t, 'app');
  const folder = path.join(dir, '.jstrace', 'logs');
  fs.mkdirSync(folder, { recursive: true });
  const log = path.join(folder, '2026-01-01T00-00-00.000Z-1.jsonl');
  assert.deepEqual(logs.readNames(folder), {});
  logs.setName(log, 'server');
  assert.deepEqual(logs.readNames(folder), { '2026-01-01T00-00-00.000Z-1.jsonl': 'server' });
  logs.setName(log, '');
  assert.deepEqual(logs.readNames(folder), {});
  assert.equal(logs.defaultName(logs.parseLog(LOG), log), 'app');
  assert.equal(logs.defaultName(logs.parseLog(''), log), '2026-01-01T00-00-00.000Z-1', 'without a script, the log file');
});

test('merging logs interleaves their processes by time, renumbered, each event marked with its process', () => {
  const lines = (/** @type {object[]} */ ...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  const call = (/** @type {number} */ id, /** @type {number | null} */ parent, /** @type {string} */ name, /** @type {number} */ time, args = {}) =>
    ({ type: 'call', id, parent, depth: parent === null ? 0 : 1, name, file: file('lib.js'), line: id, column: 0, args, time });
  const server = lines(
    { type: 'start', pid: 10, argv: ['node', file('server.js')], cwd: ROOT, started: '2026-01-01T00:00:00.000Z', time: 0 },
    { type: 'load', id: 1, parent: null, depth: 0, file: file('server.js'), time: 0.5 },
    call(2, 1, 'send', 1, { msg: 'hi' }),
    { type: 'return', call: 2, parent: 2, value: true, time: 2 },
    call(3, null, 'onReply', 10, { msg: 'ok' }),
    { type: 'return', call: 3, parent: 3, time: 11 },
    { ...call(4, null, 'tick', 12), line: 1 },
    { type: 'return', call: 4, parent: 4, time: 12 },
  );
  const client = lines(
    { type: 'start', pid: 20, argv: ['node', file('client.js')], cwd: ROOT, started: '2026-01-01T00:00:00.003Z', time: 0 },
    { type: 'load', id: 1, parent: null, depth: 0, file: file('client.js'), time: 0 },
    call(2, null, 'onMessage', 2, { msg: 'hi' }),
    call(3, 2, 'reply', 3),
    { type: 'return', call: 3, parent: 3, time: 4 },
    { type: 'return', call: 2, parent: 2, time: 4.5 },
    { ...call(4, null, 'tick', 6.5), line: 1 },
    { type: 'return', call: 4, parent: 4, time: 6.5 },
  );
  const { jsonl, txt } = logs.mergeLogs([
    { file: file('.jstrace/logs/a-10.jsonl'), text: server, name: 'server' },
    { file: file('.jstrace/logs/b-20.jsonl'), text: client + '{"type":"ca', name: 'client' },
  ], ROOT);
  const trace = logs.parseLog(jsonl);
  assert.deepEqual(trace.start?.merged.map((/** @type {any} */ proc) => [proc.name, proc.pid, proc.file]), [['server', 10, 'a-10.jsonl'], ['client', 20, 'b-20.jsonl']]);
  assert.equal(logs.logLabel(trace, 'x.jsonl', ROOT), 'merged: server + client');
  assert.match(logs.logDescription(trace), /  pids 10, 20$/);
  assert.equal(logs.isRunning(trace, Date.now()), false);
  assert.deepEqual(trace.roots.map((node) => logs.nodeLabel(node, ROOT)), [
    'server 10 › load server.js',
    'client 20 › load client.js',
    'client 20 › onMessage(msg: "hi")',
    'client 20 › tick()',
    'server 10 › onReply(msg: "ok")',
    'server 10 › tick()',
  ]);
  const [, , onMessage] = trace.roots;
  assert.deepEqual([onMessage.event.id, onMessage.event.time, onMessage.children[0].event.id, onMessage.children[0].event.parent], [4, 5, 5, 4]);
  assert.equal(logs.nodeDescription(trace.roots[4]), '← undefined');
  assert.deepEqual(logs.rows(trace.roots, [], 2).map((row) => row.kind), ['node', 'node', 'node', 'node', 'node', 'node'], "two processes' calls are never one group");
  assert.deepEqual(logs.search(trace, 'client hi', ROOT).map((node) => node.event.id), [4]);
  assert.deepEqual(txt.trim().split('\n'), [
    'jstrace: 2 processes merged: server (pid 10), client (pid 20)',
    'server 10 │ load server.js',
    'server 10 │   send(msg: "hi") #2  lib.js:2',
    'server 10 │     ← true',
    'client 20 │ load client.js',
    'client 20 │ onMessage(msg: "hi") #4  lib.js:2',
    'client 20 │   reply() #5  lib.js:3',
    'client 20 │     ← undefined',
    'client 20 │   ← undefined',
    'client 20 │ tick() #6  lib.js:1',
    'client 20 │   ← undefined',
    'server 10 │ onReply(msg: "ok") #7  lib.js:3',
    'server 10 │   ← undefined',
    'server 10 │ tick() #8  lib.js:1',
    'server 10 │   ← undefined',
  ]);
  assert.throws(() => logs.mergeLogs([{ file: file('empty.jsonl'), text: '', name: 'x' }], ROOT), /empty\.jsonl has no start/);
});

test("the app fixture's real logs parse into complete trees", (t) => {
  const dir = copyFixture(t, 'app');
  assert.equal(main(['instrument', '.'], { out() {}, err() {} }, dir), 0);
  execFileSync(process.execPath, ['index.js'], { cwd: dir });
  const found = logs.listLogs(path.join(dir, '.jstrace', 'logs')).map((file) => ({ file, trace: logs.readLog(file) }));
  assert.deepEqual(found.map(({ file, trace }) => logs.logLabel(trace, file, dir)).sort(), ['child.js 4', 'index.js']);
  for (const { trace } of found) {
    const calls = [...trace.nodes.values()].filter((node) => node.event.type === 'call');
    assert.ok(calls.length > 0);
    for (const node of calls) assert.ok(node.outcome, `${node.event.name} #${node.event.id} ended`);
  }
  const app = found.find(({ trace }) => trace.start?.argv.length === 2)?.trace;
  const double = [...(app?.nodes.values() ?? [])].find((node) => node.event.name === 'double');
  assert.ok(double && double.resumes.length > 0);
  assert.equal(logs.nodeDescription(double), '← 2');
});
