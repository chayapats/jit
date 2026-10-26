# Jit

Jit is a personal application where an owner works with specialist agents on software projects and retains project knowledge over time. Schway is the execution engine used by the application.

## Language

**Owner**:
The person authorized to configure an installation, accept obligations and grant actions within it.
_Avoid_: Agent, inferred identity from message text.

**Project**:
A software initiative whose conversations, decisions, obligations and authorized resources belong together.
_Avoid_: Provider session, current shell directory.

**Project group**:
The conversation space belonging to one project, with topics and participating specialists.
_Avoid_: Department-wide channel, Schway session.

**Topic**:
A subject of discussion within a project group that retains its project identity.
_Avoid_: Separate project, independent authorization scope.

**Specialist**:
A participant with a defined responsibility whose analysis is distinct from other participants.
_Avoid_: Model, provider, separate bot account.

**Coordinator**:
The participant responsible for selecting relevant specialists and synthesizing conclusions for the owner.
_Avoid_: Final decision maker, replacement agent loop.

**Jit (main bot)**:
The coordinator as the owner meets it in conversation: it replies to every owner message with the owner-configured persona and speaks for the team with one voice.
_Avoid_: Separate agent loop, authority holder, a specialist.

**Persona**:
Owner-authored configuration of how Jit addresses the owner, which language it uses and its personality, treated as trusted instruction and changed only by owner commands.
_Avoid_: Model memory, self-description written by the model.

**Role proposal**:
A revisioned specialist draft suggested by Jit that creates or changes a role only when the owner accepts that exact revision.
_Avoid_: Created role, model-granted configuration.

**Dispatch allowance**:
An owner-set, finite number of existing specialists Jit may call per owner message without asking, admitted as standing owner authorization for read-only analysis only.
_Avoid_: Model permission, unlimited auto-dispatch.

**General space**:
The single system project where conversations land when the owner has not chosen a project.
_Avoid_: Project-less chat, inbox outside project rules.

**Topic promotion**:
An owner-accepted continuation of a General space topic in a new project that links the origin at an exact revision without moving its project identity.
_Avoid_: Moving a topic, relabeling history.

**Setup (ตั้งจิต)**:
The first-run flow that connects a model route and records the persona before the owner starts chatting.
_Avoid_: Project creation wizard, team setup.

**Task**:
A proposed or owner-accepted obligation within a project, with an explicit status and completion rule.
_Avoid_: Agent run, suggestion treated as a commitment.

**Job**:
An authorized unit of background work, such as a PR review or configured reminder, tracked separately from the owner's obligations.
_Avoid_: Automatically accepted task, Schway tool scheduler.

**Run**:
One bounded invocation of Schway for an assigned piece of analysis or synthesis.
_Avoid_: Entire job, long-lived specialist identity.

**Decision**:
A conclusion explicitly selected by the owner for a project, retaining the proposal and evidence it resolved.
_Avoid_: Agent recommendation, majority vote.

**Memory claim**:
A retained statement with its source, project of origin and status as an explicit fact or inference.
_Avoid_: Entire conversation history, unqualified truth.

**Auth route**:
The selected identity and billing path through which a model is accessed.
_Avoid_: Model name, permission to change resources.

**Configured access**:
Locally configured credentials or endpoint policy, without proof that inference is currently available.
_Avoid_: Verified access, successful model request.

**Schway session**:
A durable native conversation with workspace identity and conversation branches, distinct from a Jit project group or running process.
_Avoid_: Group chat, durable job execution.

**Managed backup**:
A committed local backup inventory entry with a credential-free application image and opaque native session snapshots, inspectable but never activated without quarantined restore.
_Avoid_: Database copy, export, credential backup.

**Installation upgrade**:
An owner-authorized move of the whole installation to the schema this build supports: fence and quiesce, one recovery point, migrations on a staged copy only, validation, atomic activation and reconciliation; never an in-place boot migration or a backup restore.
_Avoid_: Auto-migration, restore, rollback after activation.

**Quarantined restore**:
An owner-authorized return of the installation to a managed backup: compatibility and integrity checks, a fenced and quiesced installation, an isolated copy migrated and reconciled against the latest lifecycle ledger, validation, atomic activation and reconciliation before any worker or reader resumes.
_Avoid_: Database copy-back, backup import, rollback.

**Lifecycle ledger**:
The installation's append-only, identity-only record of every deletion and forget, kept outside every backup image with an independent checkpoint; the only authority for what a restored image must still not contain.
_Avoid_: A backup's own tombstones, owner-attested deletion list.
