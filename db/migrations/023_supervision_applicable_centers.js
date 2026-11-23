'use strict';

exports.up = pgm => {
  pgm.createTable('supervision_definition_centers', {
    definition_id: { type: 'uuid', notNull: true, references: 'supervision_definitions', onDelete: 'CASCADE' },
    center_name: { type: 'varchar(200)', notNull: true },
  });
  pgm.addConstraint('supervision_definition_centers', 'supervision_definition_centers_pk', {
    primaryKey: [ 'definition_id', 'center_name' ],
  });
  pgm.sql(`
    INSERT INTO supervision_definition_centers (definition_id, center_name)
    SELECT id, btrim(scope)
    FROM supervision_definitions
    WHERE btrim(COALESCE(scope, '')) IN ('云中心', '统一运维中心', '总部')
    ON CONFLICT DO NOTHING;
  `);
  pgm.sql(`
    UPDATE supervision_definitions
    SET scope = NULL, updated_at = now()
    WHERE btrim(COALESCE(scope, '')) IN ('云中心', '统一运维中心', '总部');
  `);
  pgm.addColumn('supervision_executions', {
    supervision_center: { type: 'varchar(200)' },
  });
  pgm.sql(`
    UPDATE supervision_executions e
    SET supervision_center = CASE
      WHEN cc.name ILIKE '%统一运维%' THEN '统一运维中心'
      WHEN cc.name ILIKE '%总部%' THEN '总部'
      ELSE '云中心'
    END
    FROM cloud_centers cc
    WHERE e.cloud_center_id = cc.id;
  `);
  pgm.sql(`
    UPDATE supervision_executions e
    SET supervision_center = centers.center_name
    FROM (
      SELECT definition_id, min(center_name) AS center_name
      FROM supervision_definition_centers
      GROUP BY definition_id
      HAVING count(*) = 1
    ) centers
    WHERE e.definition_id = centers.definition_id AND e.supervision_center IS NULL;
  `);
  pgm.sql('DROP VIEW supervision_definition_candidates');
  pgm.sql(`CREATE VIEW supervision_definition_candidates AS
    SELECT d.id, d.object_name, d.scope, d.recognized_object, d.priority, d.reference_result, d.reference_materials,
           c.scope AS candidate_scope, c.recognized_object AS candidate_recognized_object,
           c.priority AS candidate_priority, c.reference_result AS candidate_reference_result,
           c.reference_materials AS candidate_reference_materials,
           d.object_category, d.check_layer, d.check_method,
           d.description, d.steps, d.frequency, d.access_mode, d.status, d.merged_into_id,
           d.normalized_hash, c.id AS candidate_id,
           c.object_name AS candidate_object_name, c.object_category AS candidate_object_category,
           c.check_layer AS candidate_check_layer, c.check_method AS candidate_check_method,
           c.description AS candidate_description, c.steps AS candidate_steps,
           c.frequency AS candidate_frequency, c.access_mode AS candidate_access_mode,
           c.normalized_hash AS candidate_normalized_hash,
           ARRAY(SELECT center_name FROM supervision_definition_centers WHERE definition_id = d.id ORDER BY center_name) AS centers,
           ARRAY(SELECT center_name FROM supervision_definition_centers WHERE definition_id = c.id ORDER BY center_name) AS candidate_centers,
           ARRAY(SELECT si.item_code FROM supervision_definition_standard_items dsi
             JOIN standard_items si ON si.id = dsi.standard_item_id WHERE dsi.definition_id = d.id ORDER BY si.item_code) AS standard_item_codes,
           ARRAY(SELECT si.item_code FROM supervision_definition_standard_items csi
             JOIN standard_items si ON si.id = csi.standard_item_id WHERE csi.definition_id = c.id ORDER BY si.item_code) AS candidate_standard_item_codes,
           (SELECT count(*)::integer FROM supervision_executions e WHERE e.definition_id = d.id) AS execution_count,
           (SELECT count(*)::integer FROM supervision_executions e WHERE e.definition_id = c.id) AS candidate_execution_count,
           (similarity(d.description, c.description) * 0.5
            + similarity(coalesce(d.steps, ''), coalesce(c.steps, '')) * 0.3
            + similarity(d.check_method, c.check_method) * 0.2) AS similarity_score,
           CASE WHEN d.normalized_hash = c.normalized_hash THEN 'exact_duplicate_candidate' ELSE 'similar_candidate' END AS candidate_type,
           d.created_at
    FROM supervision_definitions d
    JOIN supervision_definitions c ON c.id > d.id
      AND c.status = 'active'
      AND lower(btrim(d.object_name)) = lower(btrim(c.object_name))
      AND (d.normalized_hash = c.normalized_hash OR
        (similarity(d.description, c.description) * 0.5
         + similarity(coalesce(d.steps, ''), coalesce(c.steps, '')) * 0.3
         + similarity(d.check_method, c.check_method) * 0.2) >= 0.35)
      AND coalesce(d.object_category, '') = coalesce(c.object_category, '')
      AND coalesce(d.check_layer, '') = coalesce(c.check_layer, '')
    WHERE d.status = 'active'`);
};

