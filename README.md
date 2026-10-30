# jstrace

jstrace traces the function calls of any CommonJS JavaScript program, with no changes to its code by hand. It has two parts:

- **The CLI** injects tracing into every function of the `.js` files in a folder (keeping the originals). Then you run the program as usual, and it writes a log of every call: its arguments, what it returned or threw, where it was called from, and the files loaded.
- **The VSCode extension** shows those logs as call trees beside your code. You can jump from a call to its code, search, step through a run like a debugger after the fact, and merge the logs of processes that talk to each other.

It's a debugging aid: tracing is slow, and that's fine.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The Calls view](#the-calls-view)
- [Configuration](#configuration)
- [External calls](#external-calls)
- [Merging processes](#merging-processes)
- [Mocking the runtime](#mocking-the-runtime)
- [Logs](#logs)
- [Limits](#limits)
- [Development](#development)
- [License](#license)

## Install

You need Node.js 18 or newer to run the CLI. Traced programs can run on Node 12 or newer. The extension needs VSCode 1.96 or newer.

1. Build the extension from this repository:

   ```sh
   npm install
   npm run package
   ```

   This writes `jstrace-vscode-0.1.0.vsix`, with the CLI packed inside.

2. Install it, then reload VSCode (**Developer: Reload Window**):

   ```sh
   code --install-extension jstrace-vscode-0.1.0.vsix --force
   ```

   Run the same two commands again to update it.

To use the CLI on its own, run `node <this repo>/cli/bin/jstrace.js`, or install it as the `jstrace` command with `npm install --global ./cli`.

## Quick start

### In VSCode

1. In the Explorer, right-click the folder (or files) to trace and choose **jstrace: Inject**. The first time, this creates `jstrace.config.json` with the defaults. To change the config before anything is injected, first run **jstrace: Init** from the command palette (`Ctrl+Shift+P`; also a button in the empty Calls view): it creates the config and `.jstrace/`, and opens the config.
2. Run your program as you always do, for example `node index.js`.
3. Open the **jstrace** view in the activity bar. Each run is a log there, newest first; expand it to see its calls.
4. When you're done, click **Restore Original Files** in the view's title bar.
5. To trace the same files again (after editing your code, or the config), run **jstrace: Reinject** from the command palette. It injects again every folder and file you injected since the last time all was restored, picking up new files in those folders.

### On the command line

```sh
cd my-project
jstrace init                # optional: creates jstrace.config.json to edit first
jstrace instrument .        # or: jstrace instrument src lib/util.js
node index.js               # writes .jstrace/logs/<time>-<pid>.jsonl and .txt
jstrace restore             # puts every original file back
```

| Command | What it does |
| --- | --- |
| `jstrace init` | Creates `jstrace.config.json` with the defaults (or checks the one there) and `.jstrace/`, so you can configure tracing before instrumenting anything. |
| `jstrace instrument <path...>` | Injects tracing into the files under the paths. The originals go to `.jstrace/backup/`. Instrumenting again starts from the originals, so it picks up config changes. |
| `jstrace restore [path...]` | Puts the originals back: all of them, or those under the paths. A file you edited since it was instrumented is left alone, and reported. Logs stay. |
| `jstrace reinject` | Instruments again the paths instrumented since the last time all was restored (after that, until then), as `instrument` would. They're recorded in `.jstrace/injected.json`. Paths gone since are skipped. |
| `jstrace mock [file]` | Creates a mock of what tracing uses from a template, and names it in the config. See [Mocking the runtime](#mocking-the-runtime). |
| `jstrace help` | Shows the usage. |

The **project** is the folder holding `jstrace.config.json` and `.jstrace/`. That's the current folder, or the nearest one above it that already has either. To name it instead, put `--project <folder>` before the command. In VSCode it's always the workspace folder. Line numbers in an instrumented file stay the same as in the original, so stack traces still point to the right lines.

## The Calls view

Each log is one process, labeled by its script and arguments, with its start time and pid. A log whose process is still running shows a spinning icon, and its calls appear as they're made.

- **Clicking a call** shows where it was called: the line is highlighted in the editor, with the call's arguments and result at its end. The focus stays in the tree, so you can step on from there. Press `Esc` (or click elsewhere in the editor) to hide the highlight.
- **Inline buttons** on a call, in order:
  - **Go to Function**: opens the function's code.
  - **Show Details**: opens a tab beside with when the call ran, how long it took, the calls it ran in, and its arguments and outcome, pretty-printed.
  - **Go to Call Site** (`→`): puts the cursor on the call.
- **Repeated calls** of a function under one call are grouped as `name() ×count` once there are five or more (setting `jstrace.groupRepeats`).
- **Resumes**: when an async function goes on after an `await`, the rest of it is a node of its own, `↻ name() resumed`. Clicking it shows its call.
- **Errors**: a call that threw has a red icon.
- **Right-click** a call for **Expand All Below**, or a log for **Open as Text**, **Merge Logs…**, **Name Process…** and **Delete Log** (also `Delete`, or `Cmd+Backspace` on macOS, on the logs selected; it asks first).

**Show by Time** (the history button in the view's title bar) lists every record of a log at one level, in the order it happened, instead of as call trees: its calls, resumes and loads, and the calls not logged. Each call's row still shows what it returned or threw. It's made for following how programs talk, so it's most useful on a [merged log](#merging-processes). The hover says what each call ran in. Clicking a row shows it as in the tree, except that a resume stays selected, and stepping goes on from it. The clock button next to it shows or hides the timestamps (`10:15:03.123`, by your computer's clock). Both choices are kept for the workspace. A log of more than 2000 records is split into pages of 2000, each labeled with when it starts and ends. The list icon button goes back to the call trees.

**Search** (the magnifier button) finds calls in every log by function name, arguments, result, `file:line`, or the line of code that made the call, so `taxRate` finds `sum(items, taxRate)` by the variable's name. That line is also in a call's hover and details, as "called as". Only calls made from instrumented files have it, and only in logs written since Inject started recording it. Every word must match, ignoring case. Results appear in the **Search** view. A click goes to the code, and a double-click shows the call in the Calls view.

**jstrace: Find Calls at This Line** (the editor's context menu, or the command palette) lists in the Search view the calls at the cursor's line: those made from it, and those of a function defined on it.

**Stepping**: with the Calls or Search view focused, step through a run in the order it happened:

| Keys | Step |
| --- | --- |
| `Alt+↓` | Into: the next call |
| `Alt+Shift+↓` | Over: the next call that isn't inside this one |
| `Alt+↑` | Back: the call before |
| `Alt+Shift+↑` | Back over |
| `Alt+←` | Out: the call this one ran in |

On macOS, `Alt` is `⌥ Option`. The same steps are in the context menu, under **Step**.

A step (or a click on a call) highlights the line, with the call's arguments and outcome above it. Click that text for the call's details, or hover the line to see them in full. The setting `jstrace.stepHint` moves the text to the end of the line, or shows it only on hover. Its colors are the theme colors `jstrace.stepBackground` and `jstrace.stepForeground`, which you can change in `workbench.colorCustomizations`.

| Setting | Default | What it does |
| --- | --- | --- |
| `jstrace.stepHint` | `above` | Where a step shows the call's values: `above` the line (a CodeLens, or at the end where CodeLens is off), at its `end`, or only on `hover`. |
| `jstrace.groupRepeats` | `5` | How many calls of a function under one call make a group; `0` for no groups. |

## Configuration

`jstrace.config.json` sits in the project folder. Globs and paths in it are relative to the project. Instrument again after changing it.

```json
{
  "include": ["**/*.js", "**/*.cjs"],
  "exclude": [".git/**", ".jstrace/**", "**/*.min.js"],
  "maxDepth": 3,
  "maxString": 200,
  "maxLine": 2000,
  "maxRepeat": 20,
  "callSites": true,
  "externalCalls": false,
  "ignoreCalls": ["require", "console.*", "Math.*", "Object.*", "*.push", "setTimeout", "…"],
  "mock": ""
}
```

| Field | What it does |
| --- | --- |
| `include`, `exclude` | Which files `instrument` takes under a folder. `node_modules` isn't excluded, since your own code can be there. A file named outright is always taken. |
| `maxDepth` | How deep arguments and results are logged. Deeper objects show as `[Object]`, `[Array(3)]`. |
| `maxString` | How many characters of a string are logged. |
| `maxLine` | Roughly how many characters one event's values may take. |
| `maxRepeat` | How many calls of each function a call (or the top level) logs. The rest are only counted (`… f() called 980 more times, not logged`), which guards against huge logs from loops. `0` for no limit. |
| `callSites` | Whether each call logs the line it was called from. |
| `externalCalls` | Whether calls of functions that aren't traced are logged too. See [External calls](#external-calls). |
| `ignoreCalls` | With `externalCalls`, the callees not to log, as written in your code. `*` stands for anything. |
| `mock` | A module that replaces what tracing uses from its environment. See [Mocking the runtime](#mocking-the-runtime). |

Values that JSON can't hold are logged as text in brackets: `"[undefined]"`, `"[Function f]"`, `"[Circular]"`, `"[Error: boom]"`. A class instance is logged as `{"[Point]": {…}}`. Getters are never called.

## External calls

Only functions in instrumented files are traced. With `"externalCalls": true`, jstrace also logs the calls your instrumented code makes to everything else: built-ins (`JSON.parse`, `list.map`), Node's modules (`fs.readFileSync`, `worker.send`), and packages that aren't instrumented. Each one is named the way it's written (`this.items.reduce`), with its arguments by position and its result. A traced callback it runs appears inside it:

```
this.items.reduce("[Function (anonymous)]", 0)   (not traced)
  <anonymous@13:30>(sum: 0, item: {…})
    ← 6
  ← 8
```

In the Calls view, these calls have their own icon and Go to Call Site, but no Go to Function. Noisy callees are left out by `ignoreCalls`. Its default covers `console.*`, `Math.*`, `Object.*`, timers, `*.push` and the like. Optional calls (`a?.b()`), `super` calls, private methods, `eval` and `new` aren't logged.

## Merging processes

When programs talk to each other (a parent and a forked child, a client and a server), merge their logs to see the conversation in one tree:

1. Ctrl+click (`⌘`+click on macOS) the logs in the Calls view, then right-click and choose **Merge Logs…**. Or click the merge button in the view's title bar and tick the logs in the list.
2. Name each process that has no name yet. The default name is its script's name.

The merged log is a new log; the originals stay. Its events are in the order they happened across the processes, as close as their clocks agree (within a millisecond on one machine). Each process's call trees stay whole. Every call starts with its process's name and pid, and each process has its own icon color:

```
chat 25676  › worker.send({"id":1,"op":"factorial","n":5})
worker 3324 › handle(job: {"id":1,"op":"factorial","n":5})
chat 25676  › ↻ main() resumed
```

**Show by Time** in the Calls view's title bar drops the call trees and lists the whole conversation at one level, with a timestamp on each row. Stepping follows the merged order, from one process into the other. The merged `.txt` has each line after its process's name and pid. To name a process before merging, right-click its log and choose **Name Process…**. The names are kept in `.jstrace/logs/names.json`, and **Clear Logs** removes them with the logs.

## Mocking the runtime

The code jstrace injects needs a few things from its environment: Node's `fs` to write the logs, `process` for the pid, the command line and the exit, a clock, and V8's stack traces for call sites. A **mock** replaces any of them. That lets you:

- trace where some of them are missing: a sandbox, an embedded engine, a runtime without `fs`;
- send the logs somewhere else: to memory, a socket, or another folder;
- make logs the same on every run (fixed pid, start time and clock), so two runs can be diffed.

Tracing never reads files, so there's nothing to mock for reading.

### Create one

```sh
jstrace mock                # or, in VSCode: "jstrace: Create Mock" in the command palette
```

This copies the template to `jstrace.mock.js` (give a path to put it elsewhere) and sets `"mock"` in the config. The template lists every hook, commented out with an example, so it changes nothing until you edit it. Uncomment what you need, then **instrument again**: the mock's path is built into the injected code, and the program loads the mock when its first instrumented file runs.

You can also set the mock from the program itself, with no config: put the object on `globalThis.__jstraceMock` before the first instrumented file runs. For example, preload it with `node -r ./setup-mock.js index.js`, or set it in an entry file that isn't instrumented. A mock set this way takes the place of the config's.

### Hooks

Every hook is optional; what you leave out works as usual.

| Hook | Replaces | Used for |
| --- | --- | --- |
| `fs.mkdirSync(path, { recursive: true, mode: 0o700 })` | Node's `fs` | Creating the log folder. |
| `fs.openSync(path, 'a', 0o600)` → descriptor | Node's `fs` | Opening the `.jsonl` and the `.txt` to append to. |
| `fs.writeSync(fd, text)` | Node's `fs` | Writing to a log, one whole line at a time. |
| `env(name)` → string or `undefined` | `process.env` | Only `JSTRACE_OUT` is read: a folder for the logs instead of `.jstrace/logs`. |
| `pid()` → number | `process.pid` | The log's file name and its `start` event. |
| `argv()` → string[] | `process.argv` | The command line: the log's label shows the script and its arguments. |
| `cwd()` → string | `process.cwd()` | The working folder, in the `start` event. |
| `now()` → ms | `performance.now()` | Event times; only the differences between readings count. |
| `date()` → Date | `new Date()` | When the process started: the log's file name. |
| `site()` → `{ file, line }` or `null` | V8 stack traces | Where the call starting now was made. `file` is an absolute path (logged relative to the project when it's in it); `line` counts from 1. |
| `onExit(listener)` | `process.once('exit')` | Logging the calls skipped at the top level, and the `end` event, when the program ends. `listener` takes the exit code. |
| `warn(message)` | `console.error` | jstrace's own messages, like logs it can't write. |

The three `fs` hooks go together: if you mock `fs`, give all three.

The rules:

- The mock is never instrumented, even when `include` matches it.
- Its functions run with tracing off, so anything they call isn't logged.
- A hook that throws is dropped, with a message through `warn`, and the usual behaviour takes over. Your program goes on either way.
- Don't require instrumented files from the mock: it loads while tracing is being set up.

### Examples

Logs that are the same on every run, so two runs can be diffed:

```js
let clock = 0;
module.exports = {
  pid: () => 1,
  date: () => new Date('2026-01-01T00:00:00Z'),
  now: () => (clock += 1),
  argv: () => ['node', 'index.js'],
};
```

Logs kept in memory and printed when the program ends, for a runtime that can't write files:

```js
const files = [];
const atExit = []; // jstrace's own exit work, if it has any, goes first
process.once('exit', () => {
  for (const listener of atExit) listener();
  for (const file of files) if (file.path.endsWith('.txt')) process.stdout.write(file.text);
});
module.exports = {
  fs: {
    mkdirSync() {},
    openSync: (path) => files.push({ path, text: '' }) - 1,
    writeSync: (fd, text) => {
      files[fd].text += text;
    },
  },
  onExit: (listener) => atExit.push(listener),
};
```

Call sites left out, on an engine whose stack traces aren't V8's:

```js
module.exports = { site: () => null };
```

## Logs

Each process writes two files to `.jstrace/logs/` (or to `JSTRACE_OUT`), named `<start time>-<pid>`:

- **`.jsonl`**: one JSON event per line. This is what the extension reads. The events are `start`, `load`, `call`, `resume`, `return`, `throw`, `yield`, `skip` and `end` (the process exited, with its `code`). Each has a `time` in milliseconds since the start; node events have an `id` and a `parent`.
- **`.txt`**: the same as an indented tree you can read anywhere:

  ```
  factorial(n: 5) #8  lib/math.js:5  (from index.js:8)
    factorial(n: 4) #9  lib/math.js:5  (from lib/math.js:6)
      ← 24
    ← 120
  ```

### Reading logs on another machine

Files in the project are logged relative to it (`lib/math.js`), so you can copy `.jstrace/logs/` (or a few of its logs) into `.jstrace/logs/` of the same project on another machine, wherever it is there, and explore them as if they were made there: **Go to Function**, call sites, stepping and **Find Calls at This Line** open that machine's files. Keep in mind:

- The code should be the same version as when the logs were written, or lines point to the wrong places. Nothing checks this.
- Files outside the project (a call site in a globally installed package) stay absolute, and can't be opened elsewhere.
- The command line, the working folder and the project's path are logged as they were, so the other machine sees them (with your user name, often).
- A log that ended shows as ended. One whose process was killed, or is still running, may show a spinning icon for up to 30 minutes, if a process there happens to have its pid.
- Logs from different machines merge, but in the order their clocks give.
- Logs written before this change hold absolute paths, which work only where they were written.
- A log can be crafted, so treat one from someone else with care. Hovers show its text as plain text, and a network path (`\\host\share\…`) in it is opened only inside a workspace folder, since just opening one makes Windows authenticate to that host.

### What the logs hold

The logs hold whatever passed through the traced functions: arguments, return values, errors, and the command line. That includes passwords, tokens, cookies or personal data, as they were. So jstrace tries to keep them to you:

- `instrument` puts a `.gitignore` in `.jstrace/` that ignores all of it, so the logs and backups aren't committed. A `.gitignore` you put there yourself is left alone.
- On Linux and macOS, the log folder and files are readable by you only (modes `0700` and `0600`).
- On Windows those modes do nothing: the logs take the permissions of the folder they're in. If other accounts on the computer can read that folder, they can read your logs, and if they can write to it, they can change them. Folders directly on a data drive (like `D:\projects`) often let every account do both, so on a shared computer keep projects in your user folder.
- jstrace never sends anything over the network.

Mind where else they can go: a project in a synced folder (OneDrive, Dropbox) uploads them, and `JSTRACE_OUT` can put them anywhere.

## Limits

- **CommonJS only.** ES modules, TypeScript, JSX and Flow are skipped with a warning when instrumenting. That's common in `node_modules`.
- **Async code:** calls from timers, events and `.then()` callbacks start new trees, since there's no general way to tell what scheduled them. An async function that resumes after an `await` is a new root (`↻ resumed`).
- **Columns:** while a file is instrumented its columns shift, so a jump may land a little off on its line. Lines are always right.
- **Speed:** every traced call is serialized and written synchronously, so traced programs run much slower.

## Development

```sh
npm install
npm run check     # type-check (TypeScript as a checker only) and all tests
npm run package   # build the .vsix
```

The code is plain JavaScript (CommonJS) with JSDoc types and no build step. The CLI's only dependency is [acorn](https://github.com/acornjs/acorn); the extension has none. [CLAUDE.md](CLAUDE.md) describes the architecture and conventions, [ROADMAP.md](ROADMAP.md) what's planned, and [DONE.md](DONE.md) what's done.

## License

[MIT](LICENSE). The CLI bundles [acorn](https://github.com/acornjs/acorn), also MIT, with its own license.
