'use strict';

/**
 * Shared test helpers. Tests work on copies in temp directories and never touch the
 * fixtures themselves.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The folder holding the fixture projects. */
const FIXTURES = path.join(__dirname, 'fixtures');

/** What the app fixture prints, uninstrumented. Instrumenting must not change it. */
const APP_OUTPUT = `Hello, jstrace!
factorial(5) = 120
sum = 6
safeDivide = failed: division by zero
counter = 2
describe = 0.5/1
circle: 3.14
square: 4.00
scaled = square: 16.00
largest = square
label = CIRCLE
total = 12
all = 2,4,6
ids = id1,id2,id3
later = DONE
child = 16 6
..end
hello-world
0:a 1:b
`;

/**
 * Copies a fixture project into a fresh temp directory, removed once the test ends.
 * @param {import('node:test').TestContext} t the test that uses the copy
 * @param {string} name the fixture's folder in `test/fixtures`
 * @returns {string} the copy's absolute path
 */
function copyFixture(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `jstrace-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/**
 * One process's log, as the runtime wrote it.
 * @typedef {object} Log
 * @property {string} name the `.jsonl` file's name
 * @property {Record<string, any>[]} events its events, the `start` header first
 * @property {string[]} tree the lines of the `.txt` next to it
 */

/**
 * Reads the logs in a folder, oldest first.
 * @param {string} folder
 * @returns {Log[]}
 */
function readLogs(folder) {
  return fs
    .readdirSync(folder)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => ({
      name,
      events: fs.readFileSync(path.join(folder, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line)),
      tree: fs.readFileSync(path.join(folder, name.replace(/\.jsonl$/, '.txt')), 'utf8').trim().split('\n'),
    }));
}

module.exports = { FIXTURES, APP_OUTPUT, copyFixture, readLogs };
