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
 * @property {TraceNode} [call] for a resume, the call it's a part of
 * @property {Record<string, any>[]} skips the `skip` events in it: calls past `maxRepeat`, not logged
 */

/**
 * A parsed log.
 * @typedef {object} Trace
 * @property {Record<string, any> | undefined} start its `start` event, missing for an empty log
 * @property {TraceNode[]} roots the nodes with no parent, in order
 * @property {Record<string, any>[]} skips the `skip` events with no parent
 * @property {Map<number, TraceNode>} nodes every node by id
 */

/**
 * A row of the tree under a node (or at the top of a log): a node, a group of the calls of
 * one function (or the resumes of its calls) there, or calls of a function that weren't logged.
 * @typedef {object} Row
 * @property {'node' | 'group' | 'skip'} kind
 * @property {Record<string, any>} event the node's; a group's first node's; a skip's `skip` event
 * @property {string} key what a group's nodes share, and a skip's function
 * @property {TraceNode} [node] a node's
 * @property {TraceNode[]} [nodes] a group's, in order
 * @property {Record<string, any>} [skip] a group's `skip` event, when calls of it weren't logged
 */

/**
 * Builds the call trees of a log. A line that isn't JSON (one being written, or cut short by
 * a crash) is skipped.
 * @param {string} text the `.jsonl` file's content
 * @returns {Trace}
 */
function parseLog(text) {
  /** @type {Trace} */
  const trace = { start: undefined, roots: [], skips: [], nodes: new Map() };
  appendLog(trace, text);
  return trace;
}

/**
 * Adds more of a log to its call trees, as `parseLog` builds them.
 * @param {Trace} trace
 * @param {string} text lines that follow those read already
 * @returns {void}
 */
function appendLog(trace, text) {
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
      const node = { event, parent, children: [], resumes: [], skips: [] };
      trace.nodes.set(event.id, node);
      (parent ? parent.children : trace.roots).push(node);
      if (event.type === 'resume') {
        node.call = trace.nodes.get(event.call);
        node.call?.resumes.push(node);
      }
    } else if (event.type === 'return' || event.type === 'throw' || event.type === 'yield') {
      const node = trace.nodes.get(event.parent);
      if (node) node.end = event;
      const call = trace.nodes.get(event.call);
      if (call && event.type !== 'yield') call.outcome = event;
    } else if (event.type === 'skip') {
      const node = event.parent === null ? undefined : trace.nodes.get(event.parent);
      (node ? node.skips : trace.skips).push(event);
    }
  }
}

/**
 * A log read so far: its trees, and how many bytes of it they hold.
 * @typedef {object} Tail
 * @property {Trace} trace
 * @property {number} offset where the next read starts: after the last complete line read
 */

/**
 * Reads what was added to a log since the last read, up to its last complete line (one the
 * program is still writing waits for the next read). A log that got shorter is read again
 * from the start, into a new trace.
 * @param {string} file the `.jsonl` file
 * @param {Tail} tail updated in place
 * @returns {boolean} whether anything was read
 * @throws when the file can't be read (it's gone)
 */
function readMore(file, tail) {
  const size = fs.statSync(file).size;
  if (size < tail.offset) {
    tail.trace = parseLog('');
    tail.offset = 0;
  }
  if (size === tail.offset) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - tail.offset);
    const read = fs.readSync(fd, buffer, 0, buffer.length, tail.offset);
    const end = buffer.lastIndexOf(10, read - 1); // the last '\n', so a character is never cut in two
    if (end < 0) return false;
    appendLog(tail.trace, buffer.toString('utf8', 0, end + 1));
    tail.offset += end + 1;
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether a log's process still runs: one with its pid exists, and the log changed lately
 * (so an old log whose pid was taken by another process doesn't look alive for long).
 * @param {Trace} trace
 * @param {number} modified when the log last changed, in ms since the epoch
 * @param {number} [now]
 * @returns {boolean}
 */
function isRunning(trace, modified, now = Date.now()) {
  const pid = trace.start?.pid;
  if (typeof pid !== 'number' || now - modified > 30 * 60 * 1000) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM'; // it exists, but isn't ours to signal
  }
}

/**
 * What the calls of one function share (its position), or the resumes of its calls.
 * @param {Record<string, any>} event a `call`, `resume` or `skip`
 * @returns {string} `''` for what's never grouped (a load)
 */
function groupKey(event) {
  if (event.type === 'load') return '';
  return `${event.type === 'resume' || event.resumes ? 'resume:' : ''}${event.file}:${event.line}:${event.column}`;
}

/**
 * The rows under a node: its children, with the calls of a function (or the resumes of its
 * calls) made at least `min` times there grouped into one row where the first one was, and
 * calls that weren't logged with their group, or else as a row of their own at the end.
 * @param {TraceNode[]} nodes the node's children (or a log's roots)
 * @param {Record<string, any>[]} skips its `skip` events
 * @param {number} min how many make a group; 0 for none
 * @returns {Row[]}
 */
