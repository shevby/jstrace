# jstrace

A tiny tool for personal use that traces function calls in any CommonJS JavaScript code. It has two parts:

- **CLI**: injects tracing code into every function of the `.js` files in a folder. Running the program then writes logs of the calls made (with their arguments), call trees, and the files loaded.
- **VSCode extension**: reads those logs, shows the calls in a side view, and jumps to each function's code.

It's a debugging aid, not a product. Keep it small. Slow tracing is fine, and scalability isn't a goal.

## Working Together

- Don't hesitate to ask questions. When a requirement is ambiguous, when the decision is really the user's (scope, UX, naming, trade-offs), or when a wrong assumption would be costly to undo, ask instead of guessing. Pure implementation details with a sensible default don't need a question; pick one and mention it.
- Don't hesitate to add new roadmap items or suggestions whenever something worth tracking comes up. There's no need to ask first, but mark them so they're easy to review:
  - **Roadmap item**: add it to [ROADMAP.md](ROADMAP.md) with *(proposed)* until it's accepted.
  - **Suggestion**: a numbered blockquote (`> **Suggestion N:** …`) in the section it concerns. Use the next unused number, and back it with investigation (docs, prior art), not guesses.
- Once an item is accepted, fold it into plain text (drop the *(proposed)* mark or the blockquote). Once it's rejected, delete it. Never renumber the remaining ones.
- When asked to pass the work to the next chat, update two files:
  - This one, with what should last (rules, decisions). Keep it under 200 lines: tighten it, or move detail into code docs, rather than let it grow. Also update `ROADMAP.md` and `DONE.md` with the status of their items.
  - `WILL.md` (repo root, git-ignored), with everything else the next chat needs to carry on: where the work stands and what's next, decisions made with the user and why, the user's preferences, pitfalls, and whatever in the previous `WILL.md` still holds.
- When asked to read `WILL.md`: read all of it, keep it as your memory of the earlier chats, then delete it.

## Tech Stack

