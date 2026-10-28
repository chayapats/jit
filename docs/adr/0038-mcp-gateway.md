---
status: accepted
scope: S11 MCP engineering choices; extends ADRs 0029, 0036 and 0037
---

# MCP install proposals and an MCP gateway into the execution box

S11-D06 lets an agent install MCP servers after the owner approves, runs them in the box, and gates any tool that is not declared read-only.

## Selected implementation

### Install proposals

- A Jit reply may include an `mcp_install` proposal. This is a new typed proposal from ADR 0029. It contains:
  - `name`, which matches `^[a-z][a-z0-9-]{1,31}$`.
  - `source`, one of `npm`, `pypi` or `oci`.
  - `package`.
  - `version`, which must be an exact pinned version. Ranges, tags and `latest` are dropped as `unpinned_version`.
  - `command` and `args`, which the card shows verbatim.
  - `env`: names only. Each name is bound later to a connection by the owner.
- Acceptance is Web-only (`mcp.install.accept`, revision-bound). It requires the project level to be at least `workspace`, because installing needs registry access.
- The installer runs as a job in the box, using the registry proxy at `workspace` level. It records `mcp_servers(project_id, id, revision, spec_json, state, tools_json)`. A failed install leaves the server in state `failed` with the reason.

### Gateway

- Jit launches each server in the box over stdio through `podman exec -i`. A Jit-side MCP client speaks JSON-RPC over that pipe.
- When a server binds a connection, it runs in its own **sidecar container**. The sidecar uses the same pinned image, the project's network mode, no workspace mount and its own PID namespace, and it receives the secret through `podman exec --env` at spawn. This keeps the secret out of the project box's processes and filesystem.
- Tools are exposed to Schway as `ToolDefinition`s named `mcp_<server>_<tool>`, truncated to the model limits. Each input schema is checked against a JSON Schema size bound.
- Effect classification:
  - A tool whose listing says `readOnlyHint: true` is `read-only` and executes directly.
  - Every other tool is an external effect. It produces an approval card of kind `mcp_tool`, with the server, tool and exact arguments, unless an `auto_approve_rules` row of kind `mcp_tool` names that exact server and tool.
  - Hints are re-read on every tool listing. A tool that drops `readOnlyHint` becomes gated again.
- Results are untrusted source content. They are bounded to 50,000 bytes, framed as data in the next turn, and never treated as instructions or authority.

## Alternatives and consequences

- Trusting every hint (rejected by the owner, S11-6 C) would let a careless server bypass approval.
- Installing only by the owner by hand (S11-6 A) was replaced by the owner's choice of agent proposals (S11-6 B). The card and the Web-only acceptance keep the decision with the owner.
- Sidecars cost memory. A server sidecar counts against `execution.maxBoxes` only while it runs.
