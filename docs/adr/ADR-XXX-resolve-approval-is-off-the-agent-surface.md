# ADR-XXX: `resolve_approval` is off the agent surface

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Related:** ADR-059 (mandates, and who answers a call a mandate parked),
  ADR-115 (`resolve_approval` is the one billed action of the approvals
  surface), ADR-118 (approved built-in calls resume once), finding 9 of
  #3370.

## Context

The in-app assistant runs each turn as the person who typed
(`runPreparedTurn` in `packages/agent/src/runtime/assistant-turn.ts`). Its tool
calls carry that person's user id, no API key, and no agent principal. A write
whose contract sets `agent.requiresApproval` parks. `materializeTools` writes
an approval row that records the turn's message and run (`run_public_id`),
then refuses the call with a message that names the approval id.

`resolve_approval` was on the `agent` surface, rated low risk, with no approval
of its own, so the belt offered it to the same model. Its handler checked the
caller's role, which is the person's role. It refused an agent principal only
on a row a mandate parked. A chat row has no mandate, and the assistant is not
an agent principal.

A test proved the path on `main` at `eace536`
(`packages/agent/src/handlers/agent.approval.resolve.self-approval.test.ts`,
with the real kernel, contracts, `materializeTools`, `createApprovalRequest`
and handler). A turn parked `revoke_api_key`. The same belt then called
`resolve_approval` with the id the refusal had named, and the call returned
`{ approvalId, resolution: "approved", mandate: null }`. Under ADR-118 an
approval queues the stored call for the resume worker, so the parked write
would have run with no person deciding.

A check keyed on the run does not close this by itself:

- Each assistant turn opens its own run. The next turn in the same
  conversation carries a different run and could approve what the previous
  turn parked.
- The same model could approve a call another run parked, a mandate row
  included, because the person holds the role and the assistant is not an
  agent principal.
- Text in any tool result can steer the model to do either.

## Decision

1. **`resolve_approval` is not on the `agent` surface.** The contract lists
   `api` and `mcp`. The belt does not offer it to a model, and the kernel
   refuses a call that names the `agent` surface with `surface_denied`. The v2
   descriptor (the Appendix E target, #2884) drops `agent` as well, so the
   cutover keeps this decision.
2. **A person decides, in the app.** Fleet, the Run page and the shell's
   approvals drawer call the capability through the app's kernel seam, which
   names no surface. Approve and Deny in the assistant's thread, when they
   come, act as the person through the same seam. They are buttons the person
   presses, not a tool the model calls.
3. **The handler refuses a run that answers its own approval.** It reads
   `run_public_id` from the row and the run the kernel resolved for the call
   (`ctx.runId`: the caller's `opts.runId`, the outer handler's run, or the
   agent run). It reads an internal `agent_runs.id` back to its public id with
   `resolveRunPublicId`, the read the park made. When the two match, the call
   is refused `forbidden` with reason `run_cannot_resolve_own_approval`, and
   the message sends the person to Fleet. A row with no recorded run, or a
   call with no run, passes this check. It is a second line for any caller
   that carries a run on a surface that still lists the capability.
4. **The contract declares `mutates: true`.** It writes the resolution and, on
   a denied mandate row, releases the reservation.

## Alternatives considered

- **Keep the tool and rely on the run check.** Rejected. The check misses the
  next turn, another run's approval, and a mandate row, and a steered model
  can reach all three.
- **Refuse every call that carries a run.** It closes more than the run match,
  but it keys on a field a future caller may not set. Removing the surface
  closes the path for every model at the kernel, where no handler can forget
  the check. The run match stays as the targeted second line.
- **Require approval on `resolve_approval` itself.** Rejected. A resolution
  that needed approving could not terminate, as the v2 descriptor notes.

## Consequences

- The assistant can tell the person that a write is waiting and where to
  decide. It cannot decide through `resolve_approval`. The last consequence
  below names another path this record leaves open.
- `apps/app` is unaffected, because its kernel seam names no surface.
  `apps/app_deprecated` passes `{ surface: "agent" }` from its approval
  actions (`src/app/[orgSlug]/shell-actions.ts` and
  `src/app/[orgSlug]/[workspaceSlug]/sessions/actions.ts`), and the kernel now
  refuses those calls. That app is not deployed.
- The API and MCP keep the capability for programs. An MCP call acts as the
  key's creator and carries no run, so an external agent that holds a
  person's key is bounded by the key, not by the run check.
- `resolve_mcp_consent` is still on the `agent` surface, and its handler
  resolves any pending approval row by its uuid, not only a consent row, with
  no role gate. A probe on this change showed the turn's model can call it on
  the parked write's approval. The row then reads `approved` by the person.
  `resume_status` stays `waiting`, so the resume worker does not run the
  write, but the row records a person's approval of that exact call. This
  record does not change `resolve_mcp_consent`, and it needs the same
  decision.
