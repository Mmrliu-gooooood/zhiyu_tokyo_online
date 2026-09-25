/** Pinned PostgreSQL schema shared by the hosted migration and runtime store. */
export const PRO_MODEL_CONNECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS pro_model_connections (
  id UUID PRIMARY KEY, owner_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
  revoked BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pro_model_connections_owner ON pro_model_connections(owner_id);
CREATE TABLE IF NOT EXISTS pro_model_connection_revisions (
  connection_id UUID NOT NULL REFERENCES pro_model_connections(id),
  revision INTEGER NOT NULL CHECK (revision > 0), ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(connection_id, revision)
);`;
