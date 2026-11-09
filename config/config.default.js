'use strict';

const path = require('node:path');

module.exports = appInfo => {
  const config = exports;
  config.keys = process.env.EGG_KEYS || `${appInfo.name}_local_development_key`;
  config.cluster = { listen: { port: Number(process.env.PORT || 7001) } };
  config.bodyParser = { enable: true, jsonLimit: '2mb', formLimit: '2mb' };
  config.multipart = { mode: 'file', fileSize: '50mb', fileExtensions: [ '.xlsx', '.tsv', '.pdf' ] };
  // Egg checks CSRF before multipart parsing, so file uploads use the same-origin
  // referer check while regular forms continue to use the token.
  config.security = { csrf: { enable: true, type: 'any' } };
  config.middleware = [ 'auth' ];
  config.static = { prefix: '/public/', dir: path.join(appInfo.baseDir, 'app/public') };
  config.session = { key: 'security_supervision.sid', maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' };
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
  config.pdfImport = {
    maxMb: Number(process.env.PDF_IMPORT_MAX_MB || 50),
    dpi: Number(process.env.PDF_IMPORT_DPI || 120),
    concurrency: Number(process.env.PDF_IMPORT_CONCURRENCY || 4),
    ocrLanguages: process.env.PDF_OCR_LANGUAGES || 'chi_sim+eng',
    maxPages: Number(process.env.PDF_IMPORT_MAX_PAGES || 300),
  };
  config.storage = {
    driver: process.env.STORAGE_DRIVER || 'local',
    localRoot: process.env.STORAGE_LOCAL_ROOT || path.join(appInfo.baseDir, 'storage'),
    s3Endpoint: process.env.S3_ENDPOINT || '',
    s3Bucket: process.env.S3_BUCKET || '',
    s3Region: process.env.S3_REGION || 'us-east-1',
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  };
  return config;
};
