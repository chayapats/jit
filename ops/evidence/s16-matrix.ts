import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Reviewed source-test profile. Execution constructs fixed argv and fixture flags itself. */
export interface S16EvidenceProfile {
  id: string; kind: 'deterministic' | 'browser'; basis: string; reused: boolean;
  suites: string[]; timeoutMs: number; requiredObservations: number; artifactEvidence: 'profile_specific_receipts_required';
}
/** Required observable outcome, its owning inputs and unresolved composed-driver gaps. */
export interface S16EvidenceScenario {
  id: string; acceptance: string[]; title: string; requirements: string[]; owners: number[]; required: true;
  expectedOutcomes: string[]; negativeCases: string[]; profiles: string[];
  evidenceStatus: 'not_executed_at_matrix_revision'; requiredDriverGaps: string[];
}
/** Product evidence stays independently pending; deterministic execution cannot approve it. */
export interface S16ExternalEvidence { id: string; owners: number[]; basis: string; requiredFor: 'product'; status: 'pending'; outcome: string }
/** Versioned acceptance plan, distinct from an execution receipt or historical ownership inventory. */
export interface S16EvidenceMatrix {
  contract: 's16-cross-client-evidence-matrix/v1'; ownerIssue: 430; parentIssue: 392; meaning: string;
  governingDocuments: string[]; sourceBaseline: string; historicalOwnership: string;
  requirements: { id: string; title: string }[]; profiles: S16EvidenceProfile[];
  scenarios: S16EvidenceScenario[]; externalEvidence: S16ExternalEvidence[]; authorityAmendments: string[];
}

