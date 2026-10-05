/**
 * Study tables for legacy self-migrating installs (no hosted roles, schema
 * ensured at provider start like owner_material). Hosted databases get the
 * same tables, plus row security, from accounts v22 (spaces) and v23
 * (materials and learning tasks).
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

import { STUDY_TABLES_SQL_V22 } from '@/lib/server/accounts/sql-study-spaces';
import { STUDY_TABLES_SQL_V23 } from '@/lib/server/accounts/sql-study-materials';

/** Needs the document schema and stage_meta first (foreign keys). */
export async function ensureStudySchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(`${STUDY_TABLES_SQL_V22}\n${STUDY_TABLES_SQL_V23}`)) {
    await queryable.query(statement);
  }
}
