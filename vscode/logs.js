'use strict';

/**
 * Reading the runtime's `.jsonl` logs into call trees, and the text the tree view shows for
 * them (see Architecture → Events in CLAUDE.md). Nothing here needs `vscode`, so it's tested
 * with plain `node --test`.
 */

const fs = require('node:fs');
const path = require('node:path');

/** How long a call's label may get before its arguments are cut. */
const MAX_LABEL = 120;

/**
 * One node of a call tree: a file loading, a call, or an async function or generator going
 * on after a suspension.
 * @typedef {object} TraceNode
 * @property {Record<string, any>} event its `load`, `call` or `resume` event
 * @property {TraceNode | undefined} parent the node it ran in, `undefined` for a root
 * @property {TraceNode[]} children the nodes that ran in it, in order
 * @property {Record<string, any>} [end] the `return`, `throw` or `yield` that ended this node
 * @property {Record<string, any>} [outcome] for a call, its `return` or `throw`, wherever it happened
 * @property {TraceNode[]} resumes for a call, the nodes it went on in after suspending
 */

/**
 * A parsed log.
 * @typedef {object} Trace
 * @property {Record<string, any> | undefined} start its `start` event, missing for an empty log
 * @property {TraceNode[]} roots the nodes with no parent, in order
 * @property {Map<number, TraceNode>} nodes every node by id
 */

/**
 * Builds the call trees of a log. A line that isn't JSON (one being written, or cut short by
 * a crash) is skipped.
 * @param {string} text the `.jsonl` file's content
 * @returns {Trace}
 */
function parseLog(text) {
  /** @type {Trace} */
  const trace = { start: undefined, roots: [], nodes: new Map() };
  for (const line of text.split('\n')) {
    /** @type {Record<string, any>} */
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'start') {
      trace.start = event;
    } else if (event.type === 'load' || event.type === 'call' || event.type === 'resume') {
      const parent = event.parent === null ? undefined : trace.nodes.get(event.parent);
      /** @type {TraceNode} */
      const node = { event, parent, children: [], resumes: [] };
      trace.nodes.set(event.id, node);
      (parent ? parent.children : trace.roots).push(node);
      if (event.type === 'resume') trace.nodes.get(event.call)?.resumes.push(node);
    } else if (event.type === 'return' || event.type === 'throw' || event.type === 'yield') {
      const node = trace.nodes.get(event.parent);
      if (node) node.end = event;
      const call = trace.nodes.get(event.call);
      if (call && event.type !== 'yield') call.outcome = event;
    }
  }
  return trace;
}

/**
 * Reads and parses a log file.
 * @param {string} file the `.jsonl` file
 * @returns {Trace}
 */
function readLog(file) {
  return parseLog(fs.readFileSync(file, 'utf8'));
}

/**
 * The logs in a folder, newest first (their names start with the process's start time).
 * @param {string} folder a project's `.jstrace/logs`
 * @returns {string[]} the `.jsonl` files' absolute paths, none if the folder is missing
 */
function listLogs(folder) {
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .reverse()
    .map((name) => path.join(folder, name));
}

/**
 * Deletes the logs in a folder, both the `.jsonl` and the `.txt` of each.
 * @param {string} folder a project's `.jstrace/logs`
 * @returns {number} how many logs (processes) were deleted
 */
function clearLogs(folder) {
  const logs = listLogs(folder);
  for (const file of logs) {
    fs.rmSync(file, { force: true });
    fs.rmSync(textOf(file), { force: true });
  }
  return logs.length;
}

/**
 * The readable tree written next to a log.
 * @param {string} file the `.jsonl` file
 * @returns {string} its `.txt`
 */
function textOf(file) {
  return file.replace(/\.jsonl$/, '.txt');
}

/**
 * A path shown relative to the project, with `/`, or as it is when it's outside.
 * @param {string} root the project folder
 * @param {string} file an absolute path
 * @returns {string}
 */
function relativePath(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel.replaceAll('\\', '/');
}

/**
 * A value as one line of JSON, the way the `.txt` tree shows it.
 * @param {any} value a value from an event (`undefined` when the event left it out)
 * @returns {string}
 */
