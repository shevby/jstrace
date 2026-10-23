'use strict';

/**
 * Running the `jstrace` CLI from the extension: always its own, packed in it (or the repo's,
 * beside it), with VSCode's own Node. Nothing here needs `vscode`, so it's tested with plain
 * `node --test`.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * What a CLI run gave back.
 * @typedef {object} CliResult
 * @property {number} code its exit code (1 when it couldn't be started)
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Where the CLI is: packed in the extension (see `pack.js`), else the `cli/` next to it in
 * this repo (found through a symlink too).
 * @param {string} extensionDir the extension's folder
 * @returns {string | undefined} its script, or nothing when neither is there
 */
function cliScript(extensionDir) {
  let dir = extensionDir;
  try {
    dir = fs.realpathSync(extensionDir);
  } catch {}
  return [path.join(dir, 'cli', 'bin', 'jstrace.js'), path.join(dir, '..', 'cli', 'bin', 'jstrace.js')].find((file) => fs.existsSync(file));
}

/**
 * Runs the CLI with the Node that runs this code, which in VSCode is its Electron, made to
 * act as plain Node by `ELECTRON_RUN_AS_NODE`.
 * @param {string} extensionDir the extension's folder, where `cliScript` looks
 * @param {string[]} args the CLI's arguments (`instrument <path...>`, `restore`)
 * @param {string} cwd the folder it runs in, which decides the project
 * @returns {Promise<CliResult>}
 */
function runCli(extensionDir, args, cwd) {
  const script = cliScript(extensionDir);
  if (!script) return Promise.resolve({ code: 1, stdout: '', stderr: `jstrace's CLI isn't in the extension (${extensionDir}): package it again with npm run package` });
  const options = { cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: /** @type {const} */ ('utf8') };
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], options, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      const message = error && typeof error.code !== 'number' ? `Couldn't run ${script}: ${error.message}` : '';
      resolve({ code, stdout, stderr: [stderr, message].filter(Boolean).join('\n') });
    });
  });
}

module.exports = { cliScript, runCli };
