'use strict';

const Service = require('egg').Service;
const StandardCatalogRepository = require('../repository/standardCatalog');
const { STANDARD_TYPES, STANDARD_TYPE_LABELS } = require('../lib/standardTypes');
const { parseStandardImportFile } = require('../lib/standardImport');

const STANDARD_TYPE_VALUES = new Set(STANDARD_TYPES.map(item => item.value));

function required(value, field) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${field}不能为空`);
  return result;
}

class StandardCatalogService extends Service {
  get repository() {
    return new StandardCatalogRepository(this.ctx.app.db);
  }

  async listCatalog(query = {}) {
    const search = String(query.search || '').trim().slice(0, 100);
    const standardType = String(query.standardType || '').trim();
    if (standardType && !STANDARD_TYPE_VALUES.has(standardType)) this.ctx.throw(400, '无效的规范类型');
    const pageSize = 20;
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const result = await this.repository.listCatalog({ search, standardType, page, pageSize });
    const currentPage = Math.min(result.page, result.pageCount);
    if (currentPage !== page) return this.listCatalog({ ...query, page: currentPage });
    return { ...result, search, standardType, typeLabels: STANDARD_TYPE_LABELS };
  }

  async createStandard(payload) {
    try {
      const standardType = String(payload.standardType || 'other').trim();
      if (!STANDARD_TYPE_VALUES.has(standardType)) this.ctx.throw(400, '无效的规范类型');
      return await this.repository.createStandard({
        code: required(payload.code, '规范编号'),
        name: required(payload.name, '规范名称'),
        description: payload.description,
        standardType,
        issuingOrganization: String(payload.issuingOrganization || '').trim().slice(0, 300) || null,
        version: required(payload.version, '初始版本号'),
      });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '规范编号或版本号已存在');
      throw error;
    }
  }

  async importStandard(payload, filePath, fileName) {
    const standardType = String(payload.standardType || 'other').trim();
    if (!STANDARD_TYPE_VALUES.has(standardType)) this.ctx.throw(400, '无效的规范类型');
    const code = required(payload.code, '规范编号');
    const name = required(payload.name, '规范名称');
    const version = required(payload.version, '版本标识');
    if (code.length > 100) this.ctx.throw(400, '规范编号不能超过100个字符');
    if (name.length > 300) this.ctx.throw(400, '规范名称不能超过300个字符');
    if (version.length > 100) this.ctx.throw(400, '版本标识不能超过100个字符');
    const imported = await parseStandardImportFile(filePath, fileName);
    try {
      return await this.repository.importStandard({
        code, name, version, standardType,
        description: String(payload.description || '').trim() || null,
        issuingOrganization: String(payload.issuingOrganization || '').trim().slice(0, 300) || null,
        chapters: imported.chapters,
      });
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '规范编号或版本标识已存在，请检查规范库后重试');
      throw error;
    }
  }

  async updateStandard(standardId, versionId, payload) {
    try {
      const standardType = String(payload.standardType || 'other').trim();
      if (!STANDARD_TYPE_VALUES.has(standardType)) this.ctx.throw(400, '无效的规范类型');
      const code = required(payload.code, '规范编号');
      const name = required(payload.name, '规范名称');
      const version = required(payload.version, '版本标识');
      if (code.length > 100) this.ctx.throw(400, '规范编号不能超过100个字符');
      if (name.length > 300) this.ctx.throw(400, '规范名称不能超过300个字符');
      if (version.length > 100) this.ctx.throw(400, '版本标识不能超过100个字符');
      const result = await this.repository.updateStandard({
        standardId,
        versionId,
        code,
        name,
        description: String(payload.description || '').trim() || null,
        standardType,
        issuingOrganization: String(payload.issuingOrganization || '').trim().slice(0, 300) || null,
        version,
      });
      if (!result) this.ctx.throw(404, '规范或规范版本不存在');
      return result;
    } catch (error) {
      if (error.code === '23505') this.ctx.throw(409, '规范编号或该规范版本标识已存在');
      throw error;
    }
  }

  async createVersion(standardId, payload) {
    try {
      return await this.repository.createVersion({ standardId, version: required(payload.version, '版本标识') });
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

  async clearVersionContent(versionId, actorId) {
    try {
      const result = await this.repository.clearVersionContent({ versionId, actorId });
      if (!result) this.ctx.throw(404, '规范版本不存在');
      return result;
    } catch (error) {
      if (error.code === 'STANDARD_CONTENT_REFERENCED') this.ctx.throw(409, error.message);
      throw error;
    }
  }

  async importVersionContent(versionId, filePath, fileName) {
    const imported = await parseStandardImportFile(filePath, fileName);
    const result = await this.repository.importVersionContent({ versionId, chapters: imported.chapters });
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
        title: String(payload.title || '').trim() || null,
        content: required(payload.content, '标准内容'),
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
      const parts = this.splitDelimitedLine(line);
      if (index === 0 && /标准项编号|item.?code/i.test(parts[0])) return null;
      const [ itemCode, title, content ] = parts.map(item => String(item || '').trim());
      if (!itemCode || !content) this.ctx.throw(400, `第${index + 1}行缺少标准项编号或标准内容`);
      return { itemCode, title, content };
    }).filter(Boolean);
    if (!rows.length) this.ctx.throw(400, '没有可导入的标准项');
    return rows;
  }

  splitDelimitedLine(line) {
    if (line.includes('\t')) return line.split('\t');
    const parts = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"' && line[index + 1] === '"' && quoted) {
        current += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current);
    return parts;
  }

  async importItems(chapterId, text) {
    const chapter = await this.repository.findChapter(chapterId);
    if (!chapter) this.ctx.throw(404, '章节不存在');
    const rows = this.parseImport(text);
    return this.repository.upsertItems({ versionId: chapter.standard_version_id, chapterId, rows });
  }

}

module.exports = StandardCatalogService;
