'use strict';

/**
 * `jstrace instrument` and `jstrace restore` (see Architecture in CLAUDE.md). Originals are
 * kept in `.jstrace/backup/` with the paths they have in the project, and `manifest.json`
 * there lists the instrumented files with a hash of what was written, so a file edited since
 * is noticed and never overwritten.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ConfigError } = require('./config');
const { filter } = require('./glob');
const { instrumentSource, isInstrumented } = require('./instrument');
const { CONFIG_FILE, relative } = require('./project');

/** Where `jstrace mock` puts a mock when it's given no path. */
const MOCK_FILE = 'jstrace.mock.js';

/** The template of a mock (4.15). */
const MOCK_TEMPLATE = path.join(__dirname, '..', 'runtime', 'mock-template.js');

/** @typedef {import('./project').Project} Project */
/** @typedef {import('./cli').Output} Output */

/**
 * The list of instrumented files, by their path relative to the project.
 * @typedef {object} Manifest
 * @property {Record<string, { hash: string }>} files each file's hash of what was written to it
 */

/**
 * Reads the manifest, or an empty one when there's none.
 * @param {Project} project
 * @returns {Manifest}
 */
function readManifest(project) {
  if (!fs.existsSync(project.manifest)) return { files: {} };
  return JSON.parse(fs.readFileSync(project.manifest, 'utf8'));
}

/**
 * Writes the manifest, or removes the backup folder once nothing is instrumented.
 * @param {Project} project
 * @param {Manifest} manifest
 * @returns {void}
 */
