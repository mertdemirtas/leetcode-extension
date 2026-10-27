'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const manifest = require('../package.json');
const directory = path.join(__dirname, '..', 'dist');
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, `${manifest.name}-${manifest.version}.vsix`);
execFileSync(process.execPath, [path.join(__dirname, '../node_modules/@vscode/vsce/vsce'), 'package', '--allow-missing-repository', '--no-dependencies', '--out', file], { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
