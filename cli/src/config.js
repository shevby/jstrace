'use strict';

/**
 * `jstrace.config.json` (see Architecture in CLAUDE.md): created with the defaults when
 * missing, and checked, so a mistake fails with a message naming the field.
 */

const fs = require('node:fs');

/**
 * @typedef {object} Config
 * @property {string[]} include globs of the files to instrument, relative to the project
 * @property {string[]} exclude globs of the files to leave alone
 * @property {number} maxDepth how deep arguments and return values are serialized
 * @property {number} maxString how many characters of a string are logged
 * @property {number} maxLine how many characters an event's serialized values may take
 */

/** @type {Readonly<Config>} */
const DEFAULTS = Object.freeze({
  include: ['**/*.js', '**/*.cjs'],
  exclude: ['.git/**', '.jstrace/**', '**/*.min.js'],
  maxDepth: 3,
  maxString: 200,
  maxLine: 2000,
});

/** A mistake in the config file, with a message for the user. */
class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Reads the config file, creating it with the defaults when it's missing.
 * @param {string} file the config file's path
 * @returns {{ config: Config, created: boolean }}
 * @throws {ConfigError} when the file isn't valid
 */
function loadConfig(file) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n');
    return { config: { ...DEFAULTS }, created: true };
  }
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file}: ${error instanceof Error ? error.message : error}`);
  }
  return { config: validate(data, file), created: false };
}

/**
 * Checks parsed config data, filling in defaults for the fields it leaves out.
 * @param {unknown} data
 * @param {string} file the config file's path, for messages
 * @returns {Config}
 * @throws {ConfigError}
 */
function validate(data, file) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ConfigError(`${file}: must be an object`);
  }
  /** @type {Record<string, unknown>} */
  const fields = { ...data };
  /** @type {Config} */
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'include' || key === 'exclude') {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        throw new ConfigError(`${file}: "${key}" must be an array of glob strings`);
      }
      config[key] = value;
    } else if (key === 'maxDepth' || key === 'maxString' || key === 'maxLine') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ConfigError(`${file}: "${key}" must be a whole number, 0 or more`);
      }
      config[key] = value;
    } else {
      throw new ConfigError(`${file}: unknown field "${key}" (known: ${Object.keys(DEFAULTS).join(', ')})`);
    }
  }
  return config;
}

module.exports = { DEFAULTS, ConfigError, loadConfig, validate };
