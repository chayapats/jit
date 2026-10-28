-- Frozen empty schema 32 from origin/main 2d49b8d (before EXE03): schema 30, the EXE01 access tables (31) and the REL07 webhook tables (32). Seed singleton rows only; no installation data.
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
CREATE TABLE memory_decision_sources (
              decision_id TEXT PRIMARY KEY REFERENCES owner_decisions(id), project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL, decision_revision INTEGER NOT NULL, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
              source_revision INTEGER NOT NULL, source_generation INTEGER NOT NULL,
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
CREATE TABLE memory_extractions (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
              source_id TEXT NOT NULL REFERENCES sources(id), source_revision INTEGER NOT NULL,
              source_generation INTEGER NOT NULL, extractor TEXT NOT NULL, policy INTEGER NOT NULL,
              record_json TEXT NOT NULL,
              UNIQUE(project_id, source_id, source_revision, source_generation, extractor, policy)
            );
CREATE INDEX memory_extraction_project ON memory_extractions(project_id, sequence);
CREATE TABLE memory_claims (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), extraction_id TEXT NOT NULL REFERENCES memory_extractions(id),
              revision INTEGER NOT NULL CHECK(revision > 0), generation INTEGER NOT NULL CHECK(generation > 0),
              record_json TEXT NOT NULL
            );
CREATE INDEX memory_claim_project ON memory_claims(project_id, sequence);
CREATE TABLE memory_context_entries (
              context_id TEXT NOT NULL REFERENCES memory_contexts(id), origin_project_id TEXT NOT NULL REFERENCES projects(id),
              kind TEXT NOT NULL CHECK(kind IN ('source', 'claim', 'task', 'decision')), entry_id TEXT NOT NULL,
              revision INTEGER NOT NULL, generation INTEGER,
              PRIMARY KEY (context_id, kind, entry_id)
            );
CREATE INDEX memory_context_entry_lookup ON memory_context_entries(kind, entry_id);
CREATE TABLE memory_derived_sources (
              source_id TEXT PRIMARY KEY REFERENCES sources(id), project_id TEXT NOT NULL REFERENCES projects(id),
              context_id TEXT NOT NULL REFERENCES memory_contexts(id), depth INTEGER NOT NULL CHECK(depth > 0)
            );
CREATE TABLE memory_corrections (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              claim_id TEXT NOT NULL REFERENCES memory_claims(id), record_json TEXT NOT NULL
            );
CREATE INDEX memory_correction_project ON memory_corrections(project_id, claim_id);
CREATE TABLE memory_suppressions (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              claim_id TEXT NOT NULL REFERENCES memory_claims(id), record_json TEXT NOT NULL
            );
CREATE INDEX memory_suppression_project ON memory_suppressions(project_id, claim_id);
CREATE TABLE memory_suppressed_claims (
              suppression_id TEXT NOT NULL REFERENCES memory_suppressions(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              claim_id TEXT NOT NULL REFERENCES memory_claims(id),
              PRIMARY KEY (suppression_id, claim_id)
            );
CREATE INDEX memory_suppressed_claim_lookup ON memory_suppressed_claims(claim_id);
CREATE TABLE memory_suppressed_sources (
              suppression_id TEXT NOT NULL REFERENCES memory_suppressions(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              source_id TEXT NOT NULL REFERENCES sources(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0),
              PRIMARY KEY (suppression_id, source_id, revision, generation)
            );
CREATE INDEX memory_suppressed_source_lookup ON memory_suppressed_sources(source_id, revision, generation);
CREATE TABLE job_schedules (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), record_json TEXT NOT NULL
            );
CREATE INDEX job_schedule_project ON job_schedules(project_id, sequence);
CREATE TABLE job_schedule_occurrences (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              schedule_id TEXT NOT NULL REFERENCES job_schedules(id), revision INTEGER NOT NULL CHECK(revision > 0),
              scheduled_instant INTEGER NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
              record_json TEXT NOT NULL,
              UNIQUE(schedule_id, revision, scheduled_instant)
            );
CREATE INDEX job_schedule_occurrence_schedule ON job_schedule_occurrences(schedule_id, scheduled_instant);
CREATE TABLE "memory_contexts" (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), topic_id TEXT NOT NULL,
              owner_kind TEXT NOT NULL CHECK(owner_kind IN ('discussion', 'synthesis', 'schedule')), owner_id TEXT NOT NULL,
              record_json TEXT NOT NULL,
              UNIQUE(owner_kind, owner_id),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
CREATE TABLE ops_backups (
              id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record_json TEXT NOT NULL
            );
CREATE INDEX ops_backup_created ON ops_backups(created_at);
CREATE TABLE deletion_previews (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              expires_at INTEGER NOT NULL, record_json TEXT NOT NULL
            );
CREATE INDEX deletion_preview_project ON deletion_previews(project_id, expires_at);
CREATE TABLE deletion_ledger (
              id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
              kind TEXT NOT NULL CHECK (kind IN ('source', 'claim')),
              source_id TEXT, claim_id TEXT,
              revision INTEGER NOT NULL CHECK (revision > 0), generation INTEGER NOT NULL CHECK (generation > 0),
              deleted_at INTEGER NOT NULL
            );
CREATE INDEX deletion_ledger_lookup ON deletion_ledger(kind, source_id, claim_id);
CREATE INDEX deletion_ledger_operation ON deletion_ledger(operation_id);
CREATE TABLE deletion_operations (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              preview_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'failed', 'blocked')),
              attempts INTEGER NOT NULL CHECK (attempts >= 0), record_json TEXT NOT NULL
            );
