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