1. **Plain JavaScript, CommonJS** (`require()`, not `import`), with no TypeScript and no build step. Development runs on Node.js 24 LTS. Code must also run on Node 18+, except the injected code, which must run on Node 12+ (ES2019 syntax; a test parses it so).
2. **[acorn](https://github.com/acornjs/acorn)** is the only third-party runtime dependency, and only the CLI uses it. There's no code generator (astring, escodegen): code is changed by inserting text at acorn's `start`/`end` offsets, using a small hand-written AST walker. Globs are matched by hand too.
3. **VSCode extension**: plain JS with no bundler, and no dependencies beyond the `vscode` API. It must run on VSCode 1.96 (`engines.vscode` `^1.96.0`; the user has 1.96.4), so no newer API. Installed locally from a `.vsix` that `npm run package` (`vscode/pack.js`, a hand-written zip, no `vsce`) builds, with the CLI and acorn packed inside: `code --install-extension jstrace-vscode-0.1.0.vsix`. A symlink into the extensions folder isn't reliable, since recent VSCode only loads extensions listed in its `extensions.json`.
4. **Dev-only tools** (TypeScript as a checker, `@types/node`, `@types/vscode`) are fine, since they never ship.
5. **Tests**: the built-in runner (`npm test` → `node --test`). Test files sit next to the code they test as `*.test.js`. Tests work in temp directories and never instrument, restore, or write logs into a real project. They take a fixture with `copyFixture(t, name)` from `test/helpers.js`, never using it in place.

## Code Conventions

- Always write JSDoc for every class, function, method, and exported value (`@param`, `@returns`, `@typedef`, `@type`), so VS Code gives autocompletion and hover docs in plain JS.
- `jsconfig.json` has `checkJs` on, so type errors show in the editor. `npm run typecheck` runs the same check with TypeScript, which is used only as a checker, never to compile. `@types/node` is pinned to 18, the oldest Node supported, so an API newer than that (`fs.globSync`) is a type error. `@types/vscode` matches the extension's `engines.vscode`. `test/fixtures` isn't checked.
- **Injected code** (the runtime prelude and the calls woven into functions) must not depend on Node beyond what's listed in Architecture. Keep it compact, and give every name it introduces the `__jt` prefix so it can't collide with user code.

## Project Structure

- `cli/`: the instrumenter. Its `package.json` holds the `jstrace` bin and the `acorn` dependency.
  - `cli/runtime/`: the source of the prelude that's injected into instrumented files.
- `vscode/`: the extension (`package.json` is its manifest).
- `test/fixtures/`: small sample projects (classes, async code, a child process, a `node_modules` package) that tests instrument and run.
- The root `package.json` is an npm workspace over `cli` and `vscode`, holding the dev tools and the `test`/`typecheck`/`check` scripts.
- `README.md`: the user's guide (install, commands, the views, config, mocks). Update it with any change a user would notice.

## Glossary

- **Project**: the folder holding `jstrace.config.json` and `.jstrace/`. In VSCode it's the workspace folder. On the console it's the current directory, or the nearest folder above it that already has either one (as git finds `.git`), so running from a subfolder can't split backups.
- **Target**: a folder or file passed to `instrument`. It must be inside the project. Any number of targets can be instrumented at once.
- **Instrumented file**: a file that currently contains injected code. Its original is in `.jstrace/backup/`.
- **Event**: one line of a log (a call, return, throw, module load, or resume).

## Architecture

- **Config** (`<project>/jstrace.config.json`) is created with defaults by the first `instrument` (also when the extension's "jstrace: Inject" runs it). Globs are matched against paths relative to the project.
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
    "ignoreCalls": ["require", "console.*", "Math.*", "Object.*", "*.push", "*.call", …],
    "mock": ""
  }
  ```
  `node_modules` is *not* excluded by default, since the user's own code can be there.
- **CLI commands** (the user runs the instrumented program themselves, with no `jstrace run`):
  - `jstrace init` (4.17): creates the config with the defaults (one there is only checked) and `.jstrace/` with its `.gitignore`, to configure before instrumenting. The extension's "jstrace: Init" (only the palette and the empty Calls view's button, no context menu) runs it in the workspace folder and opens the config.
  - `jstrace instrument <target...>`: for each matched file under the targets (a file named outright is taken regardless of include/exclude), back up the original to `.jstrace/backup/<path relative to the project>` and rewrite the file in place.
    - `.jstrace/backup/manifest.json` lists the instrumented files with a hash of what was written. This list exists only for restoring; the extension needs nothing but the logs.
    - A file instrumented already is restored first, so code is never injected twice.
    - `.jstrace/.gitignore` (`*`) is created when missing, so logs and backups stay out of git.
    - A file acorn can't parse is skipped with a warning; that covers ESM, TS, JSX, and Flow, which turn up in `node_modules`.
  - `jstrace restore [target...]`: put the originals back, all of them, or those under the targets. Logs stay. A file changed since it was instrumented isn't overwritten. It's reported instead, so the user's edits aren't lost.
  - `jstrace reinject` (4.23): `instrument` on the targets recorded in `.jstrace/injected.json`. Each `instrument` adds its targets, or starts the list afresh when it's `done`; a `restore` leaving nothing instrumented marks it `done`, keeping it for `reinject`. Gone targets are skipped, as are those outside the project (the record can be edited). The extension's "jstrace: Reinject" (palette only) runs it in each project with a record.
  - `jstrace mock [file]`: a mock (see Runtime → Mocks) from the template, `jstrace.mock.js` (or the config's `mock`) by default, kept if it exists, and named in the config.
- **What's traced**: every function, including declarations, expressions, arrows, class methods, getters/setters, constructors, async functions, generators, and anonymous callbacks. Also each file's top-level code starting to run (a `load` event). A function in a file that isn't instrumented isn't seen, but a callback it invokes is. With `externalCalls` (4.13, off by default), calls made *from* instrumented code to functions that aren't traced (built-ins, files not instrumented) are logged too, as **external calls**, except those whose callee, as written, matches an `ignoreCalls` pattern (`*` for anything; checked at instrument time). Each call expression goes through the runtime by insertions only: `f(a)` → `__jtm.cf(i,f)(a)`, `o.m(a)` → `__jtm.cm(i,o).m(a)` (a proxy, so `this` stays `o`). A function whose source has `__jtm.enter(` is traced and called straight on. Left alone: optional chains, `super`, private methods, direct `eval`, `(o.m)()`, inline functions.
- **Names**: `foo()`, or `Class->method()` for class members (`Class->get x()`, `Class->constructor()`; `Foo.prototype.bar = function` gives `Foo->bar()`). An anonymous function takes its name from context (`const foo = () => …` gives `foo()`, `obj.x = function () {}` gives `obj.x()`, a method in `const obj = { m() {} }` gives `obj.m()`), or else is shown as `<anonymous@line:col>`. The runtime adds the `()`.
- **Injection** never adds or removes a line, so line numbers in an instrumented file match the original. Only columns shift. A shebang and `'use strict'` keep their places. A function body is wrapped as enter → `try` → `catch` (logs a throw, rethrows) → `finally` (exit), and each `return x` becomes `return __jtc.ret(x)` (`__jtc` is the function's frame). Each `await x` becomes `__jtc.r(await __jtc.sa(x))` and each `yield x` becomes `__jtc.r(yield __jtc.sy(x))`, so the runtime sees a function suspend and resume. Arguments are passed as the values of the identifiers bound by the parameters, since arrows have no `arguments`. Positions logged are always those of the **original** source.
- **Runtime (the prelude)**: an inline prelude in every instrumented file sets up a shared `globalThis.__jt` singleton, so there's no `require` of a runtime file and no path problems. Its source is `createRuntime` in `cli/runtime/runtime.js`, stripped of comments and embedded as a string run through `new Function` (keeping the prelude to one line). Each file then registers itself and its functions' metadata (name, line, column, parameter names) with `__jt.load()`, which logs the load.
  - Writes with synchronous `fs` calls (`mkdirSync`, `openSync`, `writeSync`), and reads no files. Logs hold secrets as they were (no redaction, by choice), so they're the user's only: the folder `0700`, the files `0600` (merged logs too). If writing fails, tracing stops with one message on stderr and the program goes on.
  - **Mocks** (4.15, the `Mock` typedef): everything the runtime takes from its environment (`fs`, `env`, `pid`, `argv`, `cwd`, `now`, `date`, `site`, `onExit`, `warn`) can be replaced by `globalThis.__jstraceMock`, set before the first instrumented file runs, else by the module the config's `mock` names (its absolute path baked into the options; `instrument` never instruments it). `globalThis.__jstraceFs` still stands for `{ fs }`. Each hook runs with `busy` on (tracing off); one that throws is dropped with a `warn`, and the default takes over. `jstrace mock [file]` copies `cli/runtime/mock-template.js` (every hook commented out with an example) and sets `mock`; the extension's "Create Mock" runs it.
  - Log folder: `<project>/.jstrace/logs` (an absolute path baked in at instrument time), overridden by `JSTRACE_OUT` when `process.env` exists.
  - **One instance per process**: each process knows nothing of the others and writes `<startTime>-<pid>.jsonl` (the source of truth; `startTime` is ISO with `-` for `:`) plus `<startTime>-<pid>.txt` (a readable indented tree: `name(param: value) #id  file:line  (from file:line)`, then `← value` or `← throws …`, paths relative to the project).
  - Values are serialized safely as JSON: what JSON can't hold becomes a string in brackets (`"[undefined]"`, `"[Function f]"`, `"[Circular]"`, `"[Error: msg]"`), a class instance `{"[Class]": {…}}`, getters aren't called. Depth, string length, and (roughly) each value's length are limited by `maxDepth`/`maxString`/`maxLine`.
  - **Repeats** (`maxRepeat`, 0 for no limit): a call (all its parts) or the top level logs its first `maxRepeat` calls of each function, and a call its first `maxRepeat` resumes. Past that, a call or resume is muted: kept on the stack, but nothing in it is serialized or logged. It's the guard against runaway loops (including async loops and long iterations). The counts are logged as `skip` events when the call ends, or the process (`process.once('exit')`) for the top level.
  - **Call trees** follow the synchronous stack. When an async function resumes after an `await`, the rest of it is a new root, `↻ foo() #id resumed`. A generator resumes inside the caller of `next()`. Callbacks from timers, events, and `.then()` are new roots with no known origin; there's no runtime-agnostic way to tell.
  - A rejected `await` throws without `r` being called, so `sa` turns a rejection into a value that `r` rethrows after logging the resume. That makes each `await` of a promise one microtask tick slower. `gen.throw()`/`gen.return()` log the resume at the generator's next event.
  - **Events** (one JSON object per line, each with `type` and `time`, in ms since the start):
    - **Paths** (4.19): a file in the project (case ignored on Windows) is logged relative to it, with `/`, so logs can be read where the project is elsewhere (another machine); one outside it as it is. The root is baked at instrument time.
    - `start`: `pid`, `argv`, `cwd`, `root` (the project's path there), `started` (ISO); the first line.
    - `end`: the process exited (`code`), the last line, after the top level's `skip`s. A log with it is never `running`.
    - `load`, `call`, `resume`: tree nodes with `id`, `parent` (a node id, or `null` for a root), and `depth`. `load` has `file`. `call` has `name`, `file`, `line`, `column`, and `args` (keyed by parameter name), and `site` (`{ file, line, code }`, where it was called) when known. `code` (4.22, also on an external call) is that line's code, baked by `instrument` into the `load` call for each line making a call (`lines`), so search finds a call by the variables passed to it. An external call has `external: true`, its callee as `name` (`fs.readFileSync`), where it was made as `file`/`line`/`column` (the callee's property), `args` as an array, and no `site`. `resume` has the same, plus `call`, the call it's part of.
    - `return` (`value`, left out for `undefined`), `throw` (`error`), `yield` (`value`): `call`, plus `parent`, the node (the call, or a resume of it) they happened in.
    - `skip`: calls of a function (`name`, `file`, `line`, `column`) past `maxRepeat`, `count` of them, or with `resumes: true` resumes of the call itself; `parent` is the call's last logged part (`null` for the top level). Written before the call's `return`/`throw`.
- **VSCode extension**:
  - Its own activity-bar container with a tree view, "Calls": projects (only with more than one) → log files (newest first, labeled by the script and arguments from `argv`, with start time and pid) → call tree. Buttons to refresh, clear logs (with a confirmation), and restore. "Delete Log" (4.21, context menu, `Delete`) deletes the logs selected, with their `.txt`s and names, also after a confirmation. A log's inline button opens its `.txt`.
  - It auto-detects `.jstrace/` in each workspace folder and watches for logs being added or deleted. `parseLog` resolves relative paths against the workspace folder, so the rest sees absolute ones; the label's script is relative to `start.root`. Logs may come from another machine, so their text is untrusted (4.20): hovers put all of it in code blocks or through `escapeMarkdown`, and `refused` (`mayOpen`, an allowlist of local path shapes) stops a click opening a network path outside the workspace folders. **Live tailing**: every second (and when listed or expanded) each log is read from where the last read stopped, up to its last complete line (`readMore`), into the same trees; only a log that grew is refreshed, so items (and what's expanded) stay. A log whose process still runs (its pid exists, and it changed in the last 30 minutes, `isRunning`) gets a spinning icon and `running`, and its unfinished calls `running…`.
  - A node's label is like the `.txt`'s (`name(param: value)`, `load file`, `↻ name() resumed`). Its description is how it ended: for a call, what it returned or threw in the end, even in a later resume. The hover has the arguments and the value, pretty-printed. A call that threw gets a red icon.
  - Grouping (setting `jstrace.groupRepeats`, default 5, 0 for none): under one node, a function called that many times (or with calls skipped) becomes one row `name() ×count` where its first call was, with its calls (and skipped ones) inside; the resumes of a function's calls group the same way. Skips without a group are rows `… name() ×count not logged`.
  - **By time** (4.24): "Show by Time" (title bar, kept in `workspaceState` with the timestamps' choice, context keys `jstrace.byTime`/`jstrace.showTimes`) lists each log's nodes and skips at one level, in log order (`trace.timeline`, which is time order, merged logs included), so no groups. A row's `return`/`throw` stays its description, not a row. With timestamps (`clockTime`, `started` + `time`, in the local zone) before the label; a step's hint leaves them out. A log past `PAGE_SIZE` (2000) records is split into pages (`timeRows`), since VSCode loads a level's rows all at once and a running log's are reloaded every tick; pages keep every row reachable by `reveal`, which a cap wouldn't. A resume's click stays on it, and the hover names what a node ran in.
  - "Show Details" (inline and in the context menu) opens a read-only `jsonc` tab beside (a `jstrace:` content provider): where and when a call ran, how long it took, the calls it ran in, its resumes, then its arguments and outcome (and yields) pretty-printed; a group lists each of its calls. "Expand All Below" expands an item's whole subtree, level by level (`TreeView.reveal` with `expand`).
  - **Merging processes** (4.14, `mergeLogs` in `logs.js`): logs picked (selected together in Calls, or from a checklist) merge into a new log, `<now>-merged.jsonl` and `.txt`, for following how processes talk. Events are ordered by real time (`started` + `time`), node ids renumbered in that order, and each gets its process's `pid` and name (`process`); each process's trees stay whole, only roots interleave. Its `start` has `merged` (the processes) and no `pid`. Each node's label starts `name pid › `, its icon has the process's color, and groups never mix processes. A process is named with "Name Process…" on its log (`names.json` in the log folder, by log file name; Clear Logs deletes it), or when merged, its script's name by default.
  - **Search** (a second view, "Search"): the calls and loads in every log with all the words searched (ignoring case) in their name and arguments, outcome, `file:line`, or call-site code (`search`), per log, searched again as logs grow. Its items are the Calls view's own `NodeItem`s, so they reveal there. A click goes to the code; a double-click shows the call in the Calls view. A tree item's command runs on every click, so a double-click is a second click on the same item within 500 ms. "jstrace: Find Calls at This Line" (4.16, editor context menu) lists there the calls made from the cursor's line or of a function defined on it (`searchAt`).
  - **Stepping** (`step` in `logs.js`): into/back/over/back over/out through a log in id order (what ran inside a node comes right after it), from the selection in Calls or Search, with `Alt`+arrow keys only while one of those views has the focus (the Search view's keys pass `'search'`; a context menu passes the item). A step selects the call and shows its call site with the editor keeping its focus off (`preserveFocus`), a debugger-like line highlight (theme color `jstrace.stepBackground`), its tooltip on hover, and the call's label and outcome where `jstrace.stepHint` says: `above` (a CodeLens opening its details, or `end` where CodeLens is off), `end` (`after` text, `jstrace.stepForeground`), or `hover`; selecting something else, editing the file, a mouse click on another line of it, or `Esc` (`jstrace.hideStep`, bound only while one shows, context key `jstrace.stepShown`, and in the editor only when Esc has nothing else to do there: no selection, widget, or Vim insert mode) clears it.
  - **Call sites** (`callSites`, on by default): at each call the runtime reads `new Error().stack` (V8's format) and takes the first frame with an absolute path after the callee's own, skipping the runtime's (`<anonymous>`, from `new Function`), natives, and Node's internals (`node:internal/…`, or `internal/…` before Node 16). Through code that isn't instrumented (`[].map(cb)`), that's the line calling it; a callback run by Node itself (a timer) has none. Lines are exact even in instrumented files; the extension puts the cursor on the callee's name on the line (`columnOf`).
  - Clicking a call (or a load) shows it as a step does (`showStep`): where it was called (its function, without a site), highlighted, with its values after the line, the tree keeping the focus so the step keys go on from it. Clicking a resume does that for its call, selecting it. Its inline buttons, in order: Go to Function, Show Details, Go to Call Site (`→`, the cursor at the call); the go-to ones give the editor the focus (an unfocused one hides its cursor). Line numbers are right even while the file is instrumented; the column may be off a little. An external call (icon `link-external`, context value `external`) has no Go to Function; its label shows the arguments' values only.
  - The CLI it runs is always its own (`cliScript`): packed in it, else the repo's `cli/` beside it, run with VSCode's own Node (`ELECTRON_RUN_AS_NODE`). There's no setting for another one (`jstrace.cliPath` was dropped: a workspace could point it at a script of its own). The explorer's context menu gets "jstrace: Inject" on folders and files, which runs `jstrace instrument <them>` in their workspace folder (each folder of a multi-root workspace is a project of its own). Inject and Restore report the CLI's summary, plus what it skipped or left alone (all of it in the "jstrace" output channel).
  - A command shown outside jstrace's own views (the editor's or explorer's context menu) has `jstrace: ` in its title and no `category`, which menus don't show and the palette would double.
  - Code: `logs.js` (parsing and the text shown) and `cli.js` (running the CLI) don't need `vscode`. `extension.test.js` runs the extension against a fake `vscode`.

## Git Workflow

- Local only, so no `git push`.
- A separate branch per feature/fix (`feature/…`, `fix/…`, `docs/…`) off `master`.
- Run `npm run check` (typecheck + tests) before merging into `master`. Once it passes, merge a finished branch (`git merge --no-ff`) without asking. Ask only when unsure.
- After merging a change to the extension, the CLI or the runtime, run `npm run package`, so the `.vsix` the user installs is current.
- A bug fix should add a test covering the regression it fixes, when that's reasonable and doesn't take too long. It's not a hard requirement.
- Never delete branches or squash commits.

## Roadmap

The feature roadmap is [ROADMAP.md](ROADMAP.md). It isn't loaded with this file, so read it before picking, adding, or finishing an item. Items are referred to by ID (`1.3`), here and in code docs. Finished items move to [DONE.md](DONE.md), keeping their ID; check both files before assigning a new one.
