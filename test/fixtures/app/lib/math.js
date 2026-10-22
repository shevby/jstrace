'use strict';

// Plain functions in every form: a declaration (recursive), a function expression, arrows with
// a block and an expression body, a callback, object method shorthand, and a function assigned
// to a property. divide throws, and safeDivide catches it.

function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

const sum = function (values) {
  return values.reduce((total, value) => total + value, 0);
};

const divide = (a, b) => {
  if (b === 0) throw new Error('division by zero');
  return a / b;
};

const half = (value) => value / 2;

function safeDivide(a, b) {
  try {
    return divide(a, b);
  } catch (error) {
    return `failed: ${error.message}`;
  }
}

const counter = {
  count: 0,
  increment() {
    return ++this.count;
  },
};

exports.describe = function (values) {
  return values.map(half).join('/');
};

exports.factorial = factorial;
exports.sum = sum;
exports.divide = divide;
exports.safeDivide = safeDivide;
exports.counter = counter;
