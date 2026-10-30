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

4.1, 4.2, 4.3, 4.5, 4.6, 4.7, 4.10, 4.12, 4.13, 4.14, 4.15, 4.16, 4.17, 4.19, 4.20, 4.21, 4.22, 4.23 and 4.24 are done; see [DONE.md](DONE.md).

- [ ] 4.4 Node's own objects in values (a `Timeout` returned by `setTimeout`, its `TimersList`, sockets) shown as just `[Timeout]`, instead of their internal fields filling a whole line. *(proposed)*
- [ ] 4.8 Call durations: "took 12 ms" in a call's description (from its `call` and `return` times; async waits included), and a command listing a log's slowest calls. *(proposed)*
- [ ] 4.9 From code to calls: a CodeLens above each traced function in the editor ("called 12 times, last ← 120") from the selected log; clicking it reveals those calls in the tree. *(proposed)*
- [ ] 4.11 Copy a value: context-menu commands copying a call's arguments or return value as JSON. *(proposed)*
- [ ] 4.18 Find Calls at This Line inside a function's body: when nothing was called from the line, list the calls of the function around the cursor (found with VSCode's document symbols, since the logs have no function ends). *(proposed)*
