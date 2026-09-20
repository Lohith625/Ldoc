const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');

function loadHost(name, vscode = {}, expose = '', overrides = {}) {
  const filename = path.join(root, 'out', name + '.js');
  const localRequire = createRequire(filename);
  const context = { exports: {}, TextDecoder, TextEncoder, console,
    require: id => id === 'vscode' ? vscode : overrides[id] || (id === './ai-setup' && name === 'extension' ? {} : localRequire(id)) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\n' + expose, context, { filename });
  return context.exports;
}

function exporter() {
  return loadHost('extension', {
    Uri: { joinPath: (...parts) => path.join(...parts) },
    workspace: { fs: { readFile: filename => fs.promises.readFile(filename) } },
  }, 'exports.buildStandaloneHtml = buildStandaloneHtml; exports.buildSections = buildSections;');
}
module.exports = { root, loadHost, exporter };
