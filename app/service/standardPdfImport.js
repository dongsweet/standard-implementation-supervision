'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const Service = require('egg').Service;
const StandardImportJobRepository = require('../repository/standardImportJob');
const { createStorageProvider } = require('../lib/storage');
const { ocrPdf, progressForStage } = require('../lib/pdfStandardExtract');
const { recalculateHierarchy } = require('../lib/standardOutline');

class StandardPdfImportService extends Service {
  get repository() {
    return new StandardImportJobRepository(this.ctx.app.db);
  }

  get storage() {
    return createStorageProvider(this.config.storage);
  }

  async create(versionId, file, userId) {
    if (!file) this.ctx.throw(400, '请选择PDF文件');
    if (path.extname(file.filename || '').toLowerCase() !== '.pdf') this.ctx.throw(400, '仅支持PDF文件');
    const version = await this.ctx.app.db.query('SELECT id FROM standard_versions WHERE id = $1', [ versionId ]);
    if (!version.rowCount) this.ctx.throw(404, '规范版本不存在');
    const buffer = await fs.readFile(file.filepath);
    const maxBytes = Number(this.config.pdfImport.maxMb || 50) * 1024 * 1024;
    if (buffer.length > maxBytes) this.ctx.throw(400, `PDF不能超过${this.config.pdfImport.maxMb}MB`);
    const storageKey = `standard-imports/${versionId}/${randomUUID()}.pdf`;
    await this.storage.put(storageKey, buffer);
    return this.repository.create({
      versionId,
      originalFilename: file.filename,
      storageKey,
      createdBy: userId,
    });
  }

  async process(jobId, versionId) {
    try {
      await this.repository.markProcessing(jobId);
      const job = await this.repository.find(versionId, jobId);
      if (!job) throw new Error('PDF导入任务不存在');
      const filePath = path.join(this.config.storage.localRoot, job.storage_key);
      const { tree, pageCount } = await ocrPdf(filePath, {
        dpi: this.config.pdfImport.dpi,
        concurrency: this.config.pdfImport.concurrency,
        lang: this.config.pdfImport.ocrLanguages,
        maxPages: this.config.pdfImport.maxPages,
      }, async (completed, totalPages, stage) => {
        const progress = progressForStage(completed, totalPages, stage);
        await this.repository.updateProgress(jobId, progress, totalPages);
      });
      await this.repository.completeExtraction(jobId, { pageCount, result: tree });
    } catch (error) {
      this.ctx.logger.error('PDF standard import failed', error);
      await this.repository.fail(jobId, error.message);
    }
  }

  async find(versionId, jobId) {
    const job = await this.repository.find(versionId, jobId);
    if (!job) this.ctx.throw(404, 'PDF导入任务不存在');
    return job;
  }

  async apply(versionId, jobId, payload, actorId) {
    const job = await this.find(versionId, jobId);
    if (job.status !== 'ready') this.ctx.throw(409, 'PDF尚未完成解析或已经应用');
    const nodes = job.result?.nodes || [];
    const requested = new Map((Array.isArray(payload.nodes) ? payload.nodes : []).map(node => [ node.id, node ]));
    const roles = new Set([ 'container', 'item', 'skip' ]);
    const selectedNodes = nodes.map(node => {
      const requestedNode = requested.get(node.id);
      const role = requestedNode?.role || node.role || 'container';
      if (!roles.has(role)) this.ctx.throw(400, `节点${node.id}的角色无效`);
      return {
        id: node.id,
        role,
        originalNumber: typeof requestedNode?.originalNumber === 'string'
          ? requestedNode.originalNumber
          : node.originalNumber,
        title: typeof requestedNode?.title === 'string' ? requestedNode.title : node.title,
        content: typeof requestedNode?.content === 'string' ? requestedNode.content : node.content,
      };
    });
    for (const node of selectedNodes.filter(item => item.role === 'item')) {
      if (!node.originalNumber.trim() || !node.content.trim()) {
        this.ctx.throw(400, '标准项必须填写原文编号和标准内容');
      }
    }
    const editedById = new Map(selectedNodes.map(node => [ node.id, node ]));
    const effectiveNodes = recalculateHierarchy(nodes.map(node => ({
      ...node,
      ...editedById.get(node.id),
    })));
    const byId = new Map(effectiveNodes.map(node => [ node.id, node ]));
    for (const node of effectiveNodes.filter(item => requested.get(item.id)?.role === 'item')) {
      let parentId = node.parentId;
      const visited = new Set();
      while (parentId && byId.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId);
        if (byId.get(parentId).role === 'skip') {
          this.ctx.throw(400, `标准项${node.originalNumber || node.title}的上级章节已被跳过`);
        }
        parentId = byId.get(parentId).parentId;
      }
    }
    try {
      return await this.repository.apply(jobId, versionId, selectedNodes, actorId);
    } catch (error) {
      if ([ 'INVALID_IMPORT_JOB', 'NO_SELECTED_ITEMS', 'INVALID_SELECTED_NODE', 'MISSING_CHAPTER' ].includes(error.code)) {
        this.ctx.throw(409, error.message);
      }
      throw error;
    }
  }
}

module.exports = StandardPdfImportService;
