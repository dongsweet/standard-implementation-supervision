'use strict';

const Service = require('egg').Service;
const Repository = require('../repository/supervisionExecution');

const RESULTS = new Set([ 'unassessed', 'satisfied', 'partially_satisfied', 'not_satisfied', 'not_applicable' ]);
const OVERALL_RESULTS = new Set([ 'satisfied', 'partially_satisfied', 'not_satisfied' ]);
// PostgreSQL accepts UUIDs with any version/variant bits; validate the shape only.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/);
  if (!match || Number.isNaN(Date.parse(text))) return false;
  const [ , year, month, day, hour = '0', minute = '0', second = '0', offset = '' ] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const daysPerMonth = [ 31, (yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0)) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31 ];
  const daysInMonth = monthNumber >= 1 && monthNumber <= 12 ? daysPerMonth[monthNumber - 1] : 0;
  if (yearNumber < 1 || dayNumber < 1 || dayNumber > daysInMonth || hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return false;
  if (offset && offset !== 'Z') {
    const offsetMatch = offset.match(/[+-](\d{2}):(\d{2})/);
    if (Number(offsetMatch[1]) > 23 || Number(offsetMatch[2]) > 59) return false;
  }
  return true;
}

class SupervisionExecutionService extends Service {
  get repository() {
    return new Repository(this.ctx.app.db);
  }

  async list(projectId) {
    const [ options, executions ] = await Promise.all([
      this.repository.listOptions(projectId),
      this.repository.list(projectId),
    ]);
    return { ...options, executions };
  }

  async create(projectId, payload, checkedBy) {
    const definitionId = String(payload.definitionId || '').trim();
    const cloudCenterId = String(payload.cloudCenterId || '').trim() || null;
    const supervisionCenter = String(payload.supervisionCenter || '').trim() || null;
    const checkedAt = String(payload.checkedAt || '').trim();
    if (!definitionId || !checkedAt) this.ctx.throw(400, '请选择监督定义并填写检查时间');
    if (!UUID_RE.test(definitionId)) this.ctx.throw(400, '监督定义编号格式无效');
    if (cloudCenterId && !UUID_RE.test(cloudCenterId)) this.ctx.throw(400, '云中心编号格式无效');
    if (!isValidDate(checkedAt)) this.ctx.throw(400, '检查时间格式无效');
    const overallResult = String(payload.overallResult || '').trim();
    if (overallResult && !OVERALL_RESULTS.has(overallResult)) this.ctx.throw(400, '无效的总体检查结论');
    let submitted = {};
    if (payload.itemResults) {
      try {
        submitted = JSON.parse(String(payload.itemResults));
      } catch {
        this.ctx.throw(400, '标准项检查结果格式无效');
      }
      if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
        this.ctx.throw(400, '标准项检查结果格式无效');
      }
    }
    const itemResults = new Map();
    for (const [ standardItemId, item ] of Object.entries(submitted || {})) {
      if (!item || !RESULTS.has(item.result || 'unassessed')) this.ctx.throw(400, '无效的标准项检查结论');
      const rectificationDueAt = String(item.rectificationDueAt || '').trim() || null;
      if (rectificationDueAt && !isValidDate(rectificationDueAt)) this.ctx.throw(400, '整改期限格式无效');
      itemResults.set(standardItemId, {
        result: item.result || 'unassessed',
        description: String(item.description || '').trim(),
        problemDescription: String(item.problemDescription || '').trim(),
        rectificationDueAt,
      });
    }
    try {
      return await this.repository.create({
        projectId, definitionId, cloudCenterId, supervisionCenter, checkedAt, checkedBy,
        overallResult, notes: String(payload.notes || '').trim(), itemResults,
      });
    } catch (error) {
      if ([ 'INVALID_DEFINITION', 'INVALID_CLOUD_CENTER', 'INVALID_ITEM_RESULTS', 'INVALID_SUPERVISION_CENTER' ].includes(error.code)) this.ctx.throw(400, error.message);
      throw error;
    }
  }
}

module.exports = SupervisionExecutionService;
