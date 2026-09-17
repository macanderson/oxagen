// graph-scope.ts — server-side graph-access enforcement for agent-scoped
// Neo4j sessions (Agent RBAC Phase 3, spec §3.6).
//
// This module owns the *pure* transforms that scopedSession() (in ./tenant.ts)
// applies to a Cypher query when an agent principal's GraphScope is active.
// tenant.ts is the single chokepoint every graph query already passes through;
// these helpers add label/relationship-type and budget enforcement on top of
// the existing $orgId/$workspaceId tenancy injection.
//
// Design mirrors the tenancy guard style (see ./tenant.ts): rather than parse
// and rewrite arbitrary Cypher (fragile, plan-defeating), the seam
//   - injects the scope allow-lists as reserved parameters ($__scopeLabels /
//     $__scopeRelTypes), exactly as tenancy injects $orgId/$workspaceId, and
//   - requires the query text to REFERENCE those markers when the dimension is
//     constrained (bypass guard) — a new query path that forgets the filter
//     throws instead of silently returning out-of-scope data.
// The WHERE-clause predicate *text* that consumes $__scopeLabels/$__scopeRelTypes
// lives in the ontology.*/semantic.* query builders (spec §3.6, Phase 3) — NOT
// here. This seam supplies the values + guarantees they cannot be skipped, and
// applies the budget clamps (LIMIT / variable-length hop bounds / tx timeout)
// and the read-mode write rejection, which do not require understanding the
// query's node variables.

/**
 * GraphScope — a server-side graph-access ceiling for an agent-scoped session.
 *
 * Structurally mirrors the `GraphScope` type in
 * `packages/oxagen/src/iam/conditions.ts` (the IAM condition-language source of
 * truth). It is redefined locally rather than imported because
 * `@oxagen/ontology` sits BELOW `@oxagen/oxagen` (the kernel) in the dependency
 * graph — importing the kernel here just for a type would be a backward/heavy
 * dependency and risk an import cycle. Keep the two in sync: any field added
 * there must be added here.
 *
 * An `undefined` dimension means "unrestricted" for that dimension.
 */
export interface GraphScope {
  /** Allowed node labels. `undefined` ⇒ all labels. */
  labels?: string[];
  /** Allowed relationship types. `undefined` ⇒ all relationship types. */
  relationshipTypes?: string[];
  /** Graph-access mode ceiling. `read` rejects write clauses at this seam. */
  mode?: "read" | "extend";
  /** Traversal budget clamps. `undefined` dimensions are unclamped. */
  budget?: {
    maxHops?: number;
    maxNodes?: number;
    maxTraversalMs?: number;
  };
}

/** Raised when an agent-scoped graph query violates its GraphScope ceiling. */
export class GraphScopeError extends Error {
  readonly code = "graph_scope_violation" as const;
  constructor(message: string) {
    super(message);
    this.name = "GraphScopeError";
  }
}

// ── Reserved scope parameters ────────────────────────────────────────────────
// These mirror the role of $orgId/$workspaceId: the seam injects them, the
// query builder references them. Callers may never supply them directly.

export const SCOPE_LABELS_PARAM = "__scopeLabels";
export const SCOPE_REL_TYPES_PARAM = "__scopeRelTypes";
export const RESERVED_SCOPE_PARAMS = [
  SCOPE_LABELS_PARAM,
  SCOPE_REL_TYPES_PARAM,
] as const;

// ── Cypher identifier delimiting ─────────────────────────────────────────────
//
// Cypher spells an unescaped symbolic name with the UNICODE identifier rules —
// openCypher's `IdentifierStart = ID_Start | Pc` and `IdentifierPart =
// ID_Continue | Sc`. JavaScript's `\b`, `\w` and `[A-Za-z0-9_]` are ASCII-only,
// so every guard in this file (and the tenancy guard in ./tenant.ts) that
// delimited a token with them UNDER-delimited it: `\b` fires between `d` and
// `é`, so `$__scopeLabelsé` satisfies a `\$__scopeLabels\b` marker while naming
// a DIFFERENT, caller-supplied parameter — `assertNoReservedParamCollision`
// reserves the exact name only. The same ASCII blindness split `wheré` into the
// clause keyword `WHERE` plus a stray character, which let a bare alias
// (`RETURN n AS wheré`) spoof a clause boundary; `where` itself is reserved in
// Cypher and cannot, but `wheré` is an ordinary name and can.
//
// These classes are the grammar's, not an approximation of it, and every token
// boundary in this module is drawn with them.
const ID_START_SRC = "\\p{ID_Start}\\p{Pc}";
const ID_PART_SRC = "\\p{ID_Continue}\\p{Sc}";
const ID_PART_CHAR = new RegExp(`[${ID_PART_SRC}]`, "u");
/** Lookahead asserting the preceding token ENDS here, by Cypher's rules. */
const ID_END = `(?![${ID_PART_SRC}])`;
/** Lookbehind asserting the following token BEGINS here, by Cypher's rules. */
const ID_BEGIN = `(?<![${ID_PART_SRC}])`;
/**
 * A WHOLE unescaped symbolic name, matched sticky from a given offset.
 *
 * The word scan uses this rather than testing `src[i]` character by character,
 * and the difference is code points versus UTF-16 units. A JavaScript string
 * index yields one unit, so an identifier character outside the BMP — every
 * Mathematical Alphanumeric letter, for one, and `ID_Continue` covers them —
 * arrives as a lone surrogate that matches no Unicode property, and the scan
 * SPLITS the name there. That is round nine's defect again in a third
 * encoding: `where𝐱` and `𝐱where` are each one Cypher identifier, and a
 * per-unit scan hands the seam the bare keyword `WHERE` out of both. With the
 * `u` flag the engine reads a full code point at each position, so a sticky
 * match of the whole name cannot split one, whichever plane it lives in.
 */
const IDENTIFIER_AT = new RegExp(`[${ID_START_SRC}][${ID_PART_SRC}]*`, "yu");

