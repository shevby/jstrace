// An ES module: acorn can't parse it as a script, so instrumenting skips it with a warning.
// Nothing requires it.

export const value = 1;

export default function hello() {
  return 'hello';
}
