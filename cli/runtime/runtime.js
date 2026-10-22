'use strict';

/**
 * The runtime that instrumented code calls (see Architecture in CLAUDE.md). The prelude of
 * every instrumented file embeds `createRuntime`'s source and runs it once per process, as
 * `globalThis.__jt`; so `createRuntime` must be self-contained, using nothing from this
 * module, and must stick to what any JS runtime has, Node's `fs` aside.
 *
 * What instrumented code does with it:
 * - each file starts with `var __jtm = __jt.load(file, functions)`;
 * - each function starts with `const __jtc = __jtm.enter(index, [params])`, its body in
 *   `try { … } catch (e) { throw __jtc.throw(e) } finally { __jtc.exit() }`, and each
 *   `return x` as `return __jtc.ret(x)`;
 * - `await x` becomes `__jtc.r(await __jtc.sa(x))`, and `yield x` `__jtc.r(yield __jtc.sy(x))`.
 *
 * This one passes everything through and logs nothing yet: the logging is milestone 2.
 */

/**
 * A function's metadata, as the instrumenter found it in the original source.
 * @typedef {[name: string, line: number, column: number, params: string[]]} FunctionInfo
 *   `line` counts from 1 and `column` from 0, as acorn does; `params` are the names bound by
 *   the parameters, in the order their values are passed to `enter`
 */

/**
 * One call of a function, from `enter` to `exit`.
 * @typedef {object} Frame
 * @property {<T>(value: T) => T} ret the function returns `value`
 * @property {<T>(error: T) => T} throw the function throws `error` (rethrown by the caller)
 * @property {() => void} exit the function is done (from `finally`)
 * @property {(value: unknown) => unknown} sa the function awaits `value`; what it returns is awaited instead
 * @property {<T>(value: T) => T} sy the function yields `value`
 * @property {(value: unknown) => any} r the function resumed with `value` (what `sa`'s result settled to)
 */

/**
 * An instrumented file.
 * @typedef {object} Module
 * @property {(index: number, args: unknown[]) => Frame} enter a call of the file's function `index`
 */

/**
 * The per-process runtime, `globalThis.__jt`.
 * @typedef {object} Runtime
 * @property {(file: string, functions: FunctionInfo[]) => Module} load an instrumented file starts running
 */

/**
 * What the instrumenter passes to the runtime, from the project and its config.
 * @typedef {object} RuntimeOptions
 * @property {string} [logs] the folder to write logs in
 * @property {number} [maxDepth]
 * @property {number} [maxString]
 * @property {number} [maxLine]
 */

/**
 * Creates the runtime. Its source is embedded in instrumented files.
 * @param {NodeJS.Require} require the instrumented module's `require`, for `fs`
 * @param {RuntimeOptions} options
 * @returns {Runtime}
 */
function createRuntime(require, options) {
  /** @type {Frame} */
  const frame = {
    ret: (value) => value,
    throw: (error) => error,
    exit() {},
    sa: (value) => value,
    sy: (value) => value,
    r: (value) => value,
  };
  return { load: () => ({ enter: () => frame }) };
}

module.exports = { createRuntime };
