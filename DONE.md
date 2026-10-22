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
