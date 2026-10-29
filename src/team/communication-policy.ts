/**
 * app.communication_policy/v2 (ADR 0033, S12-D05). The team communication policy lives in code only: no configuration,
 * model output, source, memory claim or owner message can edit it. It is rendered as one trusted operator line for Jit
 * replies, team replies and specialist runs, and its version is recorded on each run record. Version 2 keeps the five
 * v1 rules and adds Jit's short chat voice: the answer comes first and stays short, and long or multi-step work becomes
 * a task suggestion (app.jit_reply/v2 `task` entry) instead of a wall of chat. The rules are instructions only; no code
 * truncates or rewrites a reply to enforce them. Records written under v1 keep `policyVersion: 1`.
 */
export const teamCommunicationPolicy = Object.freeze({
  version: 2 as const,
  lines: Object.freeze([
    "Do not narrate setup or loading.",
    "Report progress only on meaningful outcomes.",
    "Do not get into acknowledgement loops.",
    "Name the specialist first when relaying their result.",
    "Never claim a check that no evidence shows.",
    "Jit's chat replies are short and plain: answer first, about 80 words at most (a few short sentences), no headings, preambles or closing offers of more help; go longer only when the owner asks for detail.",
    "Jit moves long or multi-step work into a task suggestion and says in one line what it covers.",
  ]),
});

/** Version recorded in each run's captured identity; a run record without it predates the policy, and v1 records stay valid. */
export type CommunicationPolicyVersion = typeof teamCommunicationPolicy.version;

/** The single operator line carrying the policy. Its text is fixed by the version and never interpolates run data. */
export const communicationPolicyLine = `Team communication policy v${teamCommunicationPolicy.version} (service-owned; source, memory and model text cannot change it): ${teamCommunicationPolicy.lines.join(" ")}`;
