'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { APP_OUTPUT, copyFixture } = require('../test/helpers');

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
  /** @type {Record<string, any>} the tree views, by id */
  const views = {};
  /** @type {(string | undefined)[]} what the input boxes will be answered */
  const inputs = [];
  /** @type {(string[] | undefined)[]} the labels the quick picks will be answered with */
  const picks = [];
  /** @type {any[][]} the decorations set, last first */
  const decorations = [];
  /** @type {string[]} */
  const status = [];
  /** @type {any[]} */
  const revealed = [];
  /** @type {any[]} */
  const opened = [];
  /** @type {Record<string, any>} the settings that aren't their defaults, by key without a section */
  const settings = {};
  /** @type {{ provider?: any }} the CodeLens provider */
  const lenses = {};
  /** @type {{ document?: any }} the document shown last */
  const last = {};
  /** @type {Record<string, any>} the content providers, by scheme */
  const contents = {};
  const folder = { name: path.basename(dir), index: 0, uri: { fsPath: dir, scheme: 'file' } };
  /** @param {string} kind */
  const message = (kind) => async (/** @type {string} */ text, /** @type {any[]} */ ...rest) => {
    messages.push(`${kind}: ${text}`);
    return kind === 'warning' && rest.some((item) => item?.modal) ? 'Delete' : undefined;
  };
  const vscode = {
    EventEmitter: class {
      constructor() {
        /** @type {((value: unknown) => void)[]} */
        const listeners = [];
        this.listeners = listeners;
        this.event = (/** @type {(value: unknown) => void} */ listener) => (listeners.push(listener), { dispose() {} });
        /** @type {unknown[]} */
        this.fired = [];
      }
      /** @param {unknown} value */
      fire(value) {
        this.fired.push(value);
        for (const listener of this.listeners) listener(value);
      }
    },
    TreeItem: class {
      /** @param {string} label @param {number} collapsibleState */
      constructor(label, collapsibleState) {
        Object.assign(this, { label, collapsibleState });
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      /** @param {string} id @param {any} [color] */
      constructor(id, color) {
        Object.assign(this, { id, color });
      }
    },
    ThemeColor: class {
      /** @param {string} id */
      constructor(id) {
        this.id = id;
      }
    },
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
    Uri: {
      file: (/** @type {string} */ fsPath) => ({ fsPath, scheme: 'file' }),
      from: (/** @type {any} */ parts) => ({ ...parts, fsPath: parts.path, toString: () => `${parts.scheme}:${parts.path}?${parts.query}` }),
    },
    ViewColumn: { Beside: -2 },
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
    CodeLens: class {
      /** @param {any} range @param {any} command */
      constructor(range, command) {
        Object.assign(this, { range, command });
      }
    },
    languages: {
      setTextDocumentLanguage: async (/** @type {any} */ document, /** @type {string} */ language) => ({ ...document, language }),
      registerCodeLensProvider: (/** @type {any} */ selector, /** @type {any} */ provider) => ((lenses.provider = provider), { dispose() {} }),
    },
    window: {
      createTreeView: (/** @type {string} */ id, /** @type {any} */ options) =>
        (views[id] = {
          provider: options.treeDataProvider,
          reveal: async (/** @type {any} */ item) => void revealed.push(item),
          selection: [],
          onDidChangeSelection: () => ({ dispose() {} }),
          dispose() {},
        }),
      createTextEditorDecorationType: () => ({ dispose() {} }),
      onDidChangeTextEditorSelection: () => ({ dispose() {} }),
      setStatusBarMessage: (/** @type {string} */ text) => void status.push(text),
      showInputBox: async () => inputs.shift(),
      showQuickPick: async (/** @type {any[]} */ items) => {
        const labels = picks.shift();
        return labels && items.filter((item) => labels.includes(item.label));
      },
      withProgress: (/** @type {any} */ options, /** @type {() => Promise<void>} */ task) => task(),
      createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      showTextDocument: async (/** @type {any} */ document, /** @type {any} */ options) => {
        opened.push({ file: document.fsPath, text: document.text, language: document.language, options });
        last.document = document;
        return { document, setDecorations: (/** @type {any} */ type, /** @type {any[]} */ ranges) => void decorations.unshift(ranges) };
      },
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [folder],
      getWorkspaceFolder: (/** @type {any} */ uri) => (uri.fsPath.startsWith(dir) ? folder : undefined),
      getConfiguration: () => ({ get: (/** @type {string} */ key, /** @type {any} */ value) => (key in settings ? settings[key] : value) }),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      openTextDocument: async (/** @type {any} */ uri) => {
        const lines = uri.scheme === 'file' ? fs.readFileSync(uri.fsPath, 'utf8').split(/\r?\n/) : [];
        return {
          fsPath: uri.fsPath,
          text: contents[uri.scheme]?.provideTextDocumentContent(uri),
          lineCount: lines.length,
          lineAt: (/** @type {number} */ line) => ({ text: lines[line] }),
          validatePosition: (/** @type {any} */ position) => position,
        };
      },
      registerTextDocumentContentProvider: (/** @type {string} */ scheme, /** @type {any} */ provider) => {
        contents[scheme] = provider;
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand: (/** @type {string} */ name, /** @type {(...args: any[]) => any} */ handler) => {
        commands[name] = handler;
        return { dispose() {} };
      },
      executeCommand: (/** @type {string} */ name, /** @type {any[]} */ ...args) => commands[name]?.(...args), // and the views' own
    },
  };
  return { vscode, commands, messages, revealed, opened, inputs, picks, views, decorations, status, settings, lenses, last, provider: () => views['jstrace.calls'].provider };
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
  const main = roots.find((/** @type {any} */ item) => item.node?.event.name === 'main');
  const mainItem = provider.getTreeItem(main);
  assert.deepEqual([mainItem.label, mainItem.description, mainItem.iconPath.id], ['main()', '← undefined', 'symbol-function']);
  assert.equal(mainItem.command.command, 'jstrace.showStep');

  const calls = provider.getChildren(main);
  const factorial = calls.find((/** @type {any} */ item) => item.node.event.name === 'factorial');
  assert.equal(provider.getParent(factorial), main);
  const item = provider.getTreeItem(factorial);
  assert.deepEqual([item.label, item.description], ['factorial(n: 5)', '← 120']);
  assert.match(provider.resolveTreeItem(item, factorial).tooltip.value, /Returned:/);
  /** @param {string} file @param {number} line @param {number} character @param {object} [focus] */
  const at = (file, line, character, focus = {}) => ({ file: path.join(dir, file), options: { selection: { start: { line, character }, end: { line, character } }, ...focus } });
  const opened = () => JSON.parse(JSON.stringify(fake.opened.pop()));
  assert.equal(provider.getTreeItem(factorial).contextValue, 'callSite');
  const document = () => fake.last.document;
  await fake.commands[item.command.command](...item.command.arguments);
  const lens = fake.lenses.provider.provideCodeLenses(document());
  assert.deepEqual(opened(), at('index.js', 25, 36, { preserveFocus: true }), 'a click shows where it was called, on the call, the tree keeping the focus');
  assert.deepEqual(JSON.parse(JSON.stringify(lens.map((/** @type {any} */ lens) => [lens.range.start, lens.command.title, lens.command.command]))), [[{ line: 25, character: 0 }, 'factorial(n: 5)  ← 120', 'jstrace.showDetails']], 'with its values above the line');
  assert.deepEqual([fake.decorations[0][0].renderOptions, fake.decorations[0][0].range.end.line], [undefined, 25], 'the line highlighted');
  assert.match(fake.decorations[0][0].hoverMessage.value, /Returned:/, 'its tooltip on hover');
  await fake.commands['jstrace.hideStep']();
  assert.equal(fake.decorations[0].length, 0, 'which Esc hides');
  assert.deepEqual(fake.lenses.provider.provideCodeLenses(document()), [], 'with its CodeLens');
  fake.settings.stepHint = 'end';
  await fake.commands[item.command.command](...item.command.arguments);
  assert.deepEqual(fake.lenses.provider.provideCodeLenses(document()), []);
  assert.equal(fake.decorations[0][0].renderOptions.after.contentText, 'factorial(n: 5)  ← 120', 'or at its end');
  Object.assign(fake.settings, { stepHint: 'above', codeLens: false });
  await fake.commands[item.command.command](...item.command.arguments);
  assert.deepEqual(fake.lenses.provider.provideCodeLenses(document()), [], 'at its end where CodeLens is off');
  assert.equal(fake.decorations[0][0].renderOptions.after.contentText, 'factorial(n: 5)  ← 120');
  Object.assign(fake.settings, { stepHint: 'hover', codeLens: true });
  await fake.commands[item.command.command](...item.command.arguments);
  assert.deepEqual([fake.lenses.provider.provideCodeLenses(document()), fake.decorations[0][0].renderOptions], [[], undefined], 'or only on hover');
  fake.settings.stepHint = 'end';
  await fake.commands['jstrace.hideStep']();
  await fake.commands['jstrace.goToSite'](factorial);
  assert.deepEqual(opened(), at('index.js', 25, 36), 'Go to Call Site: there too, the editor taking the focus to show its cursor');
  await fake.commands['jstrace.goToFunction'](factorial);
  assert.deepEqual(opened(), at(path.join('lib', 'math.js'), 6, 0), 'the button goes to the function');
  assert.match(provider.resolveTreeItem(item, factorial).tooltip.value, /Called from index\.js:26/);

  await fake.commands['jstrace.showDetails'](factorial);
  const shown = fake.opened.pop();
  assert.deepEqual([shown.file, shown.language, shown.options], ['/factorial #9.jsonc', 'jsonc', { preview: true, viewColumn: -2 }]);
  assert.match(shown.text, /^\/\/ factorial\(n: 5\) {2}#9\n[^]*"returned": 120/);
  await fake.commands['jstrace.showDetails'](provider.getChildren(app)[0]);
  assert.match(fake.opened.pop().text, /^\/\/ load index\.js/);

  fake.revealed.length = 0;
  await fake.commands['jstrace.expandAll'](main);
  const labels = fake.revealed.map((/** @type {any} */ item) => provider.getTreeItem(item).label);
  assert.equal(labels[0], 'main()');
  assert.ok(labels.includes('factorial(n: 2)'), 'the deepest calls are expanded');
  assert.ok(!labels.includes('factorial(n: 1)'), 'what has nothing under it is left alone');
  fake.revealed.length = 0;

  const divide = provider.getChildren(calls.find((/** @type {any} */ item) => item.node.event.name === 'safeDivide'))[0];
  assert.equal(provider.getTreeItem(divide).iconPath.id, 'error');

  const resumes = roots.find((/** @type {any} */ item) => item.kind === 'group' && item.row.event.name === 'double');
  const groupItem = provider.getTreeItem(resumes);
  assert.equal(groupItem.label, '↻ double() resumed ×6', 'the resumes of its 6 calls are grouped (jstrace.groupRepeats is 5)');
  assert.equal(groupItem.iconPath.id, 'layers');
  const [resume] = provider.getChildren(resumes);
  assert.equal(provider.getParent(resume), resumes);
  const resumeItem = provider.getTreeItem(resume);
  assert.equal(resumeItem.label, '↻ double() resumed');
  await fake.commands[resumeItem.command.command](...resumeItem.command.arguments);
  const double = fake.revealed.pop();
  assert.equal(double.node.event.id, resume.node.event.call, 'a resume shows its call');
  assert.match(fake.decorations[0][0].renderOptions.after.contentText, /^double\(value: \d\)  ← \d+$/, 'as a step does');
  assert.equal(provider.getTreeItem(provider.getParent(double)).label, 'total(values: [1,2,3])', 'which the tree can reach');

  fake.messages.length = 0;
  await fake.commands['jstrace.restore']();
  assert.deepEqual(fake.messages, ['info: Restored 7 files']);
  await fake.commands['jstrace.clearLogs']();
  assert.deepEqual(fake.messages.slice(1), ['warning: Delete 2 jstrace logs?']);
  assert.deepEqual(provider.getChildren(), []);
});

test('with externalCalls, calls of functions that are not traced show where they were made', async (t) => {
  const dir = copyFixture(t, 'app');
  fs.writeFileSync(path.join(dir, 'jstrace.config.json'), '{ "externalCalls": true }');
  const fake = activate(dir);
  const provider = fake.provider();
  await fake.commands['jstrace.inject']({ fsPath: dir, scheme: 'file' }, [{ fsPath: dir, scheme: 'file' }]);
  const stdout = execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' });
  assert.equal(stdout, APP_OUTPUT);

  const app = provider.getChildren().find((/** @type {any} */ item) => provider.getTreeItem(item).label === 'index.js');
  const main = provider.getChildren(app).find((/** @type {any} */ item) => item.node?.event.name === 'main');
  const calls = provider.getChildren(main);
  assert.ok(!calls.some((/** @type {any} */ item) => item.node?.event.name === 'lines.push'), 'ignored by default');
  const sort = calls.find((/** @type {any} */ item) => item.node?.event.name === 'shapes.sort');
  const item = provider.getTreeItem(sort);
  assert.deepEqual([item.label, item.contextValue, item.iconPath.id], ['shapes.sort("[Function compare]")', 'external', 'link-external']);
  assert.ok(provider.getChildren(sort).some((/** @type {any} */ inner) => inner.node?.event.name === 'Shape->compare'), 'the traced callback runs inside it');
  await fake.commands[item.command.command](...item.command.arguments);
  const line = fs.readFileSync(path.join(dir, '.jstrace', 'backup', 'index.js'), 'utf8').split('\n')[36];
  assert.deepEqual(JSON.parse(JSON.stringify(fake.opened.pop().options.selection.start)), { line: 36, character: line.indexOf('sort(') }, 'on the callee, as in the original');
});

test('logs of processes merge into a new one, each call marked with its named process', async (t) => {
  const dir = copyFixture(t, 'app');
  const fake = activate(dir);
  const provider = fake.provider();
  await fake.commands['jstrace.inject']({ fsPath: dir, scheme: 'file' }, [{ fsPath: dir, scheme: 'file' }]);
  execFileSync(process.execPath, ['index.js'], { cwd: dir });
  const [child, app] = provider.getChildren();

  fake.inputs.push('server');
  await fake.commands['jstrace.nameProcess'](app);
  assert.equal(provider.getTreeItem(app).label, 'server · index.js', 'a named process shows its name');

  fake.inputs.push(''); // the child's name: its script's
  await fake.commands['jstrace.mergeLogs'](app, [app, child]);
  const [merged, ...rest] = provider.getChildren();
  assert.equal(rest.length, 2, 'the logs merged stay');
  const item = provider.getTreeItem(merged);
  assert.deepEqual([item.label, item.contextValue, item.iconPath.id], ['merged: server + child', 'mergedLog', 'git-merge']);
  assert.match(item.description, /  pids \d+, \d+$/);
  assert.deepEqual(fake.revealed, [merged], 'shown once made');
  assert.equal(provider.getTreeItem(child).label, 'child · child.js 4', 'the name it got');

  const roots = provider.getChildren(merged);
  const labels = roots.map((/** @type {any} */ root) => String(provider.getTreeItem(root).label));
  const pids = /** @type {any[]} */ (merged.trace.start?.merged).map((proc) => proc.pid);
  assert.equal(labels[0], `server ${pids[0]} › load index.js`);
  assert.ok(labels.includes(`child ${pids[1]} › load child.js`));
  assert.ok(labels.indexOf(`server ${pids[0]} › load index.js`) < labels.indexOf(`child ${pids[1]} › load child.js`), 'in the order they ran');
  const colors = roots.map((/** @type {any} */ root) => provider.getTreeItem(root).iconPath.color?.id);
  assert.deepEqual([...new Set(colors)].sort(), ['charts.blue', 'charts.orange'], 'a color per process');
  assert.match(fs.readFileSync(merged.file.replace(/[.]jsonl$/, '.txt'), 'utf8'), /\nserver \d+ +│ load index\.js\n/);

  fake.picks.push(['server · index.js', 'child · child.js 4']);
  await fake.commands['jstrace.mergeLogs'](app);
  assert.equal(provider.getChildren().length, 4, 'one log picks the others from a list');
});

test('Create Mock makes one from the template, names it in the config and opens it', async (t) => {
  const dir = copyFixture(t, 'app');
  const fake = activate(dir);
  await fake.commands['jstrace.createMock']();
  assert.match(fake.messages[0], /^info: Created jstrace\.mock\.js from the template/);
  assert.equal(fake.opened.pop().file, path.join(dir, 'jstrace.mock.js'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'jstrace.config.json'), 'utf8')).mock, 'jstrace.mock.js');
});

