# ADR-087: The Neo4j tenancy seam constructs scoping rather than validating it

- **Status:** Proposed
- **Date:** 2026-09-17
- **Owners:** platform, knowledge
- **Related:** #2974 (Neo4j tenancy seam guard), PR #3193, ADR-042 (data planes),
  `packages/ontology/src/tenant.ts`, `packages/ontology/src/graph-scope.ts`,
  SCR-002 (durability first)

## Context

`scopedSession()` is the single chokepoint every Neo4j query in the platform
passes through. It injects `$orgId` / `$workspaceId` into every call and, before
running, inspects the caller's Cypher **text** for evidence that the query is
scoped to the caller's organisation.

That inspection was six versions deep by the time this ADR was written, each one
a response to a reviewer finding a query that satisfied it and read across
tenants:

| version | the rule | what it still accepted |
|---|---|---|
| 1 | `orgId` appears anywhere, raw text | the token in a comment, a string literal, a `RETURN … AS orgId` alias |
| 2 | `orgId` beside `:` or `=`, comments and literals stripped | `MATCH (n) SET n.orgId = $orgId` — reassigns every tenant's nodes to the caller |
| 3 | only in a filtering position, decided by bracket depth | `RETURN n, head([{allowed: n.label IN $__scopeLabels}])` |
| 4 | filtering position, decided by bracket kind | `MATCH (n) WHERE n.orgId = $victimOrgId RETURN n` |
| 5 | the anchor must bind the seam's own `$orgId` | `MATCH (n) CREATE (m {orgId: $orgId})`; `MATCH (n) RETURN n, ({orgId: $orgId})` |
| 6 | pattern maps count only in row-selecting clauses | — (this is where the guard stands) |

Six rounds, six real holes, one shape: each version was a more precise lexical
rule, and each time there was another expression form that satisfied it.

## The finding

**The property the seam wants is not syntactic, so no syntactic check decides
it — and that includes a full Cypher parse.**

The guard answers: *does a seam-bound tenant filter appear somewhere the grammar
lets it narrow rows?* What the platform needs is: *is every row this query reads
or writes inside the caller's organisation?* Those come apart, and not at the
margins:

```cypher
MATCH (a:GraphNode {orgId: $orgId}) MATCH (b:GraphNode) RETURN b
```

The anchor is real: seam-bound `$orgId`, inline pattern property, in a
row-selecting clause. Every condition above is satisfied. It returns every
tenant's nodes.

A parser does not help here. A parser reports structure, and this structure is
correct; what is wrong is reachability, a semantic property of the whole query.
Parsing would have caught five of the six historical holes — all the ones that
were really misread grammar — and would not have caught the sixth (the parameter
binding, which is a check *on top of* a parse), nor this one.

Four such queries are asserted as accepted in
`packages/ontology/src/tenant.scope-guard.test.ts`, so the limitation is a
recorded property of the seam rather than something the next reviewer
rediscovers.

### Why the test suite kept saying the guard was sound

Across the six rounds the mutation table reached **0 survivors three times** —
on three different guards, each of which permitted a cross-tenant read. That is
worth stating as a general caution and not just a fact about this file:

> A mutation score is evidence about the mutants you wrote. Every mutant here
> was a mangling of the filter — a weaker regex, a dropped sanitiser, a coarser
> position rule — and none was a query that satisfies the filter and still
> leaks. So the score measured how well the tests detect damage to the check,
> and never whether the check measures the right thing. A check can score
> perfectly on the thing it does not measure.

The cases that actually moved the work forward were never found by mutation.
Each came from a reader constructing a query that passes. That asymmetry is the
reason this ADR concludes the dimension is wrong rather than that the rule needs
another refinement.

## Decision

**Stop treating the lexical guard as the enforcement mechanism, and move the
guarantee to construction.**

1. The guard in `tenant.ts` stays, is documented in the code as a lint that
   cannot be sound, and keeps its recorded-limitation tests. It catches the
   common authoring mistake — a query with no tenant filter, or one bound to a
   caller-controlled parameter — and it is cheap. It is defence in depth.
2. The seam becomes responsible for the scoping it currently looks for. The
   corpus is bounded and known — **63 queries across 16 files** — which is what
   makes this tractable. Queries reach `run()` through a builder that emits the
   tenant predicates, and the seam accepts what the builder produced rather than
   inspecting what a caller wrote. "Is this query scoped?" becomes "did the seam
   scope it?", which is decidable because it is a question about provenance.
3. The live two-tenant isolation rig from #2974 is the acceptance test for (2),
   not a substitute for it: it detects a leak, it does not prevent one.

## Alternatives considered

**Parse the Cypher.** Rejected as the primary answer. It buys accuracy on
grammar-misreading at the cost of a dependency and substantial surface, and it
does not change the category: the unsound cases above parse correctly. Worth
revisiting only as an implementation detail inside (2).

**Keep refining lexically.** Rejected. Six rounds is sufficient evidence about
the method. A seventh rule would close a seventh case and tell us nothing about
the eighth.

**Strengthen to "every row-selecting clause carries an anchor."** Considered and
deliberately declined for the interim. It would close two of the four recorded
limitations and is implementable with the machinery already in `graph-scope.ts`.
It is declined because it is another approximation — it does not close the
traversal case (`MATCH (a {orgId: $orgId})-[*1..3]-(b)`), it adds surface that
(2) deletes, and shipping it would mean claiming progress on a dimension this
ADR concludes is the wrong one.

**Enforce in the database.** Neo4j has no row-level security. The real analogue
is a database per tenant or a composite database with per-tenant roles, which is
ADR-042 data-plane work at a much larger scale. Not rejected on merit — out of
scope here, and (2) is a prerequisite for making the query layer ready for it.

## Consequences

- The guard's docstring and this ADR say plainly that it is best-effort. Nothing
  should cite it as the tenancy guarantee, in an audit or a security review.
- Until (2) lands, cross-tenant isolation on the graph rests on the correctness
  of 63 hand-written queries, all of which currently anchor correctly. That is
  the honest status.
- (2) is a bounded project with its own issue and a definition of done covering
  the builder, the migration of all 63 call sites, the seam change, and the rig.
