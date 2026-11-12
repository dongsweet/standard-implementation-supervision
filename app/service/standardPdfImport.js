'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const Service = require('egg').Service;
const StandardImportJobRepository = require('../repository/standardImportJob');
const { createStorageProvider } = require('../lib/storage');
const { ocrPdf, progressForStage } = require('../lib/pdfStandardExtract');
const { mergeComparisonIntoTree, parseComparisonFile } = require('../lib/standardComparison');
const { recalculateHierarchy } = require('../lib/standardOutline');
const {
  buildAiCandidates,
  buildRuleRecommendations,
  findAfterIndex,
  findScopeEndIndex,
  trivialReason,
} = require('../lib/standardReview');

class StandardPdfImportService extends Service {
  get repository() {
    return new StandardImportJobRepository(this.ctx.app.db);
  }

  get storage() {
    return createStorageProvider(this.config.storage);
  }

  async create(versionId, file, comparisonFile, userId) {
    if (!file) this.ctx.throw(400, '请选择PDF文件');
    if (path.extname(file.filename || '').toLowerCase() !== '.pdf') this.ctx.throw(400, 'PDF文件格式无效');
    const supportedComparison = new Set([ '.xlsx', '.tsv', '.csv', '.txt' ]);
    if (comparisonFile && !supportedComparison.has(path.extname(comparisonFile.filename || '').toLowerCase())) {
      this.ctx.throw(400, '对照文本支持 .xlsx、.tsv、.csv 或制表符分隔的 .txt');
    }
    const version = await this.ctx.app.db.query('SELECT id FROM standard_versions WHERE id = $1', [ versionId ]);
    if (!version.rowCount) this.ctx.throw(404, '规范版本不存在');
    const maxBytes = Number(this.config.pdfImport.maxMb || 50) * 1024 * 1024;
    const pdfBuffer = await fs.readFile(file.filepath);
    if (pdfBuffer.length > maxBytes) this.ctx.throw(400, `PDF不能超过${this.config.pdfImport.maxMb}MB`);
    const suffix = randomUUID();
    const storageKey = `standard-imports/${versionId}/${suffix}.pdf`;
    await this.storage.put(storageKey, pdfBuffer);

    let comparisonStorageKey = null;
    if (comparisonFile) {
      const comparisonBuffer = await fs.readFile(comparisonFile.filepath);
      if (comparisonBuffer.length > maxBytes) this.ctx.throw(400, `对照文件不能超过${this.config.pdfImport.maxMb}MB`);
      comparisonStorageKey = `standard-imports/${versionId}/${suffix}-comparison${path.extname(comparisonFile.filename).toLowerCase()}`;
      await this.storage.put(comparisonStorageKey, comparisonBuffer);
    }
    return this.repository.create({
      versionId,
      originalFilename: file.filename,
      storageKey,
      comparisonFilename: comparisonFile?.filename || null,
      comparisonStorageKey,
      createdBy: userId,
    });
  }

