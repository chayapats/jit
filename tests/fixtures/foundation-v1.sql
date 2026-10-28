-- Frozen APP01 schema from25c5778fb68c0c99827bf7753c0a3c267931ce43; do not regenerate from current migrations.

            CREATE TABLE owner (
              id TEXT PRIMARY KEY CHECK (id = 'owner'), password_hash TEXT NOT NULL,
              generation INTEGER NOT NULL CHECK (generation > 0)
            );
            CREATE TABLE sessions (
              token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
              generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE TABLE login_throttle (
              id INTEGER PRIMARY KEY CHECK (id = 1), window_start INTEGER NOT NULL,
              attempts INTEGER NOT NULL CHECK (attempts >= 0)
            );
            CREATE TABLE app_state (
              id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
            );
            INSERT INTO app_state VALUES (1, 0);
            CREATE TABLE projects (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE project_groups (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id)
            );
            CREATE TABLE command_receipts (
              actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
              result_json TEXT NOT NULL, committed_at INTEGER NOT NULL,
              PRIMARY KEY (actor_id, request_id)
            );
            CREATE TABLE audit (
              id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, command_kind TEXT NOT NULL,
              request_id TEXT NOT NULL, project_id TEXT NOT NULL, committed_at INTEGER NOT NULL,
              UNIQUE (actor_id, request_id)
            );
            PRAGMA user_version = 1;
