'use strict';

/**
 * A small glob matcher for the config's include/exclude patterns (acorn is the only
 * dependency). Paths and patterns use `/`, relative to the project:
 * - `*` matches any characters but `/`, and `?` one of them;
 * - `**` as a whole segment matches any number of segments, none included (`**` + `/x.js`
 *   matches `x.js` and `a/b/x.js`; `dir/` + `**` matches everything under `dir`);
 * - anything else matches itself.
 */

/**
 * Turns a glob into a regular expression matching whole paths.
 * @param {string} pattern
 * @returns {RegExp}
 */
function compile(pattern) {
  let source = '';
  const segments = pattern.split('/');
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      // Any number of whole segments: "a/**/b", "**/b", "a/**".
      source += last ? (index === 0 ? '.*' : '(?:/.*)?') : index === 0 ? '(?:.*/)?' : '(?:/.*)?/';
      return;
    }
    if (index > 0 && segments[index - 1] !== '**') source += '/';
    for (const char of segment) {
      if (char === '*') source += '[^/]*';
      else if (char === '?') source += '[^/]';
      else source += char.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
    }
  });
  return new RegExp(`^${source}$`);
}

/**
 * Builds a filter from include and exclude patterns.
 * @param {string[]} include a file must match one of them
 * @param {string[]} exclude and none of these
 * @returns {{ file: (path: string) => boolean, directory: (path: string) => boolean }}
 *   `file` says whether a file is taken; `directory` whether a folder is worth walking
 *   (everything in it excluded or not)
 */
function filter(include, exclude) {
  const included = include.map(compile);
  const excluded = exclude.map(compile);
  return {
    file: (path) => included.some((re) => re.test(path)) && !excluded.some((re) => re.test(path)),
    // A folder whose contents are excluded as a whole: "dir/**" matches "dir/" too.
    directory: (path) => !excluded.some((re) => re.test(path + '/')),
  };
}

module.exports = { compile, filter };
