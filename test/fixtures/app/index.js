#!/usr/bin/env node
'use strict';

// The entry point: a shebang and a directive, which injection must keep in place.

const path = require('node:path');
const { fork } = require('node:child_process');
const math = require('./lib/math');
const { Shape, Circle, Square } = require('./lib/shapes');
const tasks = require('./lib/tasks');
const { pad } = require('./lib/util.cjs');
const { slug } = require('./lib/vendor.min.js');
const greet = require('greeter');

function runChild(input) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'child.js'), [String(input)]);
    child.on('message', resolve);
    child.on('error', reject);
  });
}

async function main() {
  const lines = [];
  lines.push(greet('jstrace'));
  lines.push(`factorial(5) = ${math.factorial(5)}`);
  lines.push(`sum = ${math.sum([1, 2, 3])}`);
  lines.push(`safeDivide = ${math.safeDivide(1, 0)}`);
  math.counter.increment();
  lines.push(`counter = ${math.counter.increment()}`);
  lines.push(`describe = ${math.describe([1, 2])}`);

  const shapes = [new Circle(1), new Square(2)];
  for (const shape of shapes) lines.push(shape.describe());
  shapes[1].scale = 2;
  lines.push(`scaled = ${shapes[1].describe()}`);
  lines.push(`largest = ${shapes.sort(Shape.compare).at(-1).name}`);
  lines.push(`label = ${shapes[0].label()}`);

  lines.push(`total = ${await tasks.total([1, 2, 3])}`);
  lines.push(`all = ${(await tasks.doubleAll([1, 2, 3])).join(',')}`);
  lines.push(`ids = ${[...tasks.ids(3)].join(',')}`);
  lines.push(`later = ${await tasks.later('done')}`);
  lines.push(`child = ${await runChild(4)}`);
  lines.push(pad('end', 5));
  lines.push(slug('Hello World'));
  lines.push(greet.each(['a', 'b'], (item, index) => `${index}:${item}`).join(' '));

  for (const line of lines) console.log(line);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
