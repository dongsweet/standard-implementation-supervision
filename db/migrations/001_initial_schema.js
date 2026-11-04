/* eslint-disable camelcase */
'use strict';

exports.up = pgm => {
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  pgm.sql('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  pgm.createTable('users', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, username: { type: 'varchar(100)', notNull: true, unique: true }, password_hash: { type: 'text', notNull: true }, display_name: { type: 'varchar(200)', notNull: true }, is_active: { type: 'boolean', notNull: true, default: true }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }, updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.createTable('roles', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, code: { type: 'varchar(50)', notNull: true, unique: true }, name: { type: 'varchar(100)', notNull: true }, scope: { type: 'varchar(20)', notNull: true, default: 'global' } });
  pgm.createTable('user_roles', { user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' }, role_id: { type: 'uuid', notNull: true, references: 'roles', onDelete: 'CASCADE' }, project_id: { type: 'uuid' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.createTable('projects', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, code: { type: 'varchar(100)', notNull: true, unique: true }, name: { type: 'varchar(200)', notNull: true }, status: { type: 'varchar(30)', notNull: true, default: 'draft' }, project_manager_id: { type: 'uuid', references: 'users' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }, updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.addConstraint('user_roles', 'user_roles_project_fk', { foreignKeys: { columns: 'project_id', references: 'projects(id)', onDelete: 'CASCADE' } });
  pgm.createIndex('user_roles', [ 'user_id', 'role_id' ], { unique: true, where: 'project_id IS NULL', name: 'user_roles_global_unique' });
  pgm.createIndex('user_roles', [ 'user_id', 'role_id', 'project_id' ], { unique: true, where: 'project_id IS NOT NULL', name: 'user_roles_project_unique' });
  pgm.sql(`INSERT INTO roles (code, name, scope) VALUES
    ('system_admin', '系统管理员', 'global'),
    ('audit_admin', '审计管理员', 'global'),
    ('security_admin', '安全管理员', 'global'),
    ('project_admin', '项目管理员', 'project'),
    ('operator', '操作员', 'project')
    ON CONFLICT (code) DO NOTHING`);
  pgm.createTable('standards', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, code: { type: 'varchar(100)', notNull: true, unique: true }, name: { type: 'varchar(300)', notNull: true }, description: { type: 'text' } });
  pgm.createTable('standard_versions', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, standard_id: { type: 'uuid', notNull: true, references: 'standards', onDelete: 'CASCADE' }, version: { type: 'varchar(100)', notNull: true }, status: { type: 'varchar(20)', notNull: true, default: 'draft' }, published_at: { type: 'timestamptz' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.addConstraint('standard_versions', 'standard_versions_unique', { unique: [ 'standard_id', 'version' ] });
  pgm.createTable('standard_chapters', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, standard_version_id: { type: 'uuid', notNull: true, references: 'standard_versions', onDelete: 'CASCADE' }, code: { type: 'varchar(100)', notNull: true }, name: { type: 'varchar(300)', notNull: true }, sort_order: { type: 'integer', notNull: true, default: 0 } });
  pgm.createTable('standard_items', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, standard_version_id: { type: 'uuid', notNull: true, references: 'standard_versions', onDelete: 'CASCADE' }, chapter_id: { type: 'uuid', notNull: true, references: 'standard_chapters', onDelete: 'CASCADE' }, item_code: { type: 'varchar(100)', notNull: true }, title: { type: 'varchar(500)' }, content: { type: 'text', notNull: true }, level: { type: 'varchar(100)' }, is_key: { type: 'boolean', notNull: true, default: false }, metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") } });
  pgm.addConstraint('standard_items', 'standard_items_unique', { unique: [ 'standard_version_id', 'item_code' ] });
  pgm.createTable('project_standard_versions', { project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' }, standard_version_id: { type: 'uuid', notNull: true, references: 'standard_versions' }, snapshot_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.addConstraint('project_standard_versions', 'project_standard_versions_pk', { primaryKey: [ 'project_id', 'standard_version_id' ] });
  pgm.createTable('project_standard_items', { project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' }, standard_item_id: { type: 'uuid', notNull: true, references: 'standard_items' }, item_code_snapshot: { type: 'varchar(100)', notNull: true }, content_snapshot: { type: 'text', notNull: true }, chapter_code_snapshot: { type: 'varchar(100)', notNull: true }, snapshotted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.addConstraint('project_standard_items', 'project_standard_items_pk', { primaryKey: [ 'project_id', 'standard_item_id' ] });
  pgm.createTable('chapter_responsibilities', { project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' }, chapter_id: { type: 'uuid', notNull: true, references: 'standard_chapters', onDelete: 'CASCADE' }, user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' }, assigned_by: { type: 'uuid', references: 'users' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.addConstraint('chapter_responsibilities', 'chapter_responsibilities_pk', { primaryKey: [ 'project_id', 'chapter_id', 'user_id' ] });
  pgm.createTable('cloud_centers', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, code: { type: 'varchar(100)', notNull: true, unique: true }, name: { type: 'varchar(200)', notNull: true }, center_type: { type: 'varchar(50)' }, metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") } });
  pgm.createTable('project_cloud_centers', { project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' }, cloud_center_id: { type: 'uuid', notNull: true, references: 'cloud_centers' }, owner_user_id: { type: 'uuid', references: 'users' } });
  pgm.addConstraint('project_cloud_centers', 'project_cloud_centers_pk', { primaryKey: [ 'project_id', 'cloud_center_id' ] });
  pgm.createTable('standard_provider_assignments', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, standard_item_id: { type: 'uuid', notNull: true, references: 'standard_items', onDelete: 'CASCADE' }, provider_name: { type: 'varchar(200)', notNull: true }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.addConstraint('standard_provider_assignments', 'standard_provider_assignments_unique', { unique: [ 'standard_item_id', 'provider_name' ] });
  pgm.createTable('standard_item_requirements', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, standard_item_id: { type: 'uuid', notNull: true, references: 'standard_items', onDelete: 'CASCADE' }, unified_requirement: { type: 'text', notNull: true }, implementation_evidence: { type: 'text' }, sort_order: { type: 'integer', notNull: true, default: 0 } });
  pgm.createTable('project_standard_answers', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' }, standard_item_id: { type: 'uuid', notNull: true, references: 'standard_items' }, cloud_center_id: { type: 'uuid', references: 'cloud_centers' }, status: { type: 'varchar(30)', notNull: true, default: 'unassessed' }, measure_description: { type: 'text' }, problem_description: { type: 'text' }, owner_user_id: { type: 'uuid', references: 'users' }, updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.createIndex('project_standard_answers', [ 'project_id', 'standard_item_id' ], { unique: true, where: 'cloud_center_id IS NULL', name: 'project_standard_answers_global_unique' });
  pgm.createIndex('project_standard_answers', [ 'project_id', 'standard_item_id', 'cloud_center_id' ], { unique: true, where: 'cloud_center_id IS NOT NULL', name: 'project_standard_answers_center_unique' });
  pgm.createTable('evidence_materials', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, project_id: { type: 'uuid', references: 'projects', onDelete: 'CASCADE' }, code: { type: 'varchar(100)' }, name: { type: 'varchar(500)', notNull: true }, storage_key: { type: 'text' }, source_url: { type: 'text' }, content_hash: { type: 'varchar(128)' }, metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") }, created_by: { type: 'uuid', references: 'users' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.createTable('answer_evidence', { answer_id: { type: 'uuid', notNull: true, references: 'project_standard_answers', onDelete: 'CASCADE' }, evidence_id: { type: 'uuid', notNull: true, references: 'evidence_materials', onDelete: 'CASCADE' } });
  pgm.addConstraint('answer_evidence', 'answer_evidence_pk', { primaryKey: [ 'answer_id', 'evidence_id' ] });
  pgm.createTable('supervision_definitions', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, object_name: { type: 'text', notNull: true }, object_category: { type: 'varchar(200)' }, check_layer: { type: 'varchar(200)' }, check_method: { type: 'text', notNull: true }, description: { type: 'text', notNull: true }, steps: { type: 'text' }, frequency: { type: 'varchar(100)' }, access_mode: { type: 'varchar(50)' }, normalized_hash: { type: 'varchar(64)', notNull: true }, status: { type: 'varchar(30)', notNull: true, default: 'active' }, merged_into_id: { type: 'uuid', references: 'supervision_definitions' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }, updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.createIndex('supervision_definitions', 'normalized_hash');
  pgm.createIndex('supervision_definitions', [ 'object_category', 'check_layer', 'check_method' ]);
  pgm.sql('CREATE INDEX supervision_definitions_description_trgm_idx ON supervision_definitions USING gin (description gin_trgm_ops)');
  pgm.sql('CREATE INDEX supervision_definitions_check_method_trgm_idx ON supervision_definitions USING gin (check_method gin_trgm_ops)');
  pgm.sql('CREATE INDEX supervision_definitions_steps_trgm_idx ON supervision_definitions USING gin (steps gin_trgm_ops)');
  pgm.createTable('supervision_definition_standard_items', { definition_id: { type: 'uuid', notNull: true, references: 'supervision_definitions', onDelete: 'CASCADE' }, standard_item_id: { type: 'uuid', notNull: true, references: 'standard_items' } });
  pgm.addConstraint('supervision_definition_standard_items', 'supervision_definition_standard_items_pk', { primaryKey: [ 'definition_id', 'standard_item_id' ] });
  pgm.createTable('supervision_executions', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' }, cloud_center_id: { type: 'uuid', references: 'cloud_centers' }, definition_id: { type: 'uuid', notNull: true, references: 'supervision_definitions' }, checked_at: { type: 'timestamptz', notNull: true }, checked_by: { type: 'uuid', references: 'users' }, overall_result: { type: 'varchar(30)' }, notes: { type: 'text' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.createTable('supervision_item_results', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, execution_id: { type: 'uuid', notNull: true, references: 'supervision_executions', onDelete: 'CASCADE' }, standard_item_id: { type: 'uuid', notNull: true, references: 'standard_items' }, result: { type: 'varchar(30)', notNull: true, default: 'unassessed' }, description: { type: 'text' }, problem_description: { type: 'text' }, rectification_due_at: { type: 'timestamptz' }, review_status: { type: 'varchar(30)', notNull: true, default: 'pending' } });
  pgm.addConstraint('supervision_item_results', 'supervision_item_results_unique', { unique: [ 'execution_id', 'standard_item_id' ] });
  pgm.createTable('result_evidence', { result_id: { type: 'uuid', notNull: true, references: 'supervision_item_results', onDelete: 'CASCADE' }, evidence_id: { type: 'uuid', notNull: true, references: 'evidence_materials', onDelete: 'CASCADE' } });
  pgm.addConstraint('result_evidence', 'result_evidence_pk', { primaryKey: [ 'result_id', 'evidence_id' ] });
  pgm.createTable('supervision_definition_reviews', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, left_definition_id: { type: 'uuid', notNull: true, references: 'supervision_definitions' }, right_definition_id: { type: 'uuid', notNull: true, references: 'supervision_definitions' }, decision: { type: 'varchar(40)', notNull: true }, canonical_definition_id: { type: 'uuid', references: 'supervision_definitions' }, reviewer_id: { type: 'uuid', references: 'users' }, notes: { type: 'text' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.createTable('ai_dedupe_jobs', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, left_definition_id: { type: 'uuid', notNull: true, references: 'supervision_definitions' }, right_definition_id: { type: 'uuid', notNull: true, references: 'supervision_definitions' }, input_hash: { type: 'varchar(64)', notNull: true }, algorithm_version: { type: 'varchar(50)', notNull: true }, prompt_version: { type: 'varchar(50)' }, model_name: { type: 'varchar(200)' }, status: { type: 'varchar(30)', notNull: true, default: 'pending' }, provider_status: { type: 'integer' }, duration_ms: { type: 'integer' }, attempt_count: { type: 'integer', notNull: true, default: 0 }, result: { type: 'jsonb' }, error_message: { type: 'text' }, started_at: { type: 'timestamptz' }, completed_at: { type: 'timestamptz' }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.createIndex('ai_dedupe_jobs', [ 'input_hash', 'model_name', 'prompt_version' ], { unique: true });
  pgm.createTable('audit_logs', { id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') }, actor_user_id: { type: 'uuid', references: 'users' }, action: { type: 'varchar(100)', notNull: true }, entity_type: { type: 'varchar(100)', notNull: true }, entity_id: { type: 'uuid' }, metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") }, created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.sql(`CREATE VIEW supervision_definition_candidates AS
    SELECT d.id, d.object_name, d.object_category, d.check_layer, d.check_method,
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
};

exports.down = pgm => {
  pgm.sql('DROP VIEW IF EXISTS supervision_definition_candidates');
  [ 'audit_logs', 'ai_dedupe_jobs', 'supervision_definition_reviews', 'result_evidence', 'supervision_item_results', 'supervision_executions', 'supervision_definition_standard_items', 'supervision_definitions', 'answer_evidence', 'evidence_materials', 'project_standard_answers', 'standard_item_requirements', 'standard_provider_assignments', 'project_cloud_centers', 'cloud_centers', 'chapter_responsibilities', 'project_standard_items', 'project_standard_versions', 'standard_items', 'standard_chapters', 'standard_versions', 'standards', 'projects', 'user_roles', 'roles', 'users' ].forEach(table => pgm.dropTable(table, { ifExists: true, cascade: true }));
  pgm.sql('DROP EXTENSION IF EXISTS pg_trgm');
  pgm.sql('DROP EXTENSION IF EXISTS pgcrypto');
};
