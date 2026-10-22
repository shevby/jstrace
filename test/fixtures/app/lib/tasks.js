'use strict';

// Asynchronous code: async functions resuming after await, an async arrow, a timer callback,
// a .then() callback, and a generator.

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

async function double(value) {
  await delay(1);
  return value * 2;
}

async function total(values) {
  let result = 0;
  for (const value of values) result += await double(value);
  return result;
}

const doubleAll = async (values) => Promise.all(values.map(double));

function* ids(count) {
  for (let i = 1; i <= count; i++) yield `id${i}`;
}

function later(value) {
  return delay(1, value).then((result) => result.toUpperCase());
}

module.exports = { total, doubleAll, ids, later };