function require(value: unknown, code = 's16_matrix_invalid'): asserts value { if (!value) throw Error(code); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  require(value && typeof value === 'object' && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  require(Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)));
  return row;
}
function text(value: unknown, bound = 4096): string { require(typeof value === 'string' && value.length > 0 && value.length <= bound && !value.includes('\0')); return value; }
function list(value: unknown, bound: number, min = 1): unknown[] { require(Array.isArray(value) && value.length >= min && value.length <= bound); return value; }
function strings(value: unknown, bound: number, min = 1): string[] { const result = list(value, bound, min).map(row => text(row)); require(new Set(result).size === result.length); return result; }
function owners(value: unknown): number[] { const result = list(value, 40); require(result.every(n => Number.isSafeInteger(n) && Number(n) > 0)); require(new Set(result).size === result.length); return result as number[]; }
const requirements = [...Array.from({ length: 42 }, (_, i) => `FR-${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 14 }, (_, i) => `NFR-${String(i + 1).padStart(2, '0')}`)];
const acceptance = Array.from({ length: 22 }, (_, i) => `S16-AC${String(i + 1).padStart(2, '0')}`);
const id = (value: unknown) => { const result = text(value, 80); require(/^[a-z][a-z0-9_]*$/.test(result)); return result; };

/** Returns null only for a missing reviewed input. Traversal, symlinks and special nodes always refuse. */
export function s16EvidencePath(root: string, name: string): string | null {
  require(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,240}$/.test(name) && name.split('/').every(part => part !== '.' && part !== '..' && part !== ''), 's16_matrix_path_invalid');
  const absolute = resolve(root); let path = absolute;
  const parts = name.split('/');
  for (let i = 0; i < parts.length; i++) {
    path = join(path, parts[i]!); const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return null;
    require(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()), 's16_matrix_path_invalid');
  }
  return path;
}

/** Validates all required identifiers, references and fixed test paths without executing source. */
export function validateS16EvidenceMatrix(value: unknown, root: string): S16EvidenceMatrix {
  const row = object(value, ['contract', 'ownerIssue', 'parentIssue', 'meaning', 'governingDocuments', 'sourceBaseline', 'historicalOwnership', 'requirements', 'profiles', 'scenarios', 'externalEvidence', 'authorityAmendments']);
  require(row.contract === 's16-cross-client-evidence-matrix/v1' && row.ownerIssue === 430 && row.parentIssue === 392);
  text(row.meaning); require(/^[a-f0-9]{40}$/.test(text(row.sourceBaseline)));
  require(row.historicalOwnership === 'docs/tickets/S16-rakazo-experience-coverage.json');
  const docs = strings(row.governingDocuments, 32);
  require(['AGENTS.md', 'CONTEXT.md', 'docs/product/02-prd.md', 'docs/specs/S16-rakazo-experience.md', 'docs/specs/S15-conversational-autonomy.md', 'docs/adr/0064-conversational-authority-and-protected-control-plane.md', 'docs/adr/0074-rakazo-reuse-and-product-convergence.md', 'docs/adr/0084-s16-grok-style-default-autonomy.md', 'docs/adr/0085-remove-telegram-web-push-notifications.md'].every(path => docs.includes(path)));
  for (const path of [...docs, row.historicalOwnership]) require(s16EvidencePath(root, path), 's16_matrix_document_missing');
  strings(row.authorityAmendments, 16);
  const requirementRows = list(row.requirements, 56).map(value => { const item = object(value, ['id', 'title']); text(item.title); return text(item.id); });
  require(requirementRows.length === requirements.length && requirements.every(name => requirementRows.includes(name)));
  const profiles = list(row.profiles, 100).map(value => {
    const item = object(value, ['id', 'kind', 'basis', 'reused', 'suites', 'timeoutMs', 'requiredObservations', 'artifactEvidence']);
    id(item.id); require(item.kind === 'deterministic' || item.kind === 'browser');
    require(['owning_services_with_scripted_transports', 'actual_browser_with_scripted_service_ports', 'inherited_contract_and_package_checks'].includes(text(item.basis)));
    require(typeof item.reused === 'boolean' && item.artifactEvidence === 'profile_specific_receipts_required');
    require(Number.isSafeInteger(item.timeoutMs) && Number(item.timeoutMs) >= 1000 && Number(item.timeoutMs) <= 600000);
    require(Number.isSafeInteger(item.requiredObservations) && Number(item.requiredObservations) >= 1 && Number(item.requiredObservations) <= 50000);
    for (const path of strings(item.suites, 20)) { require(/^tests\/[a-zA-Z0-9_./-]+\.test\.tsx?$/.test(path), 's16_matrix_suite_invalid'); s16EvidencePath(root, path); }
    return item.id as string;
  });
  require(new Set(profiles).size === profiles.length);
  const scenarios = list(row.scenarios, 24).map(value => {
    const item = object(value, ['id', 'acceptance', 'title', 'requirements', 'owners', 'required', 'expectedOutcomes', 'negativeCases', 'profiles', 'evidenceStatus', 'requiredDriverGaps']);
    id(item.id); text(item.title); owners(item.owners); require(item.required === true && item.evidenceStatus === 'not_executed_at_matrix_revision');
    require(strings(item.acceptance, 22).every(name => acceptance.includes(name)));
    require(strings(item.requirements, 56).every(name => requirements.includes(name)));
    require(strings(item.profiles, 100).every(name => profiles.includes(name)));
    strings(item.expectedOutcomes, 32); strings(item.negativeCases, 32); strings(item.requiredDriverGaps, 32, 0);
    return item as unknown as S16EvidenceScenario;
  });
  require(scenarios.length === 24 && new Set(scenarios.map(item => item.id)).size === 24);
  for (let i = 1; i <= 22; i++) {
    const scenario = scenarios.find(item => item.id === `ac${String(i).padStart(2, '0')}`);
    require(scenario && scenario.acceptance.length === 1 && scenario.acceptance[0] === acceptance[i - 1], 's16_matrix_acceptance_missing');
  }
  require(scenarios.some(item => item.id === 'inherited_repository_readiness' && item.requirements.includes('FR-08')));
  require(scenarios.some(item => item.id === 'inherited_design_tokens' && item.requirements.includes('NFR-13')));
  // AC22's aggregate requirement list cannot hide a missing narrower trace.
  require(requirements.every(name => scenarios.some(item => item.id !== 'ac22' && item.requirements.includes(name))), 's16_matrix_requirement_untraced');
  const external = list(row.externalEvidence, 5).map(value => {
    const item = object(value, ['id', 'owners', 'basis', 'requiredFor', 'status', 'outcome']);
    id(item.id); owners(item.owners); text(item.basis); text(item.outcome); require(item.requiredFor === 'product' && item.status === 'pending'); return item.id;
  });
  require(external.length === 5 && ['native_ui', 'linux_isolation', 'live_accounts', 'owner_host_cutover', 'configured_local_speech'].every(name => external.includes(name)));
  return row as unknown as S16EvidenceMatrix;
}

/** Loads the one reviewed plan, bounding input size before JSON parsing. */
export function readS16EvidenceMatrix(root: string): S16EvidenceMatrix {
  const path = s16EvidencePath(root, 'docs/evidence/s16-cross-client-matrix.json'); require(path, 's16_matrix_missing');
  require(lstatSync(path).size <= 1048576, 's16_matrix_bounds');
  return validateS16EvidenceMatrix(JSON.parse(readFileSync(path, 'utf8')), root);
}
