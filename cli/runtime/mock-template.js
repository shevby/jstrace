'use strict';

// A jstrace mock: what the injected tracing code uses from its environment, put in its
// place. Use it to trace where something is missing (no `fs`, no `process`), to send the
// logs somewhere else, or to make them the same on every run.
//
// The config's "mock" names this file (`jstrace mock` set it), so tracing loads it before
// anything is logged; instrument again after changing that. Instead, a program can set
// `globalThis.__jstraceMock` to such an object before its first instrumented file runs.
//
// Uncomment and change what you need: every member is optional, and what's left out works
// as usual. This file is never instrumented, and its functions run with tracing off. One
// that throws is used no more (jstrace says so), and the usual one takes over. Don't
// require instrumented files from here: they'd load before tracing is ready.
// See "Mocking the runtime" in jstrace's README.md.

// Logs kept in memory, for the `fs` example below.
// const files = [];

module.exports = {
  // Writes the logs: these three are the only file calls jstrace makes (it reads none).
  // Logs are opened to append ('a'), readable by the user only (mode 0o600, the folder
  // 0o700), and written a whole line at a time.
  // fs: {
  //   mkdirSync(path, options) {},
  //   openSync(path, flags, mode) {
  //     return files.push({ path, text: '' }) - 1;
  //   },
  //   writeSync(fd, text) {
  //     files[fd].text += text;
  //   },
  // },

  // An environment variable: only JSTRACE_OUT (a folder for the logs) is read.
  // env(name) {
  //   return name === 'JSTRACE_OUT' ? '/tmp/jstrace-logs' : undefined;
  // },

  // The process's id: in the log's file name and its start event.
  // pid() {
  //   return 1;
  // },

  // The command line, [runtime, script, ...arguments]: the log's label shows the script
  // and its arguments.
  // argv() {
  //   return ['node', `${__dirname}/index.js`];
  // },

  // The working folder, in the start event.
  // cwd() {
  //   return __dirname;
  // },

  // A clock in milliseconds, for the events' times: only the differences between its
  // readings count.
  // now() {
  //   return Date.now();
  // },

  // When the process started: the log's file name and its start event.
  // date() {
  //   return new Date('2026-01-01T00:00:00Z');
  // },

  // Where the call starting now was made, as { file, line } (an absolute path; line from 1),
  // or null for unknown. Usually read from a V8 stack trace; return null to leave call
  // sites out, or read them some other way on an engine with other stack traces.
  // site() {
  //   return null;
  // },

  // Calls the listener once, as the program ends, with its exit code: the calls skipped at
  // the top level (past maxRepeat) are logged then, and that the program ended.
  // onExit(listener) {
  //   process.once('exit', listener);
  // },

  // Where jstrace's own messages go, like logs it can't write.
  // warn(message) {
  //   console.error(message);
  // },
};
