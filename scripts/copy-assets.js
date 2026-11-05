'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'admin-lte', 'dist');
const destination = path.join(root, 'app', 'public', 'vendor', 'adminlte');
fs.mkdirSync(destination, { recursive: true });
for (const folder of [ 'css', 'js' ]) fs.cpSync(path.join(source, folder), path.join(destination, folder), { recursive: true });
const bootstrapSource = path.join(root, 'node_modules', 'bootstrap', 'dist', 'js', 'bootstrap.bundle.min.js');
const bootstrapDestination = path.join(root, 'app', 'public', 'vendor', 'bootstrap', 'js');
fs.mkdirSync(bootstrapDestination, { recursive: true });
fs.copyFileSync(bootstrapSource, path.join(bootstrapDestination, 'bootstrap.bundle.min.js'));
