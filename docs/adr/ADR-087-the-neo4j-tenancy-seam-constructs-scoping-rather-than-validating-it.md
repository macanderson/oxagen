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
| 6 | pattern maps count only in row-selecting clauses | `MATCH (n:GraphNode {orgId: $orgId}) MERGE (audit {allowed: n.label IN $__scopeLabels}) RETURN n` |
| 7 | a `MERGE` map counts only when nothing before it bound a graph variable | `MATCH (n) SET n.x = $where, n.orgId = $orgId` — a parameter named like a clause keyword moves the clause state |
| 8 | clause keywords recognised only at clause boundaries; the scope guard gets a stricter projection than the tenancy guard | `MATCH (n) RETURN EXISTS { MATCH (m) WHERE m.x = 1 } AS ok, n.orgId = $orgId AS mine, n` |
| 9 | clause state saved and restored across braces; every token boundary drawn with Cypher's Unicode identifier classes | — (this is where the guard stands) |

Seven rounds, seven real holes, one shape: each version was a more precise
lexical rule, and each time there was another expression form that satisfied it.

Round 7 is the sharpest illustration, because round 6 had already seen it and
did not recognise it. Round 6 removed `CREATE` from the row-selecting clauses —
its map stamps a node being made, so it cannot narrow rows already in play — and
left `MERGE` in, because a `MERGE` map genuinely is a match-or-create predicate
on the thing it merges. Both readings are correct. What was missed is that they
are about different variables: `MERGE (n {orgId: $orgId})` constrains `n`, and
`MERGE (audit {…})` after `MATCH (n …)` constrains `audit` while `n` — the rows
the query actually exposes — goes unnarrowed. The finding was reported about
`CREATE`; the property was about clauses whose maps cannot narrow an
already-bound variable, and `MERGE` is one of those whenever something is
already bound.

A position-based rule cannot separate those two cases, because the difference is
whether the variable in the map is bound elsewhere, which is scope and not
position. So the guard does not try. It admits a `MERGE` map only when **no
earlier clause has bound a graph variable** — the case where every variable in
the merged pattern is new and there is nothing else for the map to have failed
to narrow. `UNWIND` does not count as binding: it draws values from a parameter
list, not rows from the graph.

The alternative — dropping `MERGE` outright — was measured rather than guessed.
Against the 63 production scoped-Cypher strings the corpus test collects, it
rejects **5**: two in `packages/agent/src/dispatch/tool-projection.ts`, one in
`packages/agent/src/memory/neo4j.ts`, two in
`packages/ingestion/src/mutations/upsert-entity.ts`. Every one is a first-clause
upsert that does anchor the tenant, and one of them is the core entity-ingestion
path, so that option breaks ingestion to close a hole the conditional rule also
closes. The conditional rule rejects **0 of 63**.

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

Five such queries are asserted as **accepted** in
`describe("tenancy guard — KNOWN cross-tenant reads it accepts")` in
`packages/ontology/src/tenant.scope-guard.test.ts`, so the limitation is a
recorded property of the seam rather than something the next reviewer
rediscovers. Round 7 changed that list rather than lengthening it: `MATCH (n)
MERGE (m:GraphNode {orgId: $orgId})` moved out of it and is now rejected, and
`MERGE (a:GraphNode {orgId: $orgId}) WITH a MATCH (b) RETURN b` took its place —
the same unanchored-second-MATCH class the first entry already records, reached
through a `MERGE` anchor instead of a `MATCH` one.

That is the shape to expect from every further round: the accepted list changes
composition and does not empty. **Round 7 closes one reachable expression form,
not the class.** #3199 carries the fix that closes the class — the seam
constructing the scoping instead of validating someone else's.

### Why the test suite kept saying the guard was sound

Across the first six rounds the mutation table reached **0 survivors three
times** —
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

### Rounds 8 and 9, and the distinction they force

Rounds 8 and 9 are not more of rounds 1–7, and saying why changes what this ADR
asks for. **Two different claims are tangled together in this seam, and they
have different answers.**

**Claim A — lexical.** *The token I matched is the token I think it is, in the
position I think it is.* Every one of these was a Claim-A failure: `orgId` inside
a comment or a string (round 1), a map brace misclassified by nesting depth
(round 3), `(` after a comma read as a node pattern (round 5), `$where` read as
a clause keyword (round 7), a `WHERE` inside `EXISTS { … }` still in force after
the closing brace (round 9a), and `$orgIdé` satisfying a `\b`-delimited
parameter match (round 9b).

Claim A **is decidable by a scanner**, and the set of constructs it must
understand **is bounded and enumerable**: it is the openCypher lexical grammar —
comments, the three quoted forms and their escapes, parameters, the Unicode
identifier classes (`IdentifierStart = ID_Start | Pc`, `IdentifierPart =
ID_Continue | Sc`), and the bracket/brace nesting that delimits clause scope.
That is a finite document.

