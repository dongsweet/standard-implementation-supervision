'use strict';

const { recalculateHierarchy } = require('../lib/standardOutline');
const { chapterStandardNumber, recalculateStandardNumbers } = require('../lib/standardNumber');

class StandardImportJobRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async create({ versionId, originalFilename, storageKey, comparisonFilename, comparisonStorageKey, createdBy }) {
    const result = await this.pool.query(`
      INSERT INTO standard_import_jobs
        (standard_version_id, original_filename, storage_key,
         comparison_filename, comparison_storage_key, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`, [
      versionId, originalFilename, storageKey,
      comparisonFilename || null, comparisonStorageKey || null, createdBy || null,
    ]);
    return result.rows[0];
  }

  async find(versionId, jobId) {
    const result = await this.pool.query(`
      SELECT j.*, sv.version, s.code AS standard_code, s.name AS standard_name
      FROM standard_import_jobs j
      JOIN standard_versions sv ON sv.id = j.standard_version_id
      JOIN standards s ON s.id = sv.standard_id
      WHERE j.id = $1 AND j.standard_version_id = $2`, [ jobId, versionId ]);
    return result.rows[0] || null;
  }

  async listByVersion(versionId, limit = 10) {
    const result = await this.pool.query(`
      SELECT id, original_filename, comparison_filename, status, progress, page_count,
             error_message, created_at, updated_at, completed_at
      FROM standard_import_jobs
      WHERE standard_version_id = $1
      ORDER BY created_at DESC
      LIMIT $2`, [ versionId, limit ]);
    return result.rows;
  }

  async markProcessing(jobId) {
    await this.pool.query(`
      UPDATE standard_import_jobs
      SET status = 'processing', progress = 0, error_message = NULL, updated_at = now()
      WHERE id = $1`, [ jobId ]);
  }

  async updateProgress(jobId, progress, pageCount = null) {
    await this.pool.query(`
      UPDATE standard_import_jobs
      SET progress = $2, page_count = COALESCE($3, page_count), updated_at = now()
      WHERE id = $1 AND status = 'processing'`, [ jobId, progress, pageCount ]);
  }

  async completeExtraction(jobId, { pageCount, result, comparisonResult = null }) {
    const query = await this.pool.query(`
      UPDATE standard_import_jobs
      SET status = 'ready', progress = 100, page_count = $2, result = $3,
          comparison_result = $4, completed_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING *`, [ jobId, pageCount, JSON.stringify(result), comparisonResult ? JSON.stringify(comparisonResult) : null ]);
    return query.rows[0];
  }

  async fail(jobId, message) {
    await this.pool.query(`
      UPDATE standard_import_jobs
      SET status = 'failed', error_message = $2, updated_at = now(), completed_at = now()
      WHERE id = $1`, [ jobId, String(message || '解析失败').slice(0, 2000) ]);
  }

  async saveDraft(jobId, versionId, result, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(`
        UPDATE standard_import_jobs
        SET result = $3, status = 'ready', error_message = NULL, updated_at = now()
        WHERE id = $1 AND standard_version_id = $2 AND status = 'ready'
        RETURNING id, updated_at`, [ jobId, versionId, JSON.stringify(result) ]);
      if (!updated.rowCount) {
        const error = new Error('PDF导入任务不存在、尚未完成或已经写入规范库');
        error.code = 'INVALID_IMPORT_JOB';
        throw error;
      }
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'save_standard_pdf_import_draft', 'standard_import_job', $2, $3)`, [
        actorId || null,
        jobId,
        JSON.stringify({ versionId, nodeCount: result.nodes?.length || 0 }),
      ]);
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async apply(jobId, versionId, selectedNodes, actorId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const jobResult = await client.query(`
        SELECT j.id, j.result, s.code AS standard_code, sv.version
        FROM standard_import_jobs j
        JOIN standard_versions sv ON sv.id = j.standard_version_id
        JOIN standards s ON s.id = sv.standard_id
        WHERE j.id = $1 AND j.standard_version_id = $2 AND j.status = 'ready'
        FOR UPDATE`, [ jobId, versionId ]);
      if (!jobResult.rowCount) {
        const error = new Error('PDF导入任务不存在、尚未完成或已应用');
        error.code = 'INVALID_IMPORT_JOB';
        throw error;
      }
      const sourceNodes = jobResult.rows[0].result?.nodes || [];
      const requestedById = new Map(selectedNodes.map(node => [ node.id, node ]));
      const effectiveNodes = recalculateHierarchy(sourceNodes.map(source => {
        const requested = requestedById.get(source.id);
        return {
          ...source,
          originalNumber: typeof requested?.originalNumber === 'string'
            ? requested.originalNumber.trim()
            : source.originalNumber,
          title: typeof requested?.title === 'string' ? requested.title.trim() : source.title,
          content: typeof requested?.content === 'string' ? requested.content.trim() : source.content,
        };
      }));
      const byId = new Map(effectiveNodes.map(node => [ node.id, node ]));
      const selection = new Map(selectedNodes.map(node => [ node.id, node.role ]));
      const children = new Map();
      for (const node of effectiveNodes) {
        if (!node.parentId) continue;
        if (!children.has(node.parentId)) children.set(node.parentId, []);
        children.get(node.parentId).push(node);
      }
      const selectedItems = effectiveNodes.filter(node => selection.get(node.id) === 'item');
      if (!selectedItems.length) {
        const error = new Error('请至少选择一个标准项');
        error.code = 'NO_SELECTED_ITEMS';
        throw error;
      }

      const chapters = new Map();
      for (const item of selectedItems) {
        if (!item.originalNumber || !item.content?.trim()) {
          const error = new Error(`节点“${item.originalNumber || item.title || item.id}”缺少原文编号或标准内容`);
          error.code = 'INVALID_SELECTED_NODE';
          throw error;
        }
        const ancestors = this.ancestors(item, byId);
        const chapterNode = this.chapterNode(ancestors, item);
        const chapterCode = chapterNode.originalNumber || chapterNode.headingNumber;
        const chapterName = chapterNode.title || chapterNode.originalNumber;
        if (!chapterCode || !chapterName) {
          const error = new Error(`标准项“${item.originalNumber}”无法确定所属章节`);
          error.code = 'MISSING_CHAPTER';
          throw error;
        }
        chapters.set(chapterCode, chapterName);
      }

      const chapterIds = new Map();
      for (const [ code, name ] of chapters) {
        const inserted = await client.query(`
          INSERT INTO standard_chapters (standard_version_id, code, name, sort_order, standard_number)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (standard_version_id, code) DO UPDATE SET name = EXCLUDED.name, standard_number = EXCLUDED.standard_number
          RETURNING id, standard_number`, [
          versionId, code, name, chapterIds.size * 10,
          chapterStandardNumber(jobResult.rows[0].standard_code, jobResult.rows[0].version, code),
        ]);
        chapterIds.set(code, inserted.rows[0].id);
      }

      const chapterOrders = new Map();
      for (const item of selectedItems) {
        const ancestors = this.ancestors(item, byId);
        const chapterNode = this.chapterNode(ancestors, item);
        const chapterCode = chapterNode.originalNumber || chapterNode.headingNumber;
        const headings = [ ...ancestors ].reverse().filter(node => node.kind === 'heading');
        const chapterHeading = headings.find(node => node.level === 1) || headings[0] || chapterNode;
        const headingPath = headings
          .filter(node => node !== chapterHeading)
          .map(node => ({ level: node.level, number: node.originalNumber || node.headingNumber || '', title: node.title || '' }));
        if (item.kind === 'heading' && item !== chapterHeading) {
          headingPath.push({ level: item.level, number: item.originalNumber || item.headingNumber || '', title: item.title || '' });
        }
        const prelude = ancestors
          .filter(node => node.kind === 'heading' && node.content)
          .map(node => node.content)
          .join('\n');
        const ownContent = item.kind === 'heading'
          ? [ item.content, this.descendantContent(item.id, children, selection) ].filter(Boolean).join('\n')
          : item.content;
        const content = [ prelude, ownContent ].filter(Boolean).join('\n');
        const title = item.kind === 'heading' ? null : item.title || null;
        const importOrder = (chapterOrders.get(chapterCode) || 0) + 1;
        chapterOrders.set(chapterCode, importOrder);
        await client.query(`
          INSERT INTO standard_items
            (standard_version_id, chapter_id, item_code, title, content,
            source_page_from, source_page_to, source_excerpt, import_job_id,
             heading_path, import_order, standard_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (standard_version_id, item_code) DO UPDATE SET
            chapter_id = EXCLUDED.chapter_id, title = EXCLUDED.title, content = EXCLUDED.content,
            source_page_from = EXCLUDED.source_page_from, source_page_to = EXCLUDED.source_page_to,
            source_excerpt = EXCLUDED.source_excerpt, import_job_id = EXCLUDED.import_job_id,
            heading_path = EXCLUDED.heading_path,
            import_order = EXCLUDED.import_order, standard_number = EXCLUDED.standard_number`,
        [ versionId, chapterIds.get(chapterCode), item.originalNumber, title, content,
          item.pageFrom || null, item.pageTo || item.pageFrom || null,
          content.slice(0, 1000), jobId, JSON.stringify(headingPath), importOrder,
          [ 'TEMP', versionId, item.originalNumber ].join('-') ]);
      }
      await recalculateStandardNumbers(client, versionId);

      await client.query(`
        UPDATE standard_import_jobs
        SET status = 'completed', progress = 100, updated_at = now(), completed_at = now()
        WHERE id = $1`, [ jobId ]);
      await client.query(`
        INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, 'standard_pdf_import', 'standard_version', $2, $3)`,
      [ actorId || null, versionId, JSON.stringify({ jobId, itemCount: selectedItems.length, chapterCount: chapters.size }) ]);
      await client.query('COMMIT');
      return { itemCount: selectedItems.length, chapterCount: chapters.size };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  ancestors(node, byId) {
    const result = [];
    const visited = new Set();
    let parentId = node.parentId;
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      result.push(parent);
      parentId = parent.parentId;
    }
    return result;
  }

  chapterNode(ancestors, item) {
    const headings = [ item, ...ancestors ].filter(node => node.kind === 'heading');
    return headings.find(node => node.level === 1)
      || headings[0]
      || item;
  }

  descendantContent(nodeId, children, selection) {
    const parts = [];
    for (const child of children.get(nodeId) || []) {
      if (selection.get(child.id) === 'item') continue;
      if (child.content) parts.push(child.content);
      const nested = this.descendantContent(child.id, children, selection);
      if (nested) parts.push(nested);
    }
    return parts.join('\n');
  }
}

module.exports = StandardImportJobRepository;
