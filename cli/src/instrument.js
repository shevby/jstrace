'use strict';

/**
 * Injects tracing into one file's source (see Architecture in CLAUDE.md). acorn only parses,
 * so the source is changed by inserting text at node offsets, and nothing inserted contains a
 * line break: an instrumented file keeps its line numbers.
 */

const acorn = require('acorn');
const { walk } = require('./walk');
const { createRuntime } = require('../runtime/runtime');

/** @typedef {import('./walk').AnyNode} AnyNode */
/** @typedef {import('../runtime/runtime').FunctionInfo} FunctionInfo */
/** @typedef {import('../runtime/runtime').RuntimeOptions} RuntimeOptions */

/** @type {acorn.Options} */
const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowHashBang: true,
  allowReturnOutsideFunction: true, // CommonJS modules may return at the top level
  locations: true,
  preserveParens: true, // so an arrow's `({ … })` body is wrapped with its parentheses
};

/** Starts the call that registers a file; it marks a file as instrumented. */
const MARKER = 'var __jtm=__jt.load(';

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** What closes a function body: logs a throw and rethrows it, and ends the call. */
const BODY_END = '}catch(__jte){throw __jtc.throw(__jte)}finally{__jtc.exit()}';

/**
 * Parses a file as acorn sees it for instrumenting.
 * @param {string} source
 * @returns {AnyNode}
 * @throws {SyntaxError} acorn's, with `loc` — e.g. for an ES module
 */
function parse(source) {
  return /** @type {AnyNode} */ (acorn.parse(source, PARSE_OPTIONS));
}

/**
 * Whether a source already has injected code in it.
 * @param {string} source
 * @returns {boolean}
 */
function isInstrumented(source) {
  return source.includes(MARKER);
}

/**
 * A value as JavaScript source on one line: JSON, with the two line separators JSON leaves
 * alone (U+2028, U+2029) escaped, since editors and acorn count them as line breaks.
 * @param {unknown} value
 * @returns {string}
 */
