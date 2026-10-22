'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, ConfigError, loadConfig } = require('./config');
const { findProject, projectAt, relative } = require('./project');

/**
 * A fresh temp directory, removed once the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstrace-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a missing config is created with the defaults', (t) => {
  const file = path.join(tempDir(t), 'jstrace.config.json');
  assert.deepEqual(loadConfig(file), { config: DEFAULTS, created: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), DEFAULTS);
  assert.deepEqual(loadConfig(file), { config: DEFAULTS, created: false });
});

test('fields left out take their defaults', (t) => {
  const file = path.join(tempDir(t), 'jstrace.config.json');
  fs.writeFileSync(file, '{ "maxDepth": 5, "exclude": [] }');
  assert.deepEqual(loadConfig(file).config, { ...DEFAULTS, maxDepth: 5, exclude: [] });
});

test('mistakes fail with a message naming the field', (t) => {
  const file = path.join(tempDir(t), 'jstrace.config.json');
  /** @type {[string, RegExp][]} */
  const cases = [
    ['{', /jstrace\.config\.json: .*JSON/],
    ['[]', /must be an object/],
    ['{ "include": "**/*.js" }', /"include" must be an array/],
    ['{ "maxDepth": -1 }', /"maxDepth" must be a whole number/],
    ['{ "maxRepeat": 1.5 }', /"maxRepeat" must be a whole number/],
    ['{ "maxLines": 10 }', /unknown field "maxLines"/],
  ];
  for (const [text, message] of cases) {
    fs.writeFileSync(file, text);
    assert.throws(() => loadConfig(file), (error) => error instanceof ConfigError && message.test(error.message), text);
  }
});

test('the project is the nearest folder up with a config or .jstrace/, else the start', (t) => {
  const dir = tempDir(t);
  const deep = path.join(dir, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findProject(deep).dir, deep);
  fs.mkdirSync(path.join(dir, 'a', '.jstrace'));
  assert.equal(findProject(deep).dir, path.join(dir, 'a'));
  fs.writeFileSync(path.join(deep, 'jstrace.config.json'), '{}');
  assert.equal(findProject(deep).dir, deep);
});

test('paths relative to the project', () => {
  const project = projectAt(path.resolve('/p'));
  assert.equal(relative(project, path.resolve('/p/lib/a.js')), 'lib/a.js');
  assert.equal(relative(project, path.resolve('/p')), '');
  assert.equal(relative(project, path.resolve('/q/a.js')), null);
  assert.equal(relative(project, path.resolve('/p/.jstrace/logs')), null);
  assert.equal(relative(project, path.resolve('/p/.jstracex/a.js')), '.jstracex/a.js');
});
