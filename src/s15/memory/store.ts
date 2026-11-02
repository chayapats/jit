/**
 * MEM schema v1, application_id 0x4a495437, user_version 1. Current claim/source withdrawals,
 * correction heads, derivative retirement and command dedupe are protected continuity, never restored
 * independently from an old image. Source records retain hashes/provenance rather than whole history.
 */
export const MEMORY_SCHEMA_V1 = `
CREATE TABLE sources (id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE claims (id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE derivatives (id TEXT PRIMARY KEY, state TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE suppressions (fingerprint TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE commands (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TRIGGER immutable_suppression_update BEFORE UPDATE ON suppressions BEGIN SELECT RAISE(ABORT,'immutable_suppression'); END;
CREATE TRIGGER immutable_suppression_delete BEFORE DELETE ON suppressions BEGIN SELECT RAISE(ABORT,'immutable_suppression'); END;
`;
