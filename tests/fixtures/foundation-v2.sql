-- Frozen v2 schema from integration dfd966a; no owner or installation data.
CREATE TABLE app_state (
              id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
            );
CREATE TABLE audit (
              id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, command_kind TEXT NOT NULL,
              request_id TEXT NOT NULL, project_id TEXT NOT NULL, committed_at INTEGER NOT NULL,
              UNIQUE (actor_id, request_id)
            );
CREATE TABLE command_receipts (
              actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
              result_json TEXT NOT NULL, committed_at INTEGER NOT NULL,
              PRIMARY KEY (actor_id, request_id)
            );
CREATE TABLE login_throttle (
              id INTEGER PRIMARY KEY CHECK (id = 1), window_start INTEGER NOT NULL,
              attempts INTEGER NOT NULL CHECK (attempts >= 0)
            );
CREATE TABLE messages (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, topic_id TEXT NOT NULL,
              sequence INTEGER NOT NULL CHECK (sequence > 0), committed_at INTEGER NOT NULL,
              attribution_json TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
              source_revision INTEGER NOT NULL, source_generation INTEGER NOT NULL,
              UNIQUE (project_id, topic_id, sequence),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id),
              FOREIGN KEY (project_id, source_id) REFERENCES sources(project_id, id),
              FOREIGN KEY (source_id, source_revision, source_generation) REFERENCES source_versions(source_id, revision, generation)
            );
CREATE TABLE owner (
              id TEXT PRIMARY KEY CHECK (id = 'owner'), password_hash TEXT NOT NULL,
              generation INTEGER NOT NULL CHECK (generation > 0)
            );
CREATE TABLE project_groups (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id)
            );
CREATE TABLE projects (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL,
              created_at INTEGER NOT NULL
            );
CREATE TABLE sessions (
              token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
              generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
            );
CREATE TABLE source_versions (
              source_id TEXT NOT NULL REFERENCES sources(id), revision INTEGER NOT NULL CHECK (revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0), descriptor_json TEXT NOT NULL,
              attribution_json TEXT NOT NULL, content_text TEXT, committed_at INTEGER NOT NULL,
              PRIMARY KEY (source_id, revision, generation)
            );
CREATE TABLE sources (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              kind TEXT NOT NULL CHECK (kind IN ('topic', 'message', 'output', 'external')),
              current_revision INTEGER NOT NULL CHECK (current_revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0),
              availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
              UNIQUE (project_id, id)
            );
CREATE TABLE topics (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0), sequence INTEGER NOT NULL CHECK (sequence > 0),
              message_sequence INTEGER NOT NULL CHECK (message_sequence >= 0), created_at INTEGER NOT NULL,
              attribution_json TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
              source_revision INTEGER NOT NULL, source_generation INTEGER NOT NULL,
              UNIQUE (project_id, id), UNIQUE (project_id, sequence),
              FOREIGN KEY (project_id, group_id) REFERENCES project_groups(project_id, id),
              FOREIGN KEY (project_id, source_id) REFERENCES sources(project_id, id),
              FOREIGN KEY (source_id, source_revision, source_generation) REFERENCES source_versions(source_id, revision, generation)
            );
CREATE UNIQUE INDEX project_group_identity ON project_groups(project_id, id);
INSERT INTO app_state VALUES (1, 0);
PRAGMA user_version = 2;
