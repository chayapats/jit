---
status: accepted
scope: TEAM01 engineering choices
---

# Owner role configuration and a scripted application run port

TEAM01 implements FR-02, FR-10, FR-13, FR-14, FR-17 and NFR-01/02/03/07/10 without depending on an unlanded Schway host contract. The confirmed product decisions remain in CONTEXT.md, the MVP spec and ADRs 0001–0004. The choices below define this implementation slice; they do not select real account/model defaults or claim live feasibility.

The owner maintains named, enabled specialists and a coordinator with responsibility text. Optional presets are explicit owner actions. S09 adds owner-accepted role proposals as another path into the same command ([ADR 0029](0029-jit-conversation-and-role-proposals.md)). A saved role does not start a run, create a task or grant tools. Owner commands share the authenticated, revisioned, idempotent receipt/audit boundary of APP01/02; provider/model output has no configuration authority.

A route is one atomic provider/model/auth-reference value. Precedence is project-role override, project default, owner-role route, then owner default. Fields from different layers are never combined. Queries disclose the exact effective value, its layer and the configuration revisions used. Missing routes are blocked; configured production routes remain unverified until the supported real adapter and opt-in evidence exist. Opaque references are not credential values. No actual account/model ID is invented as a default, and failures never select a different provider/model/auth/billing path.

An explicit owner preview commits its input/configuration/authorization snapshot before work starts. JOB01 supplies finite durable admission; its fixture handler does not constitute a model/tool loop. The preview identifies both the requested effective route and the actual scripted execution, labels every result as a fixture, and commits an attributed result/source only through a fenced trusted producer. Configuration changes do not silently replace a pending run's captured route or responsibility.

The application run port receives an independent managed context, an authorization fence and cancellation signal, a purpose, one exact route, trusted operator/responsibility instructions, an untrusted source/claim revision manifest, an exact tool selection and positive finite budgets. It returns normalized events, outcome, usage and opaque session references. Credentials/provider wire types and native file paths do not cross the port. Generic shell/write/edit/arbitrary fetch, provider-hosted lookup and repository instruction/skill/package discovery are disabled for the scripted profile.

Managed references have a durable generation and lifecycle. Retirement prevents replay immediately, including late completion. Deletion reports success or an explicit managed-delete failure; Jit never edits native Schway session bytes. Scripted context records are application fixture state. JBR01 supplies the later real supported adapter, and JOB02 supplies native attempt/session reconciliation; this slice makes no atomic cross-store or exactly-once external execution claim.

Preview/configuration queries work offline. Resource ceilings, source count/bytes, output size, role count, queue/concurrency and retry/wall budgets remain finite. Unknown models, unavailable routes, quota/login, cancellation, exhausted rounds and invalid results produce explicit incomplete/blocked/error outcomes and next actions. Tests use scripted outcomes, fake clocks and disposable stores, with independent context retirement/deletion and no paid inference or host provisioning.

Schema v4 retains existing owner/project/conversation/job/source identities. A frozen empty schema from the published JOB01 artifact checks migration without importing installation state. ADRs 0006, 0008 and 0010 continue to govern storage, attribution and admission.
