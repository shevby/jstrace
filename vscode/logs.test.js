'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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

test('relativePath keeps a path outside the project as it is', () => {
  assert.equal(logs.relativePath(ROOT, file('a/b.js')), 'a/b.js');
  const outside = path.resolve('/elsewhere/c.js');
  assert.equal(logs.relativePath(ROOT, outside), outside);
});

test('listLogs lists newest first, and clearLogs deletes each log with its .txt', (t) => {
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
  assert.equal(logs.clearLogs(folder), 2);
  assert.deepEqual(fs.readdirSync(folder), ['notes.md']);
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
