'use strict';

/**
 * The jstrace VSCode extension (see Architecture in CLAUDE.md): a tree view of the logs in
 * each project's `.jstrace/logs`, each one's call tree, jumping to the functions, and
 * commands that run the CLI to inject jstrace and restore the originals.
 */

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const logs = require('./logs');
const { cliCommand, runCli } = require('./cli');

/** @typedef {import('./logs').Trace} Trace */
/** @typedef {import('./logs').TraceNode} TraceNode */

/**
 * A workspace folder with a `.jstrace/`, shown only when there's more than one.
 * @typedef {object} ProjectItem
 * @property {'project'} kind
 * @property {vscode.WorkspaceFolder} folder
 */

/**
 * A log file: one process.
 * @typedef {object} LogItem
 * @property {'log'} kind
 * @property {string} file the `.jsonl` file
 * @property {string} root the project folder, which paths are shown relative to
 * @property {ProjectItem | undefined} project its project's item, when projects are shown
 * @property {number} offset how much of the file was read (see `readMore`)
 * @property {boolean} running whether its process still runs (see `isRunning`)
 * @property {Trace} trace
 * @property {Map<number, NodeItem>} nodes the items made for its nodes, by id
 * @property {Map<string, RowItem>} rows the items made for its groups and skips, by id
 * @property {Map<Item, Item>} parents the item each of its items was last listed under
 */

/**
 * A node of a log's call tree.
 * @typedef {object} NodeItem
 * @property {'node'} kind
 * @property {LogItem} log
 * @property {TraceNode} node
 */

/**
 * A group of the calls of a function (or the resumes of a call) under a node, or calls
 * not logged (see `rows` in `logs.js`).
 * @typedef {object} RowItem
 * @property {'group' | 'skip'} kind
 * @property {string} id
 * @property {LogItem} log
 * @property {import('./logs').Row} row
 */

/** @typedef {ProjectItem | LogItem | NodeItem | RowItem} Item */

/** The colors of the processes' icons in a merged log, in the order they're listed (not red: that's for a throw). */
const PROCESS_COLORS = ['charts.blue', 'charts.orange', 'charts.green', 'charts.purple', 'charts.yellow'];

/**
 * Whether a log is a merged one (4.14).
 * @param {LogItem} log
 * @returns {boolean}
 */
function isMerged(log) {
  return Array.isArray(log.trace.start?.merged);
}

/**
 * The name given to a log's process, or `''`.
 * @param {LogItem} log
 * @returns {string}
 */
function nameOf(log) {
  return logs.readNames(path.dirname(log.file))[path.basename(log.file)] ?? '';
}

/**
 * The color of an event's process in a merged log.
 * @param {LogItem} log
 * @param {Record<string, any>} event
 * @returns {vscode.ThemeColor | undefined} none outside a merged log
 */
function processColor(log, event) {
  /** @type {Record<string, any>[] | undefined} */
  const merged = log.trace.start?.merged;
  const index = merged ? merged.findIndex((proc) => proc.pid === event.pid && proc.name === event.process) : -1;
  return index < 0 ? undefined : new vscode.ThemeColor(PROCESS_COLORS[index % PROCESS_COLORS.length]);
}

/**
 * How many calls of a function under a node make a group (setting `jstrace.groupRepeats`).
 * @returns {number} 0 for no groups
 */
function groupMin() {
  return Math.max(0, vscode.workspace.getConfiguration('jstrace').get('groupRepeats', 5));
}

/**
 * The workspace folders that are jstrace projects, with a `.jstrace/` folder.
 * @returns {vscode.WorkspaceFolder[]}
 */
function projects() {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => fs.existsSync(path.join(folder.uri.fsPath, '.jstrace')));
}

/**
 * A project's log folder.
 * @param {vscode.WorkspaceFolder} folder
 * @returns {string}
 */
function logFolder(folder) {
  return path.join(folder.uri.fsPath, '.jstrace', 'logs');
}

/**
 * The tree view's data: projects (with more than one) → logs, newest first → call trees.
 * Logs are read as they grow: from where the last read stopped, when listed or expanded and
 * every second (`tick`), so a running program's calls show up as it makes them.
 * @implements {vscode.TreeDataProvider<Item>}
 */
class CallsProvider {
  constructor() {
    /** @type {vscode.EventEmitter<Item | undefined>} */
    this.changed = new vscode.EventEmitter();
    /** @type {vscode.Event<Item | undefined>} */
    this.onDidChangeTreeData = this.changed.event;
    /** @type {Map<string, ProjectItem>} by folder */
    this.projectItems = new Map();
    /** @type {Map<string, LogItem>} by `.jsonl` file */
    this.logItems = new Map();
  }

  /**
   * Reloads the whole tree.
   * @returns {void}
   */
  refresh() {
    this.changed.fire(undefined);
  }

