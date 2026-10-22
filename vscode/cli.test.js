'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { copyFixture } = require('../test/helpers');
const { cliCommand, runCli } = require('./cli');

const BUNDLED = path.join(__dirname, '..', 'cli', 'bin', 'jstrace.js');

test('cliCommand takes the setting, else the CLI in this repo, else jstrace on the PATH', (t) => {
  assert.deepEqual(cliCommand('', __dirname), { file: process.execPath, args: [path.resolve(BUNDLED)], node: true });
  const elsewhere = copyFixture(t, 'app');
  assert.deepEqual(cliCommand('', elsewhere), { file: 'jstrace', args: [], node: false });
  assert.deepEqual(cliCommand(' tools/jstrace.js ', elsewhere), { file: process.execPath, args: ['tools/jstrace.js'], node: true });
  assert.deepEqual(cliCommand('jstrace', __dirname), { file: 'jstrace', args: [], node: false });
});

test('runCli instruments and restores a project, with what the CLI said', async (t) => {
  const dir = copyFixture(t, 'app');
  const command = cliCommand('', __dirname);
  const instrumented = await runCli(command, ['instrument', 'lib', 'index.js'], dir);
  assert.equal(instrumented.code, 0, instrumented.stderr);
  assert.match(instrumented.stdout, /Instrumented 5 files, skipped 1/);
  assert.match(instrumented.stderr, /lib\/esm\.js: skipped/);

  fs.appendFileSync(path.join(dir, 'lib', 'math.js'), '\n// edited\n');
  const restored = await runCli(command, ['restore'], dir);
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, /Restored 4 files, left 1 as they are/);
  assert.match(restored.stderr, /lib\/math\.js: changed since it was instrumented/);
});

test('runCli reports a CLI that fails or is missing', async (t) => {
  const dir = copyFixture(t, 'app');
  const failed = await runCli(cliCommand('', __dirname), ['instrument', 'nowhere'], dir);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /nowhere/);
  const missing = await runCli(cliCommand('jstrace-no-such-program', dir), ['restore'], dir);
  assert.notEqual(missing.code, 0);
  assert.notEqual(missing.stderr, '');
});

test('runCli passes arguments with spaces to a program on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = copyFixture(t, 'app');
  const program = path.join(dir, 'echo args.cmd');
  fs.writeFileSync(program, `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
  const result = await runCli(cliCommand(program, dir), ['a b', 'c'], dir);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['a b', 'c']);
});