function literal(value) {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16)}`);
}

/**
 * A piece of text to insert. At one position, pieces of one node keep their order (an empty
 * body's opening and closing); otherwise closing pieces go before opening ones, among closing
 * pieces inner ones (deeper) first, and among opening ones outer ones first.
 * @typedef {object} Insertion
 * @property {number} pos the offset in the original source
 * @property {string} text
 * @property {number} depth the nesting depth of the node it belongs to
 * @property {boolean} close
 * @property {AnyNode | null} node the node it belongs to
 */

/**
 * Injects tracing into a file's source.
 * @param {string} source the original source
 * @param {object} context
 * @param {string} context.file the file's absolute path, as logged
 * @param {RuntimeOptions & Record<string, unknown>} [context.options] passed on to the runtime
 * @param {Function} [context.runtime] the runtime factory to embed; `createRuntime` unless a
 *   test passes its own (self-contained, as `createRuntime` is)
 * @returns {{ code: string, functions: FunctionInfo[] }} the instrumented source, and the
 *   metadata of its functions
 * @throws {SyntaxError} when the source can't be parsed as a script
 */
function instrumentSource(source, { file, options = {}, runtime = createRuntime }) {
  const program = parse(source);
  /** @type {FunctionInfo[]} */
  const functions = [];
  /** @type {Insertion[]} */
  const insertions = [];
  /**
   * @param {number} pos
   * @param {string} text
   * @param {number} depth
   * @param {boolean} close
   */
  const insert = (pos, text, depth, close) => insertions.push({ pos, text, depth, close, node: current });
  /** @type {AnyNode | null} */
  let current = null;

  walk(program, (node, parents) => {
    current = node;
    const depth = parents.length;
    if (FUNCTION_TYPES.has(node.type)) {
      const index = functions.length;
      functions.push(describe(node, parents, source));
      const enter = `const __jtc=__jtm.enter(${index},[${functions[index][3].join(',')}]);`;
      const body = node.body;
      if (body.type === 'BlockStatement') {
        insert(afterDirectives(body.body, body.start + 1), `;${enter}try{`, depth, false);
        insert(body.end - 1, BODY_END, depth, true);
      } else {
        insert(body.start, `{${enter}try{return __jtc.ret(`, depth, false);
        insert(body.end, `)${BODY_END}}`, depth, true);
      }
    } else if (node.type === 'ReturnStatement') {
      if (!parents.some((parent) => FUNCTION_TYPES.has(parent.type))) return; // a module's own return
      if (node.argument) {
        insert(node.argument.start, '__jtc.ret(', depth, false);
        insert(node.argument.end, ')', depth, true);
      } else {
        insert(node.start + 'return'.length, ' __jtc.ret()', depth, false);
      }
    } else if (node.type === 'AwaitExpression') {
      insert(node.start, '__jtc.r(', depth, false);
      insert(node.argument.start, '__jtc.sa(', depth + 0.5, false);
      insert(node.argument.end, ')', depth + 0.5, true);
      insert(node.end, ')', depth, true);
    } else if (node.type === 'YieldExpression') {
      insert(node.start, '__jtc.r(', depth, false);
      if (node.argument) {
        insert(node.argument.start, '__jtc.sy(', depth + 0.5, false);
        insert(node.argument.end, ')', depth + 0.5, true);
      } else {
        insert(node.end, ' __jtc.sy()', depth + 0.5, true);
      }
      insert(node.end, ')', depth, true);
    }
  });

  const factory = `return (${compact(runtime)})(require, options);`;
  const prelude =
    `;var __jt=globalThis.__jt||(globalThis.__jt=new Function("require","options",${literal(factory)})(require,${literal(options)}));` +
    `${MARKER}${literal(file)},${literal(functions)});`;
  current = null;
  insert(preludePosition(program, source), prelude, -1, false);

  const code = apply(source, insertions);
  check(source, code, file);
  return { code, functions };
}

/** @type {WeakMap<Function, string>} */
const compacted = new WeakMap();

/**
 * A function's source without its comments, blank lines and indentation, to keep the
 * prelude short. Only for code with no multi-line strings or templates, like the runtime.
 * @param {Function} fn
 * @returns {string}
 */
function compact(fn) {
  let code = compacted.get(fn);
  if (code !== undefined) return code;
  const source = `(${fn.toString()})`;
  /** @type {acorn.Comment[]} */
  const comments = [];
  acorn.parse(source, { ecmaVersion: 'latest', onComment: comments });
  code = '';
  let last = 0;
  for (const { type, start, end } of comments) {
    // a block comment over lines still ends a line, for automatic semicolons
    code += source.slice(last, start) + (type === 'Line' ? '' : /[\r\n]/.test(source.slice(start, end)) ? '\n' : ' ');
    last = end;
  }
  code = (code + source.slice(last))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(1, -1);
  compacted.set(fn, code);
  return code;
}

/**
 * Where the prelude goes: after the directives (`'use strict'` must stay first to count),
 * else at the start, but after a shebang line.
 * @param {AnyNode} program
 * @param {string} source
 * @returns {number}
 */
function preludePosition(program, source) {
  const start = source.startsWith('#!') ? lineEnd(source, 0) : 0;
  return afterDirectives(program.body, start);
}

/**
 * The offset just past the first line break after `pos`, or the end of the source.
 * @param {string} source
 * @param {number} pos
 * @returns {number}
 */
function lineEnd(source, pos) {
  const match = /\r\n?|[\n\u2028\u2029]/.exec(source.slice(pos));
  return match ? pos + match.index + match[0].length : source.length;
}

/**
 * The offset after a body's directive prologue (`'use strict';` and the like).
 * @param {AnyNode[]} statements the body's statements
 * @param {number} start the offset to use when there are no directives
 * @returns {number}
 */
function afterDirectives(statements, start) {
  let pos = start;
  for (const statement of statements) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') break;
    pos = statement.end;
  }
  return pos;
}

/**
 * Applies insertions to a source.
 * @param {string} source
 * @param {Insertion[]} insertions
 * @returns {string}
 */
function apply(source, insertions) {
  const sorted = insertions
    .map((insertion, order) => ({ ...insertion, order }))
    .sort(
      (a, b) =>
        a.pos - b.pos ||
        (a.node !== null && a.node === b.node ? a.order - b.order : 0) ||
        Number(b.close) - Number(a.close) ||
        (a.close ? b.depth - a.depth : a.depth - b.depth) ||
        a.order - b.order,
    );
  let code = '';
  let last = 0;
  for (const { pos, text } of sorted) {
    code += source.slice(last, pos) + text;
    last = pos;
  }
  return code + source.slice(last);
}

/**
 * Makes sure instrumenting kept every line where it was and produced valid code.
 * @param {string} source
 * @param {string} code
 * @param {string} file for the message
 * @returns {void}
 * @throws {Error} a bug in the instrumenter
 */
function check(source, code, file) {
  const lines = (/** @type {string} */ text) => text.split(/\r\n?|[\n\u2028\u2029]/).length;
  if (lines(code) !== lines(source)) throw new Error(`jstrace bug: instrumenting ${file} changed its line count`);
  try {
    parse(code);
  } catch (error) {
    throw new Error(`jstrace bug: instrumenting ${file} produced invalid code: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * A function's metadata: its name, where it starts, and its parameters' names.
 * @param {AnyNode} fn
 * @param {AnyNode[]} parents
 * @param {string} source
 * @returns {FunctionInfo}
 */
function describe(fn, parents, source) {
  const { parent, child } = owner(fn, parents);
  const member = parent !== undefined && ['MethodDefinition', 'PropertyDefinition', 'Property'].includes(parent.type) && parent.value === child;
  const at = member ? /** @type {AnyNode} */ (parent).loc.start : fn.loc.start;
  const params = fn.params.flatMap(boundNames);
  return [nameOf(fn, parents, source), at.line, at.column, params];
}

/**
 * The node that holds a node, looking through parentheses.
 * @param {AnyNode} node
 * @param {AnyNode[]} parents the node's ancestors
 * @returns {{ parent: AnyNode | undefined, child: AnyNode, index: number }} the holder, the
 *   node (or the parentheses around it) it holds, and the holder's index in `parents`
 */
function owner(node, parents) {
  let index = parents.length - 1;
  let child = node;
  while (index >= 0 && parents[index].type === 'ParenthesizedExpression') child = parents[index--];
  return { parent: parents[index], child, index };
}

/**
 * A function's name: its own, a class member's (`Class->method`), or one from where it's put;
 * else `<anonymous@line:col>`.
 * @param {AnyNode} fn
 * @param {AnyNode[]} parents
 * @param {string} source
 * @returns {string}
 */
function nameOf(fn, parents, source) {
  const { parent, child, index } = owner(fn, parents);
  if (parent && (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.value === child) {
    const cls = parents[index - 2]; // the class body's class
    const prefix = parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ` : '';
    return `${className(cls, parents.slice(0, index - 2), source)}->${prefix}${keyName(parent, source)}`;
  }
  if (fn.id) return fn.id.name;
  if (parent?.type === 'Property' && parent.value === child) {
    const prefix = parent.kind === 'get' || parent.kind === 'set' ? `${parent.kind} ` : '';
    const object = owner(parents[index - 1], parents.slice(0, index - 1));
    const objectName = object.parent ? assignedName(object.parent, object.child, source) : null;
    return `${prefix}${objectName ? objectName + '.' : ''}${keyName(parent, source)}`;
  }
  const name = parent && assignedName(parent, child, source);
  if (name) return name;
  return `<anonymous@${fn.loc.start.line}:${fn.loc.start.column + 1}>`;
}

/**
 * The name a value gets from where it's put: `const name = …`, `a.b = …`, a default `name = …`.
 * `X.prototype.y = …` reads as a class member, `X->y`.
 * @param {AnyNode} parent the node holding the value
 * @param {AnyNode} child the value (or the parentheses around it)
 * @param {string} source
 * @returns {string | null}
 */
function assignedName(parent, child, source) {
  if (parent.type === 'VariableDeclarator' && parent.init === child && parent.id.type === 'Identifier') return parent.id.name;
  if (parent.type === 'AssignmentPattern' && parent.right === child && parent.left.type === 'Identifier') return parent.left.name;
  if (parent.type === 'AssignmentExpression' && parent.right === child) {
    if (parent.left.type === 'Identifier') return parent.left.name;
    const chain = memberChain(parent.left, source);
    if (!chain) return null;
    if (chain.length === 3 && chain[1] === 'prototype') return `${chain[0]}->${chain[2]}`;
    return chain.join('.');
  }
  return null;
}

/**
 * The names along `a.b.c` (or `this.b`), or `null` for anything else.
 * @param {AnyNode} node
 * @param {string} source
 * @returns {string[] | null}
 */
function memberChain(node, source) {
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'ThisExpression') return ['this'];
  if (node.type !== 'MemberExpression') return null;
  const object = memberChain(node.object, source);
  return object && [...object, keyName({ key: node.property, computed: node.computed }, source)];
}

/**
 * A property's key as written: `name`, `#name`, `"literal"`'s value, or `[expression]`.
 * @param {{ key: AnyNode, computed: boolean } | AnyNode} property a property, method, or member expression's `{ key, computed }`
 * @param {string} source
 * @returns {string}
 */
function keyName({ key, computed }, source) {
  if (computed) return key.type === 'Literal' ? String(key.value) : `[${source.slice(key.start, key.end)}]`;
  if (key.type === 'PrivateIdentifier') return `#${key.name}`;
  if (key.type === 'Literal') return String(key.value);
  return key.name;
}

/**
 * A class's name: its own, or the one it gets from where it's put.
 * @param {AnyNode} cls
 * @param {AnyNode[]} parents the class's ancestors
 * @param {string} source
 * @returns {string}
 */
function className(cls, parents, source) {
  if (cls.id) return cls.id.name;
  const { parent, child } = owner(cls, parents);
  return (parent && assignedName(parent, child, source)) || `<class@${cls.loc.start.line}:${cls.loc.start.column + 1}>`;
}

/**
 * The names a parameter binds: `a`, or every name in a pattern (`{ a, b: [c] }`, `...rest`,
 * `x = 1`).
 * @param {AnyNode} pattern
 * @returns {string[]}
 */
function boundNames(pattern) {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'AssignmentPattern':
      return boundNames(pattern.left);
    case 'RestElement':
      return boundNames(pattern.argument);
    case 'ArrayPattern':
      return pattern.elements.flatMap((/** @type {AnyNode | null} */ element) => (element ? boundNames(element) : []));
    case 'ObjectPattern':
      return pattern.properties.flatMap((/** @type {AnyNode} */ property) =>
        boundNames(property.type === 'RestElement' ? property : property.value),
      );
    default:
      return [];
  }
}

module.exports = { MARKER, parse, isInstrumented, instrumentSource };
