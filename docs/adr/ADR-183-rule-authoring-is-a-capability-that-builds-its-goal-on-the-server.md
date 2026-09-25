# ADR-183: Rule authoring is a capability that builds its goal on the server

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Related:** ADR-053 (the in-app agent on `stella-serve`), ADR-177 (a
  goal-shaped assistant turn), ADR-176 (the flyout's stream), the in-app agent
  spec (`docs/specs/in-app-agent-on-stella-serve/spec.md` §5 slice 4 and §6),
  `apps/app/ARCHITECTURE.md` §0 item 1 (the 2026-09-14 scope note), issue
  #4175.

## Context

ADR-177 gave `ask_assistant` an optional `goal` and named rule authoring as
its first caller. `ruleAuthoringGoal(rule)` in `@oxagen/agent` builds that
goal: a `query_ontology` traversal over the rule's relationship type, from a
node of the first source, returns a node of the second. Nothing called it. An
API or MCP caller could send a goal, but only by writing the statement itself,
so each caller would carry its own copy of the acceptance test, free to loosen
it or to leave it off.

The last item of #4175 is "Rule authoring sends a goal." Three callers were
weighed.

1. **A capability that takes the rule as data.** The caller names the
   relationship type and the label and source at each end. The handler builds
   the instruction and the goal on the server and asks one `ask_assistant`
   turn with both.
2. **A control in the assistant flyout.** The flyout collects the two ends and
   the relationship type and sends the turn with the goal over the existing
   stream.
3. **Both**, with the flyout sending the capability's input shape.

Two facts decide it. The rev1 app builds no graph or ontology page, and the
`graph.*` and `ontology.*` capabilities stay on the API and MCP (the
maintainer's scope note of 2026-09-14, `apps/app/ARCHITECTURE.md` §0 item 1). A
flyout form that collects node labels, sources and a relationship type is a
graph-authoring page in a smaller frame, so the second and third options build
what that note cut. And every feature in this repository is a capability that
every surface reaches through `invoke()`. A rule-authoring caller that lives
only in one client's code is the one shape no other surface can reuse.

## Decision

### 1. `author_graph_rule` is the rule-authoring caller.

The contract (`packages/oxagen/src/contracts/graph.rule.author.ts`) takes a
`rule` of `relationshipType`, `start` and `end`, each end a node `label` and a
`source`, plus an optional `note`, `conversationId` and `turnId`. The handler
(`packages/agent/src/handlers/graph.rule.author.ts`) builds the instruction
with `ruleAuthoringInstruction` and the goal with `ruleAuthoringGoal`, and
invokes `ask_assistant` through the kernel with both. It returns the goal, a
`goalMet` flag, and the `ask_assistant` output whole.

The capability is on the `api` and `mcp` surfaces. The API route is
`POST /v1/:org/:ws/graph/rule/author`.

### 2. The server writes the goal. The caller writes none.

The input has no `goal` field, and the contract refuses one. The instruction
and the goal are built from the same rule in one module, so the worker and the
verifier work to the same test. The `note` is added to the instruction, marked
as the person's, and never reaches the goal, so a note cannot relax the test.

### 3. The turn is `ask_assistant`, invoked through the kernel.

The nested invoke runs `ask_assistant`'s gates, admits the turn as its own
run, records each round's verdict as a `verification.goal_verdict` frame
before the seal, and keeps its refusal codes. Nothing about recording,
metering or the verifier's tier is copied. The handler asserts the contract's
roles itself before it asks for the turn (INV-29), because the kernel's IAM
check allows every capability for a non-enterprise organization.
`author_graph_rule` carries `ask_assistant`'s roles, sensitivity and
`noBillingGate`: the turn is not a governed action, and each tool call inside
it is one (ADR-053 §1).

### 4. `goalMet` reads how the turn ended.

The engine ends a goal-shaped turn completed only on a met verdict. A goal
still unmet after the last round ends it aborted, and `ask_assistant` refuses
with `engine_aborted`, so no output comes back. A turn that returns is met,
unless the person stopped it with `cancel_assistant_turn`, which ends it
before a met verdict. So `goalMet` is `!turn.stopped`. The verdicts
themselves, with the verifier's reasoning, stay on the run, which `get_run`
opens by `turn.runId`.

### 5. The rule spans two sources, and every name is checked.

The two sources must differ. A relationship inside one source is a schema
relationship, which `upsert_schema_relationship` writes without a turn. The
relationship type matches `RELATIONSHIP_TYPE_PATTERN`, each label matches
`LABEL_PATTERN`, and each source is a lowercase slug or a plugin id. These
names are written into the goal the verifier reads and the message the model
reads, so the contract refuses anything else before a turn starts. At these
lengths the goal statement stays under `ASSISTANT_GOAL_MAX_CHARS`.

### 6. It stays off the `agent` surface, and no app UI binds it yet.

`author_graph_rule` starts an assistant turn. The assistant does not start its
own turns, for the same reason ADR-177 keeps `ask_assistant` off that surface.
When a graph page returns to the app, its control calls this capability and
sends the same input. It does not build a goal of its own.

## Consequences

- Rule authoring sends `ruleAuthoringGoal(rule)` on every call, from the API
  and from MCP. `packages/agent/src/handlers/graph.rule.author.test.ts`
  proves it through the real kernel: the input `ask_assistant` receives,
  parsed against its own contract, carries that goal.
- The flyout still sends no goal, and `POST /chat/stream` still carries one
  only when its caller sends it.
- A future schema-builder caller follows the same shape: a capability that
  takes the schema as data and builds its goal on the server.
- `LABEL_PATTERN` (`packages/oxagen/src/lib/label-pattern.ts`) gains its first
  importer. It validates input. It is still not the guard that Cypher label
  seams run.

## Alternatives

**A flyout control (option 2).** Rejected for rev1. It builds graph-authoring
UI the scope note cut, it reaches only the people in the app, and it would
build the goal in client code.

**Both (option 3).** Rejected for now for the same scope reason. The
capability's input is what a later control sends, so that option stays open
without a second place that writes the goal.

**A `rule` field on `ask_assistant`.** Rejected. It would give one contract two
jobs, a conversation turn and a graph write, with fields that apply only to
one. A capability of its own names the action in the audit record, in IAM and
in the MCP tool list.

**Let callers send `ruleAuthoringGoal`'s text through `ask_assistant`.**
Rejected. Every caller would hold its own copy of the test, and a caller that
omits or edits it gets an unjudged turn that reads as rule authoring.
