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

All done; see [DONE.md](DONE.md).

## 2. Runtime (injected prelude)

All done; see [DONE.md](DONE.md).

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