test('the tree follows a log as it is written, keeping its items', (t) => {
  const dir = copyFixture(t, 'app');
  const folder = path.join(dir, '.jstrace', 'logs');
  fs.mkdirSync(folder, { recursive: true });
  const provider = activate(dir).provider();
  const log = path.join(folder, '2026-01-01T00-00-00.000Z-1.jsonl');
  const index = path.join(dir, 'index.js');
  const lines = (/** @type {object[]} */ ...events) => events.map((event) => `${JSON.stringify(event)}\n`).join('');
  fs.writeFileSync(log, lines(
    { type: 'start', pid: process.pid, argv: ['node', index], cwd: dir, started: new Date().toISOString(), time: 0 },
    { type: 'call', id: 1, parent: null, depth: 0, name: 'main', file: index, line: 23, column: 0, args: {}, time: 1 },
  ));

  const [item] = provider.getChildren();
  const logItem = provider.getTreeItem(item);
  assert.equal(logItem.iconPath.id, 'sync~spin', 'its process runs');
  assert.match(logItem.description, /running$/);
  const [main] = provider.getChildren(item);
  assert.equal(provider.getTreeItem(main).description, 'running…');

  fs.appendFileSync(log, lines(
    { type: 'call', id: 2, parent: 1, depth: 1, name: 'greet', file: index, line: 6, column: 0, args: {}, time: 2 },
    { type: 'return', call: 2, parent: 2, value: 'hi', time: 3 },
    { type: 'return', call: 1, parent: 1, time: 4 },
  ));
  provider.changed.fired.length = 0;
  provider.tick();
  assert.deepEqual(provider.changed.fired, [item], 'only the log that grew is refreshed');
  assert.equal(provider.getChildren(item)[0], main, 'with the same items, so what is expanded stays expanded');
  assert.equal(provider.getTreeItem(main).description, '← undefined');
  assert.deepEqual(provider.getChildren(main).map((/** @type {any} */ child) => provider.getTreeItem(child).label), ['greet()']);
  provider.tick();
  assert.equal(provider.changed.fired.length, 1, 'nothing new, nothing refreshed');
});

