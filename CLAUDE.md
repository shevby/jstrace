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
3. **VSCode extension**: plain JS with no bundler, and no dependencies beyond the `vscode` API. Installed locally (a `.vsix`, or a symlink into the extensions folder).
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
- **Runtime (the prelude)**: an inline prelude in every instrumented file sets up a shared `globalThis.__jt` singleton, so there's no `require` of a runtime file and no path problems. Its source is `createRuntime` in `cli/runtime/runtime.js`, embedded as a string run through `new Function` (keeping the prelude to one line). Each file then registers itself and its functions' metadata (name, line, column, parameter names) with `__jt.load()`, which logs the load.
  - Writes with synchronous `fs` calls (`mkdirSync`, `openSync`, `writeSync`). It uses `globalThis.__jstraceFs` if that was set before the first instrumented file loaded, and Node's `fs` otherwise.
  - Log folder: `<project>/.jstrace/logs` (an absolute path baked in at instrument time), overridden by `JSTRACE_OUT` when `process.env` exists.
  - **One instance per process**: each process knows nothing of the others and writes `<startTime>-<pid>.jsonl` (the source of truth) plus `<startTime>-<pid>.txt` (a readable indented tree).
  - Arguments are serialized safely, keyed by parameter name (`foo(): {"a":1,"b":"x"}`). Circular references become `"[Circular]"` and functions `"[Function name]"`. Depth, string length, and line length are limited by `maxDepth`/`maxString`/`maxLine`.
  - **Call trees** follow the synchronous stack. Every `await` is instrumented: when an async function resumes, the rest of it is a new root, `↻ foo() resumed`, carrying the id of the call it belongs to. Callbacks from timers, events, and `.then()` are new roots with no known origin; there's no runtime-agnostic way to tell.
  - An event carries enough for the extension: id, type, parent id (or the call a resume belongs to), depth, name, args or return value or error, the original file (absolute path), line, column, and a timestamp.
- **VSCode extension**:
  - Its own activity-bar container with a tree view: log files (newest first) → call tree. Buttons to refresh, clear logs, and restore. It auto-detects `.jstrace/` in the workspace, with no live tailing.
  - Clicking a call jumps to the function in the original file. Line numbers are right even while the file is instrumented. The extension's "Restore" brings the original sources back (via the CLI).
  - Setting `jstrace.cliPath`: the path to the CLI. The explorer's context menu gets "Inject jstrace" on folders and files, which runs `jstrace instrument <it>` in its workspace folder (each folder of a multi-root workspace is a project of its own).

## Git Workflow

- Local only, so no `git push`.
- A separate branch per feature/fix (`feature/…`, `fix/…`, `docs/…`) off `master`.
- Run `npm run check` (typecheck + tests) before merging into `master`. Once it passes, merge a finished branch (`git merge --no-ff`) without asking. Ask only when unsure.
- A bug fix should add a test covering the regression it fixes, when that's reasonable and doesn't take too long. It's not a hard requirement.
- Never delete branches or squash commits.

## Roadmap

The feature roadmap is [ROADMAP.md](ROADMAP.md). It isn't loaded with this file, so read it before picking, adding, or finishing an item. Items are referred to by ID (`1.3`), here and in code docs. Finished items move to [DONE.md](DONE.md), keeping their ID; check both files before assigning a new one.