The reason Claim A kept failing anyway is method, not category. The scanner was
built by **enumerating hazards discovered in review** rather than by
**implementing the grammar's lexical rules**. Enumerating the dangerous is
unbounded by construction; implementing a lexer is bounded, because you can hold
the result against the grammar rather than against the last reviewer. Round 9 is
the clearest case: `\b` is not a near-miss of Cypher's rule, it is a different
rule from a different language, and `[A-Za-z0-9_]` in the word scanner was the
same substitution in a second place. Both were found by a reader, one at a time,
because nothing in the file was accountable to the grammar.

Round 9 also shows the cost of the substitution precisely. The bare-alias class
(`RETURN n AS where`) was recorded as unreachable *because Cypher reserves the
word* — an external fact this seam does not verify. `whereé` is not reserved, the
database accepts it, and an ASCII word scan handed the seam the keyword `WHERE`
with the tail left behind. The unreachable class became reachable for the price
of one accent, and the argument that it was unreachable never mentioned the
lexer it depended on.

**Claim B — semantic.** *Every row this query reads or writes is inside the
caller's organisation.* This is the claim the platform actually needs, it is what
the guard is cited for, and it is **not decidable by any syntactic check,
scanner or parser** — the argument is unchanged and is in **The finding** above.
Rounds 2, 6 and the seven residual classes enumerated on `assertScopeMarkers` are
Claim-B failures, and a perfect Claim-A implementation closes none of them.

**So: can the scanner be made sound?** For Claim B, no, and these two fixes are
not claimed to be the last of anything — they are two reachable expression forms,
closed. For Claim A, yes in principle, and not by this file's method. What
remains open in Claim A after round 9, from the file itself: a bare identifier
spelled *exactly* like a clause keyword is still decided by the database's
reserved-word list rather than by this code; `stripLiteralsAndComments` does not
resolve `\uXXXX` escapes, which is the same family as the `\u0060` finding
already made against `schema.reconcile.ts` in this PR; and constructs the scanner
has never heard of (GQL quantified path patterns, `CASE … END`, `FOREACH ( … | … )`)
carry braces and clause-like words that no rule in the file is written against.
None of those is a demonstrated bypass today. That is the point: neither was
`whereé`, the day before it was.

The strongest evidence for all of this came from round 9 correcting itself.
Replacing `\b` and `[A-Za-z0-9_]` with Cypher's Unicode classes fixed the
character classes and left the word scan walking the string one **UTF-16 index**
at a time. Every identifier character outside the BMP — U+1D431 MATHEMATICAL
BOLD SMALL X, and `ID_Continue` covers the block — still arrived as a lone
surrogate, matched no Unicode property, and still split the name, so
`RETURN n AS where𝐱` still handed the seam the bare keyword `WHERE`. The fix
aimed at the demonstrated example (an accented letter) and the defect was about
the grammar (a code point), so a third encoding of it survived the fix meant to
close the class. It was found by auditing the fix rather than by review, which is
the only reason it is closed in the same PR instead of being round ten.

### What follows

This does **not** change the decision below — it strengthens the case for it and
narrows what any interim work should be.

- Decision (2), the seam constructing the scoping, deletes **both** claims. A
  query the seam built needs no lexical analysis to be trusted and no semantic
  analysis to be proved: provenance is decidable, and it is the only option on
  the table that is.
- If an interim strengthening is ever wanted, it is **implement the lexer**, not
  add rule ten. A token stream produced against the openCypher lexical grammar,
  with clause scope tracked on the bracket/brace stack, replaces a growing list
  of special cases with something that can be held against a specification. It
  is bounded work and it would have prevented rounds 1, 3, 5, 7, 9a and 9b as a
  class rather than one at a time.
- **Refusing anything outside a known-safe subset** — fail closed on shapes the
  guard cannot certify — was weighed and is the weakest of the three. The corpus
  is 63 queries across 16 files, so whitelisting shapes costs roughly what the
  builder in (2) costs while leaving the guarantee in the wrong place; and a
  refusal decided by a lexer nobody trusts is still a decision by a lexer nobody
  trusts.

Neither interim option should be built ahead of (2), and neither was built in
PR #3193, which closed two demonstrated P1 bypasses and nothing more.

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

**Keep refining lexically.** Rejected as the answer, while round 7 was still
shipped as a fix. The distinction is the point: a round closes a reachable
expression form, which is worth doing for a form a reviewer has demonstrated,
and tells us nothing about the next one. Seven rounds is sufficient evidence
about the method.

**Strengthen to "every row-selecting clause carries an anchor."** Considered and
deliberately declined for the interim. It would close two of the five recorded
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