  /**
   * @param {Item} [element]
   * @returns {Item[]}
   */
  getChildren(element) {
    if (!element) {
      const folders = projects();
      if (folders.length === 1) return this.allLogs();
      return folders.map((folder) => this.projectItem(folder));
    }
    if (element.kind === 'project') return this.logsOf(element.folder, element);
    if (element.kind === 'log') this.update(element);
    const log = element.kind === 'log' ? element : element.log;
    /** @type {import('./logs').Row[]} */
    let rows;
    if (element.kind === 'log') rows = logs.rows(element.trace.roots, element.trace.skips, groupMin());
    else if (element.kind === 'node') rows = logs.rows(element.node.children, element.node.skips, groupMin());
    else if (element.kind === 'group') {
      const { nodes = [], skip, key } = element.row;
      rows = nodes.map((node) => ({ kind: /** @type {const} */ ('node'), event: node.event, key, node }));
      if (skip) rows.push({ kind: 'skip', event: skip, key });
    } else rows = [];
    const scope = element.kind === 'log' ? 'top' : element.kind === 'node' ? String(element.node.event.id) : element.id;
    return rows.map((row) => {
      /** @type {Item} */
      const item = row.kind === 'node' && row.node ? this.nodeItem(log, row.node) : this.rowItem(log, `${row.kind}:${scope}:${row.key}`, row);
      log.parents.set(item, element);
      for (const node of row.kind === 'group' ? row.nodes ?? [] : []) log.parents.set(this.nodeItem(log, node), item);
      return item;
    });
  }

  /**
   * The parent of a node is its group, when it's in one, else the node it ran in.
   * @param {Item} element
   * @returns {Item | undefined}
   */
  getParent(element) {
    if (element.kind === 'project') return undefined;
    if (element.kind === 'log') return element.project;
    if (element.kind === 'node' && !element.log.parents.has(element)) {
      this.getChildren(element.node.parent ? this.nodeItem(element.log, element.node.parent) : element.log);
    }
    return element.log.parents.get(element);
  }

  /**
   * @param {Item} element
   * @returns {vscode.TreeItem}
   */
  getTreeItem(element) {
    const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
    if (element.kind === 'project') {
      const item = new vscode.TreeItem(element.folder.name, Expanded);
      item.id = `project:${element.folder.uri.fsPath}`;
      item.iconPath = new vscode.ThemeIcon('root-folder');
      item.contextValue = 'project';
      if (logs.listLogs(logFolder(element.folder)).length === 0) item.description = 'no logs';
      return item;
    }
    if (element.kind === 'log') {
      const { trace, file, root } = element;
      const name = isMerged(element) ? '' : nameOf(element);
      const item = new vscode.TreeItem(`${name ? `${name} · ` : ''}${logs.logLabel(trace, file, root)}`, Collapsed);
      item.id = `log:${file}`;
      item.description = `${logs.logDescription(trace)}${element.running ? '  running' : ''}`;
      item.iconPath = new vscode.ThemeIcon(element.running ? 'sync~spin' : isMerged(element) ? 'git-merge' : 'pulse');
      item.contextValue = isMerged(element) ? 'mergedLog' : 'log';
      const start = trace.start;
      item.tooltip = !start
        ? file
        : isMerged(element)
          ? `${start.merged.map((/** @type {any} */ proc) => `${proc.name} (pid ${proc.pid}): ${(proc.argv ?? []).join(' ')}`).join('\n')}\n${file}`
          : `${(start.argv ?? []).join(' ')}\ncwd: ${start.cwd}\nstarted: ${start.started}\n${file}`;
      return item;
    }
    if (element.kind !== 'node') {
      const { row, log } = element;
      const event = row.event;
      const group = element.kind === 'group';
      const item = new vscode.TreeItem(group ? logs.groupLabel(row) : logs.skipLabel(event), group ? Collapsed : None);
      item.id = `${log.file}#${element.id}`;
      item.description = group ? logs.groupDescription(row) : '';
      item.iconPath = new vscode.ThemeIcon(group ? 'layers' : 'ellipsis', processColor(log, event));
      item.contextValue = element.kind;
      item.command = { title: 'Go to code', command: 'jstrace.open', arguments: [event.file, event.line ?? 1, event.column ?? 0] };
      return item;
    }
    const { node, log } = element;
    const event = node.event;
    const item = new vscode.TreeItem(logs.nodeLabel(node, log.root), node.children.length + node.skips.length > 0 ? Collapsed : None);
    item.id = `node:${log.file}#${event.id}`;
    item.description = logs.nodeDescription(node) || (log.running && event.type === 'call' && !node.outcome ? 'running…' : '');
    const end = event.type === 'call' ? node.outcome ?? node.end : node.end;
    item.iconPath =
      end?.type === 'throw'
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
        : new vscode.ThemeIcon(
            event.type === 'load' ? 'file-code' : event.type === 'resume' ? 'debug-continue' : event.external ? 'link-external' : 'symbol-function',
            processColor(log, event),
          );
    // an external call (4.13) is logged where it was made, with no function to go to
    item.contextValue = event.type === 'call' && event.external ? 'external' : event.type === 'call' && event.site ? 'callSite' : event.type;
    item.command =
      event.type === 'resume'
        ? { title: 'Show the call', command: 'jstrace.showCall', arguments: [element] }
        : { title: 'Show where it was called, with its values', command: 'jstrace.showStep', arguments: [element] };
    return item;
  }

  /**
   * Fills in a node's hover only once it's needed, since values can be big.
   * @param {vscode.TreeItem} item
   * @param {Item} element
   * @returns {vscode.TreeItem}
   */
  resolveTreeItem(item, element) {
    if (element.kind === 'node') item.tooltip = new vscode.MarkdownString(logs.nodeTooltip(element.node, element.log.root));
    if (element.kind === 'group' || element.kind === 'skip') item.tooltip = new vscode.MarkdownString(logs.rowTooltip(element.row, element.log.root));
    return item;
  }

  /**
   * Forgets the items made for the logs' trees, so they're grouped again.
   * @returns {void}
   */
  regroup() {
    for (const log of this.logItems.values()) {
      log.rows.clear();
      log.parents.clear();
    }
    this.refresh();
  }

