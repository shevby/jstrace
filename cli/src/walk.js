'use strict';

/**
 * A minimal walker over acorn's AST: it visits every node, before its children, with the
 * chain of its ancestors.
 */

/**
 * An acorn node, with whatever fields its type has.
 * @typedef {{ type: string, start: number, end: number, [field: string]: any }} AnyNode
 */

/**
 * Whether a value is an AST node (`loc` objects and plain values aren't).
 * @param {unknown} value
 * @returns {value is AnyNode}
 */
function isNode(value) {
  return typeof value === 'object' && value !== null && typeof (/** @type {any} */ (value).type) === 'string';
}

/**
 * Visits a node and everything below it.
 * @param {AnyNode} node
 * @param {(node: AnyNode, parents: AnyNode[]) => void} visit called with the node's ancestors,
 *   outermost first; the array is reused, so copy it to keep it
 * @param {AnyNode[]} [parents]
 * @returns {void}
 */
function walk(node, visit, parents = []) {
  visit(node, parents);
  parents.push(node);
  for (const key in node) {
    if (key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, parents);
    } else if (isNode(value)) {
      walk(value, visit, parents);
    }
  }
  parents.pop();
}

module.exports = { walk, isNode };
