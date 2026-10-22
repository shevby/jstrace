'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { main, USAGE } = require('./cli');

/**
 * Runs `main` and collects what it writes.
 * @param {string[]} argv
 * @returns {{ code: number, out: string[], err: string[] }}
 */
function run(argv) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = main(argv, { out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out, err };
}

test('help prints the usage and succeeds', () => {
  for (const argv of [['help'], ['--help'], ['-h']]) {
    const { code, out } = run(argv);
    assert.equal(code, 0);
    assert.deepEqual(out, [USAGE]);
  }
});

test('no command prints the usage as a wrong command line', () => {
  const { code, out } = run([]);
  assert.equal(code, 2);
  assert.deepEqual(out, [USAGE]);
});

test('an unknown command is a wrong command line', () => {
  const { code, err } = run(['trace']);
  assert.equal(code, 2);
  assert.match(err[0], /^Unknown command: trace/);
});

test('instrument and restore take exactly one folder', () => {
  for (const argv of [['instrument'], ['restore', 'a', 'b']]) {
    const { code, err } = run(argv);
    assert.equal(code, 2);
    assert.match(err[0], /takes one argument/);
  }
});
