'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { copyFixture } = require('../test/helpers');
const { cliCommand, runCli } = require('./cli');
const { pack, crc32 } = require('./pack');

/**
 * Reads a zip file's entries back through its central directory.
 * @param {Buffer} zip
 * @returns {Map<string, Buffer>} each file's content by name
 */
function unzip(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(zip.subarray(start, start + size));
    assert.equal(crc32(data), zip.readUInt32LE(at + 16), name);
    files.set(name, data);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

test('crc32 gives the standard checksum', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the .vsix holds the extension and a CLI that runs from it', async (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jstrace-vsix-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const files = unzip(fs.readFileSync(pack(out)));
  for (const name of ['extension.vsixmanifest', '[Content_Types].xml', 'extension/package.json', 'extension/LICENSE', 'extension/extension.js', 'extension/media/jstrace.svg']) {
    assert.ok(files.has(name), name);
  }
  assert.ok(![...files.keys()].some((name) => name.endsWith('.test.js')), 'no tests');
  assert.equal(files.get('extension/package.json')?.toString(), fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  assert.match(files.get('extension.vsixmanifest')?.toString() ?? '', /Id="jstrace-vscode" Version="0\.1\.0" Publisher="local"/);

  const installed = path.join(out, 'installed');
  for (const [name, data] of files) {
    fs.mkdirSync(path.dirname(path.join(installed, name)), { recursive: true });
    fs.writeFileSync(path.join(installed, name), data);
  }
  const command = cliCommand('', path.join(installed, 'extension'));
  assert.deepEqual(command.args, [path.join(installed, 'extension', 'cli', 'bin', 'jstrace.js')]);
  const dir = copyFixture(t, 'app');
  const result = await runCli(command, ['instrument', 'lib/math.js'], dir);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Instrumented 1 file/);
});
