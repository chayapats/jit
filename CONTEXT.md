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
