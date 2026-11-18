'use strict';

const { Pool } = require('pg');
const { buildAssignmentForm, normalizeDetails } = require('../app/lib/answerAssignment');

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/security_supervision',
  });
  try {
    const result = await pool.query(`
      SELECT psa.id, psi.item_code_snapshot, psa.clause_assignment,
             psa.assignment_details, psi.explanation_snapshot, psi.content_snapshot
      FROM project_standard_answers psa
      JOIN project_standard_items psi
        ON psi.project_id = psa.project_id
       AND psi.standard_item_id = psa.standard_item_id
      WHERE psa.cloud_center_id IS NULL
        AND psa.clause_assignment ILIKE '%未选中%'
      ORDER BY psi.item_code_snapshot`);
    const changed = [];
    for (const row of result.rows) {
      const source = [ row.explanation_snapshot, row.content_snapshot ].filter(Boolean).join('\n');
      const form = buildAssignmentForm(source, []);
      if (!form.hasStructuredControls) continue;
      const normalized = normalizeDetails(row.assignment_details || [], source);
      if (normalized.clauseAssignment === (row.clause_assignment || '')
        && JSON.stringify(normalized.details) === JSON.stringify(row.assignment_details || [])) {
        continue;
      }
      changed.push({
        id: row.id,
        itemCode: row.item_code_snapshot,
        before: row.clause_assignment,
        after: normalized.clauseAssignment,
        details: normalized.details,
      });
      if (apply) {
        await pool.query(`
          UPDATE project_standard_answers
          SET clause_assignment = $2, assignment_details = $3::jsonb, updated_at = now()
          WHERE id = $1`, [ row.id, normalized.clauseAssignment || null, JSON.stringify(normalized.details) ]);
      }
    }
    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      scanned: result.rowCount,
      changed: changed.length,
      rows: changed.map(row => ({
        itemCode: row.itemCode,
        before: row.before,
        after: row.after,
        containsUnselected: String(row.after || '').includes('未选中'),
      })),
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
