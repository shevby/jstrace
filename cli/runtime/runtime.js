'use strict';

/**
 * The runtime that instrumented code calls (see Architecture in CLAUDE.md). The prelude of
 * every instrumented file embeds `createRuntime`'s source and runs it once per process, as
 * `globalThis.__jt`. So `createRuntime` must be self-contained, using nothing from this
 * module, and must stick to what any JS runtime has, Node's `fs` aside. Its comments,
 * blank lines and indentation are stripped when it's embedded, so it must have no
 * multi-line strings or templates.
 *
 * What instrumented code does with it:
 * - each file starts with `var __jtm = __jt.load(file, functions)`;
 * - each function starts with `const __jtc = __jtm.enter(index, [params])`, its body in
 *   `try { … } catch (e) { throw __jtc.throw(e) } finally { __jtc.exit() }`, and each
 *   `return x` as `return __jtc.ret(x)`;
 * - `await x` becomes `__jtc.r(await __jtc.sa(x))`, and `yield x` `__jtc.r(yield __jtc.sy(x))`.
 *
 * The call tree follows a stack of entries: a call pushes one and pops it when it exits or
 * suspends (`sa`, `sy`). A suspended call that runs again pushes a resume entry on top of
 * whatever is running then: nothing, for an async function (a new root), or the caller of
 * `next()`, for a generator. A rejected `await` throws without `r` being called, so `sa`
 * turns a rejection into a `Rejected` value that `r` rethrows once the resume is logged;
 * that costs an `await` of a promise one more microtask tick. Any other way a suspended call
 * goes on (`gen.throw()`, `gen.return()`) logs its resume at the next thing it reports.
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
 * @property {string} [logs] the folder to write logs in; nothing is logged without one
 * @property {string} [root] the project's folder; the `.txt` tree shows paths relative to it
 * @property {number} [maxDepth]
 * @property {number} [maxString]
 * @property {number} [maxLine]
 */

/**
 * A node of the call tree on the stack: a call, or a part of one that resumed.
 * @typedef {object} Entry
 * @property {number} id the call's or the resume's id
 * @property {number | null} parent the id of the entry it's in
 * @property {number} depth
 */

/**
 * Creates the runtime. Its source is embedded in instrumented files.
 * @param {NodeJS.Require} require the instrumented module's `require`, for `fs`
 * @param {RuntimeOptions} options
 * @returns {Runtime}
 */