// Bypass-guard markers. Two conditions, and BOTH are load-bearing.
//
// 1) A membership test (`… IN $__scopeLabels`). Both allow-lists are
//    list-valued, so every legitimate consumption of one is a membership test —
//    `l IN $__scopeLabels`, `type(r) IN $__scopeRelTypes` — which is what all
//    five production call sites in packages/handlers write. The Unicode-aware
//    `ID_END` after the name prevents a suffix collision — an ASCII `\b` let
//    `$__scopeLabelsExtra` through unnoticed only for non-ASCII suffixes, but
//    `$__scopeLabelsé` is exactly as caller-controlled as `$__scopeLabelsExtra`
//    is, and the guard cannot tell the two apart without the grammar's rule.
// 2) In a PREDICATE position, checked by running the regex over
//    `keepPredicatePositions` output rather than the whole query. Condition 1
//    alone does not survive contact: `RETURN n, n.label IN $__scopeLabels AS
//    allowed` contains a membership test, satisfies the regex, and returns
//    every node including the labels the agent may not see, because an aliased
//    predicate in a projection filters nothing. The relationship marker has the
//    identical hole with `type(r) IN $__scopeRelTypes AS allowed`, and a third
//    with `MERGE (n {allowed: n.label IN $__scopeLabels})`, where the boolean is
//    a stored property value. A membership test earns its standing from the
//    boolean it produces, so it counts only where a FALSE can refuse a row.
const LABELS_MARKER = new RegExp(
  `${ID_BEGIN}IN\\s*\\$${SCOPE_LABELS_PARAM}${ID_END}`,
  "iu",
);
const REL_TYPES_MARKER = new RegExp(
  `${ID_BEGIN}IN\\s*\\$${SCOPE_REL_TYPES_PARAM}${ID_END}`,
  "iu",
);

// ── Write-clause detection (read-mode defense in depth) ──────────────────────
// Note: the capability layer is the primary gate (graph_write-category
// capabilities resolve to deny under a read scope, spec §3.6). This is a
// belt-and-braces seam check. It is a conservative denylist — string literals
// and comments are stripped first so a keyword inside a literal never
// false-rejects a legitimate read.
//
// THESE FOUR KEEP `\b` DELIBERATELY, and the reason is the direction of the
// error rather than an oversight. Every other `\b` in this file was replaced
// because it delimited an ALLOW decision, where ASCII's laxity means matching
// something that is not the token and letting a query through. Here the match is
// a REFUSAL, and `\b` is strictly laxer than Cypher's rule, so it can only ever
// refuse MORE: `créateur` has no `CREATE` in it, but were a name like `createé`
// written it would be rejected as a write. It cannot hide a real write clause,
// because a real one is preceded and followed by whitespace or a bracket, where
// `\b` and the Unicode rule agree. The same argument covers `MUTATING_CALL`,
// `\bUNION\b` and the literal-LIMIT rewrite in `clampLimits`, each of which
// fails closed when it misses. A false refusal here is a loud, fixable error;
// the Unicode fix on an allow-side delimiter was a silent cross-tenant read.
const WRITE_KEYWORD = /\b(?:CREATE|MERGE|SET|DELETE|REMOVE|FOREACH)\b/i;
// Mutating procedure calls that do not surface a top-level write keyword.
const MUTATING_CALL =
  /\bCALL\s+(?:apoc\.(?:create|merge|refactor|periodic|nodes\.link|cypher\.(?:doit|runwrite|runmany|runschema))|db\.create)/i;

/**
 * Replace string literals, backtick identifiers, and comments with empty
 * placeholders so keyword scanning cannot match text inside them.
 *
 * Deliberately a single left-to-right scan rather than a chain of independent
 * regex passes: comments and literals can each contain the other's opening
 * delimiter, and a pass ordering can only ever be wrong for one of the two.
 * (A chain that strips `//` comments before strings mangles a URL literal —
 * `n.url = 'http://x' CREATE (m)` loses everything after `http:`, hiding the
 * CREATE from `assertReadOnly`; a chain in the other order mangles an
 * apostrophe inside a comment.) Scanning once means whichever delimiter opens
 * FIRST wins, which is exactly how Cypher itself reads the text.
 */
