'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { copyFixture } = require('../test/helpers');

/**
 * Just enough of the `vscode` API for the extension to activate and its tree and commands
 * to run, recording what it shows.
 * @param {string} dir the one workspace folder
 */
function fakeVscode(dir) {
  /** @type {Record<string, (...args: any[]) => any>} */
  const commands = {};
  /** @type {string[]} */
  const messages = [];
  /** @type {any} */
  let provider;
  /** @type {any[]} */
  const revealed = [];
  /** @type {any[]} */
  const opened = [];
  const folder = { name: path.basename(dir), index: 0, uri: { fsPath: dir, scheme: 'file' } };
  /** @param {string} kind */
  const message = (kind) => async (/** @type {string} */ text, /** @type {any[]} */ ...rest) => {
    messages.push(`${kind}: ${text}`);
    return kind === 'warning' && rest.some((item) => item?.modal) ? 'Delete' : undefined;
  };
  const vscode = {
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose() {} });
      }
      fire() {}
    },
    TreeItem: class {
      /** @param {string} label @param {number} collapsibleState */
      constructor(label, collapsibleState) {
        Object.assign(this, { label, collapsibleState });
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      /** @param {string} id */
      constructor(id) {
        this.id = id;
      }
    },
    ThemeColor: class {},
    MarkdownString: class {
      /** @param {string} value */
      constructor(value) {
        this.value = value;
      }
    },
    Position: class {
      /** @param {number} line @param {number} character */
      constructor(line, character) {
        Object.assign(this, { line, character });
      }
    },
    Range: class {
      /** @param {any} start @param {any} end */
      constructor(start, end) {
        Object.assign(this, { start, end });
      }
    },
    Uri: { file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: 'file' }) },
    window: {
      createTreeView: (/** @type {string} */ id, /** @type {any} */ options) => {
        provider = options.treeDataProvider;
        return { reveal: async (/** @type {any} */ item) => void revealed.push(item), dispose() {} };
      },
      createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      showTextDocument: async (/** @type {any} */ document, /** @type {any} */ options) => void opened.push({ file: document.fsPath, options }),
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [folder],
      getWorkspaceFolder: (/** @type {any} */ uri) => (uri.fsPath.startsWith(dir) ? folder : undefined),
      getConfiguration: () => ({ get: (/** @type {string} */ key, /** @type {any} */ value) => value }),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      openTextDocument: async (/** @type {any} */ uri) => ({ fsPath: uri.fsPath, validatePosition: (/** @type {any} */ position) => position }),
    },
    commands: {
      registerCommand: (/** @type {string} */ name, /** @type {(...args: any[]) => any} */ handler) => {
        commands[name] = handler;
        return { dispose() {} };
      },
      executeCommand: (/** @type {string} */ name, /** @type {any[]} */ ...args) => commands[name](...args),
    },
  };
  return { vscode, commands, messages, revealed, opened, provider: () => provider };
}

/**
 * Loads the extension with a fake `vscode` and activates it.
 * @param {string} dir the workspace folder
 */
function activate(dir) {
  const fake = fakeVscode(dir);
  const mod = /** @type {any} */ (Module);
  const load = mod._load;
  mod._load = (/** @type {string} */ request, /** @type {any[]} */ ...rest) => (request === 'vscode' ? fake.vscode : load(request, ...rest));
  try {
    delete require.cache[require.resolve('./extension')];
    require('./extension').activate(/** @type {any} */ ({ subscriptions: [], extensionPath: __dirname }));
  } finally {
    mod._load = load;
  }
  return fake;
}

test('the extension injects, shows the call trees, jumps to code, restores and clears logs', async (t) => {
  const dir = copyFixture(t, 'app');
  const fake = activate(dir);
  const provider = fake.provider();
  assert.deepEqual(provider.getChildren(), [], 'no .jstrace/ yet');

  await fake.commands['jstrace.inject']({ fsPath: dir, scheme: 'file' }, [{ fsPath: dir, scheme: 'file' }]);
  assert.deepEqual(fake.messages, ['warning: Instrumented 7 files, skipped 1 (lib/esm.js: skipped, it can\'t be parsed as a CommonJS script (\'import\' and \'export\' may appear only with \'sourceType: module\' (4:0)))']);
  assert.deepEqual(provider.getChildren(), [], 'no logs yet');
  execFileSync(process.execPath, ['index.js'], { cwd: dir });

  const [child, app] = provider.getChildren();
  assert.deepEqual([provider.getTreeItem(app).label, provider.getTreeItem(child).label], ['index.js', 'child.js 4']);
  assert.equal(provider.getParent(app), undefined);
  const roots = provider.getChildren(app);
  assert.equal(provider.getTreeItem(roots[0]).label, 'load index.js');
  const main = roots.find((/** @type {any} */ item) => item.node.event.name === 'main');
  const mainItem = provider.getTreeItem(main);
  assert.deepEqual([mainItem.label, mainItem.description, mainItem.iconPath.id], ['main()', '← undefined', 'symbol-function']);
  assert.equal(mainItem.command.command, 'jstrace.open');

  const calls = provider.getChildren(main);
  const factorial = calls.find((/** @type {any} */ item) => item.node.event.name === 'factorial');
  assert.equal(provider.getParent(factorial), main);
  const item = provider.getTreeItem(factorial);
  assert.deepEqual([item.label, item.description], ['factorial(n: 5)', '← 120']);
  assert.match(provider.resolveTreeItem(item, factorial).tooltip.value, /Returned:/);
  await fake.commands[item.command.command](...item.command.arguments);
  assert.deepEqual(JSON.parse(JSON.stringify(fake.opened.pop())), { file: path.join(dir, 'lib', 'math.js'), options: { selection: { start: { line: 6, character: 0 }, end: { line: 6, character: 0 } } } }, 'the editor takes the focus, to show its cursor');

  const divide = provider.getChildren(calls.find((/** @type {any} */ item) => item.node.event.name === 'safeDivide'))[0];
  assert.equal(provider.getTreeItem(divide).iconPath.id, 'error');

  const resume = roots.find((/** @type {any} */ item) => item.node.event.type === 'resume' && item.node.event.name === 'main');
  const resumeItem = provider.getTreeItem(resume);
  assert.equal(resumeItem.label, '↻ main() resumed');
  await fake.commands[resumeItem.command.command](...resumeItem.command.arguments);
  assert.equal(fake.revealed.pop(), main, 'a resume shows its call');

  fake.messages.length = 0;
  await fake.commands['jstrace.restore']();
  assert.deepEqual(fake.messages, ['info: Restored 7 files']);
  await fake.commands['jstrace.clearLogs']();
  assert.deepEqual(fake.messages.slice(1), ['warning: Delete 2 jstrace logs?']);
  assert.deepEqual(provider.getChildren(), []);
});
