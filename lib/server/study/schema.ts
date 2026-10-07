/**
 * Study tables for legacy self-migrating installs (no hosted roles, schema
 * ensured at provider start like owner_material). Hosted databases get the
 * same tables, plus row security, from accounts v22 (spaces), v23
 * (materials and learning tasks), v24 (retrieval and answers; the chunk
 * table only where the vector and pgroonga extensions can be created) and
 * v25 (classmate templates) and v26 (after-class classmate chats).
 */
import { splitSqlStatements, type Queryable } from '@openmaic/storage/document/pg';

import { STUDY_TABLES_SQL_V22 } from '@/lib/server/accounts/sql-study-spaces';
import { STUDY_TABLES_SQL_V23 } from '@/lib/server/accounts/sql-study-materials';
import {
  STUDY_KNOWLEDGE_STORAGE_LEGACY_SQL_V24,
  STUDY_TABLES_SQL_V24,
} from '@/lib/server/accounts/sql-study-knowledge';
import { STUDY_TABLES_SQL_V25 } from '@/lib/server/accounts/sql-study-classmates';
import { STUDY_TABLES_SQL_V26 } from '@/lib/server/accounts/sql-study-companion';

/** Needs the document schema and stage_meta first (foreign keys). */
export async function ensureStudySchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(
    `${STUDY_TABLES_SQL_V22}\n${STUDY_TABLES_SQL_V23}\n${STUDY_TABLES_SQL_V24}\n${STUDY_KNOWLEDGE_STORAGE_LEGACY_SQL_V24}\n${STUDY_TABLES_SQL_V25}\n${STUDY_TABLES_SQL_V26}`,
  )) {
    await queryable.query(statement);
  }
}
