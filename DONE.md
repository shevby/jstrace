# jstrace — Done

These are completed roadmap items, moved out of [ROADMAP.md](ROADMAP.md) to keep it focused on what's left. IDs are stable and never reused (see ROADMAP.md's header), so a number here is still taken; check both files before assigning a new one. A milestone with items still open keeps a one-line pointer, in ROADMAP.md, instead of its done items. Once every item in it is finished, the milestone moves here as a whole block.

## 0. Foundation

- [x] 0.1 Git repo on `master`, with a branch per feature/fix.
- [x] 0.2 Project skeleton: a root npm workspace over `cli/` and `vscode/`, the `jstrace` bin, `node --test`, and `npm run check`.
  - The CLI parses its command line by hand (`cli/src/cli.js`). `main(argv, output)` returns the exit code: 0 for success, 1 for a failure, 2 for a wrong command line. `instrument` and `restore` say they aren't implemented yet.
  - The extension is an empty `activate`, activated by a `.jstrace` folder in the workspace.
- [x] 0.3 JSDoc, `jsconfig.json` (`checkJs`), and `npm run typecheck`: TypeScript 7 as a dev-only checker, now part of `npm run check`.
  - `@types/node` is pinned to 18, the oldest Node supported, so newer APIs are type errors.
  - `@types/vscode` is 1.100, matching `engines.vscode`.
- [x] 0.4 Test fixtures: `test/fixtures/app`, a small CommonJS app.
  - It has a shebang and directive in `index.js`. `lib/math.js` has every plain function form, a throw caught by its caller, object method shorthand, and a function assigned to a property. `lib/shapes.js` has classes with constructors and `super`, a getter/setter, a static method, an arrow class field, and a private field.
  - `lib/tasks.js` has async/await, an async arrow, timer and `.then()` callbacks, and a generator.
  - There's also a `.cjs` file, a `.min.js` file, `lib/esm.js` (which acorn can't parse as a script, and nothing requires), a `greeter` package in `node_modules` that calls back into the app, and `child.js`, forked as a second process.
  - `test/helpers.js` has `copyFixture(t, name)`, which copies a fixture into a temp directory removed after the test, and `APP_OUTPUT`, what the app prints; instrumenting must not change it.
  - `.gitignore` lets the fixtures' `node_modules` in.

## 1. Instrumenter (CLI)

- [x] 1.1 Project and config.
  - `findProject(cwd)` (`cli/src/project.js`) walks up to the nearest folder with `jstrace.config.json` or `.jstrace/`, else takes the start folder. `relative()` gives project-relative `/` paths, refusing ones outside the project or in `.jstrace/`.
  - `loadConfig()` (`cli/src/config.js`) creates the file with the defaults when missing, fills in fields left out, and throws a `ConfigError` naming the field for a mistake (bad JSON, wrong type, unknown field).
  - `cli/src/glob.js` compiles `*`, `?` and `**` into regular expressions. `filter()` tells files to take and folders not worth walking.
- [x] 1.2 File walk and backup (`cli/src/commands.js`).
  - `jstrace instrument <path...>` (paths relative to the current folder, inside the project) takes the files under each path that the config's filter takes, or a file named outright whatever the filter says. It doesn't follow symbolic links to folders.
  - Each original is copied to `.jstrace/backup/<path>`, and `manifest.json` records the SHA-1 of what was written.
  - Paths add up: instrumenting more keeps what's already instrumented.
  - It reports a summary on stdout (`Instrumented 7 files, skipped 1`) and each skipped file on stderr. Exit code 1 for a bad config or a path missing or outside the project.
- [x] 1.3 `jstrace restore [path...]` puts back the originals (all, or those under the paths), removing their backups and empty folders, and the backup folder once nothing's left.
  - A file changed or deleted since it was instrumented is left alone, its original kept and named in the message.