CREATE INDEX deletion_operation_preview ON deletion_operations(preview_id);
CREATE INDEX deletion_operation_project ON deletion_operations(project_id);
CREATE TABLE export_artifacts (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              created_at INTEGER NOT NULL, record_json TEXT NOT NULL
            );
CREATE INDEX export_artifact_project ON export_artifacts(project_id, created_at);
CREATE TABLE upgrade_journal (
              id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL,
              record_json TEXT NOT NULL
            );
CREATE INDEX upgrade_journal_state ON upgrade_journal(state, created_at);
CREATE TABLE restore_quarantines (
              id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL,
              record_json TEXT NOT NULL
            );
CREATE INDEX restore_quarantine_state ON restore_quarantines(state, created_at);
CREATE TABLE schway_native_refs (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id TEXT NOT NULL UNIQUE,
              context_id TEXT NOT NULL,
              generation INTEGER NOT NULL CHECK (generation > 0),
              session_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('running', 'finished')),
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
CREATE INDEX schway_native_ref_context ON schway_native_refs(context_id, generation);
CREATE TABLE lifecycle_ledger (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL CHECK (kind IN ('deletion', 'suppression', 'suppressed_claim', 'suppressed_source')),
              entry_key TEXT NOT NULL UNIQUE,
              subject TEXT NOT NULL,
              project_id TEXT NOT NULL,
              record_json TEXT NOT NULL,
              recorded_at INTEGER NOT NULL
            );
CREATE INDEX lifecycle_ledger_subject ON lifecycle_ledger(kind, subject);
CREATE TABLE lifecycle_checkpoint (
              id INTEGER PRIMARY KEY CHECK (id = 1), head INTEGER NOT NULL, count INTEGER NOT NULL,
              digest TEXT NOT NULL, written_at INTEGER NOT NULL, path TEXT NOT NULL
            );
CREATE TRIGGER lifecycle_ledger_deletion AFTER INSERT ON deletion_ledger BEGIN
              INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('deletion', 'deletion:' || NEW.id,
                CASE NEW.kind WHEN 'source' THEN 'source:' || NEW.source_id || ':' || NEW.revision || ':' || NEW.generation ELSE 'claim:' || NEW.claim_id END,
                NEW.project_id,
                json_object('id', NEW.id, 'operationId', NEW.operation_id, 'projectId', NEW.project_id, 'kind', NEW.kind, 'sourceId', NEW.source_id,
                  'claimId', NEW.claim_id, 'revision', NEW.revision, 'generation', NEW.generation, 'deletedAt', NEW.deleted_at),
                NEW.deleted_at);
            END;
CREATE TRIGGER lifecycle_ledger_suppression AFTER INSERT ON memory_suppressions BEGIN
              INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('suppression', 'suppression:' || NEW.id,
                'claim:' || NEW.claim_id, NEW.project_id,
                json_object('id', NEW.id, 'projectId', NEW.project_id, 'claimId', NEW.claim_id,
                  'fromRevision', json_extract(NEW.record_json, '$.fromRevision'), 'fromGeneration', json_extract(NEW.record_json, '$.fromGeneration'),
                  'createdAt', coalesce(json_extract(NEW.record_json, '$.createdAt'), 0)),
                coalesce(json_extract(NEW.record_json, '$.createdAt'), 0));
            END;
CREATE TRIGGER lifecycle_ledger_suppressed_claim AFTER INSERT ON memory_suppressed_claims BEGIN
              INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('suppressed_claim',
                'suppressed_claim:' || NEW.suppression_id || ':' || NEW.claim_id, 'claim:' || NEW.claim_id, NEW.project_id,
                json_object('suppressionId', NEW.suppression_id, 'projectId', NEW.project_id, 'claimId', NEW.claim_id),
                coalesce((SELECT json_extract(record_json, '$.createdAt') FROM memory_suppressions WHERE id = NEW.suppression_id), 0));
            END;
