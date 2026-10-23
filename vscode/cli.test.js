'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { copyFixture } = require('../test/helpers');
const { cliScript, runCli } = require('./cli');

const BUNDLED = path.join(__dirname, '..', 'cli', 'bin', 'jstrace.js');

test('cliScript finds the CLI packed in the extension, or in this repo beside it', (t) => {
  assert.equal(cliScript(__dirname), path.resolve(BUNDLED));
  const packed = copyFixture(t, 'app');
  fs.mkdirSync(path.join(packed, 'cli', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packed, 'cli', 'bin', 'jstrace.js'), '');
  assert.equal(cliScript(packed), path.join(fs.realpathSync(packed), 'cli', 'bin', 'jstrace.js'));
  assert.equal(cliScript(path.join(packed, 'node_modules', 'greeter')), undefined);
});

test('runCli instruments and restores a project, with what the CLI said', async (t) => {
  const dir = copyFixture(t, 'app');
  const instrumented = await runCli(__dirname, ['instrument', 'lib', 'index.js'], dir);
  assert.equal(instrumented.code, 0, instrumented.stderr);
  assert.match(instrumented.stdout, /Instrumented 5 files, skipped 1/);
  assert.match(instrumented.stderr, /lib\/esm\.js: skipped/);

  fs.appendFileSync(path.join(dir, 'lib', 'math.js'), '\n// edited\n');
  const restored = await runCli(__dirname, ['restore'], dir);
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, /Restored 4 files, left 1 as they are/);
  assert.match(restored.stderr, /lib\/math\.js: changed since it was instrumented/);
});

test('runCli reports a CLI that fails or is missing, and passes arguments as they are', async (t) => {
  const dir = copyFixture(t, 'app');
  const failed = await runCli(__dirname, ['instrument', 'nowhere'], dir);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /nowhere/);
  const missing = await runCli(path.join(dir, 'node_modules', 'greeter'), ['restore'], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /CLI isn't in the extension/);
  const spaced = await runCli(__dirname, ['instrument', 'a b & "c"'], dir);
  assert.match(spaced.stderr, /a b & "c": no such file or folder/);
});