  /**
   * @param {vscode.WorkspaceFolder} folder
   * @returns {ProjectItem}
   */
  projectItem(folder) {
    const key = folder.uri.fsPath;
    let item = this.projectItems.get(key);
    if (!item) this.projectItems.set(key, (item = { kind: 'project', folder }));
    return item;
  }

  /**
   * The logs of every project, newest first in each.
   * @returns {LogItem[]}
   */
  allLogs() {
    const folders = projects();
    return folders.flatMap((folder) => this.logsOf(folder, folders.length === 1 ? undefined : this.projectItem(folder)));
  }

  /**
   * The logs of a project, newest first.
   * @param {vscode.WorkspaceFolder} folder
   * @param {ProjectItem | undefined} project its item, when projects are shown
   * @returns {LogItem[]}
   */
  logsOf(folder, project) {
    /** @type {LogItem[]} */
    const items = [];
    for (const file of logs.listLogs(logFolder(folder))) {
      let item = this.logItems.get(file);
      if (!item) {
        item = {
          kind: 'log', file, root: folder.uri.fsPath, project, offset: 0, running: false, trace: logs.parseLog(''), nodes: new Map(), rows: new Map(), parents: new Map(),
        };
        this.logItems.set(file, item);
      }
      item.project = project;
      this.update(item);
      items.push(item);
    }
    return items;
  }

  /**
   * Reads what was added to a log since it was read, and whether its process still runs.
   * @param {LogItem} item
   * @returns {boolean} whether anything changed
   */
  update(item) {
    const before = item.trace;
    let grew = false;
    let modified = 0;
    try {
      grew = logs.readMore(item.file, item);
      modified = fs.statSync(item.file).mtimeMs;
    } catch {
      return false; // gone
    }
    if (item.trace !== before) {
      item.nodes.clear();
      item.rows.clear();
      item.parents.clear();
    }
    const running = logs.isRunning(item.trace, modified);
    const changed = grew || running !== item.running;
    item.running = running;
    return changed;
  }

  /**
   * Follows the logs listed (live tailing, 4.2): reads what was added to each, and refreshes
   * only the logs that changed, so what's expanded stays expanded.
   * @returns {void}
   */
  tick() {
    for (const [file, item] of this.logItems) {
      if (!fs.existsSync(file)) this.logItems.delete(file);
      else if (this.update(item)) this.changed.fire(item);
    }
  }

  /**
   * @param {LogItem} log
   * @param {string} id where it is and what it groups, unique in the log
   * @param {import('./logs').Row} row a group or a skip
   * @returns {RowItem}
   */
  rowItem(log, id, row) {
    let item = log.rows.get(id);
    if (!item) log.rows.set(id, (item = { kind: row.kind === 'group' ? 'group' : 'skip', id, log, row }));
    item.row = row;
    return item;
  }

  /**
   * @param {LogItem} log
   * @param {TraceNode} node
   * @returns {NodeItem}
   */
  nodeItem(log, node) {
    let item = log.nodes.get(node.event.id);
    if (!item || item.node !== node) log.nodes.set(node.event.id, (item = { kind: 'node', log, node }));
    return item;
  }
}

/**
 * A log with calls matching the search, in the Search view.
 * @typedef {object} ResultsItem
 * @property {'results'} kind
 * @property {LogItem} log
 * @property {TraceNode[]} nodes what matched
 */

/**
 * The calls past {@link MAX_RESULTS} in a log, not listed.
 * @typedef {object} MoreItem
 * @property {'more'} kind
 * @property {LogItem} log
 * @property {number} count
 */

/** @typedef {ResultsItem | MoreItem | NodeItem} SearchItem */

/** How many matches of a log the Search view lists. */
const MAX_RESULTS = 1000;

/**
 * The Search view's data (4.3): the logs with calls (or loads) matching the search → those
 * calls, in the order they ran. A call is the Calls view's own item, so it can be revealed
 * there. Searched again whenever it's listed, so it follows the logs as they grow.
 * @implements {vscode.TreeDataProvider<SearchItem>}
 */
class SearchProvider {
  /** @param {CallsProvider} calls */
  constructor(calls) {
    this.calls = calls;
    /** @type {string} what to look for: words that must all be found, ignoring case */
    this.query = '';
    /** @type {{ file: string, line: number, where: string } | undefined} or else a line of code to find the calls at (4.16) */
    this.at = undefined;
    /** @type {vscode.TreeView<SearchItem> | undefined} where it says how many matched */
    this.view = undefined;
    /** @type {vscode.EventEmitter<SearchItem | undefined>} */
    this.changed = new vscode.EventEmitter();
    /** @type {vscode.Event<SearchItem | undefined>} */
    this.onDidChangeTreeData = this.changed.event;
  }

  /**
   * Whether something is searched.
   * @returns {boolean}
   */
  get active() {
    return Boolean(this.query || this.at);
  }

  /**
   * Searches again.
   * @returns {void}
   */
  refresh() {
    this.changed.fire(undefined);
  }

