-- Frozen empty schema from f262c5ffbdaac3e350359320d8d35b466ede48d6 (TASK02). No installation data.
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
CREATE UNIQUE INDEX project_group_identity ON project_groups(project_id, id);
CREATE TABLE sources (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              kind TEXT NOT NULL CHECK (kind IN ('topic', 'message', 'output', 'external')),
              current_revision INTEGER NOT NULL CHECK (current_revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0),
              availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
              UNIQUE (project_id, id)
            );
CREATE TABLE source_versions (
              source_id TEXT NOT NULL REFERENCES sources(id), revision INTEGER NOT NULL CHECK (revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0), descriptor_json TEXT NOT NULL,
              attribution_json TEXT NOT NULL, content_text TEXT, committed_at INTEGER NOT NULL,
              PRIMARY KEY (source_id, revision, generation)
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
CREATE TABLE job_scheduler (
              id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL,
              pid INTEGER NOT NULL CHECK (pid > 0)
            );
CREATE TABLE jobs (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id),
              queue_order INTEGER NOT NULL, priority INTEGER NOT NULL CHECK (priority IN (0, 1)),
              state TEXT NOT NULL, occupies INTEGER NOT NULL CHECK (occupies IN (0, 1)),
              route_key TEXT NOT NULL, record_json TEXT NOT NULL
            );
CREATE INDEX job_admission ON jobs(state, priority DESC, queue_order);
CREATE INDEX job_project ON jobs(project_id, sequence);
CREATE UNIQUE INDEX job_queue_order ON jobs(queue_order);
CREATE INDEX job_slots ON jobs(route_key) WHERE occupies = 1;
CREATE TABLE team_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, route_json TEXT);
CREATE TABLE roles (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL);
CREATE TABLE project_team (project_id TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL, route_json TEXT, overrides_json TEXT NOT NULL);
CREATE TABLE team_contexts (id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK (generation > 0), state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'delete_failed', 'deleted')));
CREATE TABLE team_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), context_id TEXT NOT NULL UNIQUE REFERENCES team_contexts(id), record_json TEXT NOT NULL);
CREATE INDEX team_run_project ON team_runs(project_id, sequence);
CREATE TABLE job_authority (job_id TEXT PRIMARY KEY REFERENCES jobs(id), generation INTEGER NOT NULL, reason TEXT, stop_json TEXT);
CREATE TABLE job_attempts (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL REFERENCES jobs(id), record_json TEXT NOT NULL);
CREATE INDEX job_attempt_job ON job_attempts(job_id, sequence);
CREATE TABLE job_reconciliation (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE telegram_binding (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              state TEXT NOT NULL CHECK (state IN ('unbound', 'pending', 'bound')),
              telegram_user_id INTEGER, telegram_chat_id INTEGER,
              username_hint TEXT, challenge_nonce TEXT, challenge_expires_at INTEGER,
              bound_at INTEGER, proof_json TEXT NOT NULL
            );
CREATE TABLE telegram_poll (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              next_offset INTEGER NOT NULL CHECK (next_offset >= 0),
              last_poll_at INTEGER, last_update_id INTEGER,
              gap_state TEXT NOT NULL CHECK (gap_state IN ('none', 'possible_missing_inputs')),
              gap_noticed_at INTEGER, gap_reason TEXT
            );
CREATE TABLE telegram_inbox (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              update_id INTEGER NOT NULL UNIQUE,
              telegram_user_id INTEGER, telegram_chat_id INTEGER,
              message_id INTEGER, callback_id TEXT,
              content_kind TEXT NOT NULL,
              classification TEXT NOT NULL,
              binding_revision INTEGER NOT NULL,
              text_content TEXT, raw_json TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('persisted', 'processing', 'processed', 'failed')),
              failure_reason TEXT,
              process_attempts INTEGER NOT NULL CHECK (process_attempts >= 0),
              committed_at INTEGER NOT NULL,
              processed_at INTEGER
            );
CREATE INDEX telegram_inbox_status ON telegram_inbox(status, sequence);
CREATE INDEX telegram_inbox_class ON telegram_inbox(classification, sequence);
CREATE TABLE delivery_reports (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), record_json TEXT NOT NULL
            );
CREATE INDEX delivery_report_project ON delivery_reports(project_id);
CREATE TABLE delivery_intents (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, dedupe_key TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), record_json TEXT NOT NULL
            );
CREATE INDEX delivery_intent_project ON delivery_intents(project_id, sequence);
CREATE TABLE delivery_attempts (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              intent_id TEXT NOT NULL REFERENCES delivery_intents(id), record_json TEXT NOT NULL
            );
