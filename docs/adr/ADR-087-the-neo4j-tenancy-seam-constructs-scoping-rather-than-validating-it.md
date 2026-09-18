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
| 9 | clause state saved and restored across braces; every token boundary drawn with Cypher's Unicode identifier classes | `MATCH (n) WHERE {orgId: $orgId} IS NOT NULL RETURN n` — an always-true predicate whose map KEY satisfied the anchor |
| 10 | a brace is classified `pattern` / `subquery` / `map`, and nothing inside a map literal counts | `WITH $orgId AS orgId … WHERE orgId = $orgId`; `WHERE true = ({orgId: $orgId} IS NOT NULL)` |
| 11 | the anchor must be a property access or a pattern-map key; a bracket opens a pattern only in a graph-pattern clause | `MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> [])` |
| 12 | a brace is tested for SUBQUERY before PATTERN MAP | — (this is where the guard stands) |

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

### Round 10, and the first round found by enumeration rather than by example

Round 10 is a Claim-A failure like 9, and it is the first one where the response
was to **enumerate the positions from the grammar** instead of closing the
encoding that was reported.

`keepFilteringPositions` keeps a `WHERE` clause whole. A map literal written
inside one therefore handed the guard its key:

```cypher
MATCH (n) WHERE {orgId: $orgId} IS NOT NULL RETURN n
```

The predicate is a non-null test on a map that is always non-null, so it returns
every tenant's nodes, and `orgId: $orgId` in a kept `WHERE` satisfied the anchor.
Review demonstrated that one. Listing where `orgId` and `$orgId` can sit adjacent
without constraining the matched variable found **eleven**, every one accepted:
bare in a `WHERE`, parenthesised, as a function argument, inside a list literal,
produced by a list comprehension, compared against a property, as a map
PROJECTION (`n{…}`), inside a `CASE`, inside a subquery's own `WHERE`, as a map
VALUE holding the whole comparison, and nested one level inside a genuine pattern
map. The scope-marker guard had the identical hole.

All eleven are one rule, and the rule is about what ENCLOSES the brace, which is
why a regex could never have reached it: `{orgId: $orgId}` and
`(n {orgId: $orgId})` differ in nothing else. Cypher gives a brace exactly three
meanings — a pattern property map, a subquery (`CALL`, `EXISTS`, `COUNT`,
`COLLECT`, and no others), and a map literal — so the scanner now classifies each
`{` as one of the three on the bracket stack it already maintained, and nothing
inside a map literal counts for either guard. The list of subquery introducers is
closed because the grammar closes it; a fifth would be a language change rather
than another hazard someone happened to find.

This is what the ADR's recommendation looks like in practice, at the scale of one
rule. Eleven encodings, ten of them never reported, closed in one round by asking
the grammar what a brace can mean instead of asking the reviewer what they tried.

### Round 11, and a correction to round 10's own conclusion

Round 11 produced two findings, and **neither is a map-literal position** — the
construct round 10 enumerated. That matters more than either fix.

**Finding one: the anchor never required a property access.** A query may bind a
variable named `orgId`, and the anchor becomes a tautology:

```cypher
WITH $orgId AS orgId MATCH (n) WHERE orgId = $orgId RETURN n
```

Three spellings of it (`WITH`, `UNWIND`, a `WITH` after a `MATCH`), plus two
through a parameter (`$p.orgId = $orgId`, where the caller supplies the map).
The guard now requires one of the two shapes Cypher actually gives an anchor:
`<variable>.orgId = $orgId`, or `orgId: $orgId` as a pattern-map key.

**Finding two: a grouping bracket was read as a pattern bracket.** `opensPattern`
decided pattern-ness from the single character before the bracket — `,`, `-`,
`>`, `<`, `=`, `|`, `(`, `[`. Every one of those is ordinary expression syntax as
well as pattern syntax, so **all eight** were bypasses of round 10's fix:

```cypher
MATCH (n) WHERE true = ({orgId: $orgId} IS NOT NULL) RETURN n
```

The `(` follows `=`, read as `MATCH p = (a)`; the brace inside became a pattern
property map rather than a map literal, `mapDepth` never rose, and the always-true
predicate anchored the tenant.

#### What this does to round 10's claim

Round 10 said Claim A is "the openCypher **lexical** grammar", that it is bounded
and enumerable, and that the fix for the method is to **implement the lexer**.
Finding two falsifies the prescription, and it is worth stating plainly rather
than leaving in a commit message.