function createRuntime(require, options) {
  const maxDepth = options.maxDepth ?? 3;
  const maxString = options.maxString ?? 200;
  const maxLine = options.maxLine ?? 2000;
  const proc = typeof process === 'object' && process ? process : null;
  const folder = (proc && proc.env && proc.env.JSTRACE_OUT) || options.logs || '';
  const root = (options.root || '').replace(/[\\/]+$/, '');
  const pid = proc && proc.pid ? proc.pid : Math.floor(Math.random() * 1e9);
  const clock = typeof performance === 'object' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now();
  const origin = clock();
  const started = new Date();
  const separators = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
  /** @type {any} */
  const customFs = /** @type {any} */ (globalThis).__jstraceFs;

  /** @type {any} */
  let fs = null;
  let jsonl = -1;
  let txt = -1;
  let off = !folder;
  let busy = false;
  let nextId = 1;
  /** @type {Entry[]} */
  const stack = [];

  /**
   * The time since the process's log started, in milliseconds.
   * @returns {number}
   */
  function time() {
    return Math.round((clock() - origin) * 1000) / 1000;
  }

  /**
   * Text with the line separators that JSON leaves alone escaped, so it stays on one line.
   * @param {string} text
   * @returns {string}
   */
  function oneLine(text) {
    return text.replace(separators, (char) => '\\u' + char.charCodeAt(0).toString(16));
  }

  /**
   * Opens the log files and writes their headers.
   * @returns {void}
   */
  function open() {
    fs = customFs || require('fs');
    fs.mkdirSync(folder, { recursive: true });
    const separator = folder.includes('\\') ? '\\' : '/';
    const base = `${folder.replace(/[\\/]+$/, '')}${separator}${started.toISOString().replace(/:/g, '-')}-${pid}`;
    jsonl = fs.openSync(`${base}.jsonl`, 'a');
    txt = fs.openSync(`${base}.txt`, 'a');
    const argv = proc && Array.isArray(proc.argv) ? proc.argv.map(String) : [];
    const cwd = proc && typeof proc.cwd === 'function' ? proc.cwd() : null;
    fs.writeSync(jsonl, oneLine(JSON.stringify({ type: 'start', pid, argv, cwd, started: started.toISOString(), time: 0 })) + '\n');
    fs.writeSync(txt, oneLine(`jstrace: process ${pid} started ${started.toISOString()}: ${argv.slice(1).join(' ')}`) + '\n');
  }

  /**
   * Writes an event to the log, and a line to the tree. On the first failure, tracing stops
   * with a message: the program itself must go on as it would.
   * @param {Record<string, unknown>} event
   * @param {number} depth the line's indentation
   * @param {string} line
   * @returns {void}
   */
  function write(event, depth, line) {
    if (off) return;
    const was = busy;
    busy = true;
    try {
      if (!fs) open();
      fs.writeSync(jsonl, oneLine(JSON.stringify(event)) + '\n');
      fs.writeSync(txt, '  '.repeat(depth) + oneLine(line) + '\n');
    } catch (error) {
      off = true;
      try {
        console.error(`jstrace: can't write logs to ${folder}, so tracing stops: ${error instanceof Error ? error.message : error}`);
      } catch (_) {
        // nowhere to tell
      }
    } finally {
      busy = was;
    }
  }

  /**
   * A file as the tree shows it: relative to the project, if it's in it.
   * @param {string} file
   * @returns {string}
   */
  function where(file) {
    const inRoot = root !== '' && file.startsWith(root) && /[\\/]/.test(file.charAt(root.length));
    return (inRoot ? file.slice(root.length + 1) : file).replace(/\\/g, '/');
  }

  /**
   * Pushes an entry on top of whatever is running.
   * @param {number} id
   * @returns {Entry}
   */
  function push(id) {
    const top = stack[stack.length - 1];
    const entry = { id, parent: top ? top.id : null, depth: top ? top.depth + 1 : 0 };
    stack.push(entry);
    return entry;
  }

  /**
   * Pops an entry, and any left above it.
   * @param {Entry} entry
   * @returns {void}
   */
  function pop(entry) {
    const index = stack.lastIndexOf(entry);
    if (index >= 0) stack.length = index;
  }

  /**
   * Runs a serialization with tracing off (it may call user code, like an error's
   * `toString`), never letting it throw.
   * @param {(budget: { left: number }) => unknown} serializer
   * @returns {unknown}
   */
  function snapshot(serializer) {
    const was = busy;
    busy = true;
    try {
      return serializer({ left: maxLine });
    } catch (_) {
      return '[Unserializable]';
    } finally {
      busy = was;
    }
  }

  /**
   * A value as JSON-safe data within the limits. Values JSON has no room for become strings
   * in brackets (`"[undefined]"`, `"[Function f]"`, `"[Circular]"`); a class instance becomes
   * `{"[Class]": {…}}` (or `"[Class]"` without own properties), and so do a Map and a Set.
   * Getters aren't called. `budget` is roughly the characters left for the whole value; once
   * it's spent, arrays and objects end with what was left out.
   * @param {any} value
   * @param {number} depth how deep in the logged value this one is
   * @param {unknown[]} ancestors the objects it's inside
   * @param {{ left: number }} budget
   * @returns {unknown}
   */
  function serialize(value, depth, ancestors, budget) {
    const result = convert(value, depth, ancestors, budget);
    if (result === null || typeof result !== 'object') budget.left -= typeof result === 'string' ? result.length + 2 : 6;
    return result;
  }

  /**
   * `serialize` without the accounting for primitives.
   * @param {any} value
   * @param {number} depth
   * @param {unknown[]} ancestors
   * @param {{ left: number }} budget
   * @returns {unknown}
   */
  function convert(value, depth, ancestors, budget) {
    switch (typeof value) {
      case 'string':
        return value.length > maxString ? `${value.slice(0, maxString)}…(+${value.length - maxString})` : value;
      case 'number':
        return Number.isFinite(value) ? value : `[${value}]`;
      case 'boolean':
        return value;
      case 'undefined':
        return '[undefined]';
      case 'bigint':
        return `[${value}n]`;
      case 'symbol':
        return `[${value.toString()}]`;
      case 'function':
        return `[${functionName(value)}]`;
    }
    if (value === null) return null;
    if (ancestors.includes(value)) return '[Circular]';
    if (Array.isArray(value)) {
      return depth >= maxDepth ? `[Array(${value.length})]` : list(value, value, depth, ancestors, budget);
    }
    if (value instanceof Error) return `[${String(value)}]`;
    if (value instanceof Date) return `[Date ${isNaN(value.getTime()) ? 'Invalid' : value.toISOString()}]`;
    if (value instanceof RegExp) return `[RegExp ${String(value)}]`;
    const name = className(value);
    if (ArrayBuffer.isView(value)) {
      if (!('length' in value)) return `[${name}(${value.byteLength})]`;
      const items = Array.prototype.slice.call(value, 0, maxString).join(',');
      return `[${name}(${value.length}) ${items.length > maxString ? items.slice(0, maxString) + '…' : items}]`;
    }
    if (value instanceof ArrayBuffer) return `[${name}(${value.byteLength})]`;
    if (value instanceof Map || value instanceof Set) {
      const label = `${value instanceof Map ? 'Map' : 'Set'}(${value.size})`;
      if (depth >= maxDepth) return `[${label}]`;
      const items = value instanceof Map ? Array.from(Map.prototype.entries.call(value)) : Array.from(Set.prototype.values.call(value));
      return { [`[${label}]`]: list(items, value, depth, ancestors, budget) };
    }
    if (depth >= maxDepth) return `[${name || 'Object'}]`;
    const props = properties(value, depth, ancestors, budget);
    if (!name) return props;
    return Object.keys(props).length > 0 ? { [`[${name}]`]: props } : `[${name}]`;
  }

  /**
   * The items of an array (or a Map's entries, a Set's values), serialized.
   * @param {unknown[]} items
   * @param {object} owner the object they're in
   * @param {number} depth the owner's
   * @param {unknown[]} ancestors
   * @param {{ left: number }} budget
   * @returns {unknown[]}
   */
  function list(items, owner, depth, ancestors, budget) {
    const result = [];
    ancestors.push(owner);
    for (let i = 0; i < items.length; i++) {
      if (budget.left <= 0) {
        result.push(`…+${items.length - i} more`);
        break;
      }
      result.push(serialize(items[i], depth + 1, ancestors, budget));
    }
    ancestors.pop();
    return result;
  }

  /**
   * An object's own enumerable properties, serialized, with getters and setters named
   * rather than called.
   * @param {object} object
   * @param {number} depth the object's
   * @param {unknown[]} ancestors
   * @param {{ left: number }} budget
   * @returns {Record<string, unknown>}
   */
  function properties(object, depth, ancestors, budget) {
    /** @type {Record<string, unknown>} */
    const result = Object.create(null); // so a "__proto__" key is a property like any other
    const keys = Object.keys(object);
    ancestors.push(object);
    for (let i = 0; i < keys.length; i++) {
      if (budget.left <= 0) {
        result['…'] = `+${keys.length - i} more`;
        break;
      }
      const key = keys[i];
      budget.left -= key.length + 3;
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor) continue;
      result[key] = 'value' in descriptor
        ? serialize(descriptor.value, depth + 1, ancestors, budget)
        : `[${descriptor.get && descriptor.set ? 'Getter/Setter' : descriptor.get ? 'Getter' : 'Setter'}]`;
    }
    ancestors.pop();
    return result;
  }

  /**
   * The name of an object's class, or `''` for a plain object.
   * @param {object} object
   * @returns {string}
   */
  function className(object) {
    const proto = Object.getPrototypeOf(object);
    const constructor = proto && Object.getOwnPropertyDescriptor(proto, 'constructor');
    const name = constructor && typeof constructor.value === 'function' ? ownName(constructor.value) : '';
    return name === 'Object' ? '' : name;
  }

  /**
   * A function's own name, without calling a getter.
   * @param {Function} fn
   * @returns {string}
   */
  function ownName(fn) {
    const descriptor = Object.getOwnPropertyDescriptor(fn, 'name');
    return descriptor && typeof descriptor.value === 'string' ? descriptor.value : '';
  }

  /**
   * `Function name`, or `class Name` for a class.
   * @param {Function} fn
   * @returns {string}
   */
  function functionName(fn) {
    let isClass = false;
    try {
      isClass = /^class\b/.test(Function.prototype.toString.call(fn));
    } catch (_) {
      // a revoked proxy
    }
    return `${isClass ? 'class' : 'Function'} ${ownName(fn) || '(anonymous)'}`;
  }

  /**
   * A value as logged.
   * @param {unknown} value
   * @returns {unknown}
   */
  function capture(value) {
    return snapshot((budget) => serialize(value, 0, [], budget));
  }

  /**
   * A value logged as an event's field `key`: the field is left out for `undefined`.
   * @param {string} key
   * @param {unknown} value
   * @returns {Record<string, unknown>}
   */
  function field(key, value) {
    return value === undefined ? {} : { [key]: capture(value) };
  }

  /**
   * A logged value as the tree shows it.
   * @param {unknown} value as logged, or `undefined` for a field left out
   * @returns {string}
   */
  function show(value) {
    return value === undefined ? 'undefined' : JSON.stringify(value);
  }

  /**
   * An awaited value's rejection, passed from `sa` to `r` as a value.
   */
  class Rejected {
    /** @param {unknown} error */
    constructor(error) {
      this.error = error;
    }
  }

  /**
   * Whether `await` would treat a value as a promise.
   * @param {unknown} value
   * @returns {boolean}
   */
  function thenable(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
      return typeof (/** @type {any} */ (value).then) === 'function';
    } catch (_) {
      return false; // `await` will throw that
    }
  }

  /** @type {Frame} */
  const NOOP = { ret: (value) => value, throw: (error) => error, exit() {}, sa: (value) => value, sy: (value) => value, r: (value) => value };

  /**
   * One call of an instrumented function.
   * @implements {Frame}
   */
  class Call {
    /**
     * Logs the call.
     * @param {FunctionInfo} info
     * @param {string} file
     * @param {unknown[]} args
     */
    constructor(info, file, args) {
      const [name, line, column, params] = info;
      this.info = info;
      this.file = file;
      this.id = nextId++;
      /** the entry of the part of the call that's running (or ran last) */
      this.entry = push(this.id);
      this.suspended = false;
      /** @type {Record<string, unknown>} the `value` returned or `error` thrown, as logged */
      this.outcome = {};
      const logged = snapshot((budget) => {
        /** @type {Record<string, unknown>} */
        const result = Object.create(null);
        params.forEach((param, i) => {
          result[param] = serialize(args[i], 0, [], budget);
        });
        return result;
      });
      const shown = logged && typeof logged === 'object'
        ? Object.entries(logged).map(([param, value]) => `${param}: ${show(value)}`).join(', ')
        : show(logged);
      const { id, entry } = this;
      write(
        { type: 'call', id, parent: entry.parent, depth: entry.depth, name, file, line, column, args: logged, time: time() },
        entry.depth,
        `${name}(${shown}) #${id}  ${where(file)}:${line}`,
      );
    }

    /**
     * @template T
     * @param {T} value
     * @returns {T}
     */
    ret(value) {
      this.wake();
      this.outcome = field('value', value);
      return value;
    }

    /**
     * @template T
     * @param {T} error
     * @returns {T}
     */
    throw(error) {
      this.wake();
      this.outcome = { error: capture(error) };
      return error;
    }

    /**
     * Logs how the call ended: a return (of `ret`'s value) or a throw.
     * @returns {void}
     */
    exit() {
      this.wake();
      pop(this.entry);
      const { outcome, entry } = this;
      const threw = 'error' in outcome;
      write(
        { type: threw ? 'throw' : 'return', call: this.id, parent: entry.id, ...outcome, time: time() },
        entry.depth + 1,
        threw ? `← throws ${show(outcome.error)}` : `← ${show(outcome.value)}`,
      );
    }

    /**
     * @param {unknown} value
     * @returns {unknown}
     */
    sa(value) {
      this.wake();
      this.suspend();
      return thenable(value) ? Promise.resolve(value).then(undefined, (error) => new Rejected(error)) : value;
    }

    /**
     * @template T
     * @param {T} value
     * @returns {T}
     */
    sy(value) {
      this.wake();
      const logged = field('value', value);
      write({ type: 'yield', call: this.id, parent: this.entry.id, ...logged, time: time() }, this.entry.depth + 1, `← yields ${show(logged.value)}`);
      this.suspend();
      return value;
    }

    /**
     * @param {unknown} value
     * @returns {any}
     */
    r(value) {
      this.wake();
      if (value instanceof Rejected) throw value.error;
      return value;
    }

    /**
     * The call stops running until it resumes.
     * @returns {void}
     */
    suspend() {
      pop(this.entry);
      this.suspended = true;
    }

    /**
     * Logs a suspended call resuming, as a part of it on top of whatever is running.
     * @returns {void}
     */
    wake() {
      if (!this.suspended) return;
      this.suspended = false;
      this.entry = push(nextId++);
      const [name, line, column] = this.info;
      const { id, file, entry } = this;
      write(
        { type: 'resume', id: entry.id, call: id, parent: entry.parent, depth: entry.depth, name, file, line, column, time: time() },
        entry.depth,
        `↻ ${name}() #${id} resumed  ${where(file)}:${line}`,
      );
    }
  }

  return {
    load(file, functions) {
      const top = stack[stack.length - 1];
      const depth = top ? top.depth + 1 : 0;
      write({ type: 'load', id: nextId++, parent: top ? top.id : null, depth, file, time: time() }, depth, `load ${where(file)}`);
      return { enter: (index, args) => (off || busy ? NOOP : new Call(functions[index], file, args)) };
    },
  };
}

module.exports = { createRuntime };