export function stripLiteralsAndComments(cypher: string): string {
  let out = "";
  let i = 0;
  const n = cypher.length;

  while (i < n) {
    const ch = cypher[i]!;
    const next = cypher[i + 1];

    // Block comment — collapse to a space, keeping tokens on either side apart.
    if (ch === "/" && next === "*") {
      const end = cypher.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? n : end + 2;
      continue;
    }

    // Line comment — collapse to a space and resume at the newline, which is
    // preserved so line structure (and any trailing clause) survives.
    if (ch === "/" && next === "/") {
      const end = cypher.indexOf("\n", i + 2);
      out += " ";
      i = end === -1 ? n : end;
      continue;
    }

    // String literal or backtick-quoted identifier — emit an empty placeholder
    // of the same delimiter and skip the body.
    if (ch === "'" || ch === '"' || ch === "`") {
      const closer = ch;
      out += closer + closer;
      i += 1;
      while (i < n) {
        const c = cypher[i]!;
        // Backtick identifiers escape by doubling; strings escape with `\`.
        if (closer === "`") {
          if (c === "`" && cypher[i + 1] === "`") {
            i += 2;
            continue;
          }
        } else if (c === "\\") {
          i += 2;
          continue;
        }
        i += 1;
        if (c === closer) break;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

// ── Filtering positions ──────────────────────────────────────────────────────

// Clause keywords that begin a new top-level clause. Recognised only at
// paren/bracket depth 0, so the inner `WHERE` of `any(x IN xs WHERE …)` does not
// re-open a clause — it stays part of whichever clause encloses it, which is
// exactly how Cypher scopes it.
const CLAUSE_KEYWORDS = new Set([
  "MATCH",
  "OPTIONAL",
  "MERGE",
  "CREATE",
  "WHERE",
  "SET",
  "DELETE",
  "DETACH",
  "REMOVE",
  "RETURN",
  "WITH",
  "UNWIND",
  "ORDER",
  "SKIP",
  "LIMIT",
  "CALL",
  "YIELD",
  "FOREACH",
  "UNION",
  "ON",
  "USING",
  "LOAD",
]);

// Keywords after which a `(` opens a NODE PATTERN rather than a call or a
// grouping. Any other bare word before a `(` is a function name — `head(`,
// `any(`, `coalesce(`, `count(` — whose braces are expression maps.
const PATTERN_INTRODUCERS = new Set(["MATCH", "MERGE", "CREATE"]);

// Words after which a `{` opens a CLAUSE SEQUENCE rather than a map. Cypher has
// exactly four: the `CALL { … }` subquery clause and the three subquery
// EXPRESSIONS. Enumerated from the grammar rather than from the last query a
// reviewer wrote, which is the distinction ADR-087 turns on — this list is
// closed because the grammar closes it, and a fifth entry would be a language
// change rather than another hazard someone happened to find.
const SUBQUERY_INTRODUCERS = new Set(["CALL", "EXISTS", "COUNT", "COLLECT"]);

// Clauses in which a `(` or `[` can open a GRAPH PATTERN at all. Everywhere else
// a bracket is grouping, a call, a list or an index.
//
// This is the round-eleven correction, and it REPLACES a rule rather than adding
// one. `opensPattern` decided pattern-ness from the single character before the
// bracket, and `,`, `-`, `>`, `<`, `=`, `|`, `(` and `[` are all ordinary
// EXPRESSION syntax as well as pattern syntax. Each one was therefore a bypass:
//
//     MATCH (n) WHERE true = ({orgId: $orgId} IS NOT NULL) RETURN n
//
// The `(` follows `=`, which the character set read as `MATCH p = (a)`. The
// grouping paren became a pattern bracket, the brace inside it became a pattern
// property map instead of a map literal, `mapDepth` never rose, and an
// always-true predicate anchored the tenant. All eight characters do this.
//
// Which clause we are in is state the scanner already tracks, and it is the
// question the grammar actually asks: a node pattern appears in a graph-pattern
// clause. Deciding it from the clause makes the character set a refinement
// WITHIN patterns rather than the whole test, which is what it was written as.
//
// `OPTIONAL` is deliberately ABSENT, and it was in this set until a mutation
// probe showed removing it failed nothing. Cypher only ever writes `OPTIONAL`
// immediately before `MATCH` or `CALL`, so the clause has already advanced past
// it by the time any bracket opens; an entry for it would be a rule that reads
// as protection and executes never. The set lists the clauses in which a bracket
// CAN open a pattern, and nothing else.
const GRAPH_PATTERN_CLAUSES = new Set(["MATCH", "MERGE", "CREATE"]);

// Clauses whose pattern property maps constrain an EXISTING row set. `CREATE`
// is a pattern introducer for bracket-classification purposes — a `(` after it
// is a node pattern, not a call — but its map only stamps a node being made, so
// it is absent here.
//
// `MERGE` is absent for a subtler reason and is readmitted conditionally below.
// A MERGE pattern map is a match-or-create predicate, so it does constrain the
// thing it merges — `MERGE (n {orgId: $orgId})` yields an `n` carrying the
// tenant whichever branch fires. What it constrains is ONLY that thing. In
//
//   MATCH (n:GraphNode {orgId: $orgId})
//   MERGE (audit {allowed: n.label IN $__scopeLabels})
//   RETURN n
//
// the membership expression is the VALUE of `audit.allowed`; it narrows `audit`
// and says nothing about `n`, which an earlier clause already bound. The rows
// the query exposes are `n`'s, and every tenant-local label is among them. So
// `MERGE` is ambiguous in a way `MATCH` is not, and the difference is whether
// the variable in the map was bound elsewhere — a scope question, not a
// position one.
const ROW_SELECTING_CLAUSES = new Set(["MATCH", "OPTIONAL"]);

// Clauses that introduce a GRAPH variable. `UNWIND` is deliberately absent: it
// binds a value out of a parameter list, so it exposes no graph rows and cannot
// be the thing a later map fails to narrow. `WITH` is absent for the same
// reason — it re-projects variables some earlier clause already bound.
const GRAPH_BINDING_CLAUSES = new Set([
  "MATCH",
  "OPTIONAL",
  "MERGE",
  "CREATE",
  "CALL",
  "FOREACH",
]);

/**
 * True when the word spanning `[start, end)` sits where a CLAUSE can begin, and
 * false when it is an ordinary identifier that happens to be SPELLED like a
 * clause keyword.
 *
 * Without this, the scanner recognised a keyword by nesting depth alone, and a
 * caller-controlled name spoofed the clause state:
 *
 *   MATCH (n) SET n.x = $where, n.orgId = $orgId
 *
 * `$where` switched `clause` to `WHERE`, which made the rest of the SET target
 * a kept "filtering position", and `n.orgId = $orgId` — a WRITE that reassigns
 * every tenant's nodes to the caller — satisfied the tenancy guard. Three more
 * spellings of the same class did the same thing: `SET n.where = 1, …` (a
 * property key), `SET n:Where, …` (a label), and `SET n += {where: 1, orgId:
 * $orgId}` (a map key).
 *
 * WHICH PRECEDING TOKENS DISQUALIFY A KEYWORD, and why each one can only ever
 * introduce an identifier (whitespace is skipped — Cypher allows `n . where`):
 *
 *  - `$` — a PARAMETER name. No clause begins after a sigil.
 *  - `.` — a PROPERTY key, or a namespaced procedure segment. This also fixes
 *    `CALL apoc.merge.node(…)`, where `merge` used to open a MERGE clause.
 *  - `:` — a LABEL (`SET n:Where`), a relationship type, or a map VALUE
 *    (`{k: where}`). A clause never begins after a colon.
 *
 * AND ONE FOLLOWING TOKEN:
 *
 *  - `:` — the word is a MAP KEY (`{where: 1}`) or a variable being labelled.
 *    No Cypher clause keyword is ever followed by a colon, so this decides the
 *    map-key case without having to tell a map brace from a `CALL { … }`
 *    subquery brace — which matters, because a subquery's inner `MATCH` /
 *    `WHERE` must keep being recognised.
 *
 * A disqualified word is treated as an ORDINARY IDENTIFIER: `clause` is left
 * exactly as it was. That is the correct reading, not merely the safe one — no
 * clause boundary occurred, so the clause genuinely continues — and it is why
 * `WHERE n.set = 1 AND n.orgId = $orgId` keeps its anchor instead of having the
 * property key `.set` close the WHERE out from under it.
 *
 * WHAT IT STILL CANNOT DECIDE. A BARE identifier spelled like a clause keyword
 * and not marked by any of these tokens — `RETURN n AS where` — is
 * indistinguishable from a clause start without a grammar, which is a parse and
 * not a lexer. Backtick-escaped names never reach here (`stripLiteralsAndComments`
 * has already emptied them), and Cypher reserves most clause keywords against
 * bare use, but this seam does not depend on that and does not claim it: the
 * class is the same one ADR-087 records, and the answer to it is to construct
 * the scoping rather than validate it.
 *
 * What Cypher's reservation DID depend on is that the word is the whole
 * identifier. `RETURN n AS wheré` is not a reserved word and is accepted by the
 * database; while the caller of this function tokenized with `[A-Za-z0-9_]` it
 * arrived here as the bare word `WHERE` with the `é` left behind, so the
 * unreachable class above became reachable for the price of one accent. The
 * word scan in `keepPositions` now uses Cypher's own identifier classes, so
 * `wheré` is one word and is not a clause keyword at all.
 */
function startsAClause(src: string, start: number, end: number): boolean {
  let before = start - 1;
  while (before >= 0 && /\s/.test(src[before]!)) before -= 1;
  if (before >= 0 && "$.:".includes(src[before]!)) return false;

  let after = end;
  while (after < src.length && /\s/.test(src[after]!)) after += 1;
  return src[after] !== ":";
}

/**
 * Classify the bracket opening at `openIdx` as a PATTERN bracket or an
 * EXPRESSION bracket.
 *
 * This exists because `paren > 0 || bracket > 0` — "we are nested inside
 * something" — is a PROXY for "we are inside a pattern", and a proxy admits
 * everything that shares its shape. `head([{allowed: n.label IN $x}])` is nested
 * inside a list inside a call, so depth alone read it as a pattern property map
 * and handed a projection the standing of a filter. The fix is to remember WHAT
 * opened each level, not merely that one is open.
 *
 *  - `[` opens a relationship pattern only when written `-[` or `<-[`, the only
 *    way Cypher spells one. A list literal, an index and a slice are each
 *    preceded by something else.
 *  - `(` opens a node pattern after a pattern-introducing keyword, after `,`
 *    (`MATCH (a), (b)`), after the dash/arrow characters that join a path, after
 *    `=` (`MATCH p = (a)`), or inside a pattern comprehension's `[`. Preceded by
 *    any other bare word it is a function call.
 *
 * BOTH of those are read only INSIDE a graph-pattern clause. The character set
 * above is `,`, `-`, `>`, `<`, `=`, `|`, `(`, `[` — every one of which is also
 * ordinary expression syntax, so outside `MATCH` / `OPTIONAL MATCH` / `MERGE` /
 * `CREATE` it classified grouping parens, argument lists, comparisons and
 * comprehensions as node patterns. `clause` answers the question the grammar
 * asks and the preceding character then refines it; the other way round, the
 * character was answering a question it cannot see.
 *
 * The cost is measured, not assumed: a pattern written in a `WHERE` — a bare
 * pattern expression, or a pattern comprehension such as
 * `WHERE size([(n)-->(m) | m]) > 0` — now classifies as an expression, so a
 * property map inside one stops counting as an anchor. That is the fail-closed
 * direction, no query in the corpus writes it, and a pattern inside
 * `WHERE EXISTS { MATCH … }` is unaffected because the subquery's own `MATCH`
 * sets the clause.
 */
function opensPattern(src: string, openIdx: number, clause: string): boolean {
  if (!GRAPH_PATTERN_CLAUSES.has(clause)) return false;

  let k = openIdx - 1;
  while (k >= 0 && /\s/.test(src[k]!)) k -= 1;
  if (k < 0) return true;
  const prev = src[k]!;

  if (src[openIdx] === "[") return prev === "-";

  if (",-><=|([".includes(prev)) return true;
  // Per UTF-16 unit rather than per code point, unlike the word scan, and the
  // asymmetry is deliberate: a lone surrogate matches no property here, so an
  // astral-plane name stops the back-scan early and the bracket is classified
  // as an EXPRESSION. That is the conservative answer — fewer pattern maps kept
  // — whereas splitting a name in the word scan let a keyword out, which is not.
  if (ID_PART_CHAR.test(prev)) {
    let j = k;
    while (j >= 0 && ID_PART_CHAR.test(src[j]!)) j -= 1;
    return PATTERN_INTRODUCERS.has(src.slice(j + 1, k + 1).toUpperCase());
  }
  return false;
}

/**
 * True when the `{` at `openIdx` opens a SUBQUERY — a clause sequence — rather
 * than a map literal.
 *
 * `CALL { … }`, `EXISTS { … }`, `COUNT { … }` and `COLLECT { … }` are the only
 * four, and the word immediately before the brace is what says so. The one
 * complication is the scoped-subquery form `CALL (n) { … }` (Neo4j 5.23), where
 * the preceding character is `)`; the balanced walk back to that `(` and then to
 * the word before it is what keeps a legitimately anchored scoped subquery from
 * being read as a map literal and blanked.
 */
function opensSubquery(src: string, openIdx: number): boolean {
  let k = openIdx - 1;
  while (k >= 0 && /\s/.test(src[k]!)) k -= 1;
  if (k < 0) return false;

  if (src[k] === ")") {
    let depth = 0;
    while (k >= 0) {
      if (src[k] === ")") depth += 1;
      else if (src[k] === "(") {
        depth -= 1;
        if (depth === 0) break;
      }
      k -= 1;
    }
    if (k < 0) return false;
    k -= 1;
    while (k >= 0 && /\s/.test(src[k]!)) k -= 1;
    if (k < 0) return false;
  }

  if (!ID_PART_CHAR.test(src[k]!)) return false;
  let j = k;
  while (j >= 0 && ID_PART_CHAR.test(src[j]!)) j -= 1;
  return SUBQUERY_INTRODUCERS.has(src.slice(j + 1, k + 1).toUpperCase());
}

// ── Position policy ──────────────────────────────────────────────────────────
//
// Two guards consume these projections, and they ask DIFFERENT questions. That
// distinction is the round-eight correction; rounds 1–7 ran both guards off one
// projection and tightened it seven times without it.
//
// The TENANCY guard (tenant.ts) looks for `orgId : $orgId` / `orgId = $orgId` —
// a BINDING of a property NAME to the seam's own parameter. An inline pattern
// property map is one of the two ways Cypher spells that binding
// (`MATCH (n {orgId: $orgId})`), so a pattern map is a filtering position for
// it, and the round-6/7 rules about WHICH clause the map sits in are exactly
// the right question there.
//
// The SCOPE guard (assertScopeMarkers, below) looks for `<expr> IN
// $__scopeLabels` — a MEMBERSHIP TEST, whose entire contribution is the BOOLEAN
// it evaluates to. A boolean narrows rows only where a FALSE value can stop
// something, and in a pattern property map it cannot:
//
//   WITH 'Forbidden' AS label
//   MERGE (n:Forbidden {orgId: $orgId, allowed: label IN $__scopeLabels})
//   RETURN n
//
// The membership test is the VALUE of `n.allowed`. Whatever it evaluates to the
// node is created, the out-of-mandate label is applied, and the row comes back:
// the expression is RECORDED, not enforced. The same holds under MATCH —
// `MATCH (n {allowed: l IN $__scopeLabels})` constrains the arbitrary property
// `n.allowed` and says nothing about `n`'s labels. So the rule is not which
// clause the map sits in: a membership expression in pattern-property-VALUE
// position is inert in EVERY clause, and the scope guard stops counting it
// anywhere.
//
// Round 7 is not undone. `mergeMapFilters` still governs whether a MERGE map
// counts for the tenancy guard, where it is load-bearing — dropping MERGE maps
// there rejects 5 of the 63 production queries the corpus test collects. It
// simply no longer has anything to say about the scope markers. The cost of the
// stricter policy was measured the same way: all four production sites that
// emit a marker append it into a WHERE clause (`AND n.label IN $__scopeLabels`,
// `AND type(r) IN $__scopeRelTypes`, `AND any(l IN labels(m) WHERE l IN
// $__scopeLabels)`, `AND ALL(n IN nodes(path) WHERE any(l IN labels(n) WHERE l
// IN $__scopeLabels))`), so the stricter policy rejects 0 of 4. `graph-scope.
// test.ts` pins all four shapes as accepted.
type PositionPolicy =
  /** A WHERE clause, or an inline pattern property map. Tenancy's question. */
  | "filtering"
  /** A WHERE clause only — a boolean that gates the row. Scope's question. */
  | "predicate";

/**
 * Blank every character of `cypher` that is not in a position capable of
 * CONSTRAINING WHICH ROWS THE QUERY TOUCHES, and return the result. Offsets are
 * preserved (blanked characters become spaces) so a match's position still maps
 * back to the original text.
 *
 * Two positions survive, and they are the only two ways Cypher narrows a row
 * set by a property:
 *
 *  - a `WHERE` clause, from the keyword until the next top-level clause; and
 *  - an inline pattern property map — a `{…}` opened inside a node `(…)` or
 *    relationship `[…]` PATTERN specifically (see `opensPattern`), which is the
 *    `MATCH (n {orgId: $orgId})` / `MERGE (n {orgId: $orgId})` form. A map
 *    nested in a call or a list — `head([{allowed: …}])`, `collect({…})` — is an
 *    expression, and is blanked like any other projection.
 *
 * Everything else is blanked, and the three that matter are:
 *
 *  - **`SET`.** `MATCH (n) SET n.orgId = $orgId` reads every tenant's nodes and
 *    reassigns them all to the caller's organisation. A SET target is where a
 *    value LANDS, never a restriction on which rows were selected. Treating it
 *    as an anchor is strictly worse than the presence check it replaced, since
 *    it reads as scoping to anyone skimming.
 *  - **`RETURN` / `WITH` projections.** `RETURN n, n.orgId = $orgId AS mine`
 *    evaluates the comparison for every row and discards nothing. An aliased
 *    predicate is a column, not a filter.
 *  - **map literals outside a pattern.** `SET n += {orgId: $orgId}` is an
 *    assignment that happens to be spelled with braces.
 *
 * Under the `"predicate"` policy the pattern-map position is dropped too, so
 * only WHERE survives — see the policy note above for why a membership test
 * written as a pattern-property VALUE enforces nothing.
 *
 * This does not make the seam a query analyser and does not prove isolation: a
 * query can bind the tenant in a WHERE and still read across tenants elsewhere
 * (an unanchored second MATCH, a CALL subquery). It establishes that the token
 * participates in filtering somewhere, which is the bar a lexical seam can hold
 * and enforce on every query in the platform.
 */
function keepPositions(cypher: string, policy: PositionPolicy): string {
  const src = stripLiteralsAndComments(cypher);
  const out = new Array<string>(src.length).fill(" ");

  let paren = 0;
  let bracket = 0;
  // One entry per open `(` / `[`: true when THAT bracket opened a pattern. The
  // stack is what makes `{…}` classification exact — the innermost enclosing
  // bracket decides, so a map inside a call inside a pattern is still a call's.
  const bracketFrames: Array<{ isPattern: boolean; braceDepth: number }> = [];
  // One entry per open `{`: which of Cypher's THREE brace meanings it is.
  //
  //  - `"pattern"` — an inline pattern property map, `MATCH (n {orgId: $orgId})`.
  //    A real anchor for the tenancy guard, and the only brace whose contents
  //    constrain the variable the enclosing pattern binds.
  //  - `"subquery"` — a clause sequence: `CALL { … }`, `EXISTS { … }`,
  //    `COUNT { … }`, `COLLECT { … }`. Clause tracking applies INSIDE it, and
  //    the clause in force outside is restored when it closes.
  //  - `"map"` — a map literal or map projection. An expression VALUE, and
  //    nothing inside it constrains anything.
  //
  // The third is the round-ten correction. A `WHERE` clause was kept whole, so
  // a map literal written inside one handed the tenancy guard its key:
  //
  //     MATCH (n) WHERE {orgId: $orgId} IS NOT NULL RETURN n
  //
  // The predicate is a non-null map and is therefore always true; every tenant's
  // nodes come back, and `orgId: $orgId` sitting in a kept `WHERE` satisfied the
  // guard. `{orgId: $orgId}` and `(n {orgId: $orgId})` differ only in what
  // ENCLOSES the brace, which is why this is decided on the bracket stack and
  // not by the regex — the regex cannot see an enclosing context at all.
  //
  // Eleven encodings of it were found by enumerating the positions a map can
  // occupy rather than by waiting for each to be demonstrated: bare in a WHERE,
  // parenthesised, as a function argument, inside a list, produced by a list
  // comprehension, compared against a property, as a map PROJECTION (`n{…}`),
  // inside a CASE, inside a subquery's WHERE, as a map VALUE holding the whole
  // comparison, and nested one level inside a genuine pattern map. All eleven
  // are one rule: a brace that is not a pattern and not a subquery is a value,
  // and a value constrains nothing.
  const braceKinds: Array<"pattern" | "subquery" | "map"> = [];
  // (How many `"map"` frames are open is tracked in `mapDepth` below: a map
  // nested anywhere inside another map is still inside a value, so the DEPTH
  // decides and not the innermost frame.)
  //
  // One entry per open `{`: the clause state in force when that brace opened,
  // restored when it closes.
  //
  // A brace is the one delimiter in Cypher that can contain a WHOLE CLAUSE
  // SEQUENCE without opening a paren or a bracket: `EXISTS { MATCH (m) WHERE
  // m.x = 1 }`, `COUNT { … }`, `COLLECT { … }`, `CALL { … }`. `clause` used to
  // be a single global, so the inner `WHERE` survived the closing brace and
  // GOVERNED THE ENCLOSING EXPRESSION — the rest of an outer projection was
  // kept as if it were a predicate:
  //
  //   MATCH (n)
  //   RETURN EXISTS { MATCH (m) WHERE m.x = 1 } AS ok,
  //          n.orgId = $orgId AS mine, n
  //
  // `n` is never scoped; the anchor is an aliased column in a RETURN, which
  // filters nothing — but the leaked `WHERE` made `keepFilteringPositions` hand
  // it to the tenancy guard as a real one. The scope guard had the identical
  // hole with `n.label IN $__scopeLabels AS allowed`.
  //
  // Saving and restoring across the brace is the correct reading and not merely
  // the safe one: an expression subquery's clause sequence is scoped to the
  // subquery in Cypher, and whatever clause the expression sits in is still in
  // force after it. It fixes `CALL { … } RETURN …` the same way — the outer
  // clause reverts to `CALL` rather than inheriting the subquery's last clause.
  const braceClause: Array<{ clause: string; mergeMapFilters: boolean }> = [];
  let mapDepth = 0;
  let clause = "";
  // True once a clause has introduced a graph variable, and the condition under
  // which a MERGE map counts as filtering (see below).
  let boundAGraphVariable = false;
  let mergeMapFilters = false;

  const enclosingBracket = () => bracketFrames[bracketFrames.length - 1];
  // A `{` is a pattern property map only when the bracket that encloses it is a
  // pattern AND no brace has been opened inside that bracket yet. The second
  // half is what stops `MATCH (n {meta: {orgId: $orgId}})`: the node paren is
  // still the nearest enclosing BRACKET at the inner brace, so bracket kind
  // alone would read a map nested in a pattern map as another pattern map.
  const opensPatternMap = () => {
    const encl = enclosingBracket();
    return (
      encl !== undefined &&
      encl.isPattern &&
      encl.braceDepth === braceKinds.length
    );
  };
  const inPatternMap = () => braceKinds[braceKinds.length - 1] === "pattern";
  const inMapLiteral = () => mapDepth > 0;
  // A pattern property map filters only in a clause that SELECTS EXISTING ROWS.
  // The two conditions conjoin; pattern-map-ness does not override the clause.
  // `MATCH (n) CREATE (m {orgId: $orgId})` assigns the tenant to a node being
  // created while the MATCH still reads every tenant's rows, and
  // `MATCH (n) RETURN n, ({orgId: $orgId})` is a parenthesised map in a
  // projection. Neither narrows anything.
  //
  // `MERGE` joins them under ONE condition: nothing before it has bound a graph
  // variable. That is not an attempt to decide which variable the map scopes —
  // it is the case where there is nothing else to scope. Every variable in the
  // merged pattern is then new, the map is a match-or-create predicate over all
  // of them, and no earlier clause has already put unscoped rows in play. The
  // moment a MATCH, an earlier MERGE, a CREATE or a CALL has run, the map can
  // only narrow what this MERGE introduces, so it stops counting.
  //
  // This is conservative, not sound, and the seam does not claim otherwise:
  // `MERGE (a {orgId: $orgId}) MATCH (b) RETURN b` still passes, for the same
  // reason `MATCH (a {orgId: $orgId}) MATCH (b) RETURN b` does. See ADR-087.
  //
  // `inMapLiteral()` gates BOTH arms, and it is the outermost condition because
  // it is the strongest: inside a map literal there is no position that
  // constrains anything, whatever clause encloses it and whichever guard is
  // asking.
  const keeping = () =>
    !inMapLiteral() &&
    (clause === "WHERE" ||
      (policy === "filtering" &&
        inPatternMap() &&
        (ROW_SELECTING_CLAUSES.has(clause) ||
          (clause === "MERGE" && mergeMapFilters))));

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    // Words: a clause keyword at depth 0 switches the current clause. Depth 0
    // also excludes the inside of a pattern property map, because the pattern's
    // own `(`/`[` is still open around it.
    IDENTIFIER_AT.lastIndex = i;
    const idMatch = IDENTIFIER_AT.exec(src);
    if (idMatch) {
      const j = i + idMatch[0].length;
      const word = idMatch[0].toUpperCase();
      if (
        paren === 0 &&
        bracket === 0 &&
        CLAUSE_KEYWORDS.has(word) &&
        startsAClause(src, i, j)
      ) {
        clause = word;
        // Decided as the clause OPENS, before this MERGE marks the query as
        // having bound something — otherwise a MERGE would always disqualify
        // itself.
        if (word === "MERGE") mergeMapFilters = !boundAGraphVariable;
        if (GRAPH_BINDING_CLAUSES.has(word)) boundAGraphVariable = true;
      }
      if (keeping()) for (let k = i; k < j; k += 1) out[k] = src[k]!;
      i = j;
      continue;
    }

    if (ch === "(") {
      paren += 1;
      bracketFrames.push({
        isPattern: opensPattern(src, i, clause),
        braceDepth: braceKinds.length,
      });
    } else if (ch === ")") {
      paren = Math.max(0, paren - 1);
      bracketFrames.pop();
    } else if (ch === "[") {
      bracket += 1;
      bracketFrames.push({
        isPattern: opensPattern(src, i, clause),
        braceDepth: braceKinds.length,
      });
    } else if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      bracketFrames.pop();
    } else if (ch === "{") {
      const kind = opensPatternMap()
        ? "pattern"
        : opensSubquery(src, i)
          ? "subquery"
          : "map";
      braceKinds.push(kind);
      if (kind === "map") mapDepth += 1;
      braceClause.push({ clause, mergeMapFilters });
    } else if (ch === "}") {
      if (braceKinds.pop() === "map") mapDepth = Math.max(0, mapDepth - 1);
      // Restore BEFORE the keeping() test below, so the `}` itself is judged by
      // the clause that encloses the expression, not by the subquery's last one.
      const saved = braceClause.pop();
      if (saved) {
        clause = saved.clause;
        mergeMapFilters = saved.mergeMapFilters;
      }
      // `boundAGraphVariable` deliberately does NOT restore. It only ever makes
      // a later MERGE map stop counting, so letting an inner `MATCH` set it is
      // the conservative direction; unwinding it could resurrect a MERGE map's
      // standing on the strength of a subquery the scanner did not analyse.
    }

    if (keeping()) out[i] = ch;
    i += 1;
  }

  return out.join("");
}

/**
 * Positions where a NAME-TO-PARAMETER BINDING can narrow the row set: a WHERE
 * clause, or an inline pattern property map in a clause that selects rows. The
 * tenancy guard's projection — `MATCH (n {orgId: $orgId})` is a real anchor and
 * has to keep counting as one.
 */
export function keepFilteringPositions(cypher: string): string {
  return keepPositions(cypher, "filtering");
}

/**
 * Positions where a BOOLEAN can gate the row: a WHERE clause, and nothing else.
 *
 * Stricter than {@link keepFilteringPositions} by exactly the pattern property
 * map, because a boolean written as a map VALUE is stored, not enforced (see
 * the policy note above). This is the projection the scope-marker guard uses.
 */
export function keepPredicatePositions(cypher: string): string {
  return keepPositions(cypher, "predicate");
}

/**
 * Throw if `cypher` contains a write clause. Called only when the scope's mode
 * is `read`.
 */
export function assertReadOnly(cypher: string): void {
  const sanitized = stripLiteralsAndComments(cypher);
  if (WRITE_KEYWORD.test(sanitized) || MUTATING_CALL.test(sanitized)) {
    throw new GraphScopeError(
      `Write clause rejected on a read-mode graph scope: ${cypher.slice(0, 80)}`,
    );
  }
}

// ── Bypass guard ─────────────────────────────────────────────────────────────

/**
 * Throw if a constrained dimension's marker is absent from the query. Mirrors
 * the tenancy guard (which requires `\borgId\b`): a query on an agent-scoped
 * session that constrains labels/rel-types but forgets to reference the filter
 * cannot silently return out-of-scope data.
 *
 * The marker is looked for only in the query's PREDICATE positions (see
 * `keepPredicatePositions`), so a marker in a comment, a string, a `RETURN`
 * projection, an alias, or a pattern property map does not satisfy the guard —
 * it has to be a membership test whose boolean can refuse a row. Error messages
 * quote the original text.
 *
 * WHAT THIS STILL DOES NOT DECIDE. A membership test is inert wherever its
 * boolean cannot gate a row, and POSITION is only one of the ways that happens.
 * Every class below puts the marker in a real WHERE clause, passes this guard,
 * and enforces nothing. `graph-scope.test.ts` asserts each one as a KNOWN-
 * ACCEPTED query, so the gap is a recorded property of the seam rather than the
 * next reviewer's discovery:
 *
 *  1. NEGATED — `WHERE NOT (l IN $__scopeLabels)` selects precisely the labels
 *     the mandate excludes.
 *  2. DISJOINED — `WHERE n.x = 1 OR l IN $__scopeLabels` admits a row without
 *     the membership holding.
 *  3. COMPARED — `WHERE n.allowed = (l IN $__scopeLabels)` is the pattern-map
 *     case moved inside a WHERE: the boolean is an operand, not the gate.
 *  4. ARGUMENT — `WHERE coalesce(l IN $__scopeLabels, true)` discards it.
 *  5. BINDER, NOT MEMBERSHIP — `WHERE any(x IN $__scopeLabels WHERE true)`.
 *     Cypher writes a comprehension's iteration source with the same `IN` token
 *     as the membership operator, and the marker regex cannot tell them apart.
 *  6. WRONG VARIABLE — `MATCH (a) MATCH (b) WHERE any(l IN labels(a) WHERE l IN
 *     $__scopeLabels) RETURN b`. A real gate, on rows the query does not return.
 *  7. WRONG BRANCH — the predicate on one UNION branch only, or attached to an
 *     `OPTIONAL MATCH` whose failure leaves the row in place with a null.
 *
 * 1–5 are expression-SHAPE questions that a boolean-tree analysis could decide.
 * 6–7 are REACHABILITY, which is the class ADR-087 records as undecidable for
 * the tenancy guard by the same argument: a full Cypher parse reports
 * structure, and in each of these the structure is correct. The durable answer
 * for both guards is to CONSTRUCT the scoping rather than validate it (ADR-087,
 * #3199). This seam is a lint. It is not the mandate.
 *
 * A THIRD CLASS sits UNDER all of these and is worth naming separately, because
 * it is the one that keeps producing findings and the one that is genuinely
 * bounded: whether the scanner read its own TOKENS correctly — where a string,
 * a comment, an identifier, a parameter or a clause begins and ends. That is
 * the openCypher LEXICAL grammar, it is a finite document, and a scanner can be
 * held against it. This module has instead been corrected one demonstrated
 * hazard at a time, which is why `\b` and `[A-Za-z0-9_]` survived in it for
 * nine rounds while Cypher's identifiers were Unicode the whole time. ADR-087
 * §"Rounds 8 and 9" separates the two claims and says what closing each costs;
 * the short version is that a perfect lexer closes none of 1–7, and none of
 * 1–7 is a reason to keep an approximate one.
 *
 * Nor does it bound WRITES. Under `mode: "extend"`, a marker in a real WHERE
 * still lets a query MERGE or CREATE a node carrying a label outside
 * `scope.labels`: the allow-list is a read filter, and nothing here reads the
 * label literals a write pattern applies. That IS decidable — a label literal
 * in a write pattern is a syntactic fact — but it is a different control, and
 * whether `labels` is meant to bound the write path at all is a mandate
 * question, not a guard question.
 */
export function assertScopeMarkers(cypher: string, scope: GraphScope): void {
  const sanitized = keepPredicatePositions(cypher);
  if (scope.labels !== undefined && !LABELS_MARKER.test(sanitized)) {
    throw new GraphScopeError(
      `Agent-scoped Cypher constrains labels but does not filter on $${SCOPE_LABELS_PARAM}: ${cypher.slice(0, 80)}`,
    );
  }
  if (
    scope.relationshipTypes !== undefined &&
    !REL_TYPES_MARKER.test(sanitized)
  ) {
    throw new GraphScopeError(
      `Agent-scoped Cypher constrains relationship types but does not filter on $${SCOPE_REL_TYPES_PARAM}: ${cypher.slice(0, 80)}`,
    );
  }
}

/** Throw if a caller supplied one of the reserved scope parameter names. */
export function assertNoReservedParamCollision(
  params: Record<string, unknown>,
): void {
  for (const key of RESERVED_SCOPE_PARAMS) {
    if (key in params) {
      throw new GraphScopeError(
        `Reserved scope parameter "${key}" must not be supplied by callers`,
      );
    }
  }
}

/** Build the reserved scope parameters for the constrained dimensions. */
export function buildScopeParams(scope: GraphScope): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (scope.labels !== undefined) params[SCOPE_LABELS_PARAM] = scope.labels;
  if (scope.relationshipTypes !== undefined) {
    params[SCOPE_REL_TYPES_PARAM] = scope.relationshipTypes;
  }
  return params;
}

// ── Budget clamps ─────────────────────────────────────────────────────────────

/**
 * Clamp variable-length relationship patterns to at most `maxHops`.
 *
 * Rewrites only the `*<lower>..<upper>` quantifier token inside a relationship
 * bracket, preserving the variable name / `:TYPE` / rest of the bracket, so
 * index selection on the surrounding MATCH is untouched. Handles every
 * variable-length syntax:
 *   `[*]`        1..∞    → `[*1..maxHops]`
 *   `[*..5]`     1..5    → `[*1..min(5,maxHops)]`
 *   `[*2..]`     2..∞    → `[*2..maxHops]`
 *   `[*1..5]`    1..5    → `[*1..min(5,maxHops)]`
 *   `[*3]`       exactly → `[*min(3,maxHops)]`
 *   `[r:T*1..5]` typed   → bounds clamped, `r:T` preserved
 */
export function clampVarLengthHops(cypher: string, maxHops: number): string {
  if (!Number.isFinite(maxHops) || maxHops < 0) return cypher;
  const cap = Math.trunc(maxHops);

  return cypher.replace(
    /(\[[^\]]*?)\*(\d*)(\.\.)?(\d*)([^\]]*?\])/g,
    (
      _match,
      pre: string,
      lowerStr: string,
      dots: string | undefined,
      upperStr: string,
      post: string,
    ) => {
      let token: string;
      if (!dots) {
        if (lowerStr === "") {
          // `*` → 1..∞. The lower bound is itself clamped so a `maxHops: 0`
          // budget (both schemas allow zero) yields the same `*0..0` the
          // explicit-bounds branch below produces, not an empty `*1..0` range.
          token = `*${Math.min(1, cap)}..${cap}`;
        } else {
          // `*N` → exactly N
          token = `*${Math.min(Number(lowerStr), cap)}`;
        }
      } else {
        const lower = lowerStr === "" ? 1 : Number(lowerStr);
        const upper = upperStr === "" ? Infinity : Number(upperStr);
        const newUpper = Math.min(upper, cap);
        const newLower = Math.min(lower, newUpper);
        token = `*${newLower}..${newUpper}`;
      }
      return `${pre}${token}${post}`;
    },
  );
}

