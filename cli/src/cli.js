'use strict';

/**
 * The `jstrace` command line (see Architecture in CLAUDE.md). Arguments are parsed by hand,
 * as acorn is the only dependency.
 */

const path = require('node:path');
const { init, instrument, restore, reinject, createMock } = require('./commands');
const { findProject, projectAt } = require('./project');

const USAGE = `Usage:
  jstrace init                   create jstrace.config.json with the defaults, and .jstrace/,
                                 to configure tracing before instrumenting
  jstrace instrument <path...>   inject tracing into the files under the paths
  jstrace restore [path...]      put the original files back (all, or those under the paths)
  jstrace reinject               instrument again the paths instrumented since the last time
                                 all was restored (or, after that, until then)
  jstrace mock [file]            create a mock of what tracing uses (file writes, clock, …) from
                                 a template, jstrace.mock.js by default, and name it in the config
  jstrace help                   show this help

The project (where jstrace.config.json and .jstrace/ live) is the current folder, or the
nearest one above it that has either. To name it instead, put --project <folder> before
the command.`;

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
  const named = argv[0] === '--project' ? argv[1] : undefined;
  const [command, ...args] = argv[0] === '--project' ? argv.slice(2) : argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    output.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  /** @type {Record<string, typeof instrument>} */
  const commands = { init, instrument, restore, reinject, mock: createMock };
  if (!Object.hasOwn(commands, command)) {
    output.err(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (command === 'instrument' && args.length === 0) {
    output.err(`instrument takes the files or folders to instrument\n\n${USAGE}`);
    return 2;
  }
  if (command === 'init' && args.length > 0) {
    output.err(`init takes no arguments: it sets up the project in the current folder\n\n${USAGE}`);
    return 2;
  }
  if (command === 'reinject' && args.length > 0) {
    output.err(`reinject takes no arguments: it instruments the paths instrumented before\n\n${USAGE}`);
    return 2;
  }
  return commands[command](named === undefined ? findProject(cwd) : projectAt(path.resolve(cwd, named)), args, cwd, output);
}

module.exports = { main, USAGE };
