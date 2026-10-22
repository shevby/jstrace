'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { FIXTURES, APP_OUTPUT, copyFixture } = require('./helpers');

test('the app fixture runs and prints what it should', (t) => {
  const dir = copyFixture(t, 'app');
  const stdout = execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' });
  assert.equal(stdout, APP_OUTPUT);
});

test('every file of the app fixture but esm.js parses as a script', () => {
  const app = path.join(FIXTURES, 'app');
  const files = fs
    .readdirSync(app, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.c?js$/.test(file))
    .map((file) => file.replaceAll('\\', '/'));
  assert.ok(files.includes('node_modules/greeter/index.js'));
  for (const file of files) {
    const source = fs.readFileSync(path.join(app, file), 'utf8');
    const parse = () => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    if (file === 'lib/esm.js') assert.throws(parse, SyntaxError, file);
    else assert.doesNotThrow(parse, file);
  }
});
