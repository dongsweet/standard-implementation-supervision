'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'admin-lte', 'dist');
const destination = path.join(root, 'app', 'public', 'vendor', 'adminlte');
fs.mkdirSync(destination, { recursive: true });
for (const folder of [ 'css', 'js' ]) fs.cpSync(path.join(source, folder), path.join(destination, folder), { recursive: true });
