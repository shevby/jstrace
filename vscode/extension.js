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
 * @property {string} stamp the file's size and time when it was read, to tell it changed
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

/**
 * How many calls of a function under a node make a group (setting `jstrace.groupRepeats`).
 * @returns {number} 0 for no groups
 */
function groupMin() {
  return Math.max(0, vscode.workspace.getConfiguration('jstrace').get('groupRepeats', 5));
}

/**
 * The size and modification time of a file, or `undefined` once it's gone.
 * @param {string} file
 * @returns {string | undefined}
 */
function stampOf(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
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
 * Logs are read when listed and read again once they change, but not watched while open
 * (no live tailing).
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
      if (folders.length === 1) return this.logsOf(folders[0], undefined);
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
      const item = new vscode.TreeItem(logs.logLabel(trace, file, root), Collapsed);
      item.id = `log:${file}`;
      item.description = logs.logDescription(trace);
      item.iconPath = new vscode.ThemeIcon('pulse');
      item.contextValue = 'log';
      const start = trace.start;
      item.tooltip = start
        ? `${(start.argv ?? []).join(' ')}\ncwd: ${start.cwd}\nstarted: ${start.started}\n${file}`
        : file;
      return item;
    }
    if (element.kind !== 'node') {
      const { row, log } = element;
      const event = row.event;
      const group = element.kind === 'group';
      const item = new vscode.TreeItem(group ? logs.groupLabel(row) : logs.skipLabel(event), group ? Collapsed : None);
      item.id = `${log.file}#${element.id}`;
      item.description = group ? logs.groupDescription(row) : '';
      item.iconPath = new vscode.ThemeIcon(group ? 'layers' : 'ellipsis');
      item.contextValue = element.kind;
      item.command = { title: 'Go to code', command: 'jstrace.open', arguments: [event.file, event.line ?? 1, event.column ?? 0] };
      return item;
    }
    const { node, log } = element;
    const event = node.event;
    const item = new vscode.TreeItem(logs.nodeLabel(node, log.root), node.children.length + node.skips.length > 0 ? Collapsed : None);
    item.id = `node:${log.file}#${event.id}`;
    item.description = logs.nodeDescription(node);
    const end = event.type === 'call' ? node.outcome ?? node.end : node.end;
    item.iconPath =
      end?.type === 'throw'
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
        : new vscode.ThemeIcon(event.type === 'load' ? 'file-code' : event.type === 'resume' ? 'debug-continue' : 'symbol-function');
    item.contextValue = event.type;
    item.command =
      event.type === 'resume'
        ? { title: 'Show the call', command: 'jstrace.showCall', arguments: [element] }
        : { title: 'Go to code', command: 'jstrace.open', arguments: [event.file, event.line ?? 1, event.column ?? 0] };
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
          kind: 'log', file, root: folder.uri.fsPath, project, stamp: '', trace: logs.parseLog(''), nodes: new Map(), rows: new Map(), parents: new Map(),
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
   * Reads a log again if it changed since it was read.
   * @param {LogItem} item
   * @returns {void}
   */
  update(item) {
    const stamp = stampOf(item.file);
    if (stamp === undefined || stamp === item.stamp) return;
    try {
      item.trace = logs.readLog(item.file);
      item.stamp = stamp;
      item.nodes.clear();
      item.rows.clear();
      item.parents.clear();
    } catch {}
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
 * Called by VSCode when the extension activates.
 * @param {vscode.ExtensionContext} context
 * @returns {void}
 */
function activate(context) {
  const provider = new CallsProvider();
  const view = vscode.window.createTreeView('jstrace.calls', { treeDataProvider: provider, showCollapseAll: true });
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

  context.subscriptions.push(
    view,
    output,
    watcher,
    { dispose: () => clearTimeout(pending) },
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
       * file is instrumented the line is right but the column may be off a little.
       * @param {string} file
       * @param {number} line
       * @param {number} column
       */
      async (file, line, column) => {
        try {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
          const position = document.validatePosition(new vscode.Position(Math.max(0, line - 1), column));
          // The editor takes the focus, since an unfocused one doesn't show its cursor.
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
        } catch (error) {
          vscode.window.showErrorMessage(`jstrace: can't open ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    ),

    vscode.commands.registerCommand(
      'jstrace.showCall',
      /**
       * Selects the call a resume is part of, and goes to the function's code.
       * @param {NodeItem} element a resume
       */
      async (element) => {
        const call = element.log.trace.nodes.get(element.node.event.call);
        const event = element.node.event;
        if (call) await view.reveal(provider.nodeItem(element.log, call), { select: true, focus: false });
        await vscode.commands.executeCommand('jstrace.open', event.file, event.line, event.column);
      },
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
