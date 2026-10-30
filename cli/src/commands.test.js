'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('./cli');
const { readInjected, readManifest } = require('./commands');
const { isInstrumented } = require('./instrument');
const { projectAt } = require('./project');
const { APP_OUTPUT, FIXTURES, copyFixture } = require('../../test/helpers');

/** The app fixture's files that the default config instruments. */
const INSTRUMENTED = [
  'child.js', 'index.js', 'lib/math.js', 'lib/shapes.js', 'lib/tasks.js', 'lib/util.cjs', 'node_modules/greeter/index.js',
];

/**
 * Runs the CLI in a folder and collects what it writes.
 * @param {string} cwd
 * @param {...string} argv
 * @returns {{ code: number, out: string[], err: string[] }}
 */
function run(cwd, ...argv) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = main(argv, { out: (text) => out.push(text), err: (text) => err.push(text) }, cwd);
  return { code, out, err };
}

/**
 * A file of the app fixture, as it is in `test/fixtures` and as it is in a copy.
 * @param {string} dir the copy
 * @param {string} file relative to the app
 * @returns {{ original: string, current: string }}
 */
function file(dir, file) {
  return {
    original: fs.readFileSync(path.join(FIXTURES, 'app', file), 'utf8'),
    current: fs.readFileSync(path.join(dir, file), 'utf8'),
  };
}