exports.down = pgm => {
  pgm.sql('DROP VIEW IF EXISTS supervision_definition_candidates');
  pgm.sql(`CREATE VIEW supervision_definition_candidates AS
    SELECT d.id, d.object_name, d.scope, d.recognized_object, d.priority, d.reference_result, d.reference_materials,
           c.scope AS candidate_scope, c.recognized_object AS candidate_recognized_object,
           c.priority AS candidate_priority, c.reference_result AS candidate_reference_result,
           c.reference_materials AS candidate_reference_materials,
           d.object_category, d.check_layer, d.check_method,
           d.description, d.steps, d.frequency, d.access_mode, d.status, d.merged_into_id,
           d.normalized_hash, c.id AS candidate_id,
           c.object_name AS candidate_object_name, c.object_category AS candidate_object_category,
           c.check_layer AS candidate_check_layer, c.check_method AS candidate_check_method,
           c.description AS candidate_description, c.steps AS candidate_steps,
           c.frequency AS candidate_frequency, c.access_mode AS candidate_access_mode,
           c.normalized_hash AS candidate_normalized_hash,
           ARRAY(SELECT si.item_code FROM supervision_definition_standard_items dsi
             JOIN standard_items si ON si.id = dsi.standard_item_id WHERE dsi.definition_id = d.id ORDER BY si.item_code) AS standard_item_codes,
           ARRAY(SELECT si.item_code FROM supervision_definition_standard_items csi
             JOIN standard_items si ON si.id = csi.standard_item_id WHERE csi.definition_id = c.id ORDER BY si.item_code) AS candidate_standard_item_codes,
           (SELECT count(*)::integer FROM supervision_executions e WHERE e.definition_id = d.id) AS execution_count,
           (SELECT count(*)::integer FROM supervision_executions e WHERE e.definition_id = c.id) AS candidate_execution_count,
           (similarity(d.description, c.description) * 0.5
            + similarity(coalesce(d.steps, ''), coalesce(c.steps, '')) * 0.3
            + similarity(d.check_method, c.check_method) * 0.2) AS similarity_score,
           CASE WHEN d.normalized_hash = c.normalized_hash THEN 'exact_duplicate_candidate' ELSE 'similar_candidate' END AS candidate_type,
           d.created_at
    FROM supervision_definitions d
    JOIN supervision_definitions c ON c.id > d.id
      AND c.status = 'active'
      AND (d.normalized_hash = c.normalized_hash OR
        (similarity(d.description, c.description) * 0.5
         + similarity(coalesce(d.steps, ''), coalesce(c.steps, '')) * 0.3
         + similarity(d.check_method, c.check_method) * 0.2) >= 0.35)
      AND coalesce(d.object_category, '') = coalesce(c.object_category, '')
      AND coalesce(d.check_layer, '') = coalesce(c.check_layer, '')
    WHERE d.status = 'active'`);
  pgm.dropColumn('supervision_executions', 'supervision_center');
  pgm.dropTable('supervision_definition_centers');
};
