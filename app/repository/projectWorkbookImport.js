'use strict';

const { normalizeKey, splitEvidence } = require('../lib/projectWorkbookImport');
const { normalizeDetails, parseSubmittedAssignmentText } = require('../lib/answerAssignment');
const { normalizeDefinition } = require('../lib/dedupe');
const SupervisionObjectRepository = require('./supervisionObject');

function normalizedContent(value) {
  return normalizeKey(value);
}

function standardContentForComparison(item) {
  const explanation = item.explanation_snapshot ?? item.explanation;
  const content = item.content_snapshot ?? item.content;
  if (normalizedContent(explanation) === normalizedContent(content)) return content;
  return explanation
    ? `${explanation}\n${content}`
    : content;
}

function hasAssignmentPlaceholder(item) {
  const text = standardContentForComparison(item);
  return /[\[［【]\s*(?:[赋賦]值|[选選]择)/u.test(String(text || ''));
}

function normalizeAnswerRow(row, item) {
  if (row.sourceKind !== 'answer') return row;
  if (!hasAssignmentPlaceholder(item)) {
    return {
      ...row,
      assignmentText: '',
      assignmentDetails: [],
    };
  }
  if (!Array.isArray(row.assignmentDetails) || !row.assignmentDetails.length) {
    const parsed = parseSubmittedAssignmentText(
      standardContentForComparison(item),
      row.assignmentText
    );
    if (!parsed.length) return row;
    return {
      ...row,
      assignmentDetails: parsed,
      assignmentText: normalizeDetails(parsed, standardContentForComparison(item)).clauseAssignment,
    };
  }
  const originalReviews = row.assignmentDetails.map(detail => ({
    reviewRequired: detail.reviewRequired,
    reviewReason: detail.reviewReason,
  }));
  const normalized = normalizeDetails(
    row.assignmentDetails.map(detail => ({
      ...detail,
      reviewRequired: false,
      reviewReason: null,
    })),
    standardContentForComparison(item)
  );
  const details = normalized.details.map((detail, index) => {
    const original = originalReviews[index];
    const staleFormatWarning = /占位符使用分号|分隔符|修正为中文冒号/.test(original?.reviewReason || '');
    return {
      ...detail,
      reviewRequired: staleFormatWarning ? false : Boolean(original?.reviewRequired || detail.reviewRequired),
      reviewReason: staleFormatWarning ? null : original?.reviewReason || detail.reviewReason || null,
    };
  });
  return {
    ...row,
    assignmentText: normalized.clauseAssignment || row.assignmentText,
    assignmentDetails: details,
  };
}

function sourceItemMap(items) {
  return new Map(items.map(item => [ item.id, item ]));
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

  async listProjectSourceItems(projectId) {
    const result = await this.pool.query(`
      SELECT si.id, si.item_code, si.standard_number, si.standard_version_id,
             si.explanation, si.content, si.heading_path, si.title, sc.code AS chapter_code
      FROM project_standard_versions psv
      JOIN standard_items si ON si.standard_version_id = psv.standard_version_id
      JOIN standard_chapters sc ON sc.id = si.chapter_id
      WHERE psv.project_id = $1`, [ projectId ]);
    return result.rows;
  }

  async getReview(projectId, jobId) {
    const [ job, cloudCenters, standardItems ] = await Promise.all([
      this.getJob(projectId, jobId),
      this.listProjectCloudCenters(projectId),
      this.listProjectStandardItems(projectId),
    ]);
    if (!job) return null;
    const sourceItems = job.payload.importMode === 'answer' ? await this.listProjectSourceItems(projectId) : [];
    const byCode = new Map();
    for (const item of standardItems) {
      for (const key of [ item.item_code_snapshot, item.standard_number_snapshot ]) {
        const normalized = normalizeKey(key);
        if (!normalized) continue;
        if (!byCode.has(normalized)) byCode.set(normalized, []);
        byCode.get(normalized).push(item);
      }
    }
    const sourceByCode = new Map();
    const sourceById = sourceItemMap(sourceItems);
    for (const item of sourceItems) {
      for (const key of [ item.item_code, item.standard_number ]) {
        const normalized = normalizeKey(key);
        if (!normalized) continue;
        if (!sourceByCode.has(normalized)) sourceByCode.set(normalized, []);
        sourceByCode.get(normalized).push(item);
      }
    }
    const matches = [];
    const unmatched = [];
    const contentDifferences = [];
    for (const row of job.payload.rows || []) {
      const lookupValue = row.sourceKind === 'answer' ? row.standardNumber : row.clauseNumber;
      const candidates = byCode.get(normalizeKey(lookupValue)) || [];
      const unique = [ ...new Map(candidates.map(item => [ item.standard_item_id, item ])).values() ];
      if (unique.length !== 1) {
        const sourceMatches = sourceByCode.get(normalizeKey(lookupValue)) || [];
        const reason = unique.length
          ? '项目中存在多个同号标准项'
          : sourceMatches.length
            ? '该标准项存在于项目所选规范版本，但项目快照缺少此项；请返回章节应答刷新项目基线后重新预览'
            : '项目基线中未找到该标准化编号';
        unmatched.push({ sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, clauseNumber: row.clauseNumber || lookupValue, standardNumber: row.standardNumber, reason });
        continue;
      }
      const currentSource = sourceById.get(unique[0].standard_item_id);
      const match = normalizeAnswerRow(
        { ...row, standardItemId: unique[0].standard_item_id, itemCodeSnapshot: unique[0].item_code_snapshot },
        currentSource || unique[0]
      );
      matches.push(match);
      if (row.sourceKind !== 'answer' && row.content && normalizedContent(row.content) !== normalizedContent(standardContentForComparison(unique[0]))) {
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
        importMode: job.payload.importMode || 'project',
        assignmentDetailCount: matches.reduce((sum, row) => sum + (row.assignmentDetails || []).length, 0),
        assignmentReviewCount: matches.reduce((sum, row) => sum + (row.assignmentDetails || []).filter(detail => detail.reviewRequired).length, 0),
        snapshotMissingCount: unmatched.filter(row => /项目快照缺少此项/.test(row.reason || '')).length,
      },
      previewRows: matches.slice(0, 8).map(row => ({ clauseNumber: row.clauseNumber || row.standardNumber, content: row.content || row.complianceDescription, assignmentText: row.assignmentText, assignmentDetails: row.assignmentDetails || [], sourceSheet: row.sourceSheet })),
    };
  }

  async apply({ projectId, jobId, cloudCenterIds, acknowledgeUnmatched, acknowledgeContentDifferences, acknowledgeAssignmentReview, actorId }) {
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
        WITH project_items AS (
          SELECT psi.standard_item_id, psi.item_code_snapshot, psi.standard_number_snapshot,
                 psi.explanation_snapshot, psi.content_snapshot
          FROM project_standard_items psi
          WHERE psi.project_id = $1
        )
        SELECT COALESCE(psi.standard_item_id, si.id) AS standard_item_id,
               CASE WHEN psi.standard_item_id IS NULL THEN si.item_code ELSE psi.item_code_snapshot END AS item_code_snapshot,
               CASE WHEN psi.standard_item_id IS NULL THEN si.standard_number ELSE psi.standard_number_snapshot END AS standard_number_snapshot,
               CASE WHEN psi.standard_item_id IS NULL THEN si.explanation ELSE psi.explanation_snapshot END AS explanation_snapshot,
               CASE WHEN psi.standard_item_id IS NULL THEN si.content ELSE psi.content_snapshot END AS content_snapshot,
               si.id AS source_item_id, si.item_code, si.standard_number, si.standard_version_id,
               si.explanation, si.content, si.heading_path, si.title, sc.code AS chapter_code,
               (psi.standard_item_id IS NULL) AS snapshot_missing
        FROM project_standard_versions psv
        JOIN standard_items si ON si.standard_version_id = psv.standard_version_id
        JOIN standard_chapters sc ON sc.id = si.chapter_id
        LEFT JOIN project_items psi ON psi.standard_item_id = si.id
        WHERE psv.project_id = $1`, [ projectId ]);
      const snapshotItems = itemResult.rows.filter(item => !item.snapshot_missing);
      const sourceItems = job.payload.importMode === 'answer'
        ? itemResult.rows.map(item => ({ ...item, id: item.source_item_id || item.standard_item_id }))
        : [];
      const centersById = new Map(projectCentersResult.rows.map(center => [ center.id, center ]));
      const chosenCenters = cloudCenterIds.map(id => id || null);
      const activeCenterIds = chosenCenters.filter(Boolean);
      if (new Set(activeCenterIds).size !== activeCenterIds.length) {
        const error = new Error('同一个分支机构不能映射到多个分支机构列组');
        error.code = 'PROJECT_IMPORT_INVALID_CENTER_MAPPING';
        throw error;
      }
      if (activeCenterIds.some(id => !centersById.has(id))) {
        const error = new Error('分支机构列组只能映射到当前项目已纳入的分支机构');
        error.code = 'PROJECT_IMPORT_INVALID_CENTER_MAPPING';
        throw error;
      }
      const byCode = new Map();
      for (const item of snapshotItems) {
        for (const value of [ item.item_code_snapshot, item.standard_number_snapshot ]) {
          const key = normalizeKey(value);
          if (!key) continue;
          if (!byCode.has(key)) byCode.set(key, []);
          byCode.get(key).push(item);
        }
      }
      const sourceByCode = new Map();
      const sourceById = sourceItemMap(sourceItems);
      for (const item of sourceItems) {
        for (const key of [ item.item_code, item.standard_number ]) {
          const normalized = normalizeKey(key);
          if (!normalized) continue;
          if (!sourceByCode.has(normalized)) sourceByCode.set(normalized, []);
          sourceByCode.get(normalized).push(item);
        }
      }
      const matches = [];
      const unmatched = [];
      const contentDifferences = [];
      for (const row of job.payload.rows || []) {
        const lookupValue = row.sourceKind === 'answer' ? row.standardNumber : row.clauseNumber;
        const candidates = [ ...new Map((byCode.get(normalizeKey(lookupValue)) || []).map(item => [ item.standard_item_id, item ])).values() ];
        if (candidates.length !== 1) {
          const sourceMatches = sourceByCode.get(normalizeKey(lookupValue)) || [];
          const reason = candidates.length
            ? '项目中存在多个同号标准项'
            : sourceMatches.length
              ? '该标准项存在于项目所选规范版本，但项目快照缺少此项；请返回章节应答刷新项目基线后重新预览'
              : '项目基线中未找到该标准化编号';
          unmatched.push({ ...row, reason });
          continue;
        }
        const currentSource = sourceById.get(candidates[0].standard_item_id);
        matches.push(normalizeAnswerRow(
          { ...row, standardItemId: candidates[0].standard_item_id },
          currentSource || candidates[0]
        ));
        if (row.sourceKind !== 'answer' && row.content && normalizedContent(row.content) !== normalizedContent(standardContentForComparison(candidates[0]))) contentDifferences.push(row);
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
      const assignmentReviewRows = matches.filter(row => (row.assignmentDetails || []).some(detail => detail.reviewRequired));
      if (assignmentReviewRows.length && !acknowledgeAssignmentReview) {
        const reviewCount = assignmentReviewRows.reduce((sum, row) => sum + row.assignmentDetails.filter(detail => detail.reviewRequired).length, 0);
        const error = new Error(`有${reviewCount}个赋值/选择项无法从工作簿确定一一对应；请确认后再导入`);
        error.code = 'PROJECT_IMPORT_ASSIGNMENT_REVIEW';
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
        const hasGlobalData = row.sourceKind === 'answer'
          ? Boolean(row.assignmentText || (row.assignmentDetails && row.assignmentDetails.length) || row.complianceDescription
            || row.expectedEvidence || row.actualEvidence || row.answerNotes || row.isKey !== null
            || row.applicability !== 'unspecified' || row.answerStatus !== 'unassessed'
            || row.pendingEvidence || row.problem || row.responsible)
          : Boolean(row.level || (row.isKey !== null && row.isKey !== undefined) || row.providerAssignment
          || row.assignmentText || (row.assignmentDetails && row.assignmentDetails.length) || row.complianceDescription
          || row.expectedEvidence || row.actualEvidence || row.answerNotes || row.applicability !== 'unspecified'
          || row.answerStatus !== 'unassessed' || row.pendingEvidence || row.problem || row.responsible);
        if (hasGlobalData) {
          const globalAnswer = await client.query(`
            INSERT INTO project_standard_answers
              (project_id, standard_item_id, is_key, clause_assignment,
               assignment_details, compliance_description, expected_evidence, actual_evidence,
               applicability, status, answer_notes, pending_evidence, responsible_text)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (project_id, standard_item_id) WHERE cloud_center_id IS NULL
            DO UPDATE SET
              is_key = CASE WHEN $14 THEN project_standard_answers.is_key ELSE EXCLUDED.is_key END,
              clause_assignment = COALESCE(EXCLUDED.clause_assignment, project_standard_answers.clause_assignment),
              assignment_details = CASE WHEN jsonb_array_length(EXCLUDED.assignment_details) > 0 THEN EXCLUDED.assignment_details ELSE project_standard_answers.assignment_details END,
              compliance_description = COALESCE(EXCLUDED.compliance_description, project_standard_answers.compliance_description),
              expected_evidence = COALESCE(EXCLUDED.expected_evidence, project_standard_answers.expected_evidence),
              actual_evidence = COALESCE(EXCLUDED.actual_evidence, project_standard_answers.actual_evidence),
              applicability = EXCLUDED.applicability,
              status = EXCLUDED.status,
              answer_notes = COALESCE(EXCLUDED.answer_notes, project_standard_answers.answer_notes),
              pending_evidence = COALESCE(EXCLUDED.pending_evidence, project_standard_answers.pending_evidence),
              responsible_text = COALESCE(EXCLUDED.responsible_text, project_standard_answers.responsible_text),
              updated_at = now()
            RETURNING id`, [
            projectId, row.standardItemId, Boolean(row.isKey), row.providerAssignment || row.assignmentText || null,
            JSON.stringify(row.assignmentDetails || []), row.complianceDescription || null, row.expectedEvidence || null,
            row.actualEvidence || null, row.applicability || 'unspecified', row.answerStatus || 'unassessed',
            row.answerNotes || null, row.pendingEvidence || null, row.responsible || null,
            row.sourceKind === 'answer',
          ]);
          answerCount += 1;
          await addEvidence(globalAnswer.rows[0].id, row.actualEvidence || row.pendingEvidence, { scope: row.actualEvidence ? 'actual' : 'pending' });
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
               compliance_description, actual_evidence, problem_description)
            VALUES ($1, $2, $3, COALESCE($4, 'unassessed'), COALESCE($5, 'unspecified'), $6, $7, $8)
            ON CONFLICT (project_id, standard_item_id, cloud_center_id) WHERE cloud_center_id IS NOT NULL
            DO UPDATE SET
              status = COALESCE($4, project_standard_answers.status),
              applicability = COALESCE($5, project_standard_answers.applicability),
              compliance_description = COALESCE($6, project_standard_answers.compliance_description),
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
          const objectRepository = new SupervisionObjectRepository(this.pool);
          const canonicalObjectId = await objectRepository.ensure(client, fields.object_name, fields.object_category);
          await client.query('UPDATE supervision_definitions SET canonical_object_id = $2 WHERE id = $1', [ definitionId, canonicalObjectId ]);
          const linked = await client.query(`
            INSERT INTO supervision_definition_standard_items (definition_id, standard_item_id)
            VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING definition_id`, [ definitionId, row.standardItemId ]);
          if (linked.rowCount) definitionLinkCount += 1;
          for (const observation of supervision.observations || []) {
            const supervisionCenter = /统一运维/.test(observation.centerName || '') ? '统一运维中心'
              : /总部/.test(observation.centerName || '') ? '总部' : '云中心';
            const resolvedCenterId = resolveCenterId(observation.centerName, observation.slot, chosenCenters, projectCentersResult.rows);
            const cloudCenterId = supervisionCenter === '云中心' ? resolvedCenterId : null;
            const checkedAt = parseCheckedAt(observation.content);
            if (!checkedAt || (supervisionCenter === '云中心' && !cloudCenterId)) {
              skippedObservationCount += 1;
              continue;
            }
            await client.query(`
              INSERT INTO supervision_definition_centers (definition_id, center_name)
              VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ definitionId, supervisionCenter ]);
            await objectRepository.ensure(client, fields.object_name, fields.object_category, supervisionCenter);
            const key = [ definitionId, supervisionCenter, cloudCenterId, checkedAt ].join('|');
            if (!executionGroups.has(key)) {
              executionGroups.set(key, {
                definitionId,
                supervisionCenter,
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
            (project_id, cloud_center_id, definition_id, supervision_center, checked_at, overall_result, notes)
          VALUES ($1, $2, $3, $4, $5, NULL, $6) RETURNING id`, [
          projectId, execution.cloudCenterId, execution.definitionId, execution.supervisionCenter, execution.checkedAt, execution.notes,
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
        assignmentDetailCount: matches.reduce((sum, row) => sum + (row.assignmentDetails || []).length, 0),
        assignmentReviewCount: matches.reduce((sum, row) => sum + (row.assignmentDetails || []).filter(detail => detail.reviewRequired).length, 0),
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
