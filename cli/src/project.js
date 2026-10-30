'use strict';

/**
 * The project: the folder holding `jstrace.config.json` and `.jstrace/` (see Glossary in
 * CLAUDE.md), and the paths of everything jstrace keeps there.
 */

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'jstrace.config.json';
const JSTRACE_DIR = '.jstrace';

/**
 * A project's folder and the paths jstrace uses in it, all absolute.
 * @typedef {object} Project
 * @property {string} dir the project folder
 * @property {string} config `jstrace.config.json`
 * @property {string} logs `.jstrace/logs`, where the runtime writes
 * @property {string} backup `.jstrace/backup`, the originals of instrumented files
 * @property {string} manifest `.jstrace/backup/manifest.json`, the list of instrumented files
 * @property {string} journal `.jstrace/backup/manifest.log`, what `instrument` added to the list so far
 * @property {string} injected `.jstrace/injected.json`, the targets instrumented since nothing was, for `reinject`
 */

/**
 * The paths of a project in a folder.
 * @param {string} dir the project folder
 * @returns {Project}
 */
function projectAt(dir) {
  dir = path.resolve(dir);
  const backup = path.join(dir, JSTRACE_DIR, 'backup');
  return {
    dir,
    config: path.join(dir, CONFIG_FILE),
    logs: path.join(dir, JSTRACE_DIR, 'logs'),
    backup,
    manifest: path.join(backup, 'manifest.json'),
    journal: path.join(backup, 'manifest.log'),
    injected: path.join(dir, JSTRACE_DIR, 'injected.json'),
  };
}

/**
 * Finds the project for a directory: the nearest folder from it upwards that holds a
 * `jstrace.config.json` or `.jstrace/`, or else the directory itself.
 * @param {string} cwd the directory to start from
 * @returns {Project}
 */
function findProject(cwd) {
  const start = path.resolve(cwd);
  for (let dir = start; ; ) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE)) || fs.existsSync(path.join(dir, JSTRACE_DIR))) {
      return projectAt(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return projectAt(start);
    dir = parent;
  }
}

/**
 * A path relative to the project, with `/` separators, or `null` when it's outside the
 * project (or is the `.jstrace/` folder or something in it).
 * @param {Project} project
 * @param {string} file an absolute path
 * @returns {string | null} `''` for the project folder itself
 */
function relative(project, file) {
  const rel = path.relative(project.dir, file);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join('/');
  if (posix === JSTRACE_DIR || posix.startsWith(JSTRACE_DIR + '/')) return null;
  return posix;
}

module.exports = { CONFIG_FILE, JSTRACE_DIR, projectAt, findProject, relative };
