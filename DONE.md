# jstrace — Done

These are completed roadmap items, moved out of [ROADMAP.md](ROADMAP.md) to keep it focused on what's left. IDs are stable and never reused (see ROADMAP.md's header), so a number here is still taken; check both files before assigning a new one. A milestone with items still open keeps a one-line pointer, in ROADMAP.md, instead of its done items. Once every item in it is finished, the milestone moves here as a whole block.

## 0. Foundation

- [x] 0.1 Git repo on `master`, with a branch per feature/fix.
- [x] 0.2 Project skeleton: a root npm workspace over `cli/` and `vscode/`, the `jstrace` bin, `node --test`, and `npm run check`.
  - The CLI parses its command line by hand (`cli/src/cli.js`). `main(argv, output)` returns the exit code: 0 for success, 1 for a failure, 2 for a wrong command line. `instrument` and `restore` say they aren't implemented yet.
  - The extension is an empty `activate`, activated by a `.jstrace` folder in the workspace.
