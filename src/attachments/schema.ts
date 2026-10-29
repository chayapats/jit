/** Schema 41: rebuild the source CHECK without renaming referenced tables; file content never enters SQLite. */
export const attachmentSchema = `
  CREATE TEMP TABLE sources_copy AS SELECT rowid AS source_rowid, * FROM sources;
  DROP TABLE sources;
  CREATE TABLE sources (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL CHECK (kind IN ('topic', 'message', 'output', 'external', 'attachment')),
    current_revision INTEGER NOT NULL CHECK (current_revision > 0), generation INTEGER NOT NULL CHECK (generation > 0),
    availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')), UNIQUE (project_id, id)
  );
  INSERT INTO sources (rowid, id, project_id, kind, current_revision, generation, availability)
    SELECT source_rowid, id, project_id, kind, current_revision, generation, availability FROM temp.sources_copy;
  DROP TABLE temp.sources_copy;
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, topic_id TEXT NOT NULL, message_id TEXT REFERENCES messages(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'rejected', 'deleted')),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
    media_type TEXT NOT NULL, display_name TEXT, bytes INTEGER NOT NULL CHECK (bytes >= 0), sha256 TEXT,
    sanitized_by TEXT CHECK (sanitized_by IN ('container', 'service', 'fallback')),
    clean_sha256 TEXT, clean_media_type TEXT, clean_bytes INTEGER, model_sha256 TEXT, model_bytes INTEGER,
    text_sha256 TEXT, text_bytes INTEGER, text_truncated INTEGER NOT NULL DEFAULT 0 CHECK (text_truncated IN (0, 1)),
    reason TEXT, sanitize_attempts INTEGER NOT NULL DEFAULT 0 CHECK (sanitize_attempts BETWEEN 0 AND 2),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, bound_at INTEGER, deleted_at INTEGER,
    FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
  );
  CREATE INDEX IF NOT EXISTS attachments_topic ON attachments(project_id, topic_id, created_at);
  CREATE INDEX IF NOT EXISTS attachments_staged ON attachments(created_at) WHERE message_id IS NULL AND state != 'deleted';
  CREATE INDEX IF NOT EXISTS attachments_pending ON attachments(created_at) WHERE state = 'pending';
  CREATE INDEX IF NOT EXISTS attachments_blobs ON attachments(project_id, sha256) WHERE state != 'deleted';
  CREATE TABLE IF NOT EXISTS attachment_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id), attachment_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('upload', 'reject', 'sanitize', 'bind', 'download', 'send_model', 'read', 'outbound_block', 'box_copy', 'box_remove', 'delete')),
    status TEXT NOT NULL CHECK (status IN ('ok', 'refused', 'failed')), reason TEXT, run_id TEXT, job_id TEXT, route TEXT, bytes INTEGER,
    detail_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attachment_events_project ON attachment_events(project_id, sequence DESC);
  PRAGMA user_version = 41;
`;