function writeManifest(project, manifest) {
  if (Object.keys(manifest.files).length === 0) {
    fs.rmSync(project.backup, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(project.backup, { recursive: true });
  fs.writeFileSync(project.manifest, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * A hash of a file's content.
 * @param {string | Buffer} content
 * @returns {string}
 */
function hash(content) {
  return crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * Resolves targets given on the command line to paths relative to the project.
 * @param {Project} project
 * @param {string[]} targets
 * @param {string} cwd what relative targets are relative to
 * @param {boolean} mustExist
 * @returns {string[]} the paths (`''` for the project itself)
 * @throws {Error} with a message for the user, for a target outside the project or missing
 */
function resolveTargets(project, targets, cwd, mustExist) {
  return targets.map((target) => {
    const absolute = path.resolve(cwd, target);
    const rel = relative(project, absolute);
    if (rel === null) throw new Error(`${target}: not inside the project (${project.dir})`);
    if (mustExist && !fs.existsSync(absolute)) throw new Error(`${target}: no such file or folder`);
    return rel;
  });
}

/**
 * The files a target stands for: itself, if it's a file (whatever the filter says), or the
 * files under it the filter takes. Symbolic links to folders aren't followed.
 * @param {Project} project
 * @param {string} target relative to the project
 * @param {ReturnType<typeof filter>} accept
 * @returns {string[]} paths relative to the project
 */
function collectFiles(project, target, accept) {
  const absolute = path.join(project.dir, target);
  if (!fs.statSync(absolute).isDirectory()) return [target];
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir relative to the project */
  const visit = (dir) => {
    for (const entry of fs.readdirSync(path.join(project.dir, dir), { withFileTypes: true })) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (relative(project, path.join(project.dir, rel)) === null) continue; // .jstrace/
      if (entry.isDirectory()) {
        if (accept.directory(rel)) visit(rel);
      } else if (entry.isFile() && accept.file(rel)) {
        files.push(rel);
      }
    }
  };
  visit(target);
  return files;
}

/**
 * `jstrace instrument <target...>`: injects tracing into the files under the targets,
 * backing up their originals. A file instrumented already is instrumented afresh from its
 * original; one edited since, or with injected code but no backup, is left alone.
 * @param {Project} project
 * @param {string[]} targets as given, relative to `cwd`
 * @param {string} cwd
 * @param {Output} output
 * @returns {number} the exit code
 */
function instrument(project, targets, cwd, output) {
  let config;
  let rels;
  try {
    const loaded = loadConfig(project.config);
    config = loaded.config;
    if (loaded.created) output.out(`Created ${CONFIG_FILE} with the defaults in ${project.dir}`);
    rels = resolveTargets(project, targets, cwd, true);
  } catch (error) {
    output.err(error instanceof ConfigError || error instanceof Error ? error.message : String(error));
    return 1;
  }
  const accept = filter(config.include, config.exclude);
  const mock = config.mock ? path.resolve(project.dir, config.mock) : undefined;
  // The mock is never instrumented: it's loaded while the runtime is being made.
  const files = [...new Set(rels.flatMap((rel) => collectFiles(project, rel, accept)))].filter((rel) => path.join(project.dir, rel) !== mock).sort();
  const options = { logs: project.logs, root: project.dir, maxDepth: config.maxDepth, maxString: config.maxString, maxLine: config.maxLine, maxRepeat: config.maxRepeat, callSites: config.callSites, mock };
  const externalCalls = config.externalCalls ? { ignore: config.ignoreCalls } : undefined;
  const manifest = readManifest(project);
  let done = 0;
  let again = 0;
  let skipped = 0;
  try {
    for (const rel of files) {
      const file = path.join(project.dir, rel);
      const backup = path.join(project.backup, rel);
      const current = fs.readFileSync(file);
      const entry = manifest.files[rel];
      if (entry && hash(current) !== entry.hash) {
        output.err(`${rel}: changed since it was instrumented, so it's left as it is (restore it first; the original is in ${path.relative(project.dir, backup)})`);
        skipped++;
        continue;
      }
      const original = entry ? fs.readFileSync(backup, 'utf8') : current.toString('utf8');
      if (!entry && isInstrumented(original)) {
        output.err(`${rel}: has injected code but no backup, so it's left as it is`);
        skipped++;
        continue;
      }
      let code;
      try {
        code = instrumentSource(original, { file, options, externalCalls }).code;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        output.err(`${rel}: skipped, it can't be parsed as a CommonJS script (${error.message})`);
        skipped++;
        continue;
      }
      if (entry) {
        again++;
      } else {
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(file, backup);
      }
      fs.writeFileSync(file, code);
      manifest.files[rel] = { hash: hash(code) };
      done++;
    }
  } finally {
    writeManifest(project, manifest);
  }
  const instrumented = again ? ` (${again} of them again)` : '';
  output.out(`Instrumented ${count(done, 'file')}${instrumented}${skipped ? `, skipped ${skipped}` : ''}`);
  return 0;
}

/**
 * `jstrace restore [target...]`: puts back the originals of the instrumented files (under
 * the targets, if any). A file edited since it was instrumented, or deleted, is left alone,
 * its original kept.
 * @param {Project} project
 * @param {string[]} targets as given, relative to `cwd`
 * @param {string} cwd
 * @param {Output} output
 * @returns {number} the exit code
 */
function restore(project, targets, cwd, output) {
  let rels;
  try {
    rels = resolveTargets(project, targets, cwd, false);
  } catch (error) {
    output.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const manifest = readManifest(project);
  const under = (/** @type {string} */ file) =>
    rels.length === 0 || rels.some((rel) => rel === '' || file === rel || file.startsWith(rel + '/'));
  const files = Object.keys(manifest.files).filter(under).sort();
  if (files.length === 0) {
    output.out('Nothing to restore');
    return 0;
  }
  let done = 0;
  let left = 0;
  try {
    for (const rel of files) {
      const file = path.join(project.dir, rel);
      const backup = path.join(project.backup, rel);
      const kept = path.relative(project.dir, backup);
      if (!fs.existsSync(file)) {
        output.err(`${rel}: deleted, so it's left as it is (the original is in ${kept})`);
        left++;
        continue;
      }
      if (hash(fs.readFileSync(file)) !== manifest.files[rel].hash) {
        output.err(`${rel}: changed since it was instrumented, so it's left as it is (the original is in ${kept})`);
        left++;
        continue;
      }
      fs.copyFileSync(backup, file);
      fs.rmSync(backup);
      removeEmptyFolders(path.dirname(backup), project.backup);
      delete manifest.files[rel];
      done++;
    }
  } finally {
    writeManifest(project, manifest);
  }
  output.out(`Restored ${count(done, 'file')}${left ? `, left ${left} as they are` : ''}`);
  return 0;
}

/**
 * Removes a folder and the ones above it while they're empty, up to (not including) `stop`.
 * @param {string} dir
 * @param {string} stop
 * @returns {void}
 */
function removeEmptyFolders(dir, stop) {
  while (dir !== stop && dir.startsWith(stop) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

/**
 * `3 files`, `1 file`.
 * @param {number} n
 * @param {string} noun
 * @returns {string}
 */
function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * `jstrace mock [file]`: creates a mock module from the template (4.15), unless the file is
 * there already, and names it in the config (created with the defaults when missing), so
 * tracing loads it once the files are instrumented again.
 * @param {Project} project
 * @param {string[]} targets the mock's path, or none for the one the config names, else
 *   `jstrace.mock.js` in the project
 * @param {string} cwd what `targets` are relative to
 * @param {Output} output
 * @returns {number} the exit code
 */
function createMock(project, targets, cwd, output) {
  try {
    const { config, created } = loadConfig(project.config);
    if (created) output.out(`Created ${CONFIG_FILE} with the defaults in ${project.dir}`);
    const file = targets.length > 0 ? path.resolve(cwd, targets[0]) : path.join(project.dir, config.mock || MOCK_FILE);
    const rel = relative(project, file);
    if (!rel) throw new Error(`${targets[0] ?? file}: not a file inside the project (${project.dir})`);
    const kept = fs.existsSync(file);
    if (!kept) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(MOCK_TEMPLATE, file);
    }
    const data = JSON.parse(fs.readFileSync(project.config, 'utf8'));
    data.mock = rel;
    fs.writeFileSync(project.config, JSON.stringify(data, null, 2) + '\n');
    output.out(`${kept ? `Kept ${rel} as it is` : `Created ${rel} from the template`}, and set "mock" to it in ${CONFIG_FILE}. Edit it, then instrument again.`);
    return 0;
  } catch (error) {
    output.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

module.exports = { instrument, restore, createMock, readManifest, MOCK_FILE };
