'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli/src/cli');
const { APP_OUTPUT, FIXTURES, copyFixture, readLogs } = require('./helpers');

/** @type {import('../cli/src/cli').Output} */
const quiet = { out() {}, err() {} };

/**
 * The files under a folder, relative to it with `/`.
 * @param {string} dir
 * @returns {string[]}
 */
function filesIn(dir) {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => fs.statSync(path.join(dir, file)).isFile())
    .map((file) => file.replaceAll('\\', '/'))
    .sort();
}

test('the instrumented app logs both its processes, and restore brings back the originals', (t) => {
  const dir = copyFixture(t, 'app');
  assert.equal(main(['instrument', '.'], quiet, dir), 0);
  assert.equal(execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' }), APP_OUTPUT);

  const logs = path.join(dir, '.jstrace', 'logs');
  assert.equal(fs.readdirSync(logs).length, 4);
  const found = readLogs(logs);
  const app = found.find((log) => log.events[0].argv.length === 2);
  const child = found.find((log) => log.events[0].argv.length === 3);
  assert.ok(app && child);
  /**
   * @param {import('./helpers').Log} log
   * @param {string} name
   */
  const calls = (log, name) => log.events.filter((event) => event.type === 'call' && event.name === name);
  /**
   * @param {import('./helpers').Log} log
   * @param {number} id
   */
  const end = (log, id) => log.events.find((event) => (event.type === 'return' || event.type === 'throw') && event.call === id);
  /** @param {import('./helpers').Log} log */
  const loads = (log) => log.events.filter((event) => event.type === 'load').map((event) => event.file);

  assert.deepEqual(loads(app), [
    'index.js', 'lib/math.js', 'lib/shapes.js', 'lib/tasks.js', 'lib/util.cjs', 'node_modules/greeter/index.js', // not *.min.js
  ]);
  assert.deepEqual(loads(child), ['child.js', 'lib/math.js']);

  for (const log of [app, child]) {
    const nodes = new Set();
    assert.deepEqual(log.events[log.events.length - 1], { type: 'end', code: 0, time: log.events[log.events.length - 1].time }, `${log.name}: the process ended`);
    for (const event of log.events.slice(1, -1)) {
      if (event.parent !== null) assert.ok(nodes.has(event.parent), `${log.name}: ${JSON.stringify(event)} is inside a node not seen yet`);
      if (event.id !== undefined) nodes.add(event.id);
    }
    const ends = log.events.filter((event) => event.type === 'return' || event.type === 'throw').map((event) => event.call);
    const ids = log.events.filter((event) => event.type === 'call').map((event) => event.id);
    assert.deepEqual([...ends].sort((a, b) => a - b), ids, `${log.name}: every call ends once`);
  }

  const [main_] = calls(app, 'main');
  const factorials = calls(app, 'factorial');
  assert.deepEqual(factorials.map((event) => event.args.n), [5, 4, 3, 2, 1]);
  assert.deepEqual(factorials.map((event) => event.parent), [main_.id, ...factorials.slice(0, -1).map((event) => event.id)]);
  assert.equal(end(app, factorials[0].id)?.value, 120);

  const [safeDivide] = calls(app, 'safeDivide');
  const [divide] = calls(app, 'divide');
  assert.equal(divide.parent, safeDivide.id);
  assert.deepEqual(end(app, divide.id)?.error, '[Error: division by zero]');
  assert.deepEqual(end(app, safeDivide.id)?.value, 'failed: division by zero');

  const [total] = calls(app, 'total');
  const resumes = app.events.filter((event) => event.type === 'resume' && event.call === total.id);
  assert.equal(resumes.length, 3);
  assert.ok(resumes.every((event) => event.parent === null && event.depth === 0 && event.line === 13));
  assert.equal(end(app, total.id)?.parent, resumes[2].id);

  const [ids] = calls(app, 'ids');
  assert.deepEqual(app.events.filter((event) => event.type === 'yield' && event.call === ids.id).map((event) => event.value), ['id1', 'id2', 'id3']);

  const callback = app.events.find((event) => event.type === 'call' && event.name.startsWith('<anonymous@47:'));
  assert.equal(callback?.parent, calls(app, 'greet.each')[0].id);

  const [square] = calls(child, 'square');
  assert.deepEqual([square.args, end(child, square.id)?.value], [{ value: 4 }, 16]);

  /** @param {Record<string, any>} event */
  const site = (event) => event.site && `${event.site.file}:${event.site.line}`;
  assert.deepEqual(factorials.map(site), ['index.js:26', 'lib/math.js:8', 'lib/math.js:8', 'lib/math.js:8', 'lib/math.js:8']);
  assert.equal(site(callback ?? {}), 'node_modules/greeter/index.js:10', 'a callback was called by the function that ran it');
  const timer = app.events.filter((event) => event.type === 'call' && event.name.startsWith('<anonymous@6:66>'));
  assert.ok(timer.length > 0 && timer.every((event) => event.site === undefined), 'a timer callback has no site');
  assert.equal(site(square), 'child.js:11');

  const tree = app.tree.join('\n');
  assert.match(tree, /^( *)factorial\(n: 5\) #\d+  lib\/math\.js:7  \(from index\.js:26\)\n\1  factorial\(n: 4\) #\d+  lib\/math\.js:7  \(from lib\/math\.js:8\)$/m);
  assert.match(tree, /^↻ total\(\) #\d+ resumed  lib\/tasks\.js:13$/m);
  assert.match(tree, /^ +Shape->set scale\(value: 2\) #\d+  lib\/shapes\.js:18  \(from index\.js:35\)$/m);
  assert.match(tree, /^<anonymous@6:66>\(\) #\d+  lib\/tasks\.js:6$/m);

  assert.equal(main(['restore'], quiet, dir), 0);
  const original = path.join(FIXTURES, 'app');
  const copied = filesIn(dir).filter((file) => !file.startsWith('.jstrace/') && file !== 'jstrace.config.json');
  assert.deepEqual(copied, filesIn(original));
  for (const file of copied) assert.ok(fs.readFileSync(path.join(dir, file)).equals(fs.readFileSync(path.join(original, file))), file);
  assert.equal(fs.readdirSync(logs).length, 4, 'logs stay');
});

test('JSTRACE_OUT sends the logs of a run elsewhere', (t) => {
  const dir = copyFixture(t, 'app');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jstrace-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  main(['instrument', '.'], quiet, dir);
  execFileSync(process.execPath, ['index.js'], { cwd: dir, env: { ...process.env, JSTRACE_OUT: out } });
  assert.equal(readLogs(out).length, 2);
  assert.ok(!fs.existsSync(path.join(dir, '.jstrace', 'logs')));
});