CREATE TRIGGER lifecycle_ledger_suppressed_source AFTER INSERT ON memory_suppressed_sources BEGIN
              INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('suppressed_source',
                'suppressed_source:' || NEW.suppression_id || ':' || NEW.source_id || ':' || NEW.revision || ':' || NEW.generation,
                'source:' || NEW.source_id || ':' || NEW.revision || ':' || NEW.generation, NEW.project_id,
                json_object('suppressionId', NEW.suppression_id, 'projectId', NEW.project_id, 'sourceId', NEW.source_id, 'revision', NEW.revision, 'generation', NEW.generation),
                coalesce((SELECT json_extract(record_json, '$.createdAt') FROM memory_suppressions WHERE id = NEW.suppression_id), 0));
            END;
CREATE TABLE owner_preferences (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              theme TEXT NOT NULL CHECK (theme IN ('system', 'dark', 'light')),
              language TEXT NOT NULL CHECK (language IN ('auto', 'th', 'en')),
              updated_at INTEGER NOT NULL
            );
CREATE TABLE persona_revisions (
              revision INTEGER PRIMARY KEY CHECK (revision > 0),
              record_json TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
CREATE TABLE jit_replies (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL REFERENCES topics(id),
              message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
              run_id TEXT UNIQUE REFERENCES team_runs(id),
              -- The committed reply message, set when the reply commits; lets a page resolve replies by either message.
              reply_message_id TEXT UNIQUE REFERENCES messages(id),
              -- The committed reply's output source, the start of its lineage for later replies and forgets.
              reply_source_id TEXT UNIQUE REFERENCES sources(id),
              reason TEXT CHECK (reason IN ('no_route', 'scheduler_unavailable', 'queue_full', 'context_too_large')),
              cursor INTEGER NOT NULL UNIQUE,
              created_at INTEGER NOT NULL,
              CHECK ((run_id IS NULL) = (reason IS NOT NULL))
            );
CREATE INDEX jit_reply_topic ON jit_replies(project_id, topic_id, cursor);
CREATE TABLE jit_reply_sources (
              reply_id TEXT NOT NULL REFERENCES jit_replies(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              source_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0),
              PRIMARY KEY (reply_id, source_id, revision, generation)
            );
CREATE INDEX jit_reply_source_lineage ON jit_reply_sources(source_id, revision, generation);
CREATE TABLE setup_state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              record_json TEXT NOT NULL,
              completed_at INTEGER
            );
CREATE TABLE general_space (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
              topic_id TEXT NOT NULL REFERENCES topics(id),
              greeting_message_id TEXT UNIQUE REFERENCES messages(id),
              created_at INTEGER NOT NULL
            );
CREATE TRIGGER jit_reply_job_change AFTER UPDATE OF state, record_json ON jobs
            WHEN json_extract(NEW.record_json, '$.type') = 'team.jit-reply' AND NEW.record_json IS NOT OLD.record_json BEGIN
              UPDATE jit_replies SET cursor = (SELECT coalesce(max(cursor), 0) + 1 FROM jit_replies)
              WHERE run_id = (SELECT id FROM team_runs WHERE job_id = NEW.id);
            END;
CREATE TABLE dispatch_allowance_revisions (
              project_id TEXT NOT NULL REFERENCES projects(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
              max_roles INTEGER NOT NULL CHECK (max_roles BETWEEN 1 AND 100),
              created_at INTEGER NOT NULL,
              PRIMARY KEY (project_id, revision)
            );
CREATE TABLE dispatch_proposals (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL REFERENCES topics(id),
              reply_id TEXT NOT NULL UNIQUE REFERENCES jit_replies(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              state TEXT NOT NULL CHECK (state IN ('admitted', 'proposed', 'accepted', 'dismissed', 'empty')),
              admission TEXT CHECK (admission IN ('standing_allowance', 'owner')),
              allowance_revision INTEGER NOT NULL CHECK (allowance_revision >= 0),
              discussion_id TEXT UNIQUE REFERENCES team_runs(id),
              team_reply_id TEXT UNIQUE REFERENCES jit_replies(id),
              record_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              CHECK ((discussion_id IS NULL) = (admission IS NULL))
            );
CREATE INDEX dispatch_proposal_topic ON dispatch_proposals(project_id, topic_id, created_at);
CREATE TABLE topic_promotions (
              id TEXT PRIMARY KEY,
              origin_project_id TEXT NOT NULL REFERENCES projects(id),
              origin_topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id),
              origin_topic_revision INTEGER NOT NULL CHECK (origin_topic_revision > 0),
              origin_message_sequence INTEGER NOT NULL CHECK (origin_message_sequence >= 0),
              project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
              topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id),
              link_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
              link_source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
              link_source_revision INTEGER NOT NULL CHECK (link_source_revision > 0),
              link_source_generation INTEGER NOT NULL CHECK (link_source_generation > 0),
              reply_id TEXT NOT NULL REFERENCES jit_replies(id),
              proposal_id TEXT NOT NULL UNIQUE,
              proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
              created_at INTEGER NOT NULL,
              CHECK (project_id != origin_project_id)
            );