**A lexer would not have prevented it.** A lexer tokenizes: it returns `LPAREN`
and stops. Whether a `(` opens a node pattern or groups an expression is a
question about which *production* is being parsed — syntax, not lexis. Round 10's
own remedy, applied perfectly, leaves finding two exactly where it was.

So the boundary drawn in round 10 was in the wrong place. The corrected version:

- **Claim A is not lexical, it is syntactic.** The questions this guard asks —
  which clause are we in, is this bracket a pattern, is this brace a map, is this
  token a property access — are all grammar-production questions. Bounded, yes,
  and enumerable from the grammar, yes. But the artifact that answers them is a
  **parser**, not a lexer, and ADR-087 already weighed parsing above and declined
  it as the primary answer, because it does not touch Claim B.
- **The enumeration method is sound and its scope is the thing that fails.**
  Round 10's enumeration was thorough *within the construct the previous round was
  about*, and round 11 arrived one construct over. That is the same failure one
  level up: enumerating within the last finding's category is still taking the
  agenda from the last reviewer.

#### Are these two inside the structure?

Yes, and that is why they were fixed here rather than escalated.

Finding two's fix **removes a rule rather than adding one**: `opensPattern` now
asks `clause`, which the scanner already tracks, and the eight-character set
becomes a refinement *within* patterns instead of the whole test. A rule that was
answering a question it could not see is replaced by the state that can see it.
Finding one's fix replaces a shapeless token match with the two shapes the
grammar gives. Both make the structure *more* accountable to the grammar and
smaller, which is the right direction even though neither closes the class.

**And no, this is not a claim that round 12 is not one construct over.** The
structure now answers four questions — which clause, which bracket kind, which
brace kind, which anchor shape — each by a local rule. Round 11 found a defect in
two of the four. There is no evidence the other two are clean, and the base rate
across eleven rounds says they are not.

Finding one also does not close its own class, which is recorded rather than
glossed:

```cypher
WITH {orgId: $orgId} AS m MATCH (n) WHERE m.orgId = $orgId RETURN n
```

is a qualified property access on a variable — an anchor's exact syntax — and a
tautology, because `m` is bound to a map rather than to a graph row. Telling the
two apart needs to know what `m` is BOUND to. That is dataflow: **Claim B**, not a
missed spelling, and no syntactic rule reaches it. It is asserted as
known-accepted in `tenant.scope-guard.test.ts`.

### Round 12: the fifth thing the structure decides

Round 11 closed with a prediction, and it is worth quoting because round 12 is
its confirmation and its correction at once:

> The structure now answers four questions — which clause, which bracket kind,
> which brace kind, which anchor shape — each by a local rule. Round 11 found a
> defect in two of the four. There is no evidence the other two are clean.

Round 12 is the third of the four. But the finding is **not** that the brace rule
is wrong. Both brace classifiers are individually correct: `opensSubquery`
recognises `COLLECT {`, and `opensPatternMap` recognises a brace after a node
paren. The defect is the **PRECEDENCE** between them — which is consulted first.

```cypher
MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> [])
RETURN n
```

Cypher 5 lets a node pattern carry its own predicate. The subquery's brace then
sits inside a PATTERN paren, `opensPatternMap` was asked first and won, and the
whole subquery — projections included — was kept as a filtering position. The
projected comparison supplied the anchor, and `COLLECT` is non-empty whenever any
node exists, so the predicate held for every row.

**Precedence is a fifth thing this structure decides, and it was not in the
enumeration.** Round 11 listed four questions as if they were independent. They
are ORDERED, and the order is itself a decision that can be wrong while every
individual rule is right. That is a category the previous eleven rounds never
named, which is why nothing had ever tested it.

The fix is the one the grammar dictates: `opensSubquery` reads the token
IMMEDIATELY BEFORE the brace, which is the grammar speaking directly, while
`opensPatternMap` reads the ENCLOSING BRACKET, which says only that a brace here
COULD be a property map. Direct evidence outranks positional evidence. And the
swap cannot cost a genuine pattern map, which is a property of the grammar rather
than a hope: a property map is never preceded by `CALL` / `EXISTS` / `COUNT` /
`COLLECT`.

Review reported `COLLECT` in an inline NODE predicate. **Seven shapes did it** —
`EXISTS` and `COUNT` as well, the inline predicate on a RELATIONSHIP pattern, a
subquery nested inside another, and the same shape under `MERGE`.

#### The precedence relations, enumerated