  /**
   * @param {SearchItem} [element]
   * @returns {SearchItem[]}
   */
  getChildren(element) {
    if (!element) {
      /** @type {ResultsItem[]} */
      const items = [];
      let count = 0;
      const at = this.at;
      for (const log of this.active ? this.calls.allLogs() : []) {
        const nodes = at ? logs.searchAt(log.trace, at.file, at.line) : logs.search(log.trace, this.query, log.root);
        count += nodes.length;
        if (nodes.length > 0) items.push({ kind: 'results', log, nodes });
      }
      if (this.view) {
        const calls = `${count} ${count === 1 ? 'call' : 'calls'}`;
        this.view.message = at
          ? count === 0 ? `No calls at ${at.where}.` : `${calls} at ${at.where}`
          : !this.query ? undefined : count === 0 ? `No calls match “${this.query}”.` : `${count} ${count === 1 ? 'match' : 'matches'} for “${this.query}”`;
      }
      return items;
    }
    if (element.kind !== 'results') return [];
    const { log, nodes } = element;
    /** @type {SearchItem[]} */
    const items = nodes.slice(0, MAX_RESULTS).map((node) => this.calls.nodeItem(log, node));
    if (nodes.length > MAX_RESULTS) items.push({ kind: 'more', log, count: nodes.length - MAX_RESULTS });
    return items;
  }

  /**
   * @param {SearchItem} element
   * @returns {vscode.TreeItem}
   */
  getTreeItem(element) {
    const { Expanded, None } = vscode.TreeItemCollapsibleState;
    if (element.kind === 'results') {
      const { log, nodes } = element;
      const item = new vscode.TreeItem(logs.logLabel(log.trace, log.file, log.root), Expanded);
      item.id = `results:${log.file}`;
      item.description = `${nodes.length}  ${logs.logDescription(log.trace)}${log.running ? '  running' : ''}`;
      item.iconPath = new vscode.ThemeIcon(log.running ? 'sync~spin' : 'pulse');
      item.tooltip = log.file;
      return item;
    }
    if (element.kind === 'more') {
      const item = new vscode.TreeItem(`… ${element.count} more`, None);
      item.id = `more:${element.log.file}`;
      return item;
    }
    const { node, log } = element;
    const event = node.event;
    const tree = this.calls.getTreeItem(element);
    const label = logs.nodeLabel(node, log.root);
    const item = new vscode.TreeItem({ label, highlights: logs.highlights(label, this.query) }, None);
    item.id = `result:${log.file}#${event.id}`;
    const where = `${logs.relativePath(log.root, event.file)}${event.type === 'load' ? '' : `:${event.line}`}`;
    item.description = `${tree.description ? `${tree.description}  ` : ''}${where}`;
    item.iconPath = tree.iconPath;
    item.contextValue = tree.contextValue;
    item.command = { title: 'Go to code (double-click: show in the Calls view)', command: 'jstrace.openResult', arguments: [element] };
    return item;
  }

  /**
   * Fills in a call's hover: the Calls view's, plus the calls it ran in.
   * @param {vscode.TreeItem} item
   * @param {SearchItem} element
   * @returns {vscode.TreeItem}
   */
  resolveTreeItem(item, element) {
    if (element.kind !== 'node') return item;
    const { node, log } = element;
    const within = node.parent ? `In ${logs.stackOf(node.parent, log.root)}\n\n` : '';
    item.tooltip = new vscode.MarkdownString(`${within}${logs.nodeTooltip(node, log.root)}\n\nDouble-click to show it in the Calls view`);
    return item;
  }
}

/**
 * A position from a log in a document: lines count from 1, columns from 0. Without a column
 * (a call site), it's where `name` is written on the line.
 * @param {vscode.TextDocument} document
 * @param {number} line
 * @param {number | null} column
 * @param {string} [name]
 * @returns {vscode.Position}
 */
function positionIn(document, line, column, name) {
  const at = Math.max(0, line - 1);
  const character = column ?? (at < document.lineCount ? logs.columnOf(document.lineAt(at).text, name ?? '') : 0);
  return document.validatePosition(new vscode.Position(at, character));
}

/** The longest text a step shows at the end of the line, in characters. */
const MAX_STEP_TEXT = 150;

/** How soon a second click on a search result makes a double-click, in ms. */
const DOUBLE_CLICK = 500;

/**
 * Called by VSCode when the extension activates.
 * @param {vscode.ExtensionContext} context
 * @returns {void}
 */