function formatValue(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/**
 * A log's label: the script the process ran and its arguments, from its `argv`.
 * @param {Trace} trace
 * @param {string} file the `.jsonl` file, named when the log has no `start`
 * @param {string} root the project folder
 * @returns {string}
 */
function logLabel(trace, file, root) {
  const argv = trace.start?.argv;
  if (!Array.isArray(argv) || argv.length === 0) return path.basename(file);
  if (argv.length === 1) return path.basename(String(argv[0]));
  return [relativePath(root, String(argv[1])), ...argv.slice(2).map(String)].join(' ');
}

/**
 * A log's description: when the process started, and its pid.
 * @param {Trace} trace
 * @returns {string}
 */
function logDescription(trace) {
  const start = trace.start;
  if (!start) return '';
  const date = new Date(start.started);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const when = isNaN(date.getTime())
    ? String(start.started)
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${when}  pid ${start.pid}`;
}

/**
 * A node's label: `load file`, `name(param: value, …)` (cut at {@link MAX_LABEL}), or
 * `↻ name() resumed`.
 * @param {TraceNode} node
 * @param {string} root the project folder
 * @returns {string}
 */
function nodeLabel(node, root) {
  const event = node.event;
  if (event.type === 'load') return `load ${relativePath(root, event.file)}`;
  if (event.type === 'resume') return `↻ ${event.name}() resumed`;
  const args = Object.entries(event.args ?? {})
    .map(([name, value]) => `${name}: ${formatValue(value)}`)
    .join(', ');
  const label = `${event.name}(${args})`;
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 2)}…)` : label;
}

/**
 * How an event ended a node: `← value`, `← throws error`, or `← yields value`.
 * @param {Record<string, any>} event a `return`, `throw` or `yield`
 * @returns {string}
 */
function formatEnd(event) {
  if (event.type === 'throw') return `← throws ${formatValue(event.error)}`;
  if (event.type === 'yield') return `← yields ${formatValue(event.value)}`;
  return `← ${formatValue(event.value)}`;
}

/**
 * A node's description: what a call returned or threw in the end (even when that happened
 * in a later resume), or how a resume ended. Empty for a load, and for a node still running
 * or suspended when the log stopped.
 * @param {TraceNode} node
 * @returns {string}
 */
function nodeDescription(node) {
  const end = node.event.type === 'call' ? node.outcome ?? node.end : node.end;
  return end ? formatEnd(end) : '';
}

/**
 * A fenced Markdown code block that the content can't close early.
 * @param {string} content
 * @param {string} [language]
 * @returns {string}
 */
function codeBlock(content, language = 'json') {
  const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${content}\n${fence}`;
}

/**
 * A value pretty-printed for a hover.
 * @param {any} value
 * @returns {string}
 */
function prettyValue(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value, null, 2);
}

/**
 * A node's hover, in Markdown: where it is, its arguments, and how it ended.
 * @param {TraceNode} node
 * @param {string} root the project folder
 * @returns {string}
 */
function nodeTooltip(node, root) {
  const event = node.event;
  const where = event.type === 'load' ? relativePath(root, event.file) : `${relativePath(root, event.file)}:${event.line}`;
  const title = event.type === 'load' ? 'load' : event.type === 'resume' ? `↻ ${event.name}() resumed` : `${event.name}()`;
  const parts = [`**${title}** #${event.id}  \n${where}  \nat ${event.time} ms`];
  if (event.type === 'resume') parts.push(`Part of call #${event.call} (click to show it)`);
  if (event.type === 'call') {
    const args = event.args ?? {};
    if (Object.keys(args).length > 0) parts.push(`Arguments:\n\n${codeBlock(prettyValue(args))}`);
    if (node.resumes.length > 0) parts.push(`Resumed ${node.resumes.length} ${node.resumes.length === 1 ? 'time' : 'times'}`);
  }
  const end = event.type === 'call' ? node.outcome ?? node.end : node.end;
  if (end?.type === 'throw') parts.push(`Threw:\n\n${codeBlock(prettyValue(end.error))}`);
  else if (end?.type === 'yield') parts.push(`Yielded:\n\n${codeBlock(prettyValue(end.value))}`);
  else if (end) parts.push(`Returned:\n\n${codeBlock(prettyValue(end.value))}`);
  return parts.join('\n\n');
}

module.exports = {
  parseLog,
  readLog,
  listLogs,
  clearLogs,
  textOf,
  relativePath,
  formatValue,
  logLabel,
  logDescription,
  nodeLabel,
  nodeDescription,
  nodeTooltip,
};