Since the category was the finding, the whole category is now written down and
tested, in `describe("classifier precedence is decided, not incidental")`: every
pair of tests that can both match at one position, which is asked first, and the
query that tells the two orders apart. Eleven relations. Only P1 was wrong.

One of them has a cost worth naming. **Bracket depth is checked before
clause-keyword recognition** (clause keywords are recognised only at depth 0), so
inside an inline node predicate a subquery's own `WHERE` never becomes the
clause. Before round 12 that did not matter, because the brace was wrongly a
pattern map and pattern maps are kept in a row-selecting clause. After the swap,
an anchor written ONLY in that inner `WHERE` is refused. That is the fail-closed
direction, it costs **0 of the 63** corpus queries, and both the pattern-map
spelling of the same query and the top-level spelling still pass. Recognising
clauses inside a brace nested in a paren would OPEN kept regions, which is the
dangerous direction, so it is deliberately not done.

#### What this says about the method, again

The security review completed on the same head with **zero** findings; this came
from the code review. A clean security pass is not evidence about this class.

And the pattern holds: review reports one spelling, enumeration finds seven.
Rounds 10, 11 and 12 have now gone eleven-for-one, thirteen-for-two and
seven-for-one. What changes each round is not the yield — it is the CATEGORY
nobody had enumerated yet: positions in round 10, prefix characters and anchor
shapes in round 11, and the ORDER OF THE TESTS in round 12. Each was invisible
from inside the previous round's frame.

That is the strongest available statement of why the answer is construction.
Every round's enumeration is bounded, and the supply of categories is not — or
at least, nothing in eleven rounds has given any evidence of its edge.

### Round 13: the sixth thing, and the one that makes round 12 a spelling

Round 13 reported this:

```cypher
MATCH (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n
```

A map literal is never null, so the predicate is constant-true and every
tenant's `n` comes back while `orgId: $orgId` supplies the anchor. Set beside
round 12's

```cypher
MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine } <> [])
RETURN n
```

the two are **one defect in two spellings**. Both braces sit in
`MATCH (n WHERE …)`; both were claimed by `opensPatternMap` because the
enclosing paren is a pattern. Round 12's brace happened to be a subquery brace,
so ordering `opensSubquery` first closed it — correctly, and that ordering is
kept and still pinned. But it closed one brace MEANING inside the region and
left the REGION open, and round 13 walked back in with the other meaning.

**The sixth thing this structure decides is WHERE INSIDE A CONSTRUCT a token
sits.** Rounds 1–11 asked four questions of a bracket — which clause, which
bracket kind, which brace kind, which anchor shape — and round 12 added the
order they are asked in. All six were asked of a bracket as though a bracket
were homogeneous. It is not. A node pattern is

```
( [variable] [labelExpression] [propertyMap] [WHERE expression] )
```

and a relationship pattern is that shape inside `[…]`. The property map comes
BEFORE the `WHERE`, so the `WHERE` is the point at which the property-map
position ENDS and ordinary expression syntax begins. "Is the enclosing paren a
pattern?" is true for the whole frame, inline predicate included — it was
answering a question one level coarser than the one the grammar asks.

The fix asks the grammar's question: a pattern's inline `WHERE` retires that
frame's property-map position, and every brace and every bracket after it in the
frame is an expression. Enumerating the region rather than the finding, **fifteen
queries reached it**: a map literal bare, parenthesised, in a `CASE` arm, as a
map VALUE holding the comparison, and after a map projection; the same on a
RELATIONSHIP pattern, on the second node of a path, under `OPTIONAL MATCH`, under
`MERGE`, after a label expression, and inside a quantified path pattern; a
pattern property map inside a subquery inside the region; one inline predicate
nested inside another; a pattern comprehension inside the region; and a grouping
paren inside it, which round 11's `=`-then-`(` rule re-admits as a node pattern
one bracket deeper. Review reported one. **Fifteen-for-one.**

That last one is worth naming on its own, because it is round 11 and round 13
interacting: round 11 correctly widened `opensPattern` to accept `(` after `=`,
`,`, `-`, `>`, `<`, `|`, `(` and `[` inside a graph-pattern clause, since
`MATCH p = (a)` spells a node pattern exactly that way. An inline predicate is
inside a graph-pattern clause and can contain every one of those characters. So
the region has to be a DEPTH rather than a per-frame flag — a bracket opened
inside the region is expression syntax too — or the rule closes at one level and
re-opens at the next.

