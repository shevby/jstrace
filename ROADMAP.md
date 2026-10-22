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

All done; see [DONE.md](DONE.md).

## 4. Later / maybe

4.1 and 4.5 are done; see [DONE.md](DONE.md).

- [ ] 4.2 Live tailing: the tree view follows a log as it's written. *(proposed)*
- [ ] 4.3 Search and filter in the tree view (by function name or file). *(proposed)*
- [ ] 4.4 Node's own objects in values (a `Timeout` returned by `setTimeout`, its `TimersList`, sockets) shown as just `[Timeout]`, instead of their internal fields filling a whole line. *(proposed)*
