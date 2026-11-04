'use strict';

const path = require('node:path');

module.exports = appInfo => {
  const config = exports;
  config.keys = `${appInfo.name}_change_this_in_production`;
  config.cluster = { listen: { port: Number(process.env.PORT || 7001) } };
  config.view = {
    root: path.join(appInfo.baseDir, 'app/view'),
    defaultViewEngine: 'ejs',
    defaultExtension: '.ejs',
  };
  config.bodyParser = { enable: true, jsonLimit: '2mb', formLimit: '2mb' };
  config.security = { csrf: { enable: true } };
  config.database = {
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/security_supervision',
    max: Number(process.env.DATABASE_POOL_MAX || 10),
  };
  config.ai = {
    baseUrl: process.env.AI_BASE_URL || '',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 30000),
  };
  config.storage = {
    driver: process.env.STORAGE_DRIVER || 'local',
    localRoot: process.env.STORAGE_LOCAL_ROOT || path.join(appInfo.baseDir, 'storage'),
  };
  return config;
};
