'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, filter } = require('./glob');
const { DEFAULTS } = require('./config');

/**
 * Asserts which paths a pattern matches.
 * @param {string} pattern
 * @param {string[]} yes
 * @param {string[]} no
 */
function matches(pattern, yes, no) {
  const re = compile(pattern);
  for (const path of yes) assert.ok(re.test(path), `${pattern} should match ${path}`);
  for (const path of no) assert.ok(!re.test(path), `${pattern} shouldn't match ${path}`);
}

test('* and ? stay within a segment', () => {
  matches('*.js', ['a.js', '.js'], ['a/b.js', 'a.cjs', 'a.jsx']);
  matches('lib/?.js', ['lib/a.js'], ['lib/ab.js', 'lib/.js', 'lib/a/b.js']);
});

test('** matches any number of segments, none included', () => {
  matches('**/*.js', ['a.js', 'a/b.js', 'a/b/c.js'], ['a.cjs', 'a/b.cjs']);
  matches('.git/**', ['.git/x', '.git/a/b', '.git/'], ['.gitignore', 'a/.git/x']);
  matches('a/**/b.js', ['a/b.js', 'a/x/b.js', 'a/x/y/b.js'], ['b.js', 'ab.js', 'a/xb.js']);
  matches('**', ['a', 'a/b'], []);
});

test('other characters match themselves', () => {
  matches('a+b(1).js', ['a+b(1).js'], ['aab1.js']);
  matches('**/*.min.js', ['x.min.js', 'lib/x.min.js'], ['xmin.js', 'x.js']);
});

test('the default filter', () => {
  const { file, directory } = filter(DEFAULTS.include, DEFAULTS.exclude);
  assert.ok(file('index.js'));
  assert.ok(file('lib/util.cjs'));
  assert.ok(file('node_modules/greeter/index.js'));
  assert.ok(!file('lib/vendor.min.js'));
  assert.ok(!file('lib/esm.mjs'));
  assert.ok(!file('.git/hooks/x.js'));
  assert.ok(!directory('.git'));
  assert.ok(!directory('.jstrace'));
  assert.ok(directory('node_modules'));
  assert.ok(directory('lib'));
});
