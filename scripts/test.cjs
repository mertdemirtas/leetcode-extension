'use strict';
const fs = require('node:fs');
const path = require('node:path');
const directory = path.join(__dirname, '..', 'test');
for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.test.cjs')).sort()) require(path.join(directory, file));
