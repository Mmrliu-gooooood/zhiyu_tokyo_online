/**
 * Study tables for legacy self-migrating installs (no hosted roles, schema
 * ensured at provider start like owner_material). Hosted databases get the
 * same tables, plus row security, from accounts v22 (spaces), v23
 * (materials and learning tasks), v24 (retrieval and answers; the chunk
 * table only where the vector and pgroonga extensions can be created) and
 * v25 (classmate templates), v26 (after-class classmate chats), v27
 * (learning events, preferences and Memory controls), v28 (question bank,
 * papers and attempts), v29 (exercise extraction from materials), v30 (open
 * questions and their gradings), v31 (the wrong-answer book), v32 (AI
 * top-ups, variants and practice assistance), v33 (review cards, review
 * settings and Memory summaries) and v34 (explanations on request).
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
import { STUDY_TABLES_SQL_V27 } from '@/lib/server/accounts/sql-study-memory';
import { STUDY_TABLES_SQL_V28 } from '@/lib/server/accounts/sql-study-exams';
import { STUDY_TABLES_SQL_V29 } from '@/lib/server/accounts/sql-study-extraction';
import { STUDY_TABLES_SQL_V30 } from '@/lib/server/accounts/sql-study-grading';
import { STUDY_TABLES_SQL_V31 } from '@/lib/server/accounts/sql-study-wrongbook';
import { STUDY_TABLES_SQL_V32 } from '@/lib/server/accounts/sql-study-practice';
import { STUDY_TABLES_SQL_V33 } from '@/lib/server/accounts/sql-study-review';
import { STUDY_TABLES_SQL_V34 } from '@/lib/server/accounts/sql-study-explanations';

/** Needs the document schema and stage_meta first (foreign keys). */
export async function ensureStudySchema(queryable: Queryable): Promise<void> {
  for (const statement of splitSqlStatements(
    `${STUDY_TABLES_SQL_V22}\n${STUDY_TABLES_SQL_V23}\n${STUDY_TABLES_SQL_V24}\n${STUDY_KNOWLEDGE_STORAGE_LEGACY_SQL_V24}\n${STUDY_TABLES_SQL_V25}\n${STUDY_TABLES_SQL_V26}\n${STUDY_TABLES_SQL_V27}\n${STUDY_TABLES_SQL_V28}\n${STUDY_TABLES_SQL_V29}\n${STUDY_TABLES_SQL_V30}\n${STUDY_TABLES_SQL_V31}\n${STUDY_TABLES_SQL_V32}\n${STUDY_TABLES_SQL_V33}\n${STUDY_TABLES_SQL_V34}`,
  )) {
    await queryable.query(statement);
  }
}