#### What the region does NOT reach, and why that is the rule and not an exception

A subquery brace opens a clause sequence of its own, so the enclosing pattern's
inline predicate does not reach into it:
`MATCH (n WHERE EXISTS { MATCH (m {orgId: $orgId}) })` keeps its map as a real
anchor. This is the same reading that already saves and restores `clause` across
a brace, applied to the same stack, and the check that it is right rather than
convenient is that the top-level spelling
`MATCH (n) WHERE EXISTS { MATCH (m {orgId: $orgId}) }` has anchored since round
10 — the two spellings had better not disagree. (That the anchor narrows `m`
while the query returns `n` is the separate, pre-existing limitation this ADR
records for `MATCH (a {orgId: $orgId}) MATCH (b) RETURN b`. It is not a position
error, and closing it is not what a position rule is for.)

#### The measured cost

Two things, both fail-closed, both **0 of the 63** corpus queries.

- An anchor written ONLY inside an inline predicate —
  `MATCH (n WHERE n.orgId = $orgId)` — is refused. This is not new in round 13:
  the region was never the `WHERE` clause, because clause keywords are recognised
  only at paren/bracket depth 0 and the pattern's own bracket is open. It is
  recorded because the region now has a name, and a reader would otherwise expect
  the rule to have made that text a predicate position. Making it one is a real
  improvement and a different change: it would have to keep the region's text
  while still refusing every brace inside it, which needs clause tracking inside
  a paren-nested subquery — the thing round 12 declined to build because it OPENS
  kept regions.
- A BARE variable spelled `where` — `MATCH (where {orgId: $orgId})` — reads as
  opening the region and costs that query its anchor. It is the same
  undecidable-without-a-parser class this ADR records for `RETURN n AS where`,
  landing on the safe side of it, and it is unreachable in Cypher besides:
  `WHERE` is reserved, so the database requires the backticks that
  `stripLiteralsAndComments` has already emptied.

#### What this says about the method, a third time

Rounds 10, 11, 12 and 13 have gone eleven-for-one, thirteen-for-two,
seven-for-one and fifteen-for-one. The yield is not the point; the CATEGORY is.
Round 12 named precedence and said "there is no evidence the other [question] is
clean". Round 13 is not the fourth question — it is the discovery that all of
them were being asked at the wrong granularity. Round 12 could not have seen
that from inside its own frame, and neither could round 11 from inside its own,
which is now the fourth consecutive round for which that is true.

It is also the first round where the previous round's fix is **not** wrong and is
still not enough. That distinction matters for what it implies: correcting the
reported spelling is not converging, because the spellings are not the thing.

### Round 14: the same scale error, one level up, and a cost that was a bypass

Round 13 said: the rules asked their questions of a BRACKET, as though a bracket
were homogeneous. Round 14 is that sentence with a different noun. **Clause
recognition asked its question of the WHOLE QUERY, as though depth were global**
— when a subquery is a clause sequence with a baseline of its own.

```cypher
MATCH (n) WHERE size(COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine }) > 0
RETURN n
```

Clause keywords were recognised only at absolute paren/bracket depth 0. `paren`
is 1 inside those braces, so the subquery's `MATCH` and `RETURN` were never seen
and the OUTER `WHERE` stayed in force over its entire body. The projected
comparison is a column and filters nothing; the inherited `WHERE` made it a
predicate, and `COLLECT` is non-empty whenever any node exists, so every tenant's
`n` came back. `$__scopeLabels` in the same position bypassed the agent
allow-list identically, and — worst of the ten — **a `SET` written there was read
as a filtering position**, which is the write that reassigns every tenant's nodes
to the caller, refused everywhere else by an explicit rule.

#### The part that is about the previous round's reasoning, not its code

Round 13 recorded, as a fail-closed cost:

> the region was never the `WHERE` clause, since clause keywords are recognised
> only at paren/bracket depth 0 and the pattern's bracket is open

That is true, and safe, and it is the SAME MECHANISM as the bypass above seen
from its other side. Round 12 had recorded the same property as a cost too, and
went further — it declined to fix it, on the grounds that recognising clauses
inside a paren-nested brace "would OPEN kept regions, which is the dangerous
direction". Both rounds examined only the direction in which the mechanism
REFUSES.

**When a cost is recorded, the question is whether the mechanism behind it can
also fail the other way.** A property that makes the guard refuse something
legitimate is, very often, the same property that makes it accept something
illegitimate from the opposite side — because both are the guard failing to
distinguish two things. Rounds 12 and 13 each enumerated their own finding
exhaustively and neither enumerated the cost they wrote down.

