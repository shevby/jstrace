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
 */

/**
 * A node of a log's call tree.
 * @typedef {object} NodeItem
 * @property {'node'} kind
 * @property {LogItem} log
 * @property {TraceNode} node
 */

/** @typedef {ProjectItem | LogItem | NodeItem} Item */

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
    if (element.kind === 'log') {
      this.update(element);
      return element.trace.roots.map((node) => this.nodeItem(element, node));
    }
    return element.node.children.map((node) => this.nodeItem(element.log, node));
  }

  /**
   * @param {Item} element
   * @returns {Item | undefined}
   */
  getParent(element) {
    if (element.kind === 'node') return element.node.parent ? this.nodeItem(element.log, element.node.parent) : element.log;
    if (element.kind === 'log') return element.project;
    return undefined;
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
    const { node, log } = element;
    const event = node.event;
    const item = new vscode.TreeItem(logs.nodeLabel(node, log.root), node.children.length > 0 ? Collapsed : None);
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
    return item;
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
        item = { kind: 'log', file, root: folder.uri.fsPath, project, stamp: '', trace: logs.parseLog(''), nodes: new Map() };
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
    } catch {}
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
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preserveFocus: true });
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
        await vscode.commands.executeCommand('jstrace.open', event.file, event.line, event.column);
        if (call) await view.reveal(provider.nodeItem(element.log, call), { select: true, focus: true });
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
