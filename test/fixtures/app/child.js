'use strict';

// Forked by index.js: a second process, which gets a log of its own.

const math = require('./lib/math');

function square(value) {
  return value * value;
}

process.send(`${square(Number(process.argv[2]))} ${math.factorial(3)}`, () => process.disconnect());
