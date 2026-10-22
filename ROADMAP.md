# jstrace — Roadmap

This is the feature roadmap, with milestones in rough dependency order.

Item IDs (`1.3`) are stable:
- Don't renumber when items are added, finished, or dropped.
- A new item takes the next free number in its milestone, and a dropped item's number is never reused.
- An item not yet accepted ends with *(proposed)*.

Finished items move to [DONE.md](DONE.md), keeping their ID, so this file stays focused on what's left; check both files before assigning a new number. A milestone with items still open keeps a one-line pointer to DONE.md instead of listing its done ones here. Once every item in it is finished, the whole milestone moves there as a block.

Section names in parentheses (Architecture, Glossary, …) refer to [CLAUDE.md](CLAUDE.md).

## 0. Foundation

All done; see [DONE.md](DONE.md).

## 1. Instrumenter (CLI)

Done items are in [DONE.md](DONE.md).

- [ ] 1.2 File walk and backup: matched files under the targets are copied to `.jstrace/backup/` (paths relative to the project), and `manifest.json` there records a hash of what was written to each, so restore can tell whether a file was edited afterwards.
- [ ] 1.3 `jstrace restore [target...]`: puts the originals back (all, or those under the targets) and keeps the logs. A file edited since instrumenting is reported, not overwritten.
- [ ] 1.4 Parsing: acorn, `sourceType: 'script'`, with locations. A file that fails to parse is skipped with a warning naming it and the reason.
- [ ] 1.5 Function discovery: a hand-written AST walker finds every kind of function (see Architecture) and names it: `foo()`, `Class->method()`, a name from context, or `<anonymous@line:col>`.
- [ ] 1.6 Injection: enter/exit/return/throw woven in by text insertion, without adding a line. Arrow expression bodies get a block; shebangs and directives keep their places. The output is checked by re-parsing it.
- [ ] 1.7 Module load events: the prelude registers the file and its functions with `__jt.load()`, which logs the load.
- [ ] 1.8 Async: `await` (and `yield`) instrumented so a resumed function shows as a new root linked to its call.
- [ ] 1.9 Instrumenting a file that's instrumented already restores it first, so code is never injected twice. A file that has injected code but no backup (a lost `.jstrace/`) is refused.

## 2. Runtime (injected prelude)

- [ ] 2.1 The `globalThis.__jt` singleton: one per process. `globalThis.__jstraceFs` or Node's `fs`, the log folder (baked in, or `JSTRACE_OUT`), and the `<startTime>-<pid>` file names.
- [ ] 2.2 Safe serializer: circular references, functions, class instances (by class name), Buffers and typed arrays, and errors. Limited by `maxDepth`, `maxString`, and `maxLine`.
- [ ] 2.3 Call tracking and the JSONL event stream (see Architecture for an event's fields).
- [ ] 2.4 The readable `.txt` tree next to each `.jsonl`.
- [ ] 2.5 End-to-end tests: instrument the fixtures, run them (child process included), check the logs, and restore. The originals must come back byte for byte.

## 3. VSCode extension

- [ ] 3.1 Manifest and activity-bar container with a tree view: log files (newest first, by process) → call tree, with the args and return value of each call on hover.
- [ ] 3.2 Jump to code: clicking a call opens the original file at the function.
- [ ] 3.3 Setting `jstrace.cliPath`, the path to the CLI.
- [ ] 3.4 "Inject jstrace" in the explorer's context menu (folders and files): runs `jstrace instrument <it>` in its workspace folder.
- [ ] 3.5 Restore: a button and command running `jstrace restore`, reporting files it left alone.
- [ ] 3.6 Refresh and clear logs buttons; `.jstrace/` auto-detected in the workspace.
- [ ] 3.7 Resumed async parts: `↻ foo() resumed` nodes link to the call they belong to.
- [ ] 3.8 Local install: a `.vsix` or a symlink into the extensions folder, documented.

## 4. Later / maybe

- [ ] 4.1 A cap on the number of events per process (`maxCalls` in the config) for runaway loops. *(proposed)*
- [ ] 4.2 Live tailing: the tree view follows a log as it's written. *(proposed)*
- [ ] 4.3 Search and filter in the tree view (by function name or file). *(proposed)*
