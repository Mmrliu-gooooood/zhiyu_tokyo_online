/**
 * v22: study spaces and server-side course progress (learning plan B01).
 *
 * - study_spaces: one long-lived subject space ("高数", "数据结构") per row,
 *   with an optional goal, exam date and exam scope. `revision` guards edits
 *   against stale tabs and devices.
 * - study_space_courses: links an owner's existing course (Stage) to a space.
 *   A course may sit in several of the same owner's spaces; removing a link or
 *   deleting a space never deletes the course. The composite foreign key keeps
 *   a link's owner equal to its space's owner.
 * - study_progress: the owner's last viewing position in a course (scene,
 *   action, scene revision at write time) plus monotonic viewing facts
 *   (furthest scene, reached the end). It records watching, never mastery.
 *
 * Owner isolation: web reads and writes are owner-bound (app.owner_id). Links
 * and progress additionally require, at write time, that the course is the
 * owner's live course (stage_meta), so even a buggy caller cannot attach a
 * foreign course. Workers have no access. Account deletion runs as the
 * migration administrator.
 *
 * STUDY_TABLES_SQL_V22 is frozen with this migration's checksum. Legacy
 * self-migrating installs (no hosted roles) apply the same table text via
 * `ensureStudySchema`; later changes belong in a new migration whose table
 * part is appended there too.
 */
export const STUDY_TABLES_SQL_V22 = `
CREATE TABLE IF NOT EXISTS study_spaces (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  owner_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  education_level text CHECK (
    education_level IS NULL
    OR education_level IN ('primary', 'junior', 'senior', 'university', 'other')
  ),
  subject text CHECK (subject IS NULL OR char_length(subject) <= 60),
  goal text CHECK (goal IS NULL OR char_length(goal) <= 500),
  exam_date date,
  exam_scope text CHECK (exam_scope IS NULL OR char_length(exam_scope) <= 2000),
  timezone text CHECK (timezone IS NULL OR char_length(timezone) <= 64),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CONSTRAINT study_spaces_archived_at CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT study_spaces_owner_id_key UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS study_spaces_owner_updated
  ON study_spaces (owner_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS study_space_courses (
  owner_id text NOT NULL,
  space_id text NOT NULL,
  stage_id text NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  added_via text NOT NULL DEFAULT 'link' CHECK (added_via IN ('link', 'generation')),
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, space_id, stage_id),
  CONSTRAINT study_space_courses_space_fk FOREIGN KEY (owner_id, space_id)
    REFERENCES study_spaces (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_space_courses_owner_stage
  ON study_space_courses (owner_id, stage_id);

CREATE TABLE IF NOT EXISTS study_progress (
  owner_id text NOT NULL,
  stage_id text NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  scene_id text NOT NULL CHECK (length(scene_id) BETWEEN 1 AND 200),
  scene_index integer NOT NULL CHECK (scene_index >= 0),
  scene_count integer NOT NULL CHECK (scene_count > scene_index),
  action_index integer NOT NULL CHECK (action_index >= 0),
  action_count integer NOT NULL CHECK (action_count >= 0 AND action_index <= action_count),
  action_id text CHECK (action_id IS NULL OR length(action_id) <= 200),
  scene_revision bigint NOT NULL DEFAULT 0,
  furthest_scene_index integer NOT NULL CHECK (furthest_scene_index >= scene_index),
  reached_end_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  observed_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, stage_id)
);
CREATE INDEX IF NOT EXISTS study_progress_owner_updated
  ON study_progress (owner_id, updated_at DESC);
`;

export const ACCOUNTS_MIGRATION_22 = `${STUDY_TABLES_SQL_V22}
DO $study_spaces_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['study_spaces', 'study_space_courses', 'study_progress']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
  END LOOP;
END
$study_spaces_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.study_spaces, public.study_space_courses, public.study_progress TO app_web;

DROP POLICY IF EXISTS study_spaces_web_all ON public.study_spaces;
CREATE POLICY study_spaces_web_all ON public.study_spaces
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_space_courses_web_all ON public.study_space_courses;
CREATE POLICY study_space_courses_web_all ON public.study_space_courses
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (
    owner_id = app_internal.current_owner_id()
    AND EXISTS (
      SELECT 1 FROM public.stage_meta m
      WHERE m.stage_id = study_space_courses.stage_id
        AND m.owner_id = app_internal.current_owner_id()
        AND m.deleted_at IS NULL
    )
  );

DROP POLICY IF EXISTS study_progress_web_all ON public.study_progress;
CREATE POLICY study_progress_web_all ON public.study_progress
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (
    owner_id = app_internal.current_owner_id()
    AND EXISTS (
      SELECT 1 FROM public.stage_meta m
      WHERE m.stage_id = study_progress.stage_id
        AND m.owner_id = app_internal.current_owner_id()
        AND m.deleted_at IS NULL
    )
  );
`;
