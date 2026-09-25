# ADR-XXX: Approvals and consent requests are off the agent surface

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Related:** ADR-059 (mandates, and who answers a call a mandate parked),
  ADR-070 (auto-approval rules and standing approvals), ADR-115
  (`resolve_approval` is the one billed action of the approvals surface),
  ADR-118 (approved built-in calls resume once), finding 9 of #3370.

## Context

The in-app assistant runs each turn as the person who typed
(`runPreparedTurn` in `packages/agent/src/runtime/assistant-turn.ts`). Its tool
calls carry that person's user id, no API key, and no agent principal. A write
whose contract sets `agent.requiresApproval` parks. `materializeTools` writes
an approval row that records the turn's message and run (`run_public_id`),
then refuses the call with a message that names the approval id. The first
call to an external MCP tool writes a consent request the same way, in the same
table.

Two contracts answer those rows, and both were on the `agent` surface with no
approval of their own, so the belt offered them to the same model:

- `resolve_approval` checked the caller's role, which is the person's role. It
  refused an agent principal only on a row a mandate parked. A chat row has no
  mandate, and the assistant is not an agent principal.
- `resolve_mcp_consent` checked no role at all, and answered any pending row by
  its uuid, not only a consent request.

A test proved both paths
(`packages/agent/src/handlers/agent.approval.resolve.self-approval.test.ts`,
with the real kernel, contracts, `materializeTools`, `createApprovalRequest`
and handlers). A turn parked `revoke_api_key`.

- On `main` at `eace536`, the same belt called `resolve_approval` with the id
  the refusal had named, and the call returned
  `{ approvalId, resolution: "approved", mandate: null }`.
  Under ADR-118 an approval queues the stored call for the resume worker, so
  the parked write would have run with no person deciding.
- A probe with the consent contract and handler as they stood on `main` had
  the same belt call `resolve_mcp_consent` on that id. The row then read
  `approved`, with the person as its resolver. `resume_status` stayed
  `waiting`, so the write did not run, but the row recorded a person's
  approval of that exact call, which an ADR-070 standing window can read.

A check keyed on the run does not close either path by itself:

- Each assistant turn opens its own run. The next turn in the same
  conversation carries a different run and could answer what the previous
  turn raised.
- The same model could answer a row another run raised, a mandate row
  included, because the person holds the role and the assistant is not an
  agent principal.
- Text in any tool result can steer the model to do either.

## Decision

One decision covers both contracts: a person answers the questions a run puts
to a person, and no model holds the tools that answer them.

1. **`resolve_approval` and `resolve_mcp_consent` are not on the `agent`
   surface.** Both list `api` and `mcp`. The belt does not offer them to a
   model, and the kernel refuses a call that names the `agent` surface with
   `surface_denied`. The v2 descriptor (the Appendix E target, #2884), which
   absorbs both, drops `agent` as well, so the cutover keeps this decision.
2. **A person decides, in the app.** Fleet, the Run page and the shell's
   approvals drawer call `resolve_approval` through the app's kernel seam,
   which names no surface. Approve and Deny in the assistant's thread, when
   they come, act as the person through the same seam. They are buttons the
   person presses, not a tool the model calls.
3. **Both handlers refuse a run that answers its own question.** Each reads
   `run_public_id` from the row and the run the kernel resolved for the call
   (`ctx.runId`: the caller's `opts.runId`, the outer handler's run, or the
   agent run). `raisedByCallingRun` in `packages/agent/src/runtime/approval.ts`
   reads an internal `agent_runs.id` back to its public id with
   `resolveRunPublicId`, the read the park made. When the two match, the call
   is refused `forbidden` with reason `run_cannot_resolve_own_approval`, and
   the message sends the person to Fleet. A row with no recorded run, or a
   call with no run, passes this check. It is a second line for any caller
   that carries a run on a surface that still lists the capability.
4. **An approval row records its kind.** `agent.approval_requests.kind` is
   `approval` or `consent`, with `approval` as the default. The consent gate
   in `materializeTools` writes `consent`. `resolve_mcp_consent` answers only
   a `consent` row and refuses any other row `conflict` with reason
   `not_a_consent_request`. The writer records the kind rather than a reader
   inferring it from the capability name, because an external tool's
   rule-driven approval carries the same `mcp.<server>.<tool>` name as its
   consent request. A new writer that does not say gets `approval`, which the
   consent resolver refuses. The migration marks the consent rows already
   written by the shape only the consent gate produced.
5. **`resolve_mcp_consent` checks the roles its contract declares.** It calls
   `assertOrgRole` with its `defaultRoles`, for the signed-in user or the API
   key's creator, as `resolve_approval` does. That person is recorded as the
   resolver and as the subject of the durable consent.
6. **Both contracts declare `mutates: true`.**

## Alternatives considered

- **Keep the tools and rely on the run check.** Rejected. The check misses the
  next turn, another run's row, and a mandate row, and a steered model can
  reach all three.
- **Refuse every call that carries a run.** It closes more than the run match,
  but it keys on a field a future caller may not set. Removing the surface
  closes the path for every model at the kernel, where no handler can forget
  the check. The run match stays as the targeted second line.
- **Tell a consent row apart by its capability name and missing columns.**
  Rejected. An external tool's rule-driven approval shares the name, and a
  rule that reads the absence of a digest or a resume key misclassifies the
  next writer that omits them. A recorded kind fails closed.
- **Require approval on the resolvers themselves.** Rejected. A resolution
  that needed approving could not terminate, as the v2 descriptor notes.

## Consequences

- The assistant can tell the person that a write or a consent request is
  waiting and where to decide. It cannot decide through either resolver.
- `apps/app` is unaffected, because its kernel seam names no surface.
  `apps/app_deprecated` passes `{ surface: "agent" }` from its approval and
  consent actions (`src/app/[orgSlug]/shell-actions.ts` and
  `src/app/[orgSlug]/[workspaceSlug]/sessions/actions.ts`), and the kernel now
  refuses those calls. That app is not deployed, and its tests mock the
  kernel.
- The API and MCP keep both capabilities for programs. An MCP call acts as
  the key's creator and carries no run, so an external agent that holds a
  person's key is bounded by the key, not by the run check.
- A consent request the consent gate wrote between the migration and the
  deploy of this change records `approval`, and `resolve_mcp_consent` refuses
  it. Such a request expires within five minutes, and the next call asks
  again. `resolve_approval` still answers it on Fleet.
- An API-key call to `resolve_mcp_consent` now records a durable consent for
  the key's creator. Before, it recorded none.