Round 12's judgement was also simply backwards, and the correction is worth
stating plainly: **recognition NARROWS what is kept.** With it off, one inherited
`WHERE` covered the subquery's whole body, projections and writes alike. With it
on, the subquery's `RETURN` is a `RETURN` and its `SET` is a `SET`. The only
region it opens is a subquery's own clause sequence, which is exactly where a
`WHERE` genuinely filters.

#### The enumeration

Ten queries reached it on the tenancy guard and two on the scope guard; review
reported one. Under a function call, under a grouping paren, under a list
bracket, two brackets deep, with `EXISTS` / `COUNT` / `COLLECT` / a nested
`CALL`, with a `WITH` between the `MATCH` and the projection, inside a `CASE`,
and the `SET` spelling. **Ten-for-one.**

Two mechanisms beyond the baseline itself were found by MUTATION rather than by
enumeration, and both are bypasses in their own right:

- **The baseline must be restored when the subquery closes.** Left raised, every
  clause keyword after the closing brace — back at depth 0 — goes unrecognised,
  the saved `WHERE` stays in force, and a trailing projection or a trailing `SET`
  is read as a predicate. The same defect on the way out instead of the way in.
- **A subquery starts with NO clause in force.** Cypher 5 lets a subquery
  expression hold a bare pattern with no `MATCH` keyword, so without the reset
  there is no keyword to displace the outer clause and the enclosing `WHERE`
  governs the body — the same leak, reached with no nesting at all.

Neither was in the reviewer's finding or in the enumeration derived from it. They
were found by reverting each line of the fix and asking which test noticed;
when none did, the answer was a missing test rather than a redundant line.

#### What it costs, and what it gives back

This round REMOVES two refusals rather than adding them, and both were round 12's
recorded cost: an anchor in a nested subquery's own `WHERE`, and one in an
inline-predicate subquery's `WHERE`, now both anchor — agreeing with their
top-level spellings, which have anchored since round 10. Agreement is the
property that makes it a correction rather than a loosening; the PROJECTION
spelling of the same queries is still refused.

The one new cost is fail-closed and inherited: a bare-pattern subquery's INLINE
predicate (`EXISTS { (m WHERE m.orgId = $orgId) }`) is refused, which is round
13's cost — an inline predicate is never a predicate position — not a new one.
0 of the 63 corpus queries.

#### What this says about the method, a fourth time

Rounds 10–14 have gone eleven-for-one, thirteen-for-two, seven-for-one,
fifteen-for-one and ten-for-one. Round 13 observed that it was the first round in
which the previous round's fix was not wrong and was still not enough. Round 14
is sharper than that: the previous round's fix was correct, its enumeration was
exhaustive *for the thing it enumerated*, and the defect was sitting inside the
sentence where it wrote down what the fix cost.

### What follows

This does **not** change the decision below — it strengthens the case for it and
narrows what any interim work should be.

- Decision (2), the seam constructing the scoping, deletes **both** claims. A
  query the seam built needs no lexical analysis to be trusted and no semantic
  analysis to be proved: provenance is decidable, and it is the only option on
  the table that is.
- If an interim strengthening is ever wanted, it is **implement enough of the
  grammar to answer the questions the guard asks**, held against the
  specification rather than against the last reviewer. Round 10 wrote this as
  "implement the lexer"; round 11 corrected it, because a lexer returns `LPAREN`
  and cannot say whether that paren opens a node pattern — that is a production,
  not a token. The honest name for the artifact is a **parser**, which this ADR
  weighs and declines above as the primary answer: it would have prevented rounds
  1, 3, 5, 7, 9, 10 and 11 as a class, and closes none of Claim B. Anyone
  proposing it should price it as a parser and justify it on Claim A alone.
- **Refusing anything outside a known-safe subset** — fail closed on shapes the
  guard cannot certify — was weighed and is the weakest of the three. The corpus
  is 63 queries across 16 files, so whitelisting shapes costs roughly what the
  builder in (2) costs while leaving the guarantee in the wrong place; and a
  refusal decided by a lexer nobody trusts is still a decision by a lexer nobody
  trusts.

Neither interim option should be built ahead of (2), and neither was built in
PR #3193, which closed the demonstrated P1 bypasses — and, in round 13, the
region they were spellings of — and nothing more.

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
