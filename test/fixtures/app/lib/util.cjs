'use strict';

// A .cjs file, which the default config includes.

function pad(text, width) {
  return text.padStart(width, '.');
}

module.exports = { pad };
