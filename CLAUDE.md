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

1. **Plain JavaScript, CommonJS** (`require()`, not `import`), with no TypeScript and no build step. Development runs on Node.js 24 LTS. Code must also run on Node 18+.
2. **[acorn](https://github.com/acornjs/acorn)** is the only third-party runtime dependency, and only the CLI uses it. There's no code generator (astring, escodegen): code is changed by inserting text at acorn's `start`/`end` offsets, using a small hand-written AST walker. Globs are matched by hand too.
3. **VSCode extension**: plain JS with no bundler, and no dependencies beyond the `vscode` API. Installed locally from a `.vsix` that `npm run package` (`vscode/pack.js`, a hand-written zip, no `vsce`) builds, with the CLI and acorn packed inside: `code --install-extension jstrace-vscode-0.1.0.vsix`. A symlink into the extensions folder isn't reliable, since recent VSCode only loads extensions listed in its `extensions.json`.
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

## Glossary

- **Project**: the folder holding `jstrace.config.json` and `.jstrace/`. In VSCode it's the workspace folder. On the console it's the current directory, or the nearest folder above it that already has either one (as git finds `.git`), so running from a subfolder can't split backups.
- **Target**: a folder or file passed to `instrument`. It must be inside the project. Any number of targets can be instrumented at once.
- **Instrumented file**: a file that currently contains injected code. Its original is in `.jstrace/backup/`.
- **Event**: one line of a log (a call, return, throw, module load, or resume).

## Architecture

- **Config** (`<project>/jstrace.config.json`) is created with defaults by the first `instrument` (also when the extension's "Inject jstrace" runs it). Globs are matched against paths relative to the project.
  ```json
  {
    "include": ["**/*.js", "**/*.cjs"],
    "exclude": [".git/**", ".jstrace/**", "**/*.min.js"],
    "maxDepth": 3,
    "maxString": 200,
    "maxLine": 2000
  }
  ```
  `node_modules` is *not* excluded by default, since the user's own code can be there.
- **CLI commands** (the user runs the instrumented program themselves, with no `jstrace run`):
  - `jstrace instrument <target...>`: for each matched file under the targets (a file named outright is taken regardless of include/exclude), back up the original to `.jstrace/backup/<path relative to the project>` and rewrite the file in place.
    - `.jstrace/backup/manifest.json` lists the instrumented files with a hash of what was written. This list exists only for restoring; the extension needs nothing but the logs.
    - A file instrumented already is restored first, so code is never injected twice.
    - A file acorn can't parse is skipped with a warning; that covers ESM, TS, JSX, and Flow, which turn up in `node_modules`.
  - `jstrace restore [target...]`: put the originals back, all of them, or those under the targets. Logs stay. A file changed since it was instrumented isn't overwritten. It's reported instead, so the user's edits aren't lost.
- **What's traced**: every function, including declarations, expressions, arrows, class methods, getters/setters, constructors, async functions, generators, and anonymous callbacks. Also each file's top-level code starting to run (a `load` event). A function in a file that isn't instrumented isn't seen, but a callback it invokes is.
- **Names**: `foo()`, or `Class->method()` for class members (`Class->get x()`, `Class->constructor()`; `Foo.prototype.bar = function` gives `Foo->bar()`). An anonymous function takes its name from context (`const foo = () => …` gives `foo()`, `obj.x = function () {}` gives `obj.x()`, a method in `const obj = { m() {} }` gives `obj.m()`), or else is shown as `<anonymous@line:col>`. The runtime adds the `()`.
- **Injection** never adds or removes a line, so line numbers in an instrumented file match the original. Only columns shift. A shebang and `'use strict'` keep their places. A function body is wrapped as enter → `try` → `catch` (logs a throw, rethrows) → `finally` (exit), and each `return x` becomes `return __jtc.ret(x)` (`__jtc` is the function's frame). Each `await x` becomes `__jtc.r(await __jtc.sa(x))` and each `yield x` becomes `__jtc.r(yield __jtc.sy(x))`, so the runtime sees a function suspend and resume. Arguments are passed as the values of the identifiers bound by the parameters, since arrows have no `arguments`. Positions logged are always those of the **original** source.
- **Runtime (the prelude)**: an inline prelude in every instrumented file sets up a shared `globalThis.__jt` singleton, so there's no `require` of a runtime file and no path problems. Its source is `createRuntime` in `cli/runtime/runtime.js`, stripped of comments and embedded as a string run through `new Function` (keeping the prelude to one line). Each file then registers itself and its functions' metadata (name, line, column, parameter names) with `__jt.load()`, which logs the load.
  - Writes with synchronous `fs` calls (`mkdirSync`, `openSync`, `writeSync`). It uses `globalThis.__jstraceFs` if that was set before the first instrumented file loaded, and Node's `fs` otherwise. If writing fails, tracing stops with one message on stderr and the program goes on.
  - Log folder: `<project>/.jstrace/logs` (an absolute path baked in at instrument time), overridden by `JSTRACE_OUT` when `process.env` exists.
  - **One instance per process**: each process knows nothing of the others and writes `<startTime>-<pid>.jsonl` (the source of truth; `startTime` is ISO with `-` for `:`) plus `<startTime>-<pid>.txt` (a readable indented tree: `name(param: value) #id  file:line`, then `← value` or `← throws …`, paths relative to the project).
  - Values are serialized safely as JSON: what JSON can't hold becomes a string in brackets (`"[undefined]"`, `"[Function f]"`, `"[Circular]"`, `"[Error: msg]"`), a class instance `{"[Class]": {…}}`, getters aren't called. Depth, string length, and (roughly) each value's length are limited by `maxDepth`/`maxString`/`maxLine`.
  - **Call trees** follow the synchronous stack. When an async function resumes after an `await`, the rest of it is a new root, `↻ foo() #id resumed`. A generator resumes inside the caller of `next()`. Callbacks from timers, events, and `.then()` are new roots with no known origin; there's no runtime-agnostic way to tell.
  - A rejected `await` throws without `r` being called, so `sa` turns a rejection into a value that `r` rethrows after logging the resume. That makes each `await` of a promise one microtask tick slower. `gen.throw()`/`gen.return()` log the resume at the generator's next event.
  - **Events** (one JSON object per line, each with `type` and `time`, in ms since the start):
    - `start`: `pid`, `argv`, `cwd`, `started` (ISO); the first line.
    - `load`, `call`, `resume`: tree nodes with `id`, `parent` (a node id, or `null` for a root), and `depth`. `load` has `file`. `call` has `name`, `file` (absolute), `line`, `column`, and `args` (keyed by parameter name). `resume` has the same, plus `call`, the call it's part of.
    - `return` (`value`, left out for `undefined`), `throw` (`error`), `yield` (`value`): `call`, plus `parent`, the node (the call, or a resume of it) they happened in.
- **VSCode extension**:
  - Its own activity-bar container with a tree view, "Calls": projects (only with more than one) → log files (newest first, labeled by the script and arguments from `argv`, with start time and pid) → call tree. Buttons to refresh, clear logs (with a confirmation), and restore. A log's inline button opens its `.txt`.
  - It auto-detects `.jstrace/` in each workspace folder and watches for logs being added or deleted, but doesn't follow one being written (no live tailing). A log is read again once it changed, when its node is listed or expanded.
  - A node's label is like the `.txt`'s (`name(param: value)`, `load file`, `↻ name() resumed`). Its description is how it ended: for a call, what it returned or threw in the end, even in a later resume. The hover has the arguments and the value, pretty-printed. A call that threw gets a red icon.
  - Clicking a call or load jumps to it in the original file. Clicking a resume also selects its call in the tree. Line numbers are right even while the file is instrumented; the column may be off a little.
  - Setting `jstrace.cliPath`: the CLI, as a `.js` script (run with VSCode's own Node via `ELECTRON_RUN_AS_NODE`) or a program. Empty means the CLI packed in the extension, else the repo's `cli/` beside it, else `jstrace` on the PATH. The explorer's context menu gets "Inject jstrace" on folders and files, which runs `jstrace instrument <them>` in their workspace folder (each folder of a multi-root workspace is a project of its own). Inject and Restore report the CLI's summary, plus what it skipped or left alone (all of it in the "jstrace" output channel).
  - Code: `logs.js` (parsing and the text shown) and `cli.js` (running the CLI) don't need `vscode`. `extension.test.js` runs the extension against a fake `vscode`.

## Git Workflow

- Local only, so no `git push`.
- A separate branch per feature/fix (`feature/…`, `fix/…`, `docs/…`) off `master`.
- Run `npm run check` (typecheck + tests) before merging into `master`. Once it passes, merge a finished branch (`git merge --no-ff`) without asking. Ask only when unsure.
- A bug fix should add a test covering the regression it fixes, when that's reasonable and doesn't take too long. It's not a hard requirement.
- Never delete branches or squash commits.

## Roadmap

The feature roadmap is [ROADMAP.md](ROADMAP.md). It isn't loaded with this file, so read it before picking, adding, or finishing an item. Items are referred to by ID (`1.3`), here and in code docs. Finished items move to [DONE.md](DONE.md), keeping their ID; check both files before assigning a new one.
