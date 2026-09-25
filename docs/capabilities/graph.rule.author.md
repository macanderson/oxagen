# author_graph_rule

**Domain:** graph
**Mode:** sync
**Scope:** workspace (`scoped: true`)
**Surfaces:** api, mcp
**Sensitivity:** medium · **Default effect:** deny · **Roles:** org Owner, Admin; workspace Owner, Member
**Billing gate:** none · **Agent tool:** no

Contract: `packages/oxagen/src/contracts/graph.rule.author.ts`
Handler: `packages/agent/src/handlers/graph.rule.author.ts`
API: `POST /v1/:org_slug/:workspace_slug/graph/rule/author`
MCP: `author_graph_rule`

## Intent

Ask the in-app agent to author a relationship rule between nodes from two sources, such as a `Person` from `hubspot` who owns an `Account` from `stripe` (ADR-186). You name the rule as data. The server builds the instruction the model reads and the goal the verifier judges, and asks one [`ask_assistant`](assistant.ask.md) turn with both.

The goal is the proof that the rule works: a `query_ontology` traversal over the relationship type, from a node of the first source, returns a node of the second (`ruleAuthoringGoal` in `@oxagen/agent`, ADR-177). The engine works in rounds, and a verifier on another tier rules after each one whether the goal is met. The call returns when it is met, and refuses when the rounds run out first.

The rev1 app has no graph page, so no UI binds this capability. It is reached over the API and MCP, with the other `graph.*` capabilities (`apps/app/ARCHITECTURE.md` §0 item 1).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `rule.relationshipType` | string | yes | `^[A-Z][A-Z0-9_]{0,62}$`, e.g. `OWNS_ACCOUNT` |
| `rule.start.label` | string | yes | a letter, then letters, digits and underscores, at most 63 |
| `rule.start.source` | string | yes | a lowercase slug (`hubspot`) or plugin id (`oxagen/hubspot`) |
| `rule.end.label` | string | yes | as `rule.start.label` |
| `rule.end.source` | string | yes | as `rule.start.source`, and different from it |
| `note` | string | no | 1 to 4,000 characters after trimming. Added to the instruction, never to the goal |
| `conversationId` | uuid or `cnv_…` | no | the conversation to continue; null or omitted opens a new one |
| `turnId` | uuid | no | a key to stop the turn with [`cancel_assistant_turn`](assistant.turn.cancel.md) |

The input takes no goal. The server writes it from the rule, so a caller cannot loosen it.

## Output

| Field | Type | Description |
|---|---|---|
| `goal` | object | the goal the turn was judged against: `statement` and `maxRounds` (3) |
| `goalMet` | boolean | true when the verifier ruled the goal met; false when the person stopped the turn first |
| `turn` | object | the `ask_assistant` output, whole: `runId`, `conversationId`, `conversationPublicId`, both message ids, `reply`, `parkedCards`, `toolCalls` and `stopped` |

Open the run with `get_run` by `turn.runId`. Each round's verdict is on it as a `verification.goal_verdict` frame, with the verifier's reasoning as the frame's body.

## Behavior

1. The handler checks that the person asking holds one of the contract's roles, before any turn starts. An API key acts as its creator.
2. It builds the instruction and the goal from the rule, and invokes `ask_assistant` through the kernel. That turn runs its own gates, and is recorded as its own run on the `api-chat` surface.
3. The turn is not a governed action and is not billed as one. Each tool call inside it is a governed action through `invoke()`, and the turn's tokens are metered on the organization's funding source (ADR-053).
4. A governed write the turn opened that waits on a person comes back in `turn.parkedCards`. A write that is still parked has not reached the graph, so the query the goal names cannot return the node while it waits.

## Errors

| Code | Status | When |
|---|---|---|
| `validation_error` | 400 | the rule names one source twice, a name breaks its pattern, the note is blank or too long, or the body carries another field |
| (none) | 400 | the body is not JSON |
| `forbidden` (reason `no_principal`, `org_role_required`) | 403 | the caller carries no person to ask as, or the person holds none of the contract's roles |
| `engine_aborted` | 409 | the goal was still unmet after the last round, or a per-turn budget stop ended the turn. The verdicts stay on the run |
| `engine_unavailable`, `assistant_run_not_recorded` | 503 | as for `ask_assistant` |
| `insufficient_credits`, `billing_suspended`, `assistant_spend_cap` | 402 | the turn's credit gate refused it |

`ask_assistant`'s `not_found` (reason `conversation_not_found`) and `forbidden` (reason `kill_switch`) also pass through.