- [x] 1.4 Parsing: a file acorn can't parse as a script is skipped with `<path>: skipped, it can't be parsed as a CommonJS script (<acorn's message> (line:col))`.
- [x] 1.5 Function discovery: `cli/src/walk.js` visits every node with its ancestors, and `cli/src/instrument.js` names each function.
  - Rules: its own name; a class member's `Class->method` (`get`/`set` prefixed, `#private`, `[computed]`); or the name it's given (`const x =`, `a.b =`, `X.prototype.y =` as `X->y`, a default parameter, `obj.method` in `const obj = {…}`).
  - Anything else is `<anonymous@line:col>`, with the column counted from 1.
  - Metadata per function: `[name, line, column, params]`, with the position of the member for methods (the key, not the parentheses) and the names the parameters bind (patterns included).
- [x] 1.6 Injection (`instrumentSource()`): text insertions sorted by offset. At one offset, a node's own pieces keep their order (an empty body), closing pieces come before opening ones, inner closings first and outer openings first.
  - A block body gets `;const __jtc=__jtm.enter(i,[params]);try{` after its directives, and `}catch…finally{__jtc.exit()}` before its `}`. An arrow's expression body becomes a block returning `__jtc.ret(…)`. acorn's `preserveParens` keeps a `({…})` body whole.
  - A module's own top-level `return` is left alone.
  - The output is checked to have the same line count and to parse, else it's a jstrace bug.
  - The same tests run sources both ways and compare results (functions, classes, async, generators, a shebang, directives, CRLF, a BOM, an empty file).
- [x] 1.7 The prelude: after the shebang line and directives, `;var __jt=globalThis.__jt||(globalThis.__jt=new Function("require","options",…)(require,{options}));var __jtm=__jt.load(file,functions);`.
  - The runtime factory's source and the metadata are JSON with U+2028/U+2029 escaped, so it stays on one line.
  - `var __jtm=__jt.load(` marks a file as instrumented (`isInstrumented()`).
  - The runtime (`cli/runtime/runtime.js`) documents the API instrumented code calls. It passes everything through until milestone 2.
- [x] 1.8 Async: `await x` becomes `__jtc.r(await __jtc.sa(x))` and `yield x` becomes `__jtc.r(yield __jtc.sy(x))` (a bare `yield` yields `__jtc.sy()`). `for await` isn't touched.
  - An end-to-end test instruments the app fixture with a recording runtime: it prints the same, and every load, call, return, throw, suspend and resume is recorded, in both processes.
- [x] 1.9 Instrumenting a file again starts from its backup, so it picks up config changes and never gets code injected twice. A changed one is left alone. One with injected code but no backup (`.jstrace/` lost) is refused.

## 2. Runtime (injected prelude)

- [x] 2.1 The `globalThis.__jt` singleton (`createRuntime` in `cli/runtime/runtime.js`), one per process. It writes with `globalThis.__jstraceFs` or Node's `fs`, to the folder baked in (`options.logs`) or `JSTRACE_OUT`, as `<startTime>-<pid>.jsonl` and `.txt` (the ISO start time, with `-` for `:`).
  - The files open at the first event, starting with a `start` event (pid, argv, cwd). A failed write stops tracing with one message on stderr; the program goes on.
  - The instrumenter embeds the runtime without its comments, blank lines and indentation (`compact()` in `instrument.js`, using acorn's comments).
- [x] 2.2 Safe serializer: JSON, with what JSON can't hold as bracketed strings (`[undefined]`, `[NaN]`, `[10n]`, `[Symbol(s)]`, `[Function f]`, `[class C]`, `[Circular]`, `[Error: msg]`, `[Date …]`, `[RegExp /x/]`, `[Uint8Array(2) 1,2]`, `[ArrayBuffer(4)]`).
  - A class instance is `{"[Class]": {…}}`, or `"[Class]"` with no own properties (a Promise). Maps and Sets are `{"[Map(n)]": [[k, v], …]}` and `{"[Set(n)]": […]}`.
  - Getters and setters are named, not called. Serializing runs with tracing off, and a value that throws becomes `[Unserializable]`.
  - Past `maxDepth`, an object is `[Object]`, `[Array(n)]`, `[Class]`. Strings are cut at `maxString` (`abcde…(+3)`). A value's whole length is kept to roughly `maxLine`: arrays and objects end with `…+N more`.
- [x] 2.3 Call tracking: a stack of entries (calls and resumes). The events: `start`, `load`, `call`, `return`, `throw`, `yield`, `resume` (see Architecture for the fields).
  - Each call ends with exactly one `return` or `throw`, logged at `exit` with the value `ret` or `throw` got.
  - A suspended call that goes on is logged as a resume on top of whatever is running: a new root for an async function, inside the caller of `next()` for a generator.
  - `sa` turns an awaited promise's rejection into a value that `r` rethrows after logging the resume (one more microtask tick per `await` of a promise). A suspended generator ended by `gen.throw()` or `gen.return()` logs its resume at its next event.
- [x] 2.4 The `.txt` tree: two spaces per depth. A `start` header line, then `load file`, `name(param: value) #id  file:line`, `← value`, `← throws …`, `← yields …`, `↻ name() #id resumed  file:line`, with paths relative to the project (`options.root`).
- [x] 2.5 End-to-end tests (`test/e2e.test.js`): instrument the app fixture with the CLI and run it. Both processes' logs are checked: loads, every call ending once, every parent seen before, the factorial chain, a throw, async resumes, yields, a callback from `node_modules`, and the tree's text.
  - Then restore: every file comes back byte for byte, and the logs stay. `JSTRACE_OUT` is tested too.
  - Runtime tests (`cli/runtime/runtime.test.js`) run instrumented sources in-process with a fresh runtime. The `same()` tests in `instrument.test.js` now run with the real runtime, logging to a temp folder.

## 3. VSCode extension

- [x] 3.1 Manifest and an activity-bar container with the "Calls" tree view: projects (only with more than one) → log files (newest first, one per process, labeled by script and arguments, with start time and pid) → call tree.
  - Labels read like the `.txt` tree. A call's description is what it returned or threw in the end, even in a later resume. The hover has the arguments and value, pretty-printed. A call that threw gets a red icon.
  - `vscode/logs.js` parses the `.jsonl` (skipping a line cut short) and makes the text, with no `vscode` needed.
- [x] 3.2 Jump to code: clicking a call or load opens the original file at the function (the line is exact even while instrumented; the column may be off a little).
- [x] 3.3 Setting `jstrace.cliPath`: a `.js` script (run with VSCode's own Node via `ELECTRON_RUN_AS_NODE`) or a program (through `cmd.exe` on Windows, arguments quoted). Empty takes the CLI packed in the extension, else the repo's `cli/` beside it, else `jstrace` on the PATH (`vscode/cli.js`).
- [x] 3.4 "Inject jstrace" in the explorer's context menu (folders and files, several at once): runs `jstrace instrument <them>` in each one's workspace folder. It reports the CLI's summary and what it skipped; everything goes to the "jstrace" output channel.
- [x] 3.5 Restore: a view button and command running `jstrace restore` in each project with a backup, reporting files it left alone.
- [x] 3.6 Refresh and clear logs (with a confirmation) buttons. `.jstrace/` is detected in each workspace folder, and a watcher refreshes the list when logs are added or deleted. A log's inline button opens its `.txt`. A welcome text explains how to start.
- [x] 3.7 Clicking a `↻ foo() resumed` node selects the call it belongs to, and goes to the function. A call's hover says how many times it resumed.
- [x] 3.8 Local install: `npm run package` (`vscode/pack.js`, a hand-written zip with no `vsce`) builds `jstrace-vscode-0.1.0.vsix` with the CLI and acorn inside, for `code --install-extension`. A symlink isn't used, since recent VSCode only loads extensions listed in its `extensions.json`.
  - Tests: `vscode/extension.test.js` runs the extension against a fake `vscode` (inject, the tree of a real run, jumping, a resume's call, restore, clear). `pack.test.js` unzips the package and runs the CLI from it. Installing it into a separate extensions folder was checked by hand.

## 4. Later / maybe

- [x] 4.1 Repeats: `maxRepeat` in the config (default 20, 0 for no limit), instead of the proposed cap on events per process. A call (all its parts) or the top level logs its first `maxRepeat` calls of each function, and a call its first `maxRepeat` resumes (async loops, long iterations). Past that, a call or resume is muted: kept on the stack, but nothing in it is serialized or logged.
  - `skip` events give the counts, in the call's last logged part before its return (`… step() called 3 more times, not logged` in the `.txt`). The top level's, and those of calls still running, are written when the process exits.
  - Calls aren't found in loops by reading the code: only function bodies are instrumented, and repetition also comes from `.map` callbacks, timers and events, so calls are counted while the program runs.
- [x] 4.5 Grouping in the tree view (setting `jstrace.groupRepeats`, default 5, 0 for none): under one node, the calls of a function made that many times (or with some skipped) become one row, `step() ×1003` with `3 not logged, 1 threw`, where the first call was. The resumes of a function's calls group the same way (`↻ double() resumed ×6`). A skip without a group is a row of its own. A resume in a group still reveals its call.
