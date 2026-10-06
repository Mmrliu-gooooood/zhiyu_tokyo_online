/**
 * v25: classmate templates (learning plan B04).
 *
 * - study_classmates: the student's current template (name, role, persona,
 *   companion style, speaking rule, avatar, color, voice). `revision` guards
 *   edits from stale tabs and devices; archiving keeps the row.
 * - study_classmate_revisions: an immutable snapshot of every saved revision.
 *   A classroom stores a copy of one revision under the agent id
 *   `<classmateId>-r<revision>`; the chat routes read the speaking rule of
 *   that exact revision here, and the course generator for Pro sessions reads
 *   the snapshot it copies. Web may only insert and read (never rewrite).
 * - study_classmate_materials: which of the owner's library materials the
 *   classmate may draw on (used by after-class chat, B05). Composite foreign
 *   keys keep a link's owner equal to both its classmate's and its material's
 *   owner; deleting a material drops the link.
 * - study_classmate_avatars: small uploaded avatars (already resized by the
 *   browser), served only to their owner. Rows are never rewritten, so a
 *   classroom that copied an avatar URL keeps showing the same picture.
 *
 * Owner isolation: web reads and writes are owner-bound (app.owner_id). The
 * generation worker runs Pro sessions and may read templates and revisions;
 * like the other worker grants its queries name the owner explicitly. Account
 * deletion runs as the migration administrator.
 *
 * STUDY_TABLES_SQL_V25 is frozen with this migration's checksum. Legacy
 * self-migrating installs apply the same table text via `ensureStudySchema`.
 */
export const STUDY_CLASSMATE_TABLES = [
  'study_classmates',
  'study_classmate_revisions',
  'study_classmate_materials',
  'study_classmate_avatars',
] as const;

export const STUDY_TABLES_SQL_V25 = `
CREATE TABLE IF NOT EXISTS study_classmates (
  id text PRIMARY KEY CHECK (id ~ '^cm-[0-9a-f]{16}$'),
  owner_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  role text NOT NULL CHECK (role IN ('assistant', 'student')),
  persona text NOT NULL DEFAULT '' CHECK (char_length(persona) <= 2000),
  learning_style text NOT NULL CHECK (
    learning_style IN ('encouraging', 'socratic', 'peer', 'summarizer')
  ),
  speech_policy text NOT NULL CHECK (speech_policy IN ('active', 'on_demand')),
  avatar text NOT NULL CHECK (char_length(avatar) BETWEEN 1 AND 200),
  color text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  voice jsonb CHECK (voice IS NULL OR jsonb_typeof(voice) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  import_key text CHECK (import_key IS NULL OR import_key ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  CONSTRAINT study_classmates_archived_at CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT study_classmates_owner_id_key UNIQUE (owner_id, id)
);
CREATE INDEX IF NOT EXISTS study_classmates_owner_updated
  ON study_classmates (owner_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS study_classmates_owner_import
  ON study_classmates (owner_id, import_key) WHERE import_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS study_classmate_revisions (
  owner_id text NOT NULL,
  classmate_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, classmate_id, revision),
  CONSTRAINT study_classmate_revisions_classmate_fk FOREIGN KEY (owner_id, classmate_id)
    REFERENCES study_classmates (owner_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_classmate_materials (
  owner_id text NOT NULL,
  classmate_id text NOT NULL,
  material_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_id, classmate_id, material_id),
  CONSTRAINT study_classmate_materials_classmate_fk FOREIGN KEY (owner_id, classmate_id)
    REFERENCES study_classmates (owner_id, id) ON DELETE CASCADE,
  CONSTRAINT study_classmate_materials_material_fk FOREIGN KEY (owner_id, material_id)
    REFERENCES study_materials (owner_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS study_classmate_materials_owner_material
  ON study_classmate_materials (owner_id, material_id);

CREATE TABLE IF NOT EXISTS study_classmate_avatars (
  id text PRIMARY KEY CHECK (id ~ '^av-[0-9a-f]{16}$'),
  owner_id text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 98304),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT study_classmate_avatars_owner_sha UNIQUE (owner_id, sha256)
);
`;

export const ACCOUNTS_MIGRATION_25 = `${STUDY_TABLES_SQL_V25}
DO $study_classmates_rls$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[${STUDY_CLASSMATE_TABLES.map((table) => `'${table}'`).join(', ')}]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
  END LOOP;
END
$study_classmates_rls$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.study_classmates, public.study_classmate_materials TO app_web;
GRANT SELECT, INSERT ON TABLE
  public.study_classmate_revisions, public.study_classmate_avatars TO app_web;
GRANT SELECT ON TABLE public.study_classmates, public.study_classmate_revisions TO app_worker;

DROP POLICY IF EXISTS study_classmates_web_all ON public.study_classmates;
CREATE POLICY study_classmates_web_all ON public.study_classmates
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_classmate_revisions_web_select ON public.study_classmate_revisions;
CREATE POLICY study_classmate_revisions_web_select ON public.study_classmate_revisions
  FOR SELECT TO app_web
  USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_classmate_revisions_web_insert ON public.study_classmate_revisions;
CREATE POLICY study_classmate_revisions_web_insert ON public.study_classmate_revisions
  FOR INSERT TO app_web
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_classmate_materials_web_all ON public.study_classmate_materials;
CREATE POLICY study_classmate_materials_web_all ON public.study_classmate_materials
  FOR ALL TO app_web
  USING (owner_id = app_internal.current_owner_id())
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_classmate_avatars_web_select ON public.study_classmate_avatars;
CREATE POLICY study_classmate_avatars_web_select ON public.study_classmate_avatars
  FOR SELECT TO app_web
  USING (owner_id = app_internal.current_owner_id());
DROP POLICY IF EXISTS study_classmate_avatars_web_insert ON public.study_classmate_avatars;
CREATE POLICY study_classmate_avatars_web_insert ON public.study_classmate_avatars
  FOR INSERT TO app_web
  WITH CHECK (owner_id = app_internal.current_owner_id());

DROP POLICY IF EXISTS study_classmates_worker_select ON public.study_classmates;
CREATE POLICY study_classmates_worker_select ON public.study_classmates
  FOR SELECT TO app_worker USING (true);
DROP POLICY IF EXISTS study_classmate_revisions_worker_select ON public.study_classmate_revisions;
CREATE POLICY study_classmate_revisions_worker_select ON public.study_classmate_revisions
  FOR SELECT TO app_worker USING (true);
`;
