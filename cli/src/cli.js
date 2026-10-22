'use strict';

/**
 * The `jstrace` command line: `jstrace instrument <root>` and `jstrace restore <root>`
 * (see Architecture in CLAUDE.md). Arguments are parsed by hand, as acorn is the only
 * dependency.
 */

const path = require('node:path');

const USAGE = `Usage:
  jstrace instrument <root>   inject tracing into the files under <root>
  jstrace restore <root>      put the original files back
  jstrace help                show this help`;

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
 * @returns {number} the exit code: 0 on success, 1 when the command failed, 2 for a wrong command line
 */
function main(argv, output = consoleOutput) {
  const [command, ...args] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    output.out(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command !== 'instrument' && command !== 'restore') {
    output.err(`Unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  if (args.length !== 1) {
    output.err(`${command} takes one argument, the root folder\n\n${USAGE}`);
    return 2;
  }
  const root = path.resolve(args[0]);
  output.err(`${command} ${root}: not implemented yet`);
  return 1;
}

module.exports = { main, USAGE };