test('the Search view finds calls in every log; a double-click shows one in the Calls view', async (t) => {
  const dir = copyFixture(t, 'app');
  const folder = path.join(dir, '.jstrace', 'logs');
  fs.mkdirSync(folder, { recursive: true });
  const fake = activate(dir);
  const provider = fake.provider();
  const view = fake.views['jstrace.searchResults'];
  const search = view.provider;
  const index = path.join(dir, 'index.js');
  const adds = [1, 2, 3, 4, 5, 6].flatMap((n) => [
    { type: 'call', id: n + 1, parent: 1, depth: 1, name: 'add', file: index, line: 6, column: 0, args: { n }, site: { file: index, line: 26 }, time: n },
    { type: 'return', call: n + 1, parent: n + 1, value: n * 2, time: n },
  ]);
  fs.writeFileSync(path.join(folder, '2026-01-01T00-00-00.000Z-1.jsonl'), [
    { type: 'start', pid: 1, argv: ['node', index], cwd: dir, started: '2026-01-01T00:00:00.000Z', time: 0 },
    { type: 'call', id: 1, parent: null, depth: 0, name: 'main', file: index, line: 23, column: 0, args: {}, time: 0 },
    ...adds,
    { type: 'return', call: 1, parent: 1, time: 7 },
  ].map((event) => `${JSON.stringify(event)}\n`).join(''));

  assert.deepEqual(search.getChildren(), [], 'nothing searched yet');
  fake.inputs.push('ADD 3');
  await fake.commands['jstrace.search']();
  const [results] = search.getChildren();
  assert.equal(view.message, '1 match for “ADD 3”');
  const resultsItem = search.getTreeItem(results);
  assert.equal(resultsItem.label, 'index.js');
  assert.match(resultsItem.description, /^1 {2}2026-01-01 .* {2}pid 1$/, 'how many matched in the log');
  const [add] = search.getChildren(results);
  const item = search.getTreeItem(add);
  assert.deepEqual([item.label, item.description, item.contextValue], [{ label: 'add(n: 3)', highlights: [[0, 3], [7, 8]] }, '← 6  index.js:6', 'callSite']);
  assert.match(search.resolveTreeItem(item, add).tooltip.value, /^In main\(\) #1\n/);

  const [other] = search.getChildren(search.getChildren()[0]);
  await fake.commands[item.command.command](...item.command.arguments);
  assert.equal(fake.opened.pop().options.selection.start.line, 25, 'a click goes to where it was called, as in the Calls view');
  assert.deepEqual(fake.revealed, []);
  await fake.commands[item.command.command](...item.command.arguments);
  assert.deepEqual(fake.revealed, [add], 'a double-click shows it in the Calls view');
  assert.equal(fake.opened.length, 0);
  assert.equal(other, add, 'the very item the Calls view has');
  const group = provider.getParent(add);
  assert.equal(provider.getTreeItem(group).label, 'add() ×6', 'which it can reach through its group');

  fake.inputs.push('nothing like it');
  await fake.commands['jstrace.search']();
  assert.deepEqual(search.getChildren(), []);
  assert.equal(view.message, 'No calls match “nothing like it”.');
  await fake.commands['jstrace.clearSearch']();
  assert.deepEqual([search.getChildren(), view.message], [[], undefined]);

  const window = /** @type {any} */ (fake.vscode.window);
  /** @param {number} line @returns {Promise<number[]>} the ids found at the line */
  const findAt = async (line) => {
    window.activeTextEditor = { document: { uri: { fsPath: index, scheme: 'file' } }, selection: { active: { line: line - 1 } } };
    await fake.commands['jstrace.searchLine']();
    return search.getChildren().flatMap((/** @type {any} */ results) => search.getChildren(results).map((/** @type {any} */ node) => node.node.event.id));
  };
  assert.deepEqual(await findAt(26), [2, 3, 4, 5, 6, 7], "the calls made from the cursor's line");
  assert.equal(view.message, '6 calls at index.js:26');
  assert.deepEqual(await findAt(23), [1], 'the calls of a function defined on it');
  assert.equal(view.message, '1 call at index.js:23');
  assert.deepEqual(await findAt(1), []);
  assert.equal(view.message, 'No calls at index.js:1.');
  window.activeTextEditor = undefined;
  await fake.commands['jstrace.searchLine']();
  assert.equal(fake.messages.pop(), 'info: jstrace: open a file to find the calls at its line.');
  await fake.commands['jstrace.clearSearch']();
  assert.deepEqual([search.getChildren(), view.message], [[], undefined]);
});

test('stepping goes through the run, showing each call where it was called with its values', async (t) => {
  const dir = copyFixture(t, 'app');
  const folder = path.join(dir, '.jstrace', 'logs');
  fs.mkdirSync(folder, { recursive: true });
  const fake = activate(dir);
  fake.settings.stepHint = 'end'; // the values at the line's end
  const provider = fake.provider();
  const calls = fake.views['jstrace.calls'];
  const index = path.join(dir, 'index.js');
  const adds = [1, 2, 3, 4, 5, 6].flatMap((n) => [
    { type: 'call', id: n + 1, parent: 1, depth: 1, name: 'add', file: index, line: 6, column: 0, args: { n }, site: { file: index, line: 26 }, time: n },
    { type: 'return', call: n + 1, parent: n + 1, value: n * 2, time: n },
  ]);
  fs.writeFileSync(path.join(folder, '2026-01-01T00-00-00.000Z-1.jsonl'), [
    { type: 'start', pid: 1, argv: ['node', index], cwd: dir, started: '2026-01-01T00:00:00.000Z', time: 0 },
    { type: 'call', id: 1, parent: null, depth: 0, name: 'main', file: index, line: 23, column: 0, args: {}, time: 0 },
    ...adds,
    { type: 'return', call: 1, parent: 1, time: 7 },
  ].map((event) => `${JSON.stringify(event)}\n`).join(''));
  const [log] = provider.getChildren();
  const [main] = provider.getChildren(log);
  const at = () => {
    const item = fake.revealed.pop();
    calls.selection = [item]; // as the reveal selects it
    const { options } = fake.opened.pop();
    return [item.node.event.id, options.selection.start.line, options.preserveFocus, fake.decorations[0][0]?.renderOptions.after.contentText];
  };

  calls.selection = [main];
  await fake.commands['jstrace.stepInto']();
  assert.deepEqual(at(), [2, 25, true, 'add(n: 1)  ← 2'], 'into: the first call in main(), on its call site, the view keeping the focus');
  assert.equal(provider.getTreeItem(provider.getParent(calls.selection[0])).label, 'add() ×6', 'revealed in its group');
  await fake.commands['jstrace.stepOver']();
  assert.deepEqual(at(), [3, 25, true, 'add(n: 2)  ← 4']);
  await fake.commands['jstrace.stepBack']();
  assert.equal(at()[0], 2);
  await fake.commands['jstrace.stepOut']();
  assert.deepEqual(at(), [1, 22, true, 'main()  ← undefined'], 'out: the caller, at its own code since it has no site');
  assert.deepEqual(fake.decorations[1], [], 'the last step lost its highlight');
  await fake.commands['jstrace.stepBackOver']();
  assert.deepEqual([fake.revealed, fake.status], [[], ['jstrace: no call before it']], 'nothing before main()');

  await fake.commands['jstrace.stepOver'](log);
  assert.equal(at()[0], 1, 'from a log: its first call (the context menu passes the item)');
  const group = provider.getParent(provider.nodeItem(log, log.trace.nodes.get(7)));
  await fake.commands['jstrace.stepOver'](group);
  assert.deepEqual([fake.revealed, fake.status.length], [[], 2], 'over a group: past its last call, here the end');
  fake.views['jstrace.searchResults'].selection = [provider.nodeItem(log, log.trace.nodes.get(4))];
  await fake.commands['jstrace.stepInto']('search');
  assert.equal(at()[0], 5, "from the Search view's selection (its keys)");
});