test('instrument creates the config, backs up and instruments the files, and the app still runs', (t) => {
  const dir = copyFixture(t, 'app');
  const { code, out, err } = run(dir, 'instrument', '.');
  assert.equal(code, 0);
  assert.deepEqual(out, [`Created jstrace.config.json with the defaults in ${dir}`, 'Instrumented 7 files, skipped 1']);
  assert.equal(err.length, 1);
  assert.match(err[0], /^lib\/esm\.js: skipped, it can't be parsed as a CommonJS script \(.*\(4:0\)\)$/);

  assert.deepEqual(Object.keys(readManifest(projectAt(dir)).files), INSTRUMENTED);
  for (const rel of INSTRUMENTED) {
    assert.ok(isInstrumented(file(dir, rel).current), rel);
    assert.equal(fs.readFileSync(path.join(dir, '.jstrace/backup', rel), 'utf8'), file(dir, rel).original, rel);
  }
  for (const rel of ['lib/esm.js', 'lib/vendor.min.js']) assert.equal(file(dir, rel).current, file(dir, rel).original, rel);
  assert.equal(execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' }), APP_OUTPUT);
});

test('restore puts every original back and removes the backup', (t) => {
  const dir = copyFixture(t, 'app');
  run(dir, 'instrument', '.');
  const { code, out, err } = run(dir, 'restore');
  assert.deepEqual([code, out, err], [0, ['Restored 7 files'], []]);
  for (const rel of INSTRUMENTED) assert.equal(file(dir, rel).current, file(dir, rel).original, rel);
  assert.ok(!fs.existsSync(path.join(dir, '.jstrace/backup')));
  assert.ok(fs.existsSync(path.join(dir, 'jstrace.config.json')));
  assert.deepEqual(run(dir, 'restore').out, ['Nothing to restore']);
});

test('instrumenting again starts from the originals, and picks up the config', (t) => {
  const dir = copyFixture(t, 'app');
  run(dir, 'instrument', 'lib/math.js');
  const once = file(dir, 'lib/math.js').current;
  assert.deepEqual(run(dir, 'instrument', 'lib').out, ['Instrumented 4 files (1 of them again), skipped 1']);
  assert.equal(file(dir, 'lib/math.js').current, once);
  fs.writeFileSync(path.join(dir, 'jstrace.config.json'), '{ "maxDepth": 7 }');
  run(dir, 'instrument', 'lib/math.js');
  assert.match(file(dir, 'lib/math.js').current, /"maxDepth":7/);
  run(dir, 'restore');
  assert.equal(file(dir, 'lib/math.js').current, file(dir, 'lib/math.js').original);
});

test('targets add up, and restore can take some of them', (t) => {
  const dir = copyFixture(t, 'app');
  run(dir, 'instrument', 'lib/math.js', 'node_modules/greeter');
  run(dir, 'instrument', 'child.js');
  assert.deepEqual(Object.keys(readManifest(projectAt(dir)).files).sort(), ['child.js', 'lib/math.js', 'node_modules/greeter/index.js']);
  assert.deepEqual(run(dir, 'restore', 'node_modules', 'lib').out, ['Restored 2 files']);
  assert.deepEqual(Object.keys(readManifest(projectAt(dir)).files), ['child.js']);
  assert.ok(!fs.existsSync(path.join(dir, '.jstrace/backup/node_modules')));
});

test('what an instrument killed midway rewrote can still be restored', (t) => {
  const dir = copyFixture(t, 'app');
  const project = projectAt(dir);
  const killed = `require(${JSON.stringify(require.resolve('./cli'))}).main(['instrument', '.'], { out() {}, err() { process.exit(9); } }, ${JSON.stringify(dir)});`;
  assert.equal(spawnSync(process.execPath, ['-e', killed]).status, 9, 'at the first file it skips');
  assert.ok(!fs.existsSync(project.manifest), 'it never got to write the manifest');
  const rewritten = Object.keys(readManifest(project).files);
  assert.ok(rewritten.length > 0);
  for (const rel of rewritten) assert.ok(isInstrumented(file(dir, rel).current), rel);

  fs.appendFileSync(project.journal, '["cut sh'); // a line the kill cut short
  assert.equal(run(dir, 'restore').code, 0);
  for (const rel of rewritten) assert.equal(file(dir, rel).current, file(dir, rel).original, rel);
  assert.ok(!fs.existsSync(project.backup), 'nothing left');

  assert.equal(run(dir, 'instrument', 'index.js').code, 0);
  assert.ok(fs.existsSync(project.manifest));
  assert.ok(!fs.existsSync(project.journal), 'a run that ended needs none');
});

test('--project names the project, whatever is above the folder', (t) => {
  const dir = copyFixture(t, 'app');
  run(dir, 'init');
  const folder = path.join(dir, 'lib');
  assert.equal(run(folder, '--project', '.', 'instrument', 'math.js').code, 0);
  assert.deepEqual(Object.keys(readManifest(projectAt(folder)).files), ['math.js']);
  assert.ok(!fs.existsSync(projectAt(dir).manifest), 'not the one above');
  assert.equal(run(dir, '--project').code, 2);
});

test('reinject skips a recorded path outside the project, and goes on with the others', (t) => {
  const dir = copyFixture(t, 'app');
  run(dir, 'instrument', 'lib');
  const targets = ['lib', '../elsewhere', path.resolve(dir, '..'), '.jstrace/backup'];
  fs.writeFileSync(path.join(dir, '.jstrace', 'injected.json'), JSON.stringify({ targets, done: false }));
  const { code, out, err } = run(dir, 'reinject');
  assert.equal(code, 0);
  assert.equal(out[0], 'Reinjecting lib');
  assert.deepEqual(err.filter((line) => line.includes('not inside')), targets.slice(1).map((target) => `${target}: not inside the project, so it's skipped`));
});

test('reinject instruments again the targets since all was last restored, new files in them too', (t) => {
  const dir = copyFixture(t, 'app');
  assert.deepEqual(run(dir, 'reinject'), { code: 1, out: [], err: ['Nothing to reinject: nothing was instrumented in this project yet'] });
  run(dir, 'instrument', 'lib/math.js', 'node_modules/greeter');
  run(path.join(dir, 'lib'), 'instrument', '../child.js', 'math.js');
  assert.deepEqual(readInjected(projectAt(dir)), { targets: ['lib/math.js', 'node_modules/greeter', 'child.js'], done: false }, 'they add up');
  run(dir, 'restore', 'lib');
  assert.equal(readInjected(projectAt(dir)).done, false, 'not all restored');
  run(dir, 'restore');
  assert.equal(readInjected(projectAt(dir)).done, true);

  fs.writeFileSync(path.join(dir, 'node_modules/greeter/extra.js'), 'module.exports = () => 1;');
  fs.rmSync(path.join(dir, 'child.js'));
  const { code, out, err } = run(path.join(dir, 'lib'), 'reinject');
  assert.deepEqual([code, out, err], [0, ['Reinjecting lib/math.js, node_modules/greeter', 'Instrumented 3 files'], ["child.js: no longer there, so it's skipped"]]);
  assert.ok(isInstrumented(fs.readFileSync(path.join(dir, 'node_modules/greeter/extra.js'), 'utf8')), 'a new file');
  assert.deepEqual(readInjected(projectAt(dir)), { targets: ['lib/math.js', 'node_modules/greeter'], done: false });

  run(dir, 'restore');
  run(dir, 'instrument', '.');
  assert.deepEqual(readInjected(projectAt(dir)).targets, ['.'], 'afresh once all was restored');
  assert.deepEqual(run(dir, 'reinject').out.at(-1), 'Instrumented 7 files (7 of them again), skipped 1');
  assert.equal(run(dir, 'reinject', 'x').code, 2);
});

test('a file named outright is taken whatever the filter says', (t) => {
  const dir = copyFixture(t, 'app');
  assert.deepEqual(run(dir, 'instrument', 'lib/vendor.min.js').out.at(-1), 'Instrumented 1 file');
  assert.ok(isInstrumented(file(dir, 'lib/vendor.min.js').current));
});

test('a file edited since it was instrumented is left alone', (t) => {
  const dir = copyFixture(t, 'app');
  run(dir, 'instrument', 'lib');
  const math = path.join(dir, 'lib/math.js');
  fs.appendFileSync(math, '// edited\n');
  const edited = fs.readFileSync(math, 'utf8');

  const again = run(dir, 'instrument', 'lib/math.js');
  assert.deepEqual(again.out, ['Instrumented 0 files, skipped 1']);
  assert.match(again.err[0], /^lib\/math\.js: changed since it was instrumented, so it's left as it is/);

  const { out, err } = run(dir, 'restore');
  assert.deepEqual(out, ['Restored 3 files, left 1 as they are']);
  assert.match(err[0], /^lib\/math\.js: changed since it was instrumented.*\.jstrace[\\/]backup[\\/]lib[\\/]math\.js\)$/);
  assert.equal(fs.readFileSync(math, 'utf8'), edited);
  assert.deepEqual(Object.keys(readManifest(projectAt(dir)).files), ['lib/math.js']);
});

test('instrument keeps .jstrace/ out of git, unless the user made its .gitignore', (t) => {
  const dir = copyFixture(t, 'app');
  const ignore = path.join(dir, '.jstrace/.gitignore');
  run(dir, 'instrument', 'lib/math.js');
  assert.match(fs.readFileSync(ignore, 'utf8'), /^\*$/m);
  run(dir, 'restore');
  assert.ok(fs.existsSync(ignore), 'restore keeps it');

  fs.writeFileSync(ignore, '# mine\n');
  run(dir, 'instrument', 'lib/math.js');
  assert.equal(fs.readFileSync(ignore, 'utf8'), '# mine\n');
});

test('restore never writes outside the project, whatever the manifest names', (t) => {
  const dir = copyFixture(t, 'app');
  const victim = path.join(dir, '..', `${path.basename(dir)}-victim.js`);
  fs.writeFileSync(victim, '');
  t.after(() => fs.rmSync(victim, { force: true }));
  fs.mkdirSync(path.join(dir, '.jstrace/backup'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.jstrace', `${path.basename(dir)}-victim.js`), 'payload');
  const empty = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'; // the hash of an empty file
  const files = { [`../${path.basename(dir)}-victim.js`]: { hash: empty }, '.jstrace/x.js': { hash: empty }, 'lib/../index.js': { hash: empty } };
  fs.writeFileSync(path.join(dir, '.jstrace/backup/manifest.json'), JSON.stringify({ files }));

  const { out, err } = run(dir, 'restore');
  assert.deepEqual(out, ['Restored 0 files, left 3 as they are']);
  assert.equal(err.length, 3);
  for (const line of err) assert.match(line, /: not a path inside the project, so it's left alone$/);
  assert.equal(fs.readFileSync(victim, 'utf8'), '');
});

test('a file with injected code but no backup is refused', (t) => {
  const dir = copyFixture(t, 'app');
  run(dir, 'instrument', 'lib/math.js');
  fs.rmSync(path.join(dir, '.jstrace'), { recursive: true });
  const { out, err } = run(dir, 'instrument', 'lib/math.js');
  assert.deepEqual(out, ['Instrumented 0 files, skipped 1']);
  assert.deepEqual(err, ["lib/math.js: has injected code but no backup, so it's left as it is"]);
});

test('paths are relative to the current folder, and the project is found above it', (t) => {
  const dir = copyFixture(t, 'app');
  fs.writeFileSync(path.join(dir, 'jstrace.config.json'), '{}');
  const lib = path.join(dir, 'lib');
  assert.deepEqual(run(lib, 'instrument', 'math.js').out, ['Instrumented 1 file']);
  assert.deepEqual(Object.keys(readManifest(projectAt(dir)).files), ['lib/math.js']);
  assert.ok(!fs.existsSync(path.join(lib, '.jstrace')));
  assert.deepEqual(run(lib, 'restore', '.').out, ['Restored 1 file']);
});

test('targets outside the project, missing, or a bad config fail', (t) => {
  const dir = copyFixture(t, 'app');
  fs.writeFileSync(path.join(dir, 'jstrace.config.json'), '{}');
  assert.deepEqual(run(dir, 'instrument', '..').err, [`..: not inside the project (${dir})`]);
  assert.deepEqual(run(dir, 'instrument', 'nope').err, ['nope: no such file or folder']);
  assert.equal(run(dir, 'restore', '..').code, 1);
  fs.writeFileSync(path.join(dir, 'jstrace.config.json'), '{ "include": 1 }');
  const { code, err } = run(dir, 'instrument', '.');
  assert.equal(code, 1);
  assert.match(err[0], /"include" must be an array/);
});

test('init creates the config and .jstrace/ before anything is instrumented, keeping a config there', (t) => {
  const dir = copyFixture(t, 'app');
  assert.deepEqual(run(dir, 'init'), { code: 0, out: [`Created jstrace.config.json with the defaults in ${dir}. Edit it, then instrument.`], err: [] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'jstrace.config.json'), 'utf8')).maxDepth, 3);
  assert.match(fs.readFileSync(path.join(dir, '.jstrace', '.gitignore'), 'utf8'), /^\*$/m);
  assert.ok(!fs.existsSync(projectAt(dir).backup), 'nothing instrumented');
  assert.equal(file(dir, 'index.js').current, file(dir, 'index.js').original);

  fs.writeFileSync(path.join(dir, 'jstrace.config.json'), '{ "maxDepth": 5 }');
  fs.mkdirSync(path.join(dir, 'lib', 'deep'));
  assert.deepEqual(run(path.join(dir, 'lib', 'deep'), 'init').out, [`Kept jstrace.config.json as it is in ${dir}. Edit it, then instrument.`], 'the project above');
  assert.equal(fs.readFileSync(path.join(dir, 'jstrace.config.json'), 'utf8'), '{ "maxDepth": 5 }');
  fs.writeFileSync(path.join(dir, 'jstrace.config.json'), '{ "maxDepth": "deep" }');
  assert.equal(run(dir, 'init').code, 1, 'a bad config fails');
  assert.equal(run(dir, 'init', 'lib').code, 2);
});

test('mock creates a mock from the template and names it in the config; tracing loads it, never instrumented', (t) => {
  const dir = copyFixture(t, 'app');
  const { code, out } = run(dir, 'mock');
  assert.equal(code, 0);
  assert.deepEqual(out, ['Created jstrace.config.json with the defaults in ' + dir, 'Created jstrace.mock.js from the template, and set "mock" to it in jstrace.config.json. Edit it, then instrument again.']);
  assert.equal(fs.readFileSync(path.join(dir, 'jstrace.mock.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'runtime', 'mock-template.js'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'jstrace.config.json'), 'utf8')).mock, 'jstrace.mock.js');
  assert.deepEqual(require(path.join(dir, 'jstrace.mock.js')), {}, 'the template changes nothing until it is edited');

  const elsewhere = path.join(dir, 'mocked-logs');
  fs.writeFileSync(path.join(dir, 'jstrace.mock.js'), `module.exports = { env: (name) => (name === 'JSTRACE_OUT' ? ${JSON.stringify(elsewhere)} : undefined) };\n`);
  assert.equal(run(dir, 'instrument', '.').code, 0);
  assert.ok(!isInstrumented(fs.readFileSync(path.join(dir, 'jstrace.mock.js'), 'utf8')));
  assert.equal(execFileSync(process.execPath, ['index.js'], { cwd: dir, encoding: 'utf8' }), APP_OUTPUT);
  assert.equal(fs.readdirSync(elsewhere).filter((name) => name.endsWith('.jsonl')).length, 2, 'both processes logged where the mock said');
  assert.ok(!fs.existsSync(projectAt(dir).logs));

  assert.match(run(dir, 'mock').out[0], /^Kept jstrace\.mock\.js as it is/);
  assert.match(run(dir, 'mock', '../outside.js').err[0], /not a file inside the project/);
});
