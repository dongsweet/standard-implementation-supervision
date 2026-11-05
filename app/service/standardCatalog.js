'use strict';

const Service = require('egg').Service;
const StandardCatalogRepository = require('../repository/standardCatalog');

function required(value, field) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${field}不能为空`);
  return result;
}

class StandardCatalogService extends Service {
  get repository() {
    return new StandardCatalogRepository(this.ctx.app.db);
  }

  async listCatalog() {
    return this.repository.listCatalog();
  }

  async createStandard(payload) {
    try {
      return await this.repository.createStandard({
        code: required(payload.code, '规范编号'),
        name: required(payload.name, '规范名称'),
        description: payload.description,
        version: required(payload.version, '初始版本号'),
      });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '规范编号或版本号已存在');
      throw error;
    }
  }

  async createVersion(standardId, payload) {
    try {
      return await this.repository.createVersion({ standardId, version: required(payload.version, '版本号') });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '该规范版本号已存在');
      throw error;
    }
  }

  async getVersionDetail(versionId) {
    const result = await this.repository.getVersionDetail(versionId);
    if (!result) this.ctx.throw(404, '规范版本不存在');
    return result;
  }

  async createChapter(versionId, payload) {
    try {
      return await this.repository.createChapter({
        versionId,
        code: required(payload.code, '章节编号'),
        name: required(payload.name, '章节名称'),
        sortOrder: Number(payload.sortOrder || 0),
      });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '章节编号已存在');
      throw error;
    }
  }

  async createItem(chapterId, payload) {
    const chapter = await this.repository.findChapter(chapterId);
    if (!chapter) this.ctx.throw(404, '章节不存在');
    try {
      return await this.repository.createItem({
        versionId: chapter.standard_version_id,
        chapterId,
        itemCode: required(payload.itemCode, '标准项编号'),
        title: payload.title,
        content: required(payload.content, '标准内容'),
        level: payload.level,
        isKey: payload.isKey === true || payload.isKey === 'true' || payload.isKey === 'on',
        metadata: {},
        providerNames: this.parseProviders(payload.providerNames),
        unifiedRequirement: String(payload.unifiedRequirement || '').trim() || null,
        implementationEvidence: String(payload.implementationEvidence || '').trim() || null,
      });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '该版本下标准项编号已存在');
      throw error;
    }
  }

  parseImport(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) this.ctx.throw(400, '请填写待导入内容');
    const rows = lines.map((line, index) => {
      const parts = line.includes('\t') ? line.split('\t') : line.split(',');
      if (index === 0 && /标准项编号|item.?code/i.test(parts[0])) return null;
      const [ itemCode, title, content, level, isKey, providers, unifiedRequirement, implementationEvidence ] = parts.map(item => String(item || '').trim());
      if (!itemCode || !content) this.ctx.throw(400, `第${index + 1}行缺少标准项编号或标准内容`);
      return {
        itemCode, title, content, level,
        isKey: [ '1', 'true', '是', '是关键项' ].includes(isKey.toLowerCase()),
        providerNames: this.parseProviders(providers),
        unifiedRequirement: unifiedRequirement || null,
        implementationEvidence: implementationEvidence || null,
      };
    }).filter(Boolean);
    if (!rows.length) this.ctx.throw(400, '没有可导入的标准项');
    return rows;
  }

  parseProviders(value) {
    return String(value || '').split(/[,，、;；|\n]/).map(item => item.trim()).filter(Boolean).slice(0, 30);
  }

  async importItems(chapterId, text) {
    const chapter = await this.repository.findChapter(chapterId);
    if (!chapter) this.ctx.throw(404, '章节不存在');
    const rows = this.parseImport(text);
    return this.repository.upsertItems({ versionId: chapter.standard_version_id, chapterId, rows });
  }

  async publishVersion(versionId) {
    const result = await this.repository.publishVersion(versionId);
    if (!result) this.ctx.throw(404, '规范版本不存在');
    return result;
  }
}

module.exports = StandardCatalogService;
