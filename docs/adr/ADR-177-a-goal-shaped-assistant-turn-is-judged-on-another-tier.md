# ADR-177: A goal-shaped assistant turn is judged on another tier, and each verdict is on the run

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Related:** ADR-053 (the in-app agent on `stella-serve`), ADR-058 (what a
  run's evidence retains), the in-app agent spec
  (`docs/specs/in-app-agent-on-stella-serve/spec.md` §5 slice 4 and §6),
  issue #4175, #2968 item 3c, ADR-182 (the rule-authoring caller,
  `author_graph_rule`).

## Context

The in-app agent authors rules that relate nodes from two sources, and it
drives the schema builder (ADR-053). A turn that does either used to end when
the model stopped. Nothing checked the result against what the person asked
for.

Stella's engine already has the check. `goal` on `POST /v1/turns` makes a turn
a judged run (`crates/stella-serve/src/routes.rs`, `GoalSpec`, lines 127-151).
`drive_goal` (`crates/stella-serve/src/goal.rs`, lines 92-208) runs a working
round, asks an independent verifier whether the goal is met, and either ends
the turn or sends the verifier's feedback back to the worker. The round cap
defaults to 8 and the server clamps it at 32 (`routes.rs` line 184). The
verifier is a read-only sub-agent of up to 8 steps
(`crates/stella-core/src/goal.rs`, lines 358-440). Its model calls reach the
host as `provider_request` frames with `role: "verdict"` (`session.rs` line
808). After each round the engine emits one `goal_verdict` event with the
round, `met`, the verifier's reasoning and its cost (`goal.rs` lines 171-176).
A met goal ends the turn completed, with the reasoning as the outcome's text.
An unmet goal at the cap ends it aborted with the reason named.

The wire docs, the serve routes and the protocol crate are the same at the
pinned 0.9.411 and at 0.9.414.

Three things had to be decided on Oxagen's side: who may set a goal, how large
it may be, and where the verdict lives.

## Decision

### 1. The caller of `ask_assistant` sets the goal. The model never does.

`goal` is an optional field on `ask_assistant`'s input. The person or the
program asking for the turn states what done means. `ask_assistant` is on the
`api` and `mcp` surfaces and not on `agent`, so no model can call it and so no
model can set or loosen its own goal. A goal grants nothing. It adds verifier
rounds, and every tool call inside every round still goes through
`kernel.invoke()` with the asking person's IAM.

### 2. A goal is at most 2,000 characters and 4 rounds.

The engine writes the statement into every round's kickoff and feedback
message and into each verifier call's instruction, so it is paid for once per
round on both tiers. A goal is the test the result must pass, and 2,000
characters holds one with room to spare. It also records whole under the run
spec's 8,192-character goal.

Each round is a whole turn of up to 12 steps plus a verifier of up to 8, and a
person is waiting on the reply. Four rounds bounds the worst case at 48 worker
steps. Three is the default: author the rule, prove it, and one round to
recover. The per-turn budget guard still applies to every round.

### 3. The verifier runs on another tier, chosen by the frame's role.

The host sends no `verifier_provider_id`. `modelForRole`
(`packages/agent/src/runtime/engine/provider.ts`) already answers `verdict` on
the precise tier, or on balanced when the worker is on precise. A verifier
that shares the worker's model is not an independent judge, and routing by
the role the engine stamps on every verifier call keeps that choice in one
place.

### 4. Each round's verdict is a `verification.goal_verdict` frame.

The run ledger registers `verification.goal_verdict` in the verification
stage, content class `verification_receipt`. The inline payload is the engine
frame's `seq`, the round, `met`, the digests of the goal and of the reasoning,
and the verifier's cost in integer micro-dollars. The goal and the reasoning
are the frame's body, so a reader can see why the verifier ruled as it did.
It is not `verification.completed`, which is one verification of an attempt:
a goal turn has one verdict per round and only the last can be met.

The verdict is written before the seal. A verdict that cannot be recorded
cancels the turn, the same as any other receipt, so a goal-shaped turn never
answers from a judgment the record does not hold.

The run spec's `goal` is the goal statement when one is set, and the
instruction otherwise. The seal keeps `verdict: waived`. The seal's verdict
vocabulary names witness results (a flip, a failing check), and a model's
opinion of a transcript is not a witness.

### 5. Rule authoring is the first caller.

Rule authoring has no page of its own. It happens in the in-app turn, with the
schema and graph tools the belt holds. `ruleAuthoringGoal`
(`packages/agent/src/runtime/rule-authoring-goal.ts`) builds the goal for a
rule across two sources: a `query_ontology` traversal over the rule's
relationship type, from a node of the first source, returns a node of the
second. A caller that asks for a rule sends that goal. The flyout sends none
yet, because it has no control that says "this turn authors a rule", and the
graph pages are out of scope for rev1 (the maintainer's scope note of
2026-09-14 on #2968).

## Consequences

- A goal-shaped turn whose goal is not met at the cap fails with
  `engine_aborted`, and nothing is saved as a reply. Its verdicts stay on the
  run.
- The reply of a met goal is the worker's last answer. The verifier's
  reasoning is the engine's outcome text and the frame's body.
- `POST /chat/stream` builds its input field by field and does not carry
  `goal` yet. The API route and the MCP tool pass the whole input through.

## Alternatives

**Let the model set a goal through a tool.** Rejected. A worker that writes
its own acceptance test grades its own work, which is the property the goal
loop exists to remove.

**Send `verifier_provider_id`.** Rejected. It would be a second place that
decides the verifier's model, beside `modelForRole`, and the two could
disagree.

**Record verdicts as `verification.completed`.** Rejected. Its `verdict`
enum has no "not yet", and a round the verifier sends back is not a failed
verification.
