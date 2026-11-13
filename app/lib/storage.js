'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class LocalStorageProvider {
  constructor(root) {
    this.root = root;
  }

  async put(key, data) {
    const target = path.join(this.root, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return { key };
  }

  async get(key) {
    return fs.readFile(path.join(this.root, key));
  }

  async remove(key) {
    await fs.rm(path.join(this.root, key), { force: true });
  }
}

function createStorageProvider(config) {
  if (config.driver !== 'local') throw new Error(`暂不支持的存储驱动: ${config.driver}`);
  return new LocalStorageProvider(config.localRoot);
}

module.exports = { LocalStorageProvider, createStorageProvider };