/**
 * Clamp the result-set size to at most `maxNodes`.
 *
 * - Every literal `LIMIT <n>` is clamped down to `min(n, maxNodes)` (never up),
 *   which preserves a smaller existing LIMIT and clamps a larger one. Scanning
 *   *all* literal LIMITs (not just a top-level one) correctly bounds each branch
 *   of a UNION and any intermediate `WITH … LIMIT`.
 * - When the query has NO LIMIT at all, a `LIMIT <maxNodes>` is appended —
 *   except for a UNION query, where a bare trailing LIMIT is a syntax error, so
 *   the seam fails closed and the builder must add a per-branch LIMIT.
 * - A runtime-parameterized `LIMIT $x` cannot be verified at this seam, so it
 *   fails closed: an agent-scoped read query must use a literal LIMIT.
 */
export function clampLimits(cypher: string, maxNodes: number): string {
  if (!Number.isFinite(maxNodes) || maxNodes < 0) return cypher;
  const cap = Math.trunc(maxNodes);

  // `\$\w+` was ASCII-only, so `LIMIT $é` slipped past this fail-closed check
  // AND past the literal rewrite below, and the seam appended a second `LIMIT`
  // — a Cypher syntax error at the database instead of the GraphScopeError the
  // author needs to read. Any `$` after LIMIT is a parameter, whatever it names.
  if (/\bLIMIT\s+\$/i.test(cypher)) {
    throw new GraphScopeError(
      `Cannot enforce maxNodes budget on a parameterized LIMIT; agent-scoped read queries must use a literal LIMIT: ${cypher.slice(0, 80)}`,
    );
  }

  let hadLiteral = false;
  const clamped = cypher.replace(/\bLIMIT\s+(\d+)\b/gi, (_m, n: string) => {
    hadLiteral = true;
    return `LIMIT ${Math.min(Number(n), cap)}`;
  });
  if (hadLiteral) return clamped;

  if (/\bUNION\b/i.test(clamped)) {
    throw new GraphScopeError(
      `Cannot enforce maxNodes budget: UNION query has no per-branch LIMIT; builder must add one: ${cypher.slice(0, 80)}`,
    );
  }
  return `${clamped.trimEnd()}\nLIMIT ${cap}`;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export interface AppliedGraphScope {
  /** The transformed Cypher (hop + LIMIT clamps applied). */
  cypher: string;
  /** Caller params merged with the injected reserved scope params. */
  params: Record<string, unknown>;
  /** neo4j-driver TransactionConfig — present only when maxTraversalMs is set. */
  txConfig?: { timeout: number };
}

/**
 * Apply a GraphScope to a Cypher query + params. Runs the bypass guard, the
 * read-mode write rejection, the budget clamps, and injects the reserved scope
 * params. Pure — tenant.ts layers $orgId/$workspaceId on top of the returned
 * params (so tenancy always wins) and threads txConfig into `session.run`.
 *
 * Throws GraphScopeError on any violation the seam cannot enforce silently.
 */
export function applyGraphScope(
  cypher: string,
  params: Record<string, unknown>,
  scope: GraphScope,
): AppliedGraphScope {
  assertNoReservedParamCollision(params);
  assertScopeMarkers(cypher, scope);
  if (scope.mode === "read") assertReadOnly(cypher);

  let finalCypher = cypher;
  const budget = scope.budget;
  if (budget?.maxHops !== undefined) {
    finalCypher = clampVarLengthHops(finalCypher, budget.maxHops);
  }
  if (budget?.maxNodes !== undefined) {
    finalCypher = clampLimits(finalCypher, budget.maxNodes);
  }

  const txConfig =
    budget?.maxTraversalMs !== undefined
      ? { timeout: budget.maxTraversalMs }
      : undefined;

  return {
    cypher: finalCypher,
    params: { ...params, ...buildScopeParams(scope) },
    txConfig,
  };
}