  async process(jobId, versionId) {
    try {
      await this.repository.markProcessing(jobId);
      const job = await this.repository.find(versionId, jobId);
      if (!job) throw new Error('PDF导入任务不存在');
      const filePath = path.join(this.config.storage.localRoot, job.storage_key);
      let comparisonResult = null;
      let parsedComparison = null;
      if (job.comparison_storage_key) {
        const comparisonPath = path.join(this.config.storage.localRoot, job.comparison_storage_key);
        parsedComparison = await parseComparisonFile(comparisonPath, job.comparison_filename);
        comparisonResult = {
          fileName: job.comparison_filename,
          itemCount: parsedComparison.itemCount,
          chapterCount: parsedComparison.chapters.length,
          duplicateItemCount: parsedComparison.duplicateItemCount || 0,
        };
      }
      const { tree, pageCount } = await ocrPdf(filePath, {
        dpi: this.config.pdfImport.dpi,
        concurrency: this.config.pdfImport.concurrency,
        lang: this.config.pdfImport.ocrLanguages,
        maxPages: this.config.pdfImport.maxPages,
      }, async (completed, totalPages, stage) => {
        const progress = progressForStage(completed, totalPages, stage);
        await this.repository.updateProgress(jobId, progress, totalPages);
      });
      if (comparisonResult) {
        comparisonResult.summary = mergeComparisonIntoTree(tree, parsedComparison);
      }
      await this.repository.completeExtraction(jobId, { pageCount, result: tree, comparisonResult });
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

  async aiReview(versionId, jobId, payload) {
    const job = await this.find(versionId, jobId);
    if (job.status !== 'ready') this.ctx.throw(409, '只有待确认的PDF导入任务可以进行AI校验');
    const aiConfig = await this.ctx.service.systemSetting.getAiConfig({ includeKey: true });
    if (!aiConfig.enabled || !aiConfig.baseUrl || !aiConfig.model || !aiConfig.apiKey) {
      this.ctx.throw(409, 'AI服务尚未启用或配置不完整，请先在系统配置中完成设置');
    }
    const sourceNodes = job.result?.nodes || [];
    const sourceById = new Map(sourceNodes.map(node => [ node.id, node ]));
    const requested = Array.isArray(payload.nodes) ? payload.nodes : [];
    if (!requested.length) this.ctx.throw(400, '请选择需要AI校验的标准项');
    if (requested.length > 20) this.ctx.throw(400, '一次最多校验20个标准项，请分批提交');
    const selected = requested.map(input => {
      const source = sourceById.get(String(input.id || ''));
      if (!source) this.ctx.throw(400, '包含不存在的标准项');
      return {
        id: source.id,
        originalNumber: String(input.originalNumber ?? source.originalNumber ?? '').trim(),
        title: String(input.title ?? source.title ?? '').trim(),
        content: String(input.content ?? source.content ?? '').trim(),
      };
    }).filter(node => node.content);
    if (!selected.length) this.ctx.throw(400, '所选标准项没有可校验的正文');
    const result = await this.ctx.service.aiProvider.correctStandardNodes(selected, {
      standardCode: job.standard_code,
      standardName: job.standard_name,
      version: job.version,
    });
    const beforeById = new Map(selected.map(node => [ node.id, node ]));
    const corrections = result.corrections.map(correction => {
      const before = beforeById.get(correction.nodeId);
      const changedFields = [ 'originalNumber', 'title', 'content' ]
        .filter(field => (before[field] || '') !== (correction[field] || ''));
      return {
        ...correction,
        before: {
          originalNumber: before.originalNumber,
          title: before.title,
          content: before.content,
        },
        changedFields,
      };
    }).filter(correction => correction.changedFields.length);
    return {
      corrections,
      providerStatus: result.providerStatus,
      durationMs: result.durationMs,
    };
  }

  async smartReview(versionId, jobId, payload = {}) {
    const job = await this.find(versionId, jobId);
    if (job.status !== 'ready') this.ctx.throw(409, '只有待确认的PDF导入任务可以进行智能复核');
    const sourceNodes = job.result?.nodes || [];
    const incomingNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const incomingById = new Map(incomingNodes.map(node => [ String(node?.id || ''), node ]));
    const workingNodes = recalculateHierarchy(sourceNodes.map(source => ({
      ...source,
      ...(incomingById.get(String(source.id)) || {}),
    })));
    const afterIndex = findAfterIndex(workingNodes, payload.afterOriginalNumber);
    const scopeEndIndex = findScopeEndIndex(workingNodes, payload.afterOriginalNumber, afterIndex);
    const requestedIds = Array.isArray(payload.nodeIds) ? new Set(payload.nodeIds.map(String)) : null;
    const scopedNodes = workingNodes.filter((node, index) => index >= Math.max(0, afterIndex + 1)
      && index < scopeEndIndex
      && (!requestedIds || requestedIds.has(String(node.id))));
    const scopedSet = new Set(scopedNodes.map(node => node.id));
    const rules = buildRuleRecommendations(workingNodes, { afterIndex, endIndex: scopeEndIndex })
      .filter(item => !requestedIds || scopedSet.has(item.nodeId))
      .map(item => ({
        ...item,
        source: workingNodes.find(node => node.id === item.nodeId) || null,
      }));
    const candidates = buildAiCandidates(workingNodes, { afterIndex, endIndex: scopeEndIndex })
      .filter(item => !requestedIds || scopedSet.has(item.id));
    const aiSuggestions = [];
    let aiUnavailable = null;
    let providerStatus = null;
    let durationMs = 0;
    if (candidates.length) {
      const aiConfig = await this.ctx.service.systemSetting.getAiConfig({ includeKey: true });
      if (!aiConfig.enabled || !aiConfig.baseUrl || !aiConfig.model || !aiConfig.apiKey) {
        aiUnavailable = 'AI服务尚未启用或配置不完整；规则复核结果仍可使用。';
      } else {
        for (let index = 0; index < candidates.length; index += 10) {
          const chunk = candidates.slice(index, index + 10);
          try {
            const result = await this.ctx.service.aiProvider.reviewStandardNodes(chunk, {
              standardCode: job.standard_code,
              standardName: job.standard_name,
              version: job.version,
            });
            providerStatus = result.providerStatus;
            durationMs += result.durationMs || 0;
            aiSuggestions.push(...result.suggestions);
          } catch (error) {
            aiUnavailable = error.message || 'AI复核调用失败；请稍后重试。';
            break;
          }
        }
      }
    }
    const sourceById = new Map(workingNodes.map(node => [ node.id, node ]));
    return {
      afterOriginalNumber: payload.afterOriginalNumber || '',
      scopeEndIndex,
      rules,
      ai: aiSuggestions.map(suggestion => ({
        ...suggestion,
        source: sourceById.get(suggestion.nodeId) || null,
      })),
      candidates: candidates.length,
      summary: {
        ruleContainerCount: rules.filter(item => item.action === 'container').length,
        ruleSkipCount: rules.filter(item => item.action === 'skip').length,
        aiCount: aiSuggestions.length,
        unresolvedCount: candidates.length,
        trivialCount: workingNodes.slice(Math.max(0, afterIndex + 1), scopeEndIndex).filter(node => trivialReason(node.content)).length,
      },
      aiUnavailable,
      providerStatus,
      durationMs,
    };
  }

  async saveDraft(versionId, jobId, payload, actorId) {
    const job = await this.find(versionId, jobId);
    if (job.status !== 'ready') this.ctx.throw(409, '只有待确认的PDF导入任务可以保存草稿');
    const requested = Array.isArray(payload.nodes) ? payload.nodes : [];
    if (!requested.length) this.ctx.throw(400, '草稿至少需要保留一个节点');
    if (requested.length > 20000) this.ctx.throw(400, '草稿节点数量超出限制');
    const sourceNodes = job.result?.nodes || [];
    const sourceById = new Map(sourceNodes.map(node => [ String(node.id), node ]));
    const seen = new Set();
    const roles = new Set([ 'container', 'item', 'skip' ]);
    const nodes = requested.map((input, index) => {
      const id = String(input?.id || '').trim();
      if (!id || seen.has(id)) this.ctx.throw(400, `草稿第${index + 1}个节点编号无效或重复`);
      seen.add(id);
      const source = sourceById.get(id);
      const role = String(input.role || source?.role || 'container');
      if (!roles.has(role)) this.ctx.throw(400, `节点${id}的导入角色无效`);
      const kind = String(input.kind || source?.kind || 'list');
      const originalNumber = String(input.originalNumber ?? source?.originalNumber ?? '').trim();
      const title = String(input.title ?? source?.title ?? '').trim();
      const content = String(input.content ?? source?.content ?? '').trim();
      // 草稿允许保留未完成节点，便于先保存排序、角色和部分文字修改。
      // 原文编号和标准内容的完整性只在最终“确认并写入规范库”时校验。
      return {
        ...(source || {}),
        ...input,
        id,
        kind,
        role,
        originalNumber,
        title,
        content,
        pageFrom: Number.isFinite(Number(input.pageFrom ?? source?.pageFrom)) ? Number(input.pageFrom ?? source?.pageFrom) : null,
        pageTo: Number.isFinite(Number(input.pageTo ?? source?.pageTo)) ? Number(input.pageTo ?? source?.pageTo) : null,
      };
    });
    const result = { ...(job.result || {}), nodes: recalculateHierarchy(nodes) };
    try {
      return await this.repository.saveDraft(jobId, versionId, result, actorId);
    } catch (error) {
      if (error.code === 'INVALID_IMPORT_JOB') this.ctx.throw(409, error.message);
      throw error;
    }
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