CREATE INDEX delivery_attempt_intent ON delivery_attempts(intent_id, sequence);
CREATE TABLE delivery_worker (
              id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, pid INTEGER NOT NULL CHECK (pid > 0)
            );
CREATE TABLE coordinator_syntheses (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              discussion_id TEXT NOT NULL,
              job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
              context_id TEXT NOT NULL UNIQUE REFERENCES team_contexts(id),
              base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
              state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'complete', 'incomplete', 'failed', 'cancelled')),
              reason TEXT,
              record_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
CREATE INDEX coordinator_synthesis_discussion ON coordinator_syntheses(discussion_id, created_at);
CREATE TABLE decision_proposals (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              discussion_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              synthesis_id TEXT NOT NULL REFERENCES coordinator_syntheses(id),
              record_json TEXT NOT NULL,
              source_id TEXT NOT NULL REFERENCES sources(id),
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              created_at INTEGER NOT NULL,
              UNIQUE (discussion_id, revision),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
CREATE INDEX decision_proposal_topic ON decision_proposals(project_id, topic_id, created_at);
CREATE TABLE owner_decisions (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              proposal_id TEXT NOT NULL REFERENCES decision_proposals(id),
              proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
              revision INTEGER NOT NULL CHECK (revision > 0),
              actor_id TEXT NOT NULL CHECK (actor_id = 'owner'),
              channel TEXT NOT NULL CHECK (channel = 'web'),
              option_id TEXT,
              conclusion TEXT NOT NULL,
              rationale TEXT NOT NULL,
              source_links_json TEXT NOT NULL,
              superseded_by TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE (project_id, topic_id, revision),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
CREATE INDEX owner_decision_topic ON owner_decisions(project_id, topic_id, created_at);
CREATE UNIQUE INDEX owner_decision_live ON owner_decisions(project_id, topic_id) WHERE superseded_by IS NULL;
CREATE TABLE task_proposals (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              project_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              source_id TEXT NOT NULL REFERENCES sources(id),
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              origin TEXT NOT NULL CHECK (origin IN ('owner', 'validated_output')),
              created_at INTEGER NOT NULL,
              UNIQUE (task_id, revision)
            );
CREATE INDEX task_proposal_project ON task_proposals(project_id, task_id);
CREATE TABLE "tasks" (
              id TEXT PRIMARY KEY,
              task_revision INTEGER NOT NULL CHECK (task_revision > 0),
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'ready_for_review', 'completed', 'dismissed', 'cancelled', 'superseded')),
              proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
              current_proposal_id TEXT NOT NULL,
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              source_id TEXT NOT NULL,
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              origin TEXT NOT NULL CHECK (origin IN ('owner', 'validated_output')),
              acceptance_json TEXT,
              closed_reason TEXT,
              completion_policy_json TEXT NOT NULL,
              completion_json TEXT,
              pending_reason_json TEXT,
              superseded_by TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id),
              FOREIGN KEY (source_id) REFERENCES sources(id)
            );
CREATE INDEX task_project ON tasks(project_id, updated_at, id);
CREATE TABLE "task_events" (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              project_id TEXT NOT NULL,
              kind TEXT NOT NULL CHECK (kind IN ('proposed', 'edited', 'dismissed', 'accepted', 'cancelled', 'completed', 'reopened', 'superseded', 'policy_changed', 'ready_for_review')),
              actor_id TEXT NOT NULL CHECK (actor_id = 'owner'),
              channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
              proposal_id TEXT,
              proposal_revision INTEGER,
              reason TEXT,
              created_at INTEGER NOT NULL
            );
CREATE INDEX task_event_task ON task_events(task_id, sequence);
CREATE TABLE task_evidence_artifacts (
              id TEXT PRIMARY KEY,
              proposal_id TEXT NOT NULL REFERENCES task_proposals(id),
              task_id TEXT NOT NULL REFERENCES tasks(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              work_type TEXT NOT NULL CHECK (work_type IN ('analysis', 'review', 'reminder')),
              outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed', 'unknown')),
              delivery_state TEXT CHECK (delivery_state IN ('sent', 'failed', 'unknown')),
              source_id TEXT NOT NULL,
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              record_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              UNIQUE (task_id, revision),
              FOREIGN KEY (task_id) REFERENCES tasks(id)
            );
CREATE INDEX task_evidence_project ON task_evidence_artifacts(project_id, task_id, revision);
PRAGMA user_version = 10;