function rows(nodes, skips, min) {
  /** @type {Map<string, TraceNode[]>} */
  const byKey = new Map();
  for (const node of nodes) {
    const key = groupKey(node.event);
    if (!key) continue;
    const same = byKey.get(key);
    if (same) same.push(node);
    else byKey.set(key, [node]);
  }
  const skipped = new Map(skips.map((event) => [groupKey(event), event]));
  /** @type {Row[]} */
  const result = [];
  /** @type {Set<string>} */
  const grouped = new Set();
  for (const node of nodes) {
    const key = groupKey(node.event);
    const same = byKey.get(key) ?? [];
    const skip = skipped.get(key);
    if (min > 0 && key && (same.length >= min || skip)) {
      if (grouped.has(key)) continue;
      grouped.add(key);
      skipped.delete(key);
      result.push({ kind: 'group', event: node.event, key, nodes: same, skip });
    } else {
      result.push({ kind: 'node', event: node.event, key, node });
    }
  }
  for (const [key, event] of skipped) result.push({ kind: 'skip', event, key });
  return result;
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
  if (event.site) parts.push(`Called from ${relativePath(root, event.site.file)}:${event.site.line}`);
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

/**
 * A group's label: `name() ×count` (calls not logged included), or `↻ name() resumed ×count`.
 * @param {Row} row a group
 * @returns {string}
 */
function groupLabel(row) {
  const count = (row.nodes?.length ?? 0) + (row.skip?.count ?? 0);
  return row.event.type === 'resume' ? `↻ ${row.event.name}() resumed ×${count}` : `${row.event.name}() ×${count}`;
}

/**
 * A group's description: how many of its calls weren't logged, and how many threw.
 * @param {Row} row a group
 * @returns {string}
 */
function groupDescription(row) {
  const threw = (row.nodes ?? []).filter((node) => nodeDescription(node).startsWith('← throws')).length;
  return [row.skip ? `${row.skip.count} not logged` : '', threw ? `${threw} threw` : ''].filter(Boolean).join(', ');
}

/**
 * A skip's label: `… name() ×count not logged`, or `… name() resumed ×count not logged`.
 * @param {Record<string, any>} event a `skip`
 * @returns {string}
 */
function skipLabel(event) {
  return `… ${event.name}()${event.resumes ? ' resumed' : ''} ×${event.count} not logged`;
}

/**
 * A group's or a skip's hover, in Markdown.
 * @param {Row} row
 * @param {string} root the project folder
 * @returns {string}
 */
function rowTooltip(row, root) {
  const event = row.event;
  const where = `${relativePath(root, event.file)}:${event.line}`;
  const why = 'past `maxRepeat` in `jstrace.config.json` (0 logs every call)';
  if (row.kind === 'skip') {
    const what = event.resumes ? 'resumed' : 'called';
    const note = event.resumes ? ' What ran in those parts is neither logged nor counted.' : '';
    return `**${event.name}()** ${what} ${event.count} more ${event.count === 1 ? 'time' : 'times'} here, not logged: ${why}.${note}  \n${where}`;
  }
  const logged = row.nodes?.length ?? 0;
  if (event.type === 'resume') return `**${event.name}()** resumed ${logged} times here  \n${where}`;
  const lines = [`**${event.name}()** called ${logged + (row.skip?.count ?? 0)} times here  \n${where}`];
  if (row.skip) lines.push(`${logged} logged, ${row.skip.count} not: ${why}`);
  return lines.join('\n\n');
}

/**
 * The name a call of a function is written with, to find it on its call site's line:
 * `factorial` for `factorial`, `add` for `Cart->add` or `cart.add`, the class for a
 * constructor, `total` for `Cart->get total`. Empty when there's no name to look for (an
 * anonymous or computed one).
 * @param {string} name a call's name, as logged
 * @returns {string}
 */
function callName(name) {
  if (name.startsWith('<') || name.includes('[')) return '';
  const [owner, member] = name.includes('->') ? name.split('->') : ['', name];
  if (member === 'constructor') return owner;
  return member.replace(/^(?:get|set|static) /, '').split('.').pop() ?? '';
}

/**
 * Where on a line a call is written: the column of its name (not part of a longer word),
 * preferring the last place it's called or reached through a dot (`math.factorial(` rather
 * than the text in `'factorial(5) = '` before it), or else of the line's first character
 * that isn't blank.
 * @param {string} text the call site's line
 * @param {string} name from {@link callName}
 * @returns {number}
 */
function columnOf(text, name) {
  if (name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = [...text.matchAll(new RegExp(`(?<![\\w$#])${escaped}(?![\\w$])`, 'g'))];
    const called = found.filter((match) => text[(match.index ?? 0) - 1] === '.' || /^\s*\(/.test(text.slice((match.index ?? 0) + name.length)));
    const best = called.length > 0 ? called[called.length - 1] : found[0];
    if (best) return best.index ?? 0;
  }
  return text.length - text.trimStart().length;
}

/**
 * How an end event ended a node, as details: `returned`, `threw` or `yielded`.
 * @param {Record<string, any> | undefined} end a `return`, `throw` or `yield`
 * @returns {Record<string, unknown>} empty for none
 */
function endData(end) {
  if (!end) return {};
  if (end.type === 'throw') return { threw: end.error };
  return { [end.type === 'yield' ? 'yielded' : 'returned']: end.value === undefined ? '[undefined]' : end.value };
}

/**
 * The calls a node ran in, outermost first: `main() #7 → factorial() #9`.
 * @param {TraceNode} node
 * @param {string} root the project folder
 * @returns {string}
 */
function stackOf(node, root) {
  /** @type {string[]} */
  const names = [];
  for (let at = /** @type {TraceNode | undefined} */ (node); at; at = at.parent) {
    const event = at.event;
    names.unshift(
      event.type === 'load' ? `load ${relativePath(root, event.file)}` : event.type === 'resume' ? `↻ ${event.name}() #${event.call}` : `${event.name}() #${event.id}`,
    );
  }
  return names.join(' → ');
}

/**
 * A file name for a details tab, without the characters file systems refuse.
 * @param {string} text
 * @returns {string}
 */
function fileName(text) {
  return text.replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * The details of a node, for a read-only tab: comments about the call (where, when, how
 * long, the calls it ran in, its resumes), then its arguments and how it ended as JSON. A
 * resume shows its call's details. Values are those logged, pretty-printed.
 * @param {TraceNode} node
 * @param {string} root the project folder
 * @returns {{ name: string, text: string }} the tab's name (`.jsonc`) and content
 */
function nodeDetails(node, root) {
  const event = node.event;
  if (event.type === 'load') {
    const lines = [
      `// load ${relativePath(root, event.file)}  #${event.id}`,
      `// ${event.file}`,
      `// at ${event.time} ms; its top-level code made ${node.children.length} calls logged in it`,
    ];
    return { name: fileName(`load ${path.basename(event.file)} #${event.id}.jsonc`), text: lines.join('\n') + '\n' };
  }
  const call = event.type === 'resume' ? node.call : node;
  const head = call?.event ?? event;
  const lines = [`// ${call ? nodeLabel(call, root) : `${event.name}()`}  #${head.type === 'resume' ? head.call : head.id}`];
  lines.push(`// ${relativePath(root, event.file)}:${event.line}  (${event.file})`);
  if (call) {
    const outcome = call.outcome;
    const took = outcome ? `took ${Math.round((outcome.time - call.event.time) * 1000) / 1000} ms` : 'still running when the log ended';
    lines.push(`// called at ${call.event.time} ms, ${took}`);
    const site = call.event.site;
    if (site) lines.push(`// called from ${relativePath(root, site.file)}:${site.line}  (${site.file})`);
    lines.push(`// in: ${stackOf(call, root)}`);
    if (call.resumes.length > 0) lines.push(`// resumed ${call.resumes.length} ${call.resumes.length === 1 ? 'time' : 'times'}: ${call.resumes.map((part) => `#${part.event.id}`).join(', ')}`);
  }
  if (event.type === 'resume') lines.push(`// this part: ↻ #${event.id} at ${event.time} ms, in: ${stackOf(node, root)}`);
  /** @type {Record<string, unknown>} */
  const data = {};
  if (call) {
    data.arguments = call.event.args ?? {};
    const yields = [call, ...call.resumes].map((part) => part.end).filter((end) => end?.type === 'yield');
    if (yields.length > 0) data.yielded = yields.map((end) => (end?.value === undefined ? '[undefined]' : end.value));
    Object.assign(data, call.outcome ? endData(call.outcome) : {});
  } else {
    Object.assign(data, endData(node.end));
  }
  const id = event.type === 'resume' ? event.call : event.id;
  return { name: fileName(`${event.name} #${id}.jsonc`), text: `${lines.join('\n')}\n${JSON.stringify(data, null, 2)}\n` };
}

/**
 * The details of a group, for a read-only tab: each of its calls (or resumes) with its
 * arguments and how it ended, and how many weren't logged.
 * @param {Row} row a group
 * @param {string} root the project folder
 * @returns {{ name: string, text: string }} the tab's name (`.jsonc`) and content
 */
function groupDetails(row, root) {
  const event = row.event;
  const nodes = row.nodes ?? [];
  const lines = [`// ${groupLabel(row)}${row.skip ? `: ${nodes.length} logged, ${row.skip.count} not (past maxRepeat)` : ''}`];
  lines.push(`// ${relativePath(root, event.file)}:${event.line}  (${event.file})`);
  if (nodes[0]?.parent) lines.push(`// in: ${stackOf(nodes[0].parent, root)}`);
  const items = nodes.map((node) =>
    node.event.type === 'resume'
      ? { resume: node.event.id, call: node.event.call, ...endData(node.end) }
      : { call: node.event.id, arguments: node.event.args ?? {}, ...endData(node.outcome ?? node.end) },
  );
  return { name: fileName(`${event.name} ×${nodes.length + (row.skip?.count ?? 0)}.jsonc`), text: `${lines.join('\n')}\n${JSON.stringify(items, null, 2)}\n` };
}

module.exports = {
  parseLog,
  readMore,
  isRunning,
  callName,
  columnOf,
  nodeDetails,
  groupDetails,
  rows,
  groupLabel,
  groupDescription,
  skipLabel,
  rowTooltip,
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
