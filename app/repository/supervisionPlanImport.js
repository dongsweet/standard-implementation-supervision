'use strict';

const { normalizeDefinition, normalizeText } = require('../lib/dedupe');

const PLAN_METADATA_FIELDS = [ 'scope', 'recognized_object', 'priority', 'access_mode', 'reference_result', 'reference_materials' ];

function planImportKey(normalizedHash, fields) {
  const metadata = PLAN_METADATA_FIELDS.map(field => {
    const value = fields[field];
    return typeof value === 'boolean' ? String(value) : normalizeText(value);
  });
  return JSON.stringify([ normalizedHash, ...metadata ]);
}

function canReuseDefinition(definition, fields) {
  return PLAN_METADATA_FIELDS.every(field => {
    const stored = definition[field] === undefined ? null : definition[field];
    const incoming = fields[field] === undefined ? null : fields[field];
    if (stored === null || stored === '') return true;
    if (incoming === null || incoming === '') return false;
    if (typeof stored === 'boolean' || typeof incoming === 'boolean') return stored === incoming;
    return normalizeText(stored) === normalizeText(incoming);
  });
}

function standardKey(value) {
  return String(value || '').normalize('NFKC').trim().toUpperCase();
}

function importError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class SupervisionPlanImportRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async createJob({ fileName, payload, createdBy }) {
    const result = await this.pool.query(`
      INSERT INTO supervision_plan_import_jobs (original_filename, payload, created_by)
      VALUES ($1, $2::jsonb, $3)
      RETURNING id, original_filename, status, created_at`,
    [ fileName, JSON.stringify(payload), createdBy ]);
    return result.rows[0];
  }

  async getJob(jobId, client = this.pool) {
    const result = await client.query(`
      SELECT id, original_filename, status, payload, created_by, created_at, applied_at
      FROM supervision_plan_import_jobs WHERE id = $1`, [ jobId ]);
    return result.rows[0] || null;
  }

  async listStandardItems(standardNumbers, client = this.pool) {
    if (!standardNumbers.length) return [];
    const result = await client.query(`
      SELECT si.id, si.standard_number, si.item_code, si.title,
             s.code AS standard_code, sv.version, sc.code AS chapter_code, sc.name AS chapter_name
      FROM standard_items si
      JOIN standard_versions sv ON sv.id = si.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      JOIN standard_chapters sc ON sc.id = si.chapter_id
      WHERE si.standard_number = ANY($1::text[])
      ORDER BY s.code, sv.version, si.item_code`, [ standardNumbers ]);
    return result.rows;
  }

  async getReview(jobId) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const rows = job.payload?.rows || [];
    const standardNumbers = [ ...new Set(rows.flatMap(row => row.standardNumbers || [])) ];
    const standardItems = await this.listStandardItems(standardNumbers);
    const byNumber = new Map();
    for (const item of standardItems) {
      const key = standardKey(item.standard_number);
      if (!byNumber.has(key)) byNumber.set(key, []);
      byNumber.get(key).push(item);
    }
    const unmatchedNumbers = [];
    const ambiguousNumbers = [];
    const reviewedRows = rows.map(row => {
      const mapped = [];
      const missing = [];
      for (const number of row.standardNumbers || []) {
        const candidates = byNumber.get(standardKey(number)) || [];
        if (candidates.length === 1) mapped.push(candidates[0]);
        else if (candidates.length > 1) {
          ambiguousNumbers.push(number);
          missing.push(number);
        } else {
          unmatchedNumbers.push(number);
          missing.push(number);
        }
      }
      return { ...row, standardItems: mapped, unmatchedNumbers: missing };
    });
    const uniqueUnmatched = [ ...new Set(unmatchedNumbers) ];
    const uniqueAmbiguous = [ ...new Set(ambiguousNumbers) ];
    return {
      job,
      rows: reviewedRows,
      standardNumbers,
      unmatchedNumbers: uniqueUnmatched,
      ambiguousNumbers: uniqueAmbiguous,
      summary: {
        rowCount: rows.length,
        standardNumberCount: standardNumbers.length,
        matchedNumberCount: standardNumbers.length - uniqueUnmatched.length - uniqueAmbiguous.length,
        linkCount: reviewedRows.reduce((sum, row) => sum + row.standardItems.length, 0),
        unmatchedCount: uniqueUnmatched.length,
        ambiguousCount: uniqueAmbiguous.length,
        status: job.status,
        ignoredXRowCount: Number(job.payload?.ignoredXRowCount || 0),
        ignoredXNumberCount: Number(job.payload?.ignoredXNumberCount || 0),
      },
    };
  }

  async apply(jobId, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const jobResult = await client.query(`
        SELECT * FROM supervision_plan_import_jobs WHERE id = $1 FOR UPDATE`, [ jobId ]);
      if (!jobResult.rowCount) throw importError('SUPERVISION_IMPORT_NOT_FOUND', '检查方案导入任务不存在');
      const job = jobResult.rows[0];
      if (job.status !== 'ready') throw importError('SUPERVISION_IMPORT_NOT_READY', '该检查方案导入任务已处理，不能重复写入');

      const rows = job.payload?.rows || [];
      const standardNumbers = [ ...new Set(rows.flatMap(row => row.standardNumbers || [])) ];
      const standardItems = await this.listStandardItems(standardNumbers, client);
      const byNumber = new Map();
      for (const item of standardItems) {
        const key = standardKey(item.standard_number);
        if (!byNumber.has(key)) byNumber.set(key, []);
        byNumber.get(key).push(item);
      }
      const unmatched = [];
      const ambiguous = [];
      for (const number of standardNumbers) {
        const candidates = byNumber.get(standardKey(number)) || [];
        if (!candidates.length) unmatched.push(number);
        else if (candidates.length > 1) ambiguous.push(number);
      }
      if (unmatched.length || ambiguous.length) {
        const details = [
          unmatched.length ? `系统中找不到：${unmatched.join('、')}` : '',
          ambiguous.length ? `系统中存在多个对应项：${ambiguous.join('、')}` : '',
        ].filter(Boolean).join('；');
        throw importError('SUPERVISION_IMPORT_STANDARD_MISMATCH', `标准编号关联未通过校验，未导入任何方案。${details}`);
      }

      const definitionsByKey = new Map();
      let createdCount = 0;
      let reusedCount = 0;
      let linkCount = 0;
      for (const row of rows) {
        const fields = {
          object_name: row.objectName,
          scope: row.scope || null,
          recognized_object: row.recognizedObject,
          object_category: row.objectCategory || null,
          check_layer: row.checkLayer || null,
          check_method: row.checkMethod,
          description: row.description,
          steps: row.steps || null,
          frequency: row.frequency || null,
          access_mode: row.accessMode || null,
          priority: row.priority || null,
          reference_result: row.referenceResult || null,
          reference_materials: row.referenceMaterials || null,
        };
        const normalizedHash = normalizeDefinition(fields).normalizedHash;
        const planKey = planImportKey(normalizedHash, fields);
        let definitionId = definitionsByKey.get(planKey);
        if (!definitionId) {
          const existing = await client.query(`
            SELECT id, scope, recognized_object, priority, access_mode, reference_result, reference_materials
            FROM supervision_definitions
            WHERE normalized_hash = $1 AND status = 'active'
            ORDER BY created_at FOR UPDATE`, [ normalizedHash ]);
          const reusable = existing.rows.find(candidate => canReuseDefinition(candidate, fields));
          if (reusable) {
            definitionId = reusable.id;
            reusedCount += 1;
            await client.query(`
              UPDATE supervision_definitions
              SET scope = COALESCE(scope, $2), recognized_object = COALESCE(recognized_object, $3),
                  priority = COALESCE(priority, $4), access_mode = COALESCE(access_mode, $5),
                  reference_result = COALESCE(reference_result, $6),
                  reference_materials = COALESCE(reference_materials, $7), updated_at = now()
              WHERE id = $1`, [
              definitionId, fields.scope, fields.recognized_object, fields.priority,
              fields.access_mode, fields.reference_result, fields.reference_materials,
            ]);
          } else {
            const created = await client.query(`
              INSERT INTO supervision_definitions
                (object_name, scope, recognized_object, object_category, check_layer, check_method,
                 description, steps, frequency, access_mode, priority, reference_result,
                 reference_materials, normalized_hash)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
              RETURNING id`, [
              fields.object_name, fields.scope, fields.recognized_object, fields.object_category,
              fields.check_layer, fields.check_method, fields.description, fields.steps, fields.frequency,
              fields.access_mode, fields.priority, fields.reference_result, fields.reference_materials, normalizedHash,
            ]);
            definitionId = created.rows[0].id;
            createdCount += 1;
          }
          definitionsByKey.set(planKey, definitionId);
        }
        for (const number of row.standardNumbers || []) {
          const standardItemId = byNumber.get(standardKey(number))[0].id;
          const linked = await client.query(`
            INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
            VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING definition_id`, [ definitionId, standardItemId ]);
          if (linked.rowCount) linkCount += 1;
        }
      }
      await client.query(`
        UPDATE supervision_plan_import_jobs SET status = 'applied', applied_at = now()
        WHERE id = $1`, [ jobId ]);
      await client.query('COMMIT');
      return { importedRowCount: rows.length, createdCount, reusedCount, linkCount, actorId };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { SupervisionPlanImportRepository, canReuseDefinition, planImportKey, standardKey };
