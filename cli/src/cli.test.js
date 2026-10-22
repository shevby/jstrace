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

test('instrument takes at least one path', () => {
  const { code, err } = run(['instrument']);
  assert.equal(code, 2);
  assert.match(err[0], /^instrument takes the files or folders/);
});
