'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
for (const folder of ['src', 'media', 'scripts', 'test']) {
  for (const file of fs.readdirSync(path.join(root, folder))) {
    if (/\.(cjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', path.join(root, folder, file)], { stdio: 'inherit' });
  }
}
const manifest = require('../package.json');
if (manifest.contributes.viewsContainers.panel.length !== 1 || !manifest.main) throw new Error('Invalid extension manifest.');
console.log('JavaScript syntax and extension manifest checks passed.');
