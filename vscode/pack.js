'use strict';

/**
 * Packs the extension into a `.vsix` for a local install (`npm run package`, then
 * `code --install-extension jstrace-vscode-<version>.vsix`), with no `vsce`. A `.vsix` is a
 * zip of the extension under `extension/`, plus a manifest. The CLI goes in too, with
 * acorn, under `extension/cli/`, where `cliScript` finds it: the installed extension runs
 * only its own CLI.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const EXTENSION = __dirname;
const CLI = path.join(__dirname, '..', 'cli');

/**
 * One file of the package.
 * @typedef {object} Entry
 * @property {string} name its path in the zip, with `/`
 * @property {Buffer} data
 */

/**
 * The CRC-32 table of zip files.
 * @type {number[]}
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/**
 * @param {Buffer} data
 * @returns {number}
 */
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * A zip file of the entries, each deflated.
 * @param {Entry[]} entries
 * @returns {Buffer}
 */
function zip(entries) {
  /** @type {Buffer[]} */
  const parts = [];
  /** @type {Buffer[]} */
  const directory = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const packed = zlib.deflateRawSync(data);
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // time and date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, fileName, packed);
    directory.push(central, fileName);
    offset += local.length + fileName.length + packed.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...directory, end]);
}

/**
 * Escapes text for XML.
 * @param {string} text
 * @returns {string}
 */
function xml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The `.js` files of a folder and those below it, tests left out.
 * @param {string} dir
 * @returns {string[]} their absolute paths
 */
function sources(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(file);
      return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [file] : [];
    });
}

/**
 * The files of the package: the extension with its license, the CLI with acorn, and the manifests.
 * @returns {Entry[]}
 */
function entries() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'package.json'), 'utf8'));
  const acorn = path.dirname(require.resolve('acorn/package.json', { paths: [CLI] }));
  /** @type {[string, string][]} the files as [name in the zip, source] */
  const files = [
    ...['package.json', 'extension.js', 'logs.js', 'cli.js'].map((name) => [`extension/${name}`, path.join(EXTENSION, name)]),
    ['extension/LICENSE', path.join(EXTENSION, '..', 'LICENSE')],
    ...fs.readdirSync(path.join(EXTENSION, 'media')).map((name) => [`extension/media/${name}`, path.join(EXTENSION, 'media', name)]),
    ['extension/cli/package.json', path.join(CLI, 'package.json')],
    ...['bin', 'src', 'runtime'].flatMap((dir) =>
      sources(path.join(CLI, dir)).map((file) => [`extension/cli/${path.relative(CLI, file).replaceAll('\\', '/')}`, file]),
    ),
    ...['package.json', 'LICENSE', 'dist/acorn.js'].map((name) => [`extension/cli/node_modules/acorn/${name}`, path.join(acorn, name)]),
  ].map(([name, file]) => /** @type {[string, string]} */ ([name, file]));

  const vsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(manifest.name)}" Version="${xml(manifest.version)}" Publisher="${xml(manifest.publisher)}" />
    <DisplayName>${xml(manifest.displayName)}</DisplayName>
    <Description xml:space="preserve">${xml(manifest.description)}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(manifest.engines.vscode)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>
`;
  const types = [...new Set(['.vsixmanifest', ...files.map(([name]) => path.extname(name) || '.txt')])];
  /** @type {Record<string, string>} */
  const mime = { '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.vsixmanifest': 'text/xml' };
  const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types
    .map((type) => `<Default Extension="${type}" ContentType="${mime[type] ?? 'text/plain'}" />`)
    .join('')}</Types>
`;
  return [
    { name: 'extension.vsixmanifest', data: Buffer.from(vsixManifest) },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
    ...files.map(([name, file]) => ({ name, data: fs.readFileSync(file) })),
  ];
}

/**
 * Writes the `.vsix`.
 * @param {string} [dir] the folder to write it in, the repo's root by default
 * @returns {string} the file written
 */
function pack(dir = path.join(EXTENSION, '..')) {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION, 'package.json'), 'utf8'));
  const file = path.join(dir, `${manifest.name}-${manifest.version}.vsix`);
  fs.writeFileSync(file, zip(entries()));
  return file;
}

if (require.main === module) {
  const file = pack(process.argv[2]);
  console.log(`Wrote ${file}\nInstall it with: code --install-extension "${file}"`);
}

module.exports = { pack, zip, crc32 };