function activate(context) {
  const provider = new CallsProvider();
  const view = vscode.window.createTreeView('jstrace.calls', { treeDataProvider: provider, showCollapseAll: true, canSelectMany: true });
  const search = new SearchProvider(provider);
  const searchView = vscode.window.createTreeView('jstrace.searchResults', { treeDataProvider: search });
  search.view = searchView;
  /** @type {{ element: SearchItem | undefined, time: number, opening: Promise<unknown> }} the last click on a result */
  const click = { element: undefined, time: 0, opening: Promise.resolve() };
  /** The line a step is at, like a debugger's, with the call's values at its end (`jstrace.stepHint` `end`). */
  const stepDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('jstrace.stepBackground'),
    after: { color: new vscode.ThemeColor('jstrace.stepForeground'), fontStyle: 'italic', margin: '0 0 0 2em' },
  });
  /**
   * Where the last step went, and its CodeLens's text when its values are shown above the line.
   * @type {{ item: NodeItem | undefined, editor: vscode.TextEditor | undefined, line: number, lens: string }}
   */
  const stepped = { item: undefined, editor: undefined, line: -1, lens: '' };
  /** @type {vscode.EventEmitter<void>} */
  const lensChanged = new vscode.EventEmitter();
  const output = vscode.window.createOutputChannel('jstrace');
  /** @type {Map<string, string>} the details tabs' contents, by URI */
  const details = new Map();
  /** @type {vscode.EventEmitter<vscode.Uri>} */
  const detailsChanged = new vscode.EventEmitter();

  /** @type {NodeJS.Timeout | undefined} */
  let pending;
  const refreshSoon = () => {
    clearTimeout(pending);
    pending = setTimeout(() => provider.refresh(), 300);
  };
  provider.onDidChangeTreeData(() => {
    if (search.active) search.refresh();
  });
  const ticker = setInterval(() => provider.tick(), 1000);
  ticker.unref(); // not to keep a process alive (tests)
  const watcher = vscode.workspace.createFileSystemWatcher('**/.jstrace/logs/*.jsonl', false, true, false);
  watcher.onDidCreate(refreshSoon);
  watcher.onDidDelete(refreshSoon);

  /**
   * Runs the CLI in a project, logs what it said in the output channel, and tells the user
   * how it went: its summary, plus what it left alone or skipped.
   * @param {vscode.WorkspaceFolder} folder the project
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  async function run(folder, args) {
    const command = cliCommand(vscode.workspace.getConfiguration('jstrace').get('cliPath', ''), context.extensionPath);
    output.appendLine(`> jstrace ${args.join(' ')}  (in ${folder.uri.fsPath})`);
    const result = await runCli(command, args, folder.uri.fsPath);
    if (result.stdout) output.append(result.stdout);
    if (result.stderr) output.appendLine(result.stderr.trimEnd());
    const summary = result.stdout.trim().split('\n').pop() ?? '';
    const problems = result.stderr.trim().split('\n').filter(Boolean);
    const prefix = projects().length > 1 || (vscode.workspace.workspaceFolders ?? []).length > 1 ? `${folder.name}: ` : '';
    const details = problems.length > 0 && problems.length <= 3 ? ` (${problems.join('; ')})` : '';
    const show = 'Show Output';
    const answer =
      result.code !== 0
        ? await vscode.window.showErrorMessage(`${prefix}jstrace ${args[0]} failed: ${problems[0] ?? `exit code ${result.code}`}`, show)
        : problems.length > 0
          ? await vscode.window.showWarningMessage(`${prefix}${summary}${details}`, show)
          : void vscode.window.showInformationMessage(`${prefix}${summary}`);
    if (answer === show) output.show();
    provider.refresh();
  }

  /**
   * Forgets the last step and takes its highlight away.
   * @returns {void}
   */
  function clearStep() {
    if (stepped.editor) void vscode.commands.executeCommand('setContext', 'jstrace.stepShown', false);
    stepped.editor?.setDecorations(stepDecoration, []);
    const lens = stepped.lens;
    Object.assign(stepped, { item: undefined, editor: undefined, line: -1, lens: '' });
    if (lens) lensChanged.fire();
  }

  /**
   * Where a step shows the call's values (`jstrace.stepHint`): `above` the line (a CodeLens),
   * at its `end`, or only on `hover`. Above needs CodeLens, so it's the end where they're off.
   * @param {vscode.TextDocument} document
   * @returns {string}
   */
  function stepHint(document) {
    const hint = vscode.workspace.getConfiguration('jstrace').get('stepHint', 'above');
    return hint === 'above' && !vscode.workspace.getConfiguration('editor', document.uri).get('codeLens', true) ? 'end' : hint;
  }

  /**
   * Steps through a run (4.10) from the selected call in the Calls or Search view: selects
   * where the step goes in the Calls view and shows where it was called (its code, without
   * a site), with the line highlighted and the call's values at its end. The view keeps the
   * focus, so the next step's keys go on working there.
   * @param {'into' | 'back' | 'over' | 'backOver' | 'out'} how see `step` in `logs.js`
   * @param {unknown} from the item (from a context menu), or `'search'` for the Search
   *   view's selection (its keys); else the Calls view's selection
   * @returns {Promise<void>}
   */
  async function stepTo(how, from) {
    /** @type {Item | SearchItem | undefined} */
    const element = from && typeof from === 'object' ? /** @type {Item} */ (from) : from === 'search' ? searchView.selection[0] : view.selection[0];
    /** @type {LogItem | undefined} */
    let log;
    /** @type {TraceNode | undefined} */
    let next;
    if (element?.kind === 'node') {
      log = element.log;
      next = logs.step(log.trace, element.node, how);
    } else if (element?.kind === 'group') {
      log = element.log;
      const nodes = element.row.nodes ?? [];
      const forward = how === 'into' || how === 'over';
      next = how === 'into' ? nodes[0] : logs.step(log.trace, forward ? nodes[nodes.length - 1] : nodes[0], how);
    } else if (element?.kind === 'log') {
      log = element;
      if (how === 'into' || how === 'over') next = log.trace.nodes.values().next().value;
    } else {
      return void vscode.window.showInformationMessage('jstrace: select a call in the Calls view to step from it.');
    }
    if (!next) return void vscode.window.setStatusBarMessage(`jstrace: no ${how === 'out' ? 'caller' : how.startsWith('back') ? 'call before it' : 'call after it'}`, 3000);
    const item = provider.nodeItem(log, next);
    await showStep(item);
    await view.reveal(item, { select: true, focus: true });
  }

  /**
   * Shows a call as a step does (and a click): where it was called (its code, without a
   * site) with the line highlighted, the call's label and outcome where `stepHint` says, and
   * its tooltip on hover, the editor leaving the focus where it was. Steps then go on from it.
   * @param {NodeItem} item
   * @returns {Promise<void>}
   */
  async function showStep(item) {
    const event = item.node.event;
    const [file, line, column, name] = event.site
      ? [event.site.file, event.site.line, null, logs.callName(event.name)]
      : [event.file, event.line ?? 1, event.column ?? 0, undefined];
    clearStep();
    stepped.item = item;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const position = positionIn(document, line, column, name);
      const editor = await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preserveFocus: true });
      const tree = provider.getTreeItem(item);
      let text = `${tree.label}${tree.description ? `  ${tree.description}` : ''}`;
      if (text.length > MAX_STEP_TEXT) text = `${text.slice(0, MAX_STEP_TEXT - 1)}…`;
      const hint = stepHint(document);
      const range = new vscode.Range(new vscode.Position(position.line, 0), new vscode.Position(position.line, document.lineAt(position.line).text.length));
      const hoverMessage = new vscode.MarkdownString(logs.nodeTooltip(item.node, item.log.root));
      editor.setDecorations(stepDecoration, [{ range, hoverMessage, ...(hint === 'end' && { renderOptions: { after: { contentText: text } } }) }]);
      Object.assign(stepped, { editor, line: position.line, lens: hint === 'above' ? text : '' });
      if (stepped.lens) lensChanged.fire();
      void vscode.commands.executeCommand('setContext', 'jstrace.stepShown', true); // for Esc to hide it
    } catch (error) {
      vscode.window.showErrorMessage(`jstrace: can't open ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  context.subscriptions.push(
    view,
    searchView,
    stepDecoration,
    { dispose: clearStep },
    lensChanged,
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      {
        onDidChangeCodeLenses: lensChanged.event,
        /**
         * The step's values above its line, when `jstrace.stepHint` is `above`; a click shows its details.
         * @param {vscode.TextDocument} document
         * @returns {vscode.CodeLens[]}
         */
        provideCodeLenses(document) {
          if (!stepped.lens || document !== stepped.editor?.document) return [];
          const at = new vscode.Position(stepped.line, 0);
          return [new vscode.CodeLens(new vscode.Range(at, at), { title: stepped.lens, tooltip: 'Show Details', command: 'jstrace.showDetails', arguments: [stepped.item] })];
        },
      },
    ),
    view.onDidChangeSelection((event) => {
      if (stepped.item && event.selection[0] !== stepped.item) clearStep(); // selected some other way
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length > 0 && event.document === stepped.editor?.document) clearStep(); // its line may have moved
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      // A click on another line of its editor: the user has moved on.
      const moved = event.selections[0]?.active.line !== stepped.line;
      if (event.textEditor === stepped.editor && event.kind === vscode.TextEditorSelectionChangeKind.Mouse && moved) clearStep();
    }),
    vscode.commands.registerCommand('jstrace.hideStep', clearStep),
    vscode.commands.registerCommand('jstrace.stepInto', (/** @type {unknown} */ from) => stepTo('into', from)),
    vscode.commands.registerCommand('jstrace.stepBack', (/** @type {unknown} */ from) => stepTo('back', from)),
    vscode.commands.registerCommand('jstrace.stepOver', (/** @type {unknown} */ from) => stepTo('over', from)),
    vscode.commands.registerCommand('jstrace.stepBackOver', (/** @type {unknown} */ from) => stepTo('backOver', from)),
    vscode.commands.registerCommand('jstrace.stepOut', (/** @type {unknown} */ from) => stepTo('out', from)),
    output,
    watcher,
    { dispose: () => clearTimeout(pending) },
    { dispose: () => clearInterval(ticker) },
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('jstrace.groupRepeats')) provider.regroup();
    }),

    vscode.commands.registerCommand('jstrace.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('jstrace.clearLogs', async () => {
      const folders = projects().filter((folder) => logs.listLogs(logFolder(folder)).length > 0);
      const count = folders.reduce((sum, folder) => sum + logs.listLogs(logFolder(folder)).length, 0);
      if (count === 0) return void vscode.window.showInformationMessage('There are no jstrace logs to clear.');
      const yes = 'Delete';
      const answer = await vscode.window.showWarningMessage(
        `Delete ${count} jstrace ${count === 1 ? 'log' : 'logs'}?`,
        { modal: true, detail: folders.map(logFolder).join('\n') },
        yes,
      );
      if (answer !== yes) return;
      for (const folder of folders) logs.clearLogs(logFolder(folder));
      provider.refresh();
    }),

    vscode.commands.registerCommand(
      'jstrace.nameProcess',
      /**
       * Names a log's process: its label shows it, and so do its calls once it's merged.
       * @param {Item} [element] the selected item, from the command palette
       */
      async (element = view.selection[0]) => {
        if (element?.kind !== 'log' || isMerged(element)) return void vscode.window.showInformationMessage('jstrace: select a log in the Calls view to name its process.');
        const name = await vscode.window.showInputBox({
          title: 'Name Process',
          value: nameOf(element) || logs.defaultName(element.trace, element.file),
          prompt: `The process of ${logs.logLabel(element.trace, element.file, element.root)}: shown in its label, and before each of its calls once it's merged. Empty for none.`,
        });
        if (name === undefined) return; // cancelled
        logs.setName(element.file, name.trim());
        provider.changed.fire(element);
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.mergeLogs',
      /**
       * Merges the logs of processes into a new one (4.14): those selected, or else those
       * picked from a list. A process that has no name yet is named first.
       * @param {Item} [element] the item right-clicked
       * @param {Item[]} [selected] all the items selected with it
       */
      async (element, selected) => {
        /** @param {Item | undefined} item @returns {item is LogItem} */
        const mergeable = (item) => item?.kind === 'log' && !isMerged(item);
        let chosen = (selected && selected.length > 0 ? selected : [element]).filter(mergeable);
        if (chosen.length < 2) {
          const all = provider.allLogs().filter(mergeable);
          if (all.length < 2) return void vscode.window.showInformationMessage('jstrace: merging takes two or more logs.');
          const picks = await vscode.window.showQuickPick(
            all.map((log) => ({
              label: `${nameOf(log) ? `${nameOf(log)} · ` : ''}${logs.logLabel(log.trace, log.file, log.root)}`,
              description: logs.logDescription(log.trace),
              picked: chosen.includes(log),
              log,
            })),
            { title: 'Merge Logs', placeHolder: 'The processes to merge into one log (two or more)', canPickMany: true },
          );
          if (!picks) return; // cancelled
          chosen = picks.map((pick) => pick.log);
          if (chosen.length < 2) return void vscode.window.showInformationMessage('jstrace: pick two or more logs to merge.');
        }
        for (const log of chosen) {
          if (nameOf(log)) continue;
          const name = await vscode.window.showInputBox({
            title: `Merge Logs: name the process of ${logs.logLabel(log.trace, log.file, log.root)} (${logs.logDescription(log.trace)})`,
            value: logs.defaultName(log.trace, log.file),
            prompt: 'Shown before each of its calls in the merged log.',
          });
          if (name === undefined) return; // cancelled
          logs.setName(log.file, name.trim() || logs.defaultName(log.trace, log.file));
        }
        const file = path.join(path.dirname(chosen[0].file), `${new Date().toISOString().replace(/:/g, '-')}-merged.jsonl`);
        try {
          const sources = chosen.map((log) => ({ file: log.file, text: fs.readFileSync(log.file, 'utf8'), name: nameOf(log) }));
          const { jsonl, txt } = logs.mergeLogs(sources, chosen[0].root);
          fs.writeFileSync(logs.textOf(file), txt, { mode: 0o600 });
          fs.writeFileSync(file, jsonl, { mode: 0o600 });
        } catch (error) {
          return void vscode.window.showErrorMessage(`jstrace: can't merge the logs: ${error instanceof Error ? error.message : String(error)}`);
        }
        provider.refresh();
        const merged = provider.allLogs().find((log) => log.file === file);
        if (merged) await view.reveal(merged, { select: true, focus: true, expand: true });
      },
    ),

    vscode.commands.registerCommand('jstrace.createMock', async () => {
      const all = vscode.workspace.workspaceFolders ?? [];
      const folder = all.length === 1 ? all[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'The project to create a jstrace mock in' });
      if (!folder) return;
      await run(folder, ['mock']);
      try {
        const config = JSON.parse(fs.readFileSync(path.join(folder.uri.fsPath, 'jstrace.config.json'), 'utf8'));
        if (config.mock) await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.uri.fsPath, config.mock)));
      } catch {
        // the CLI said what went wrong
      }
    }),

    vscode.commands.registerCommand('jstrace.restore', async () => {
      const folders = projects().filter((folder) => fs.existsSync(path.join(folder.uri.fsPath, '.jstrace', 'backup')));
      if (folders.length === 0) return void vscode.window.showInformationMessage('jstrace: nothing to restore.');
      for (const folder of folders) await run(folder, ['restore']);
    }),

    vscode.commands.registerCommand(
      'jstrace.inject',
      /**
       * Runs on the Explorer's selection (or the open file, from the command palette).
       * @param {vscode.Uri} [uri]
       * @param {vscode.Uri[]} [uris]
       */
      async (uri, uris) => {
        const targets = uris && uris.length > 0 ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
        if (targets.length === 0) return void vscode.window.showErrorMessage('jstrace: pick a folder or file to inject jstrace into.');
        /** @type {Map<vscode.WorkspaceFolder, string[]>} */
        const byFolder = new Map();
        for (const target of targets) {
          const folder = target.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(target) : undefined;
          if (!folder) return void vscode.window.showErrorMessage(`jstrace: ${target.fsPath} isn't in a workspace folder.`);
          byFolder.set(folder, [...(byFolder.get(folder) ?? []), path.relative(folder.uri.fsPath, target.fsPath) || '.']);
        }
        for (const [folder, paths] of byFolder) await run(folder, ['instrument', ...paths]);
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.open',
      /**
       * Opens a file at a position from a log: lines count from 1, columns from 0. While the
       * file is instrumented the line is right but the column may be off a little. Without
       * a column (a call site), the cursor goes to where `name` is written on the line.
       * @param {string} file
       * @param {number} line
       * @param {number | null} column
       * @param {string} [name] what to look for on the line, without a column
       */
      async (file, line, column, name) => {
        try {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
          const position = positionIn(document, line, column, name);
          // The editor takes the focus, since an unfocused one doesn't show its cursor.
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
        } catch (error) {
          vscode.window.showErrorMessage(`jstrace: can't open ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.goToSite',
      /**
       * Goes to where a call was made, on the callee's name there; to the function itself
       * when that's unknown (a callback run by Node, or `callSites` off).
       * @param {Item} [element] the selected item, from the command palette
       */
      async (element = view.selection[0]) => {
        if (element?.kind !== 'node') return;
        const event = element.node.event;
        if (event.site) await vscode.commands.executeCommand('jstrace.open', event.site.file, event.site.line, null, logs.callName(event.name));
        else await vscode.commands.executeCommand('jstrace.open', event.file, event.line ?? 1, event.column ?? 0);
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.goToFunction',
      /**
       * Goes to the function a call (or resume, or group) ran, rather than where it was called.
       * @param {Item} [element] the selected item, from the command palette
       */
      async (element = view.selection[0]) => {
        const event = element?.kind === 'node' ? element.node.event : element?.kind === 'group' ? element.row.event : undefined;
        if (event) await vscode.commands.executeCommand('jstrace.open', event.file, event.line ?? 1, event.column ?? 0);
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.showCall',
      /**
       * Selects the call a resume is part of, and shows it as a step does (the resume
       * itself, when its call wasn't logged).
       * @param {NodeItem} element a resume
       */
      async (element) => {
        const call = element.log.trace.nodes.get(element.node.event.call);
        const item = call ? provider.nodeItem(element.log, call) : element;
        await showStep(item);
        if (call) await view.reveal(item, { select: true, focus: false });
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.showStep',
      /**
       * A click on a call or a load: shows it as a step does, so the keys step on from it.
       * @param {NodeItem} element
       */
      (element) => showStep(element),
    ),

    vscode.workspace.registerTextDocumentContentProvider('jstrace', {
      onDidChange: detailsChanged.event,
      provideTextDocumentContent: (uri) => details.get(uri.toString()) ?? '',
    }),
    detailsChanged,

    vscode.commands.registerCommand(
      'jstrace.showDetails',
      /**
       * Opens a read-only tab beside with a call's (or a group's) details, as `jsonc`.
       * @param {Item} [element] the selected item, from the command palette
       */
      async (element = view.selection[0]) => {
        if (element?.kind !== 'node' && element?.kind !== 'group') {
          return void vscode.window.showInformationMessage('jstrace: select a call in the Calls view to see its details.');
        }
        const { name, text } = element.kind === 'node' ? logs.nodeDetails(element.node, element.log.root) : logs.groupDetails(element.row, element.log.root);
        const key = element.kind === 'node' ? element.node.event.id : element.id;
        const uri = vscode.Uri.from({ scheme: 'jstrace', path: `/${name}`, query: `${element.log.file}#${key}` });
        details.set(uri.toString(), text);
        detailsChanged.fire(uri);
        const document = await vscode.languages.setTextDocumentLanguage(await vscode.workspace.openTextDocument(uri), 'jsonc');
        await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.expandAll',
      /**
       * Expands an item and everything under it, level by level.
       * @param {Item} [element] the selected item, from the command palette
       */
      async (element = view.selection[0]) => {
        if (!element) return;
        await vscode.window.withProgress({ location: { viewId: 'jstrace.calls' } }, async () => {
          /** @type {Item[]} */
          const queue = [element];
          for (let item = queue.shift(); item; item = queue.shift()) {
            const children = provider.getChildren(item);
            if (children.length === 0) continue;
            await view.reveal(item, { expand: true, select: item === element, focus: item === element });
            queue.push(...children);
          }
        });
      },
    ),

    vscode.commands.registerCommand('jstrace.search', async () => {
      const query = await vscode.window.showInputBox({
        title: 'Search Calls',
        value: search.query,
        prompt: 'Words to find in calls: function names, files, arguments, values. All must match; case is ignored.',
        placeHolder: 'fetchPrice 42',
      });
      if (query === undefined) return; // cancelled
      search.query = query.trim();
      search.at = undefined;
      search.refresh();
      await vscode.commands.executeCommand('jstrace.searchResults.focus');
    }),

    vscode.commands.registerCommand(
      'jstrace.searchLine',
      /**
       * Lists in the Search view the calls at the cursor's line (4.16): made from it, or of a
       * function defined on it.
       */
      async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
          return void vscode.window.showInformationMessage('jstrace: open a file to find the calls at its line.');
        }
        const file = editor.document.uri.fsPath;
        const line = editor.selection.active.line + 1;
        const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        search.query = '';
        search.at = { file, line, where: `${folder ? logs.relativePath(folder.uri.fsPath, file) : path.basename(file)}:${line}` };
        search.refresh();
        await vscode.commands.executeCommand('jstrace.searchResults.focus');
      },
    ),

    vscode.commands.registerCommand('jstrace.clearSearch', () => {
      search.query = '';
      search.at = undefined;
      search.refresh();
    }),

    vscode.commands.registerCommand(
      'jstrace.showInTree',
      /**
       * Selects a search result in the Calls view, expanding what it ran in.
       * @param {SearchItem} [element] the selected result, from the command palette
       */
      async (element = searchView.selection[0]) => {
        if (element?.kind === 'node') await view.reveal(element, { select: true, focus: true });
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.openResult',
      /**
       * A click on a search result does what it does in the Calls view (goes to the code);
       * a double-click (a second click on it soon after) shows it in the Calls view. A tree
       * item's command runs on every click, so a double-click is told by the time between.
       * @param {NodeItem} element
       */
      async (element) => {
        const now = Date.now();
        const double = click.element === element && now - click.time < DOUBLE_CLICK;
        Object.assign(click, { element, time: now });
        if (double) {
          await click.opening; // so the editor it opens doesn't take the focus back
          return void (await vscode.commands.executeCommand('jstrace.showInTree', element));
        }
        const command = provider.getTreeItem(element).command;
        click.opening = command ? Promise.resolve(vscode.commands.executeCommand(command.command, ...(command.arguments ?? []))) : Promise.resolve();
        await click.opening;
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.openText',
      /** @param {LogItem} element */
      async (element) => {
        await vscode.window.showTextDocument(vscode.Uri.file(logs.textOf(element.file)));
      },
    ),
  );
}

/**
 * Called by VSCode when the extension is deactivated.
 * @returns {void}
 */
function deactivate() {}

module.exports = { activate, deactivate };
