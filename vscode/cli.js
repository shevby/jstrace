'use strict';

/**
 * Running the `jstrace` CLI from the extension (setting `jstrace.cliPath`). Nothing here
 * needs `vscode`, so it's tested with plain `node --test`.
 */

const { exec, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * How to start the CLI.
 * @typedef {object} CliCommand
 * @property {string} file the program to run
 * @property {string[]} args the arguments that come before the CLI's own
 * @property {boolean} node whether `file` is a script run with Node
 */

/**
 * What a CLI run gave back.
 * @typedef {object} CliResult
 * @property {number} code its exit code (1 when it couldn't be started)
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Where the CLI is: the setting when given (a `.js`/`.cjs` script runs with Node, anything
 * else as a program, such as `jstrace` on the PATH; a relative path is taken from the
 * project), else the CLI packed in the extension (see `pack.js`), else the `cli/` next to
 * it in this repo (found through a symlink too), else `jstrace` on the PATH.
 * @param {string} setting `jstrace.cliPath`, empty for the default
 * @param {string} extensionDir the extension's folder
 * @returns {CliCommand}
 */
function cliCommand(setting, extensionDir) {
  setting = setting.trim();
  if (setting === '') {
    let dir = extensionDir;
    try {
      dir = fs.realpathSync(extensionDir);
    } catch {}
    for (const bundled of [path.join(dir, 'cli', 'bin', 'jstrace.js'), path.join(dir, '..', 'cli', 'bin', 'jstrace.js')]) {
      if (fs.existsSync(bundled)) return { file: process.execPath, args: [bundled], node: true };
    }
    setting = 'jstrace';
  }
  if (/\.c?js$/i.test(setting)) return { file: process.execPath, args: [setting], node: true };
  return { file: setting, args: [], node: false };
}

/**
 * Quotes an argument for `cmd.exe`, which runs a program named by the setting on Windows
 * (where `jstrace` on the PATH is a `.cmd` file).
 * @param {string} arg
 * @returns {string}
 */
function quote(arg) {
  return /^[\w\-.\\/:=]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Runs the CLI. A Node script runs with the Node that runs this code, which in VSCode is
 * its Electron, made to act as plain Node by `ELECTRON_RUN_AS_NODE`.
 * @param {CliCommand} command
 * @param {string[]} args the CLI's arguments (`instrument <path...>`, `restore`)
 * @param {string} cwd the folder it runs in, which decides the project
 * @returns {Promise<CliResult>}
 */
function runCli(command, args, cwd) {
  const all = [...command.args, ...args];
  const options = {
    cwd,
    env: command.node ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
    windowsHide: true,
    encoding: /** @type {const} */ ('utf8'),
  };
  return new Promise((resolve) => {
    /**
     * @param {any} error
     * @param {string} stdout
     * @param {string} stderr
     */
    const done = (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      const message = error && typeof error.code !== 'number' ? `Couldn't run ${command.file}: ${error.message}` : '';
      resolve({ code, stdout, stderr: [stderr, message].filter(Boolean).join('\n') });
    };
    if (!command.node && process.platform === 'win32') {
      exec([command.file, ...all].map(quote).join(' '), options, done);
    } else {
      execFile(command.file, all, options, done);
    }
  });
}

module.exports = { cliCommand, runCli };
