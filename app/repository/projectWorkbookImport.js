'use strict';

const { normalizeKey, splitEvidence } = require('../lib/projectWorkbookImport');
const { normalizeDefinition } = require('../lib/dedupe');

function normalizedContent(value) {
  return normalizeKey(value);
}

function standardContentForComparison(item) {
  return item.explanation_snapshot
    ? `${item.explanation_snapshot}\n${item.content_snapshot}`
    : item.content_snapshot;
}

function parseCheckedAt(value) {
  const match = String(value || '').match(/\b(20\d{2})\s*[./年-]\s*(\d{1,2})\s*[./月-]\s*(\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function resultStatus(value) {
  const text = String(value || '');
  if (/部分满足|部分符合|基本满足/.test(text)) return 'partially_satisfied';
  if (/不满足|不符合|不合格/.test(text)) return 'not_satisfied';
  if (/满足|符合|合格/.test(text)) return 'satisfied';
  return 'unassessed';
}

function definitionFields(row, supervision) {
  const fields = {
    object_name: row.standardName || row.level || row.chapterName || '安全规范条款',
    object_category: row.chapterName || null,
    check_layer: row.level || null,
    check_method: supervision.method || '综合检查',
    description: supervision.measure,
    steps: null,
    frequency: supervision.frequency || null,
    access_mode: /现场/.test(supervision.measure) ? 'onsite' : /远程/.test(supervision.measure) ? 'remote' : null,
  };
  return { ...fields, normalized_hash: normalizeDefinition(fields).normalizedHash };
}

function resolveCenterId(label, slot, cloudCenterIds, projectCenters) {
  const normalizedLabel = normalizeKey(label);
  if (normalizedLabel) {
    const matched = projectCenters.find(center => {
      const name = normalizeKey(center.name);
      const code = normalizeKey(center.code);
      return (name && (name.includes(normalizedLabel) || normalizedLabel.includes(name)))
        || (code && (code.includes(normalizedLabel) || normalizedLabel.includes(code)));
    });
    if (matched) return matched.id;
  }
  return cloudCenterIds[slot] || null;
}

class ProjectWorkbookImportRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async createJob({ projectId, fileName, payload, createdBy }) {
    const result = await this.pool.query(`
      INSERT INTO project_data_import_jobs (project_id, original_filename, payload, created_by)
      VALUES ($1, $2, $3::jsonb, $4)
      RETURNING id, project_id, original_filename, status, created_at`,
    [ projectId, fileName, JSON.stringify(payload), createdBy ]);
    return result.rows[0];
  }

  async getJob(projectId, jobId) {
    const result = await this.pool.query(`
      SELECT id, project_id, original_filename, status, payload, cloud_mapping,
             created_by, created_at, applied_at
      FROM project_data_import_jobs WHERE project_id = $1 AND id = $2`, [ projectId, jobId ]);
    return result.rows[0] || null;
  }

  async listProjectCloudCenters(projectId) {
    const result = await this.pool.query(`
      SELECT cc.id, cc.code, cc.name FROM project_cloud_centers pcc
      JOIN cloud_centers cc ON cc.id = pcc.cloud_center_id
      WHERE pcc.project_id = $1 ORDER BY cc.name, cc.code`, [ projectId ]);
    return result.rows;
  }

  async listProjectStandardItems(projectId) {
    const result = await this.pool.query(`
      SELECT psi.standard_item_id, psi.item_code_snapshot, psi.standard_number_snapshot,
             psi.explanation_snapshot, psi.content_snapshot
      FROM project_standard_items psi
      WHERE psi.project_id = $1`, [ projectId ]);
    return result.rows;
  }

  async getReview(projectId, jobId) {
    const [ job, cloudCenters, standardItems ] = await Promise.all([
      this.getJob(projectId, jobId),
      this.listProjectCloudCenters(projectId),
      this.listProjectStandardItems(projectId),
    ]);
    if (!job) return null;
    const byCode = new Map();
    for (const item of standardItems) {
      for (const key of [ item.item_code_snapshot, item.standard_number_snapshot ]) {
        const normalized = normalizeKey(key);
        if (!normalized) continue;
        if (!byCode.has(normalized)) byCode.set(normalized, []);
        byCode.get(normalized).push(item);
      }
    }
    const matches = [];
    const unmatched = [];
    const contentDifferences = [];
    for (const row of job.payload.rows || []) {
      const candidates = byCode.get(normalizeKey(row.clauseNumber)) || [];
      const unique = [ ...new Map(candidates.map(item => [ item.standard_item_id, item ])).values() ];
      if (unique.length !== 1) {
        unmatched.push({ sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, clauseNumber: row.clauseNumber, reason: unique.length ? '项目中存在多个同号标准项' : '项目基线中未找到该条款号' });
        continue;
      }
      const match = { ...row, standardItemId: unique[0].standard_item_id, itemCodeSnapshot: unique[0].item_code_snapshot };
      matches.push(match);
      if (normalizedContent(row.content) !== normalizedContent(standardContentForComparison(unique[0]))) {
        contentDifferences.push({ sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, clauseNumber: row.clauseNumber, snapshotContent: standardContentForComparison(unique[0]), importedContent: row.content });
      }
    }
    const rowCount = (job.payload.rows || []).length;
    const supervisionDefinitionCount = (job.payload.rows || []).reduce((sum, row) => sum + (row.supervision || []).length, 0);
    const supervisionObservationCount = (job.payload.rows || []).reduce((sum, row) => sum + (row.supervision || []).reduce((count, item) => count + (item.observations || []).length, 0), 0);
    return {
      job,
      cloudCenters,
      cloudGroups: job.payload.cloudCenterNames || [],
      matches,
      unmatched,
      contentDifferences,
      summary: {
        rowCount,
        matchedCount: matches.length,
        unmatchedCount: unmatched.length,
        contentDifferenceCount: contentDifferences.length,
        importedSheetCount: job.payload.importedSheetCount || 0,
        skippedSheetCount: job.payload.skippedSheetCount || 0,
        supervisionDefinitionCount,
        supervisionObservationCount,
      },
      previewRows: matches.slice(0, 8).map(row => ({ clauseNumber: row.clauseNumber, content: row.content, sourceSheet: row.sourceSheet })),
    };
  }

  async apply({ projectId, jobId, cloudCenterIds, acknowledgeUnmatched, acknowledgeContentDifferences, actorId }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const jobResult = await client.query(`
        SELECT * FROM project_data_import_jobs
        WHERE project_id = $1 AND id = $2 FOR UPDATE`, [ projectId, jobId ]);
      if (!jobResult.rowCount) {
        const error = new Error('项目数据导入任务不存在');
        error.code = 'PROJECT_IMPORT_NOT_FOUND';
        throw error;
      }
      const job = jobResult.rows[0];
      if (job.status !== 'ready') {
        const error = new Error('该导入任务已处理，不能重复写入');
        error.code = 'PROJECT_IMPORT_NOT_READY';
        throw error;
      }
      const projectCentersResult = await client.query(`
        SELECT cc.id, cc.code, cc.name FROM project_cloud_centers pcc
        JOIN cloud_centers cc ON cc.id = pcc.cloud_center_id
        WHERE pcc.project_id = $1 ORDER BY cc.name, cc.code`, [ projectId ]);
      const itemResult = await client.query(`
        SELECT psi.standard_item_id, psi.item_code_snapshot, psi.standard_number_snapshot,
               psi.explanation_snapshot, psi.content_snapshot
        FROM project_standard_items psi WHERE psi.project_id = $1`, [ projectId ]);
      const centersById = new Map(projectCentersResult.rows.map(center => [ center.id, center ]));
      const chosenCenters = cloudCenterIds.map(id => id || null);
      const activeCenterIds = chosenCenters.filter(Boolean);
      if (new Set(activeCenterIds).size !== activeCenterIds.length) {
        const error = new Error('同一个云中心不能映射到多个云中心列组');
        error.code = 'PROJECT_IMPORT_INVALID_CENTER_MAPPING';
        throw error;
      }
      if (activeCenterIds.some(id => !centersById.has(id))) {
        const error = new Error('云中心列组只能映射到当前项目已纳入的云中心');
        error.code = 'PROJECT_IMPORT_INVALID_CENTER_MAPPING';
        throw error;
      }
      const byCode = new Map();
      for (const item of itemResult.rows) {
        for (const value of [ item.item_code_snapshot, item.standard_number_snapshot ]) {
          const key = normalizeKey(value);
          if (!key) continue;
          if (!byCode.has(key)) byCode.set(key, []);
          byCode.get(key).push(item);
        }
      }
      const matches = [];
      const unmatched = [];
      const contentDifferences = [];
      for (const row of job.payload.rows || []) {
        const candidates = [ ...new Map((byCode.get(normalizeKey(row.clauseNumber)) || []).map(item => [ item.standard_item_id, item ])).values() ];
        if (candidates.length !== 1) {
          unmatched.push(row);
          continue;
        }
        matches.push({ ...row, standardItemId: candidates[0].standard_item_id });
        if (normalizedContent(row.content) !== normalizedContent(standardContentForComparison(candidates[0]))) contentDifferences.push(row);
      }
      if (unmatched.length && !acknowledgeUnmatched) {
        const error = new Error(`有${unmatched.length}條未匹配條款；请确认后勾选“仅导入已匹配条款”`);
        error.code = 'PROJECT_IMPORT_UNMATCHED';
        throw error;
      }
      if (contentDifferences.length && !acknowledgeContentDifferences) {
        const error = new Error(`有${contentDifferences.length}条标准正文与项目快照不同；请确认后再导入`);
        error.code = 'PROJECT_IMPORT_CONTENT_DIFFERENCE';
        throw error;
      }
      if (!matches.length) {
        const error = new Error('项目基线中没有匹配的条款，无法导入');
        error.code = 'PROJECT_IMPORT_NO_MATCH';
        throw error;
      }

      let answerCount = 0;
      let cloudAnswerCount = 0;
      let evidenceCount = 0;
      const evidenceCache = new Map();
      const addEvidence = async (answerId, value, metadata) => {
        for (const name of splitEvidence(value)) {
          const key = [ projectId, name ].join('|');
          let evidenceId = evidenceCache.get(key);
          if (!evidenceId) {
            const created = await client.query(`
              INSERT INTO evidence_materials (project_id, name, metadata, created_by)
              VALUES ($1, $2, $3::jsonb, $4)
              RETURNING id`, [ projectId, name, JSON.stringify({ importSource: job.original_filename, ...metadata }), actorId ]);
            evidenceId = created.rows[0].id;
            evidenceCache.set(key, evidenceId);
            evidenceCount += 1;
          }
          await client.query('INSERT INTO answer_evidence (answer_id, evidence_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ answerId, evidenceId ]);
        }
      };
      for (const row of matches) {
        const hasGlobalData = row.level || row.isKey !== null || row.providerAssignment || row.unifiedRequirement
          || row.expectedEvidence || row.pendingEvidence || row.problem || row.responsible;
        if (hasGlobalData) {
          const globalAnswer = await client.query(`
            INSERT INTO project_standard_answers
              (project_id, standard_item_id, standard_level, is_key, clause_assignment,
               unified_requirement, expected_evidence, pending_evidence, responsible_text, problem_description)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (project_id, standard_item_id) WHERE cloud_center_id IS NULL
            DO UPDATE SET
              standard_level = COALESCE(EXCLUDED.standard_level, project_standard_answers.standard_level),
              is_key = EXCLUDED.is_key,
              clause_assignment = COALESCE(EXCLUDED.clause_assignment, project_standard_answers.clause_assignment),
              unified_requirement = COALESCE(EXCLUDED.unified_requirement, project_standard_answers.unified_requirement),
              expected_evidence = COALESCE(EXCLUDED.expected_evidence, project_standard_answers.expected_evidence),
              pending_evidence = COALESCE(EXCLUDED.pending_evidence, project_standard_answers.pending_evidence),
              responsible_text = COALESCE(EXCLUDED.responsible_text, project_standard_answers.responsible_text),
              problem_description = COALESCE(EXCLUDED.problem_description, project_standard_answers.problem_description),
              updated_at = now()
            RETURNING id`, [
            projectId, row.standardItemId, row.level || null, Boolean(row.isKey), row.providerAssignment || null,
            row.unifiedRequirement || null, row.expectedEvidence || null, row.pendingEvidence || null,
            row.responsible || null, row.problem || null,
          ]);
          answerCount += 1;
          await addEvidence(globalAnswer.rows[0].id, row.pendingEvidence, { scope: 'pending' });
        }
        for (const [ slot, groupName ] of (job.payload.cloudCenterNames || []).entries()) {
          const answer = row.cloudCenters?.[groupName];
          const cloudCenterId = chosenCenters[slot];
          if (!answer || !cloudCenterId || !(answer.status || answer.measure || answer.evidence)) continue;
          const status = answer.status?.status || null;
          const applicability = answer.status?.applicability || null;
          const cloudAnswer = await client.query(`
            INSERT INTO project_standard_answers
              (project_id, standard_item_id, cloud_center_id, status, applicability,
               measure_description, actual_evidence, problem_description)
            VALUES ($1, $2, $3, COALESCE($4, 'unassessed'), COALESCE($5, 'unspecified'), $6, $7, $8)
            ON CONFLICT (project_id, standard_item_id, cloud_center_id) WHERE cloud_center_id IS NOT NULL
            DO UPDATE SET
              status = COALESCE($4, project_standard_answers.status),
              applicability = COALESCE($5, project_standard_answers.applicability),
              measure_description = COALESCE($6, project_standard_answers.measure_description),
              actual_evidence = COALESCE($7, project_standard_answers.actual_evidence),
              problem_description = COALESCE($8, project_standard_answers.problem_description),
              updated_at = now()
            RETURNING id`, [ projectId, row.standardItemId, cloudCenterId, status, applicability,
            answer.measure || null, answer.evidence || null, row.problem || null ]);
          cloudAnswerCount += 1;
          await addEvidence(cloudAnswer.rows[0].id, answer.evidence, { scope: 'cloud-center', cloudCenterId });
        }
      }

      const definitionsByHash = new Map();
      const executionGroups = new Map();
      let definitionLinkCount = 0;
      let skippedObservationCount = 0;
      for (const row of matches) {
        for (const supervision of row.supervision || []) {
          const fields = definitionFields(row, supervision);
          let definitionId = definitionsByHash.get(fields.normalized_hash);
          if (!definitionId) {
            const existing = await client.query('SELECT id FROM supervision_definitions WHERE normalized_hash = $1 AND status = \'active\' ORDER BY created_at LIMIT 1', [ fields.normalized_hash ]);
            if (existing.rowCount) {
              definitionId = existing.rows[0].id;
            } else {
              const created = await client.query(`
                INSERT INTO supervision_definitions
                  (object_name, object_category, check_layer, check_method, description, steps, frequency, access_mode, normalized_hash)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`, [
                fields.object_name, fields.object_category, fields.check_layer, fields.check_method,
                fields.description, fields.steps, fields.frequency, fields.access_mode, fields.normalized_hash,
              ]);
              definitionId = created.rows[0].id;
            }
            definitionsByHash.set(fields.normalized_hash, definitionId);
          }
          const linked = await client.query(`
            INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
            VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING definition_id`, [ definitionId, row.standardItemId ]);
          if (linked.rowCount) definitionLinkCount += 1;
          for (const observation of supervision.observations || []) {
            const cloudCenterId = resolveCenterId(observation.centerName, observation.slot, chosenCenters, projectCentersResult.rows);
            const checkedAt = parseCheckedAt(observation.content);
            if (!checkedAt || !cloudCenterId) {
              skippedObservationCount += 1;
              continue;
            }
            const key = [ definitionId, cloudCenterId, checkedAt ].join('|');
            if (!executionGroups.has(key)) {
              executionGroups.set(key, {
                definitionId,
                cloudCenterId,
                checkedAt,
                notes: '从项目整理工作簿导入',
                results: new Map(),
              });
            }
            const execution = executionGroups.get(key);
            const existing = execution.results.get(row.standardItemId);
            const result = {
              result: resultStatus(observation.result || observation.content),
              description: observation.content,
              problemDescription: observation.result || null,
            };
            if (existing) {
              existing.description = [ existing.description, result.description ].filter(Boolean).join('\n\n');
              existing.problemDescription = [ existing.problemDescription, result.problemDescription ].filter(Boolean).join('\n\n') || null;
              if (existing.result === 'unassessed') existing.result = result.result;
            } else execution.results.set(row.standardItemId, result);
          }
        }
      }
      let executionCount = 0;
      let resultCount = 0;
      for (const execution of executionGroups.values()) {
        const created = await client.query(`
          INSERT INTO supervision_executions
            (project_id, cloud_center_id, definition_id, checked_at, overall_result, notes)
          VALUES ($1, $2, $3, $4, NULL, $5) RETURNING id`, [
          projectId, execution.cloudCenterId, execution.definitionId, execution.checkedAt, execution.notes,
        ]);
        executionCount += 1;
        for (const [ standardItemId, result ] of execution.results) {
          await client.query(`
            INSERT INTO supervision_item_results
              (execution_id, standard_item_id, result, description, problem_description)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (execution_id, standard_item_id) DO UPDATE SET
              result = EXCLUDED.result, description = EXCLUDED.description,
              problem_description = EXCLUDED.problem_description`, [
            created.rows[0].id, standardItemId, result.result, result.description, result.problemDescription,
          ]);
          resultCount += 1;
        }
      }

      await client.query(`
        UPDATE project_data_import_jobs
        SET status = 'applied', cloud_mapping = $3::jsonb, applied_at = now()
        WHERE project_id = $1 AND id = $2`, [ projectId, jobId, JSON.stringify(chosenCenters) ]);
      await client.query('COMMIT');
      return {
        matchedCount: matches.length,
        unmatchedCount: unmatched.length,
        contentDifferenceCount: contentDifferences.length,
        answerCount,
        cloudAnswerCount,
        definitionCount: definitionsByHash.size,
        definitionLinkCount,
        executionCount,
        resultCount,
        evidenceCount,
        skippedObservationCount,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { ProjectWorkbookImportRepository, parseCheckedAt, resultStatus, resolveCenterId };