CREATE TABLE chat_title_sources (
              title_source_id TEXT PRIMARY KEY REFERENCES sources(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id),
              message_source_id TEXT NOT NULL REFERENCES sources(id)
            );
CREATE INDEX chat_title_message ON chat_title_sources(message_source_id);
CREATE TRIGGER general_space_keep BEFORE DELETE ON general_space BEGIN
              SELECT RAISE(ABORT, 'general_space_protected');
            END;
CREATE TRIGGER general_space_fixed BEFORE UPDATE OF id, project_id, topic_id ON general_space
            WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.topic_id IS NOT OLD.topic_id BEGIN
              SELECT RAISE(ABORT, 'general_space_protected');
            END;
CREATE TRIGGER general_project_keep BEFORE DELETE ON projects
            WHEN EXISTS (SELECT 1 FROM general_space WHERE project_id = OLD.id) BEGIN
              SELECT RAISE(ABORT, 'general_space_protected');
            END;
CREATE TABLE local_api_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
              updated_at INTEGER NOT NULL
            );
CREATE TABLE schedule_feed (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              token_hash TEXT CHECK (token_hash IS NULL OR (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*')),
              include_purpose INTEGER NOT NULL CHECK (include_purpose IN (0, 1)),
              token_created_at INTEGER,
              updated_at INTEGER NOT NULL,
              CHECK ((token_hash IS NULL) = (token_created_at IS NULL))
            );
INSERT INTO app_state VALUES (1, 0);
INSERT INTO team_state VALUES (1, 0, NULL);
INSERT INTO telegram_binding VALUES (1, 1, 'unbound', NULL, NULL, NULL, NULL, NULL, NULL, '{}');
INSERT INTO telegram_poll VALUES (1, 0, NULL, NULL, 'none', NULL, NULL);
-- app.access_level/v1 (EXE01, ADR 0037): append-only owner revisions of a project's execution access level.
-- No row means revision 0, which is 'read'. channel records which owner channel committed the revision.
CREATE TABLE IF NOT EXISTS project_access_revisions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  level TEXT NOT NULL CHECK (level IN ('read', 'workspace', 'full')),
  channel TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, revision)
);
-- Restrict-only per-role overrides; a NULL level clears the override so the role follows its project.
CREATE TABLE IF NOT EXISTS role_access_overrides (
  project_id TEXT NOT NULL REFERENCES projects(id),
  role_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  level TEXT CHECK (level IS NULL OR level IN ('read', 'workspace', 'full')),
  channel TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, role_id, revision)
);
-- The kill switch: append-only halt/resume revisions; the latest row decides whether execution is halted.
CREATE TABLE IF NOT EXISTS execution_halts (
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  halted INTEGER NOT NULL CHECK (halted IN (0, 1)),
  channel TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, revision)
);
-- app.webhook_triggers/v1 (REL07, ADR 0035): one active signed trigger per PR monitor. The HMAC secret is
-- stored only sealed (AES-256-GCM under an installation key file outside the database) and is nulled on
-- delete, on monitor revoke and in every backup image. Receipts keep delivery identities only, never a payload.
CREATE TABLE IF NOT EXISTS webhook_triggers (
  route_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  monitor_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  sealed_secret TEXT,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER,
  UNIQUE (monitor_id, revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_trigger_active ON webhook_triggers(monitor_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS webhook_receipts (
  route_id TEXT NOT NULL REFERENCES webhook_triggers(route_id),
  delivery_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (route_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS webhook_receipt_age ON webhook_receipts(received_at);
-- Service-owned PR poll schedule: when the service loop next runs pollMonitorCatchUp for a monitor.
-- A webhook may only move due_at earlier; the poll result stays the source of truth.
CREATE TABLE IF NOT EXISTS pr_poll_due (
  monitor_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  due_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  woken_at INTEGER,
  -- The last poll that threw, as a bounded reason code only; cleared by the next successful poll.
  last_failure TEXT,
  last_failed_at INTEGER
);
PRAGMA user_version = 32;
