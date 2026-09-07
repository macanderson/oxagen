# 4. Tacho's policy decision point is Cedar

- Status: accepted
- Date: 2026-08-31

## Context

Tacho's approval flow (design: `docs/design/tacho/approval-tokens.md`) needs a
policy engine in two places: locally in the collector, evaluating standing
grants with zero added latency, and centrally in the PDP, deciding elevation
requests with the agent's trust tier and request context as inputs. Insurers
and auditors additionally want to answer questions like "could this fleet
ever have been permitted a production database write" — statically, from the
policy text.

Candidates: OPA/Rego, Cedar, a bespoke rules DSL.

## Decision

**Cedar.**

- It is purpose-built for authorization: the principal/action/resource/context
  model matches "may this agent take this action on this resource, given its
  tier" one-to-one, with `permit`/`forbid` semantics where forbid always
  wins — the right default for an enforcement product.
- The evaluator is formally verified and the language is deliberately
  analyzable: policy analysis can statically answer reachability questions,
  which is exactly the audit and underwriting requirement. Rego is a general
  Turing-adjacent query language; equivalent analysis is undecidable in
  general.
- The reference implementation is a Rust crate, which drops into Stella and
  the collector natively; bindings exist for the other wrapper languages.
- A bespoke DSL fails SCR-002 on its face: it is the cheap-and-easy option
  whose cost arrives in year three.

Trust tiers enter as a context attribute (`context.trust_tier`), so
enterprises tune auto-approval thresholds in policy without Tacho code
changes.

## Why durable

Authorization logic outlives every service that evaluates it. Choosing a
language whose semantics are formally specified and whose policies are
analyzable means the policy corpus an enterprise accumulates remains a
portable, auditable asset; the engine can be swapped, the corpus survives.
The analyzability property is also what makes the insurance story honest —
"we can prove what was never permitted" — and that claim must still hold in
ten years.

## Consequences

- Cedar's schema discipline (entity types, action groups) must be maintained
  as the canonical action vocabulary grows; the caveat/action catalog in the
  design docs is the seed of that schema.
- Rego shops integrating Tacho must translate existing policies; a mapping
  guide is residue for the implementation phase.
