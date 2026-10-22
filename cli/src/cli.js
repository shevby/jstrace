'use strict';

/**
 * The `jstrace` command line (see Architecture in CLAUDE.md). Arguments are parsed by hand,
 * as acorn is the only dependency.
 */

const { instrument, restore, createMock } = require('./commands');
const { findProject } = require('./project');

const USAGE = `Usage:
  jstrace instrument <path...>   inject tracing into the files under the paths
  jstrace restore [path...]      put the original files back (all, or those under the paths)
  jstrace mock [file]            create a mock of what tracing uses (file writes, clock, …) from
                                 a template, jstrace.mock.js by default, and name it in the config
  jstrace help                   show this help

The project (where jstrace.config.json and .jstrace/ live) is the current folder, or the
nearest one above it that has either.`;

/**
 * Where the CLI writes: stdout for results, stderr for problems. Tests pass their own.
 * @typedef {object} Output
 * @property {(text: string) => void} out
 * @property {(text: string) => void} err
 */

/** @type {Output} */
const consoleOutput = {
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
};

/**
 * Runs a command line.
 * @param {string[]} argv the arguments after the script name
 * @param {Output} [output] where to write messages
 * @param {string} [cwd] the folder it runs in
 * @returns {number} the exit code: 0 on success, 1 when the command failed, 2 for a wrong command line
 */
function main(argv, output = consoleOutput, cwd = process.cwd()) {
  const [command, ...args] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    output.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== 'instrument' && command !== 'restore' && command !== 'mock') {
    output.err(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (command === 'instrument' && args.length === 0) {
    output.err(`instrument takes the files or folders to instrument\n\n${USAGE}`);
    return 2;
  }
  const project = findProject(cwd);
  return (command === 'instrument' ? instrument : command === 'restore' ? restore : createMock)(project, args, cwd, output);
}

module.exports = { main, USAGE };
