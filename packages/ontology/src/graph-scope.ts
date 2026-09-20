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
  return scanLiteralsAndComments(cypher).text;
}

/**
 * The scan behind {@link stripLiteralsAndComments}, which also reports whether
 * the input ended INSIDE a comment, a string or a backtick identifier.
 *
 * ROUND SIXTEEN AUDITED THIS AGAINST THE LEXER RATHER THAN AGAINST A FINDING,
 * and it is the layer under every other rule in this file: the tenancy anchor,
 * the scope markers, the read-mode write rejection and the clause tracking all
 * read its output. Five rounds of position rules each assumed it produced a
 * faithful projection; nothing had checked that it did.
 *
 * The reference is Neo4j's own `Cypher25Lexer.g4` (`neo4j/cypher-language-support`,
 * `packages/language-support/src/antlr-grammar`), and the rules that matter are
 * restated here so the next reader need not go and find them. `CLOSE` below is
 * an asterisk followed by a slash, spelled out because writing it literally
 * would end this comment:
 *
 *     MULTI_LINE_COMMENT    : '/CLOSE' .*? 'CLOSE'   // non-greedy: FIRST close
 *     SINGLE_LINE_COMMENT   : '//' ~[\r\n]*          // CR **or** LF ends it
 *     STRING_LITERAL1       : '\'' (~['\\] | EscapeSequence)* '\''
 *     STRING_LITERAL2       : '"'  (~["\\] | EscapeSequence)* '"'
 *     fragment EscapeSequence : '\\' .               // backslash + ANY char
 *     ESCAPED_SYMBOLIC_NAME : '`' ( ~'`' | '``' )* '`'  // doubling, no backslash
 *
 * What the audit found, and what it did not:
 *
 *  - **Block comments do not nest.** The `.*?` is non-greedy, so Cypher closes
 *    at the first terminator exactly as `indexOf` does here. A review round
 *    reported a doubled-open comment as a bypass on the premise that Neo4j
 *    keeps it commented to the OUTER terminator. It does not: the two agree on
 *    which text is live, and what is left over is a syntax error rather than a
 *    query. No change was needed and none was made.
 *  - **A lone CR did not end a line comment here, and does in Cypher.** That
 *    was real, and it failed in the dangerous direction: this function hid text
 *    the database executes, so `assertReadOnly` — a DENYLIST — found no write
 *    keyword in a query ending `RETURN n // c` CR `DETACH DELETE n`, and a
 *    read-scoped session deleted. Fixed below by scanning for `~[\r\n]` as the
 *    grammar writes it.
 *  - **A quote inside a comment, and a comment marker inside a literal, are
 *    both inert** — in the lexer and here, because both are decided by
 *    whichever delimiter opens first. Already correct; now pinned, since it is
 *    the property the single-pass design exists to provide.
 *
 * `unterminated` is the other half. An unclosed comment, string or backtick
 * does not lex in Cypher at all, so there is no faithful projection of it to
 * produce — and this function's answer was to swallow to end of input, which
 * hides whatever follows. Nothing executed, but only because the database
 * rejects the query: an external guarantee standing in for a local one. The
 * flag lets each caller fail closed in ITS OWN direction, which is not the same
 * direction for all of them — see `keepPositions` and `assertReadOnly`.
 *
 * One scanner with two entry points rather than two scanners: a separate pass
 * answering "is it unterminated" would be a second lexer to keep in agreement
 * with this one, which is the class of defect this module exists to stop
 * repeating.
 */
export function scanLiteralsAndComments(cypher: string): {
  text: string;
  unterminated: boolean;
} {
  let out = "";
  let i = 0;
  const n = cypher.length;
  let unterminated = false;

  while (i < n) {
    const ch = cypher[i]!;
    const next = cypher[i + 1];

    // Block comment — collapse to a space, keeping tokens on either side apart.
    // Non-greedy in the grammar, so the FIRST terminator closes it and the
    // construct does not nest.
    if (ch === "/" && next === "*") {
      const end = cypher.indexOf("*/", i + 2);
      out += " ";
      if (end === -1) unterminated = true;
      i = end === -1 ? n : end + 2;
      continue;
    }

    // Line comment — collapse to a space and resume at the line terminator,
    // which is preserved so line structure (and any trailing clause) survives.
    //
    // CR ends it as well as LF. Scanning only for LF hid every character
    // between a lone CR and the next LF — text Cypher executes — from all four
    // guards. Running off the end is NOT unterminated: `~[\r\n]*` matches
    // happily to end of input, so a trailing comment with no newline is a
    // complete token and the text after it is genuinely commented.
    if (ch === "/" && next === "/") {
      let end = i + 2;
      while (end < n && cypher[end] !== "\n" && cypher[end] !== "\r") end += 1;
      out += " ";
      i = end;
      continue;
    }

    // String literal or backtick-quoted identifier — emit an empty placeholder
    // of the same delimiter and skip the body.
    if (ch === "'" || ch === '"' || ch === "`") {
      const closer = ch;
      out += closer + closer;
      i += 1;
      let closed = false;
      while (i < n) {
        const c = cypher[i]!;
        // Backtick identifiers escape by DOUBLING and take no backslash escape
        // at all — the grammar has no EscapeSequence in that rule. Strings are
        // the other way round: an escape is a backslash and ANY character,
        // which is why the skip is two rather than a lookup table.
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
        if (c === closer) {
          closed = true;
          break;
        }
      }
      if (!closed) unterminated = true;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { text: out, unterminated };
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

/** What a subquery brace declares about its own variable scope. */
interface SubqueryOpening {
  /**
   * `"call"` for `CALL { … }`, whose body sees NOTHING from the enclosing
   * scope unless it imports it; `"expression"` for `EXISTS` / `COUNT` /
   * `COLLECT`, whose body sees every enclosing variable.
   */
  readonly subquery: "call" | "expression";
  /**
   * For the scoped form `CALL (a, b) { … }` (Neo4j 5.23), the variables the
   * scope clause imports; `"all"` for `CALL (*) { … }`; `null` when there is
   * no scope clause, so any import is an importing `WITH` as the body's first
   * clause.
   */
  readonly imports: readonly string[] | "all" | null;
}

/**
 * The introducer of the subquery brace at `openIdx` — a SUBQUERY is a clause
 * sequence rather than a map literal — or `null` when the brace is a map.
 *
 * `CALL { … }`, `EXISTS { … }`, `COUNT { … }` and `COLLECT { … }` are the only
 * four, and the word immediately before the brace is what says so. The one
 * complication is the scoped-subquery form `CALL (n) { … }` (Neo4j 5.23), where
 * the preceding character is `)`; the balanced walk back to that `(` and then to
 * the word before it is what keeps a legitimately anchored scoped subquery from
 * being read as a map literal and blanked. The walk keeps what it passed over,
 * because the tenancy guard's per-scope rule needs to know which of the four
 * it is and what a scope clause imports.
 */
function subqueryOpening(src: string, openIdx: number): SubqueryOpening | null {
  let k = openIdx - 1;
  while (k >= 0 && /\s/.test(src[k]!)) k -= 1;
  if (k < 0) return null;

  let imports: readonly string[] | "all" | null = null;
  if (src[k] === ")") {
    const close = k;
    let depth = 0;
    while (k >= 0) {
      if (src[k] === ")") depth += 1;
      else if (src[k] === "(") {
        depth -= 1;
        if (depth === 0) break;
      }
      k -= 1;
    }
    if (k < 0) return null;
    const inner = src.slice(k + 1, close).trim();
    imports =
      inner === "*"
        ? "all"
        : inner === ""
          ? []
          : inner.split(",").map((name) => name.trim());
    k -= 1;
    while (k >= 0 && /\s/.test(src[k]!)) k -= 1;
    if (k < 0) return null;
  }

  if (!ID_PART_CHAR.test(src[k]!)) return null;
  let j = k;
  while (j >= 0 && ID_PART_CHAR.test(src[j]!)) j -= 1;
  const word = src.slice(j + 1, k + 1).toUpperCase();
  if (!SUBQUERY_INTRODUCERS.has(word)) return null;
  // A scope clause belongs to `CALL` alone. The three expression subqueries
  // see the enclosing scope whole, so a paren before one of them (not Cypher
  // today) declares nothing and is not read as an import list.
  return word === "CALL"
    ? { subquery: "call", imports }
    : { subquery: "expression", imports: null };
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
  return projectPositions(cypher, policy).kept;
}

/** What {@link projectPositions} reports alongside the kept projection. */
interface PositionProjection {
  /** The kept projection: every non-filtering character blanked. */
  readonly kept: string;
  /** The query with comments, literals and backtick names blanked. */
  readonly src: string;
  /** Per character, the row-selecting PATTERN PART it belongs to, or -1. */
  readonly partOwner: Int32Array;
  /** Per character, the row-selecting clause whose WHERE it belongs to, or -1. */
  readonly whereOwner: Int32Array;
  /** For each part id, the clause id it belongs to. */
  readonly clauseOfPart: readonly number[];
  /** For each part id, which top-level UNION branch it sits in (0-based). */
  readonly branchOfPart: readonly number[];
  /**
   * Per character, 1 where a `(` or `[` opens a node or relationship PATTERN
   * ELEMENT — the bracket `opensPattern` classified as one, outside any inline
   * predicate. The variable a pattern element binds is the identifier written
   * first inside such a bracket and nowhere else.
   */
  readonly patternOpen: Uint8Array;
  /**
   * The query's variable-scope events in source order, with each pattern part
   * as a `part` event — see {@link ScopeEvent}.
   */
  readonly events: readonly RawScopeEvent[];
}

/**
 * One step of a query's VARIABLE SCOPE, in source order. The tenancy guard
 * walks these to decide which variables a pattern part may inherit credit
 * from, and Cypher's rules for that are not "everything bound so far":
 *
 *  - `with` — a `WITH` projection REPLACES the scope. `WITH count(n) AS c`
 *    discards `n`, and a later `MATCH (n)` binds a fresh `n` that reads every
 *    tenant's rows. `projection` is the text between `WITH` and the next
 *    clause, literals blanked.
 *  - `return` — the same shape, and inside a `CALL { … }` it is what the
 *    subquery EXPORTS to the enclosing scope.
 *  - `open` / `close` — a subquery's body is a scope of its own. A `CALL`
 *    body sees nothing from outside unless it imports it (a scope clause, or
 *    an importing `WITH` as its first clause); an expression subquery
 *    (`EXISTS` / `COUNT` / `COLLECT`) sees everything. Nothing a body binds is
 *    visible after `close` except what a `CALL` returns.
 *  - `union` — a `UNION` at ANY scope level starts a branch whose scope is
 *    what the enclosing scope handed in, and nothing the earlier branch bound.
 */
export type ScopeEvent =
  | { readonly kind: "part"; readonly part: RowSelectingPart }
  | { readonly kind: "with"; readonly projection: string }
  | { readonly kind: "return"; readonly projection: string }
  | ({ readonly kind: "open" } & SubqueryOpening)
  | { readonly kind: "close" }
  | { readonly kind: "union" };

/** {@link ScopeEvent} before the part is materialised: the part by id. */
type RawScopeEvent =
  | { readonly kind: "part"; readonly partId: number }
  | Exclude<ScopeEvent, { kind: "part" }>;

function projectPositions(
  cypher: string,
  policy: PositionPolicy,
): PositionProjection {
  const { text: src, unterminated } = scanLiteralsAndComments(cypher);
  const out = new Array<string>(src.length).fill(" ");
  // Row-selecting clause ownership, for `rowSelectingParts`. A `MATCH` or
  // `OPTIONAL MATCH` clause is split into its comma-separated PATTERN PARTS,
  // and its `WHERE` is recorded against the clause, so the tenancy guard can
  // ask of each part whether IT is anchored rather than whether the query is.
  const partOwner = new Int32Array(src.length).fill(-1);
  const whereOwner = new Int32Array(src.length).fill(-1);
  const clauseOfPart: number[] = [];
  const branchOfPart: number[] = [];
  const patternOpen = new Uint8Array(src.length);
  const events: RawScopeEvent[] = [];
  // A `WITH` or `RETURN` whose projection is still being read: its kind and
  // where the projection text starts. Flushed as one event at the next clause
  // keyword of the same clause sequence, at the brace that closes the
  // sequence, or at the end of the query.
  let pendingProjection: { kind: "with" | "return"; start: number } | null =
    null;
  const flushProjection = (end: number) => {
    if (pendingProjection === null) return;
    events.push({
      kind: pendingProjection.kind,
      projection: src.slice(pendingProjection.start, end),
    });
    pendingProjection = null;
  };
  let branch = 0;
  let nextClauseId = 0;
  let currentClause = -1;
  let currentPart = -1;
  let inClauseWhere = false;
  const openPart = () => {
    currentPart = clauseOfPart.length;
    clauseOfPart.push(currentClause);
    branchOfPart.push(branch);
    events.push({ kind: "part", partId: currentPart });
  };
  const own = (k: number) => {
    if (inClauseWhere) whereOwner[k] = currentClause;
    else partOwner[k] = currentPart;
  };
  // An unterminated comment, string or backtick means there is no faithful
  // projection to produce, so NOTHING is reported as a filtering position and
  // both guards that read this refuse for want of an anchor or a marker.
  //
  // Blanking rather than throwing because this function is a projection, not a
  // guard: its callers turn an empty result into their own error, with their own
  // message, and `keepFilteringPositions` has no business deciding which of them
  // is asking. `assertReadOnly` takes the opposite branch on the same flag, for
  // the reason given there.
  if (unterminated) {
    return {
      kept: out.join(""),
      src,
      partOwner,
      whereOwner,
      clauseOfPart,
      branchOfPart,
      patternOpen,
      events,
    };
  }

  let paren = 0;
  let bracket = 0;
  // One entry per open `(` / `[`: whether THAT bracket opened a pattern, and
  // whether that pattern's PROPERTY-MAP POSITION HAS ALREADY CLOSED. The stack
  // is what makes `{…}` classification exact — the innermost enclosing bracket
  // decides, so a map inside a call inside a pattern is still a call's.
  //
  // `inlinePredicate` is the round-thirteen correction, and like round eleven it
  // REPLACES a question rather than adding a case. A node pattern is
  //
  //     ( [variable] [labelExpression] [propertyMap] [WHERE expression] )
  //
  // and a relationship pattern is the same shape inside `[…]`. The property map
  // comes BEFORE the `WHERE`, so the `WHERE` is the point at which the
  // property-map position ENDS and ordinary expression syntax begins. Every
  // brace and every bracket after it in that frame is an expression.
  //
  // The scanner used to ask only "is the enclosing paren a pattern?", which is
  // true for the whole frame, inline predicate included. The round-12 and
  // round-13 findings are that one gap in two spellings:
  //
  //     MATCH (n WHERE {orgId: $orgId} IS NOT NULL) RETURN n       (round 13)
  //     MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId
  //                              AS mine } <> []) RETURN n         (round 12)
  //
  // Neither predicate can be false — a map literal is never null, and a COLLECT
  // over an unfiltered MATCH is non-empty whenever any node exists — so every
  // tenant's `n` comes back while the guard reads a tenant binding. Round 12's
  // was closed by ordering `subqueryOpening` first, which is correct on its own
  // terms and is kept; it closed one brace MEANING inside the region and left
  // the REGION open, which is what round 13 then demonstrated with another.
  //
  // Enumerating the region rather than the finding, fifteen queries reached it:
  // a map literal bare, parenthesised, in a CASE, as a map VALUE holding the
  // comparison, and after a map projection; the same on a RELATIONSHIP pattern,
  // on a second node in the path, under `OPTIONAL MATCH`, under `MERGE`, after
  // a label expression, and inside a quantified path pattern; a pattern
  // property map inside a subquery inside the region; one inline predicate
  // nested inside another; a pattern comprehension inside the region; and a
  // grouping paren inside it, which round 11's `=`-then-`(` rule re-admitted as
  // a pattern. One rule answers all fifteen, which is the test that it is the
  // right rule rather than a sixteenth case.
  //
  // The flag is set on the frame and dies when the frame pops, so it cannot
  // leak past the pattern it belongs to: `MATCH (a WHERE a.x = 1)-[r]->(b
  // {orgId: $orgId})` still anchors on `b`'s map, and a map written BEFORE the
  // `WHERE` — `MATCH (n {orgId: $orgId} WHERE n.x = 1)` — is still the real
  // anchor Cypher says it is.
  const bracketFrames: Array<{
    isPattern: boolean;
    braceDepth: number;
    inlinePredicate: boolean;
  }> = [];
  // How many open frames are in their inline-predicate region. A frame opened
  // INSIDE one is expression syntax too, so this is a DEPTH rather than a
  // per-frame read: `MATCH (n WHERE true = ({orgId: $orgId} IS NOT NULL))`
  // opens a grouping paren after `=`, which `opensPattern` classifies as a node
  // pattern (`MATCH p = (a)` spells one exactly that way), and the map inside
  // that paren would otherwise be read as its property map.
  let inlinePredicateFrames = 0;
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
  //
  // The inline-predicate region saves and restores WITH the clause, and for the
  // same reason. A pattern's inline `WHERE` belongs to THAT pattern; a subquery
  // brace opens a new clause sequence whose own patterns are not inside it, so
  // `MATCH (n WHERE EXISTS { MATCH (m {orgId: $orgId}) })` keeps its map as a
  // real anchor — exactly as the top-level spelling
  // `MATCH (n) WHERE EXISTS { MATCH (m {orgId: $orgId}) }` already does. (That
  // the anchor narrows `m` while the query returns `n` is the separate,
  // pre-existing limitation ADR-087 records for `MATCH (a {orgId: $orgId})
  // MATCH (b) RETURN b`; it is not a position error, and the two spellings had
  // better not disagree about it.) Restoring on `}` rather than decrementing on
  // the frame pop is also what keeps the depth from drifting if the input is
  // unbalanced.
  const braceClause: Array<{
    clause: string;
    mergeMapFilters: boolean;
    inlinePredicateFrames: number;
    clauseParenBase: number;
    clauseBracketBase: number;
    currentClause: number;
    currentPart: number;
    inClauseWhere: boolean;
    pendingProjection: { kind: "with" | "return"; start: number } | null;
  }> = [];
  let mapDepth = 0;
  let clause = "";
  // The bracket depth at which a clause keyword BEGINS A CLAUSE. Zero at the
  // top level; reset to the depth of the enclosing brackets when a subquery
  // brace opens, and restored when it closes.
  //
  // This is round fourteen, and it is round thirteen's finding one scale up.
  // Round thirteen: the rules asked their questions of a bracket, as though a
  // bracket were homogeneous. This: clause recognition asked its question of the
  // WHOLE QUERY, as though depth were global — when a subquery is a clause
  // sequence with its OWN baseline.
  //
  // Absolute depth 0 is correct only for the outermost sequence. Nest a subquery
  // under any paren or bracket and its clauses stop being recognised:
  //
  //     MATCH (n) WHERE size(COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine })
  //                > 0 RETURN n
  //
  // `paren` is 1 inside the braces, so the subquery's `MATCH` and `RETURN` are
  // not seen and the OUTER `WHERE` stays in force over the whole subquery. The
  // projected comparison — a column, which filters nothing — was therefore read
  // as a predicate, and `COLLECT` is non-empty whenever any node exists, so every
  // tenant's `n` came back. `$__scopeLabels` in the same position bypassed the
  // agent allow-list the same way, and a `SET` written there was read as a
  // filtering position, which is a WRITE reassigning every tenant's nodes.
  //
  // Round twelve met the same mechanism from its fail-closed side — an anchor
  // written only in a nested subquery's `WHERE` was refused — and declined to
  // fix it on the grounds that recognising clauses inside a paren-nested brace
  // would OPEN kept regions. That judgement was backwards, and this is the
  // correction: recognition NARROWS what is kept. With it off, one inherited
  // `WHERE` covered the subquery's entire body, projections and writes included.
  // With it on, the subquery's `RETURN` is a `RETURN` and its `SET` is a `SET`.
  // The rule that refused something legitimate was the same rule that accepted
  // something illegitimate from the other side.
  let clauseParenBase = 0;
  let clauseBracketBase = 0;
  // True once a clause has introduced a graph variable, and the condition under
  // which a MERGE map counts as filtering (see below).
  let boundAGraphVariable = false;
  let mergeMapFilters = false;

  const enclosingBracket = () => bracketFrames[bracketFrames.length - 1];
  // True anywhere inside a pattern's inline `WHERE`, at any bracket depth.
  const insideInlinePredicate = () => inlinePredicateFrames > 0;
  // A `{` is a pattern property map only when the bracket that encloses it is a
  // pattern AND no brace has been opened inside that bracket yet. The second
  // half is what stops `MATCH (n {meta: {orgId: $orgId}})`: the node paren is
  // still the nearest enclosing BRACKET at the inner brace, so bracket kind
  // alone would read a map nested in a pattern map as another pattern map.
  // The third condition is the inline predicate: past the frame's `WHERE` the
  // property-map position is over, so a brace there is an expression however
  // pattern-ish its enclosing bracket is.
  const opensPatternMap = () => {
    const encl = enclosingBracket();
    return (
      encl !== undefined &&
      encl.isPattern &&
      !encl.inlinePredicate &&
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
        paren === clauseParenBase &&
        bracket === clauseBracketBase &&
        CLAUSE_KEYWORDS.has(word) &&
        startsAClause(src, i, j)
      ) {
        // A clause keyword ends the projection of a `WITH` / `RETURN` before
        // it, whatever the keyword is — `WHERE`, `ORDER`, `SKIP` and `LIMIT`
        // are sub-clauses of the projection in Cypher, but what they filter or
        // order is already the projected scope, so the names are decided here.
        flushProjection(i);
        if (word === "WITH" || word === "RETURN") {
          pendingProjection = {
            kind: word === "WITH" ? "with" : "return",
            start: j,
          };
        }
        // A `UNION` at any scope level starts a branch that inherits only what
        // the enclosing scope handed in — the top-level `branch` counter below
        // is the older, top-level-only view of the same fact.
        if (word === "UNION") events.push({ kind: "union" });
        // Row-selecting clause bookkeeping. `OPTIONAL MATCH` is one clause
        // spelled with two keywords; `WHERE` and a `USING` planner hint belong
        // to the clause they follow; every other keyword ends it.
        if (word === "MATCH" && clause === "OPTIONAL" && currentClause !== -1) {
          // The clause OPTIONAL opened continues.
        } else if (
          (word === "MATCH" && clause !== "ON") ||
          word === "OPTIONAL"
        ) {
          // `ON MATCH SET` is MERGE's update branch, not a clause that selects.
          currentClause = nextClauseId++;
          inClauseWhere = false;
          openPart();
        } else if (word === "WHERE" && currentClause !== -1) {
          inClauseWhere = true;
          currentPart = -1;
        } else if (word === "USING" && currentClause !== -1) {
          currentPart = -1;
        } else {
          currentClause = -1;
          currentPart = -1;
          inClauseWhere = false;
          // A top-level UNION starts a query of its own; nothing either branch
          // bound is visible in the other.
          if (word === "UNION" && braceClause.length === 0) branch += 1;
        }
        clause = word;
        // Decided as the clause OPENS, before this MERGE marks the query as
        // having bound something — otherwise a MERGE would always disqualify
        // itself.
        if (word === "MERGE") mergeMapFilters = !boundAGraphVariable;
        if (GRAPH_BINDING_CLAUSES.has(word)) boundAGraphVariable = true;
      }
      // A `WHERE` written INSIDE a pattern's own bracket is the inline node /
      // relationship predicate. It never reaches the branch above — that one
      // requires depth 0, and the pattern's `(`/`[` is open — which is correct,
      // because an inline predicate does not start a top-level clause. What it
      // does do is CLOSE the property-map position of the bracket it sits in,
      // and that is what is recorded here.
      //
      // Both conditions are load-bearing. `startsAClause` is what keeps a
      // property key (`{where: 1, orgId: $orgId}`), a label (`(n:Where {…})`), a
      // map value and a parameter from spoofing the region — the same
      // disqualifiers the clause branch relies on. The brace-depth equality is
      // what keeps a `WHERE` written INSIDE a brace opened in this frame — a
      // subquery's own clause, `(n {k: COLLECT { MATCH (m) WHERE … }})` — from
      // retiring the frame's map position, since that `WHERE` belongs to the
      // subquery and not to the pattern.
      //
      // What it cannot decide is a BARE variable spelled `where`
      // (`MATCH (where {orgId: $orgId})`), which is read as opening the region
      // and costs that query its anchor. That is the fail-closed direction, and
      // it is unreachable in Cypher besides: `WHERE` is a reserved word, so the
      // database requires the backticks that `stripLiteralsAndComments` has
      // already emptied by the time the word scan runs. It is the same
      // undecidable-without-a-parser class ADR-087 records for `RETURN n AS
      // where`, landing here on the safe side of it.
      if (word === "WHERE" && startsAClause(src, i, j)) {
        const encl = enclosingBracket();
        if (
          encl !== undefined &&
          encl.isPattern &&
          !encl.inlinePredicate &&
          encl.braceDepth === braceKinds.length
        ) {
          encl.inlinePredicate = true;
          inlinePredicateFrames += 1;
        }
      }
      if (keeping()) for (let k = i; k < j; k += 1) out[k] = src[k]!;
      for (let k = i; k < j; k += 1) own(k);
      i = j;
      continue;
    }

    if (
      ch === "," &&
      currentClause !== -1 &&
      !inClauseWhere &&
      currentPart !== -1 &&
      paren === clauseParenBase &&
      bracket === clauseBracketBase
    ) {
      // A top-level comma in a MATCH pattern starts the next pattern part:
      // `MATCH (a {orgId: $orgId}), (b)` is a Cartesian product of two parts,
      // and the second is exactly as unscoped as a second MATCH would be.
      openPart();
    }

    if (ch === "(") {
      paren += 1;
      // Inside an inline predicate every bracket is expression syntax, so the
      // character test is not even asked. Without this, round 11's admission
      // of `(` after `=`, `,`, `-`, `>`, `<`, `|`, `(` and `[` — every one of
      // which an inline predicate can contain — would re-open the region one
      // grouping paren deeper.
      const isPattern =
        !insideInlinePredicate() && opensPattern(src, i, clause);
      if (isPattern) patternOpen[i] = 1;
      bracketFrames.push({
        isPattern,
        braceDepth: braceKinds.length,
        inlinePredicate: false,
      });
    } else if (ch === ")") {
      paren = Math.max(0, paren - 1);
      if (bracketFrames.pop()?.inlinePredicate === true) {
        inlinePredicateFrames = Math.max(0, inlinePredicateFrames - 1);
      }
    } else if (ch === "[") {
      bracket += 1;
      const isPattern =
        !insideInlinePredicate() && opensPattern(src, i, clause);
      if (isPattern) patternOpen[i] = 1;
      bracketFrames.push({
        isPattern,
        braceDepth: braceKinds.length,
        inlinePredicate: false,
      });
    } else if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      if (bracketFrames.pop()?.inlinePredicate === true) {
        inlinePredicateFrames = Math.max(0, inlinePredicateFrames - 1);
      }
    } else if (ch === "{") {
      // PRECEDENCE, and it is load-bearing in its own right. Both classifiers
      // can be true at the same `{`, and which is asked FIRST is a fifth thing
      // this scanner decides — separately from the four questions it answers.
      //
      // `subqueryOpening` reads the token IMMEDIATELY BEFORE the brace, which is
      // the grammar speaking directly: `COLLECT {` is a subquery expression and
      // nothing else. `opensPatternMap` reads the ENCLOSING BRACKET, which says
      // only that a brace here COULD be a property map — true of the pattern's
      // own map, and equally true of every other brace that happens to sit
      // inside the parens. Direct evidence outranks positional evidence, so the
      // subquery test goes first.
      //
      // Asked the other way round, Cypher 5's inline node predicate defeated it:
      //
      //   MATCH (n WHERE COLLECT { MATCH (m) RETURN m.orgId = $orgId AS mine }
      //          <> []) RETURN n
      //
      // The node paren is a pattern, so `opensPatternMap` won and the WHOLE
      // subquery — projections included — was kept as a filtering position. The
      // projected comparison satisfied the anchor, and `COLLECT` is non-empty
      // whenever any node exists, so every tenant's `n` came back. `EXISTS`,
      // `COUNT`, the inline predicate on a RELATIONSHIP pattern, a subquery
      // nested in another, and the same shape under `MERGE` all did it too.
      //
      // Swapping cannot cost a genuine pattern map, and that is a property of
      // the grammar rather than a hope: a property map is never preceded by
      // `CALL` / `EXISTS` / `COUNT` / `COLLECT`, so `subqueryOpening` is null at
      // every brace `opensPatternMap` is meant to claim.
      const opening = subqueryOpening(src, i);
      const kind =
        opening !== null ? "subquery" : opensPatternMap() ? "pattern" : "map";
      braceKinds.push(kind);
      if (kind === "map") mapDepth += 1;
      braceClause.push({
        clause,
        mergeMapFilters,
        inlinePredicateFrames,
        clauseParenBase,
        clauseBracketBase,
        currentClause,
        currentPart,
        inClauseWhere,
        pendingProjection,
      });
      // A subquery is a clause sequence of its own, so the enclosing pattern's
      // inline predicate does not reach into it, its clause baseline is the
      // depth of the brackets it is nested under rather than zero, and it
      // starts with NO clause in force — the outer one does not carry in. Only
      // a subquery brace does any of this: a map literal is an expression, and
      // an expression stays inside whatever encloses it.
      if (opening !== null) {
        inlinePredicateFrames = 0;
        clauseParenBase = paren;
        clauseBracketBase = bracket;
        clause = "";
        // The subquery's own clauses are recorded as their own; nothing inside
        // it belongs to the enclosing part or WHERE. The brace itself stays
        // with the enclosing clause, so its ownership is recorded first.
        own(i);
        currentClause = -1;
        currentPart = -1;
        inClauseWhere = false;
        // A projection the brace sits inside (`WITH COUNT { … } AS c`) is
        // still being read outside; the body's own `WITH` / `RETURN` are its
        // own, so the pending one is parked on the frame and resumed on `}`.
        pendingProjection = null;
        events.push({ kind: "open", ...opening });
      }
    } else if (ch === "}") {
      const closing = braceKinds.pop();
      if (closing === "map") mapDepth = Math.max(0, mapDepth - 1);
      // A subquery's last clause is its `RETURN` (or, for an existence test,
      // whatever it ended on); the brace ends the sequence and so ends its
      // projection. Flushed BEFORE the restore, so the event carries the
      // body's projection and the enclosing one resumes untouched.
      if (closing === "subquery") {
        flushProjection(i);
        events.push({ kind: "close" });
      }
      // Restore BEFORE the keeping() test below, so the `}` itself is judged by
      // the clause that encloses the expression, not by the subquery's last one.
      const saved = braceClause.pop();
      if (saved) {
        clause = saved.clause;
        mergeMapFilters = saved.mergeMapFilters;
        inlinePredicateFrames = saved.inlinePredicateFrames;
        clauseParenBase = saved.clauseParenBase;
        clauseBracketBase = saved.clauseBracketBase;
        currentClause = saved.currentClause;
        currentPart = saved.currentPart;
        inClauseWhere = saved.inClauseWhere;
        pendingProjection = saved.pendingProjection;
      }
      // `boundAGraphVariable` deliberately does NOT restore. It only ever makes
      // a later MERGE map stop counting, so letting an inner `MATCH` set it is
      // the conservative direction; unwinding it could resurrect a MERGE map's
      // standing on the strength of a subquery the scanner did not analyse.
    }

    if (keeping()) out[i] = ch;
    // A subquery brace recorded its owner before clearing the clause state.
    if (!(ch === "{" && braceKinds[braceKinds.length - 1] === "subquery")) {
      own(i);
    }
    i += 1;
  }
  // The query's last clause is usually a `RETURN`; the end of the text ends it.
  flushProjection(src.length);

  return {
    kept: out.join(""),
    src,
    partOwner,
    whereOwner,
    clauseOfPart,
    branchOfPart,
    patternOpen,
    events,
  };
}

/** One comma-separated pattern part of a `MATCH` / `OPTIONAL MATCH` clause. */
export interface RowSelectingPart {
  /**
   * The part's own pattern text, comments and literals blanked, every other
   * character of the query replaced by a space (offsets preserved).
   */
  readonly pattern: string;
  /** The part's kept filtering positions: its own pattern property maps. */
  readonly anchors: string;
  /** The kept projection of the WHERE of the clause the part belongs to. */
  readonly where: string;
  /** The top-level UNION branch the part sits in (0-based). */
  readonly branch: number;
  /**
   * The variables the part's PATTERN ELEMENTS bind or reference: the name
   * written first inside each node `(` and relationship `[` of the part, in
   * source order, duplicates kept. A name that appears anywhere else in the
   * part — in a property-map value (`(b {x: toString(a.x)})`), a label
   * expression, an inline predicate — is NOT one of them: a `(` or `[` there
   * is a call, a list or a grouping, and the earlier variable it mentions does
   * not make this part's rows that variable's rows. The tenancy guard credits
   * a part with an earlier anchor only through a variable listed here.
   */
  readonly variables: readonly string[];
}

/**
 * Every pattern part of every row-selecting clause in `cypher`, at every
 * clause-sequence level (a `MATCH` inside `CALL { … }` or `EXISTS { … }` is its
 * own clause, and nothing in the subquery is credited to the enclosing one).
 *
 * The tenancy guard reads this to ask a narrower question than "does the query
 * bind the tenant somewhere": does EACH part that selects rows bind it, in its
 * own pattern map or through its clause's WHERE on one of its own variables.
 * That is the question `MATCH (a {orgId: $orgId}) MATCH (b) RETURN b` fails and
 * the query-wide check passed.
 *
 * An unterminated input yields no parts; the query-wide check refuses it first.
 */
export function rowSelectingParts(cypher: string): RowSelectingPart[] {
  return rowSelectingScope(cypher).flatMap((event) =>
    event.kind === "part" ? [event.part] : [],
  );
}

/**
 * Every row-selecting pattern part of `cypher` — see {@link rowSelectingParts}
 * — interleaved with the VARIABLE-SCOPE events between them, in source order.
 *
 * The parts alone answer whether each pattern is anchored on its own. What
 * they cannot answer is whether a pattern may INHERIT an earlier pattern's
 * anchor through a shared variable, because that depends on whether the name
 * still means the same thing: `MATCH (n {orgId: $orgId}) WITH count(n) AS c
 * MATCH (n) RETURN n` spells `n` twice and binds it twice, and the second
 * reads every tenant. The events carry what Cypher does to the scope between
 * two parts, so the tenancy guard can follow it rather than assume a name,
 * once anchored, stays anchored.
 */
export function rowSelectingScope(cypher: string): ScopeEvent[] {
  const p = projectPositions(cypher, "filtering");
  const n = p.src.length;
  const materialise = (partId: number): RowSelectingPart => {
    const clauseId = p.clauseOfPart[partId]!;
    const pattern = new Array<string>(n).fill(" ");
    const anchors = new Array<string>(n).fill(" ");
    const where = new Array<string>(n).fill(" ");
    const variables: string[] = [];
    for (let k = 0; k < n; k += 1) {
      if (p.partOwner[k] === partId) {
        pattern[k] = p.src[k]!;
        anchors[k] = p.kept[k]!;
        if (p.patternOpen[k] === 1) {
          // `( name` / `[ name`: the element's variable, if it has one. A
          // label-only element (`(:Label)`), an anonymous relationship
          // (`[:REL]`, `[*1..3]`) and a bare map (`({k: v})`) bind nothing.
          let j = k + 1;
          while (j < n && /\s/.test(p.src[j]!)) j += 1;
          IDENTIFIER_AT.lastIndex = j;
          const name = IDENTIFIER_AT.exec(p.src);
          if (name) variables.push(name[0]);
        }
      } else if (p.whereOwner[k] === clauseId) {
        where[k] = p.kept[k]!;
      }
    }
    return {
      pattern: pattern.join(""),
      anchors: anchors.join(""),
      where: where.join(""),
      branch: p.branchOfPart[partId]!,
      variables,
    };
  };
  return p.events.map((event) =>
    event.kind === "part"
      ? { kind: "part", part: materialise(event.partId) }
      : event,
  );
}

/** A whole unescaped symbolic name and nothing else. */
const BARE_VARIABLE = new RegExp(`^[${ID_START_SRC}][${ID_PART_SRC}]*$`, "u");

/**
 * The variable names a `WITH` / `RETURN` projection carries forward out of
 * `source`, by Cypher's rules for what a projection keeps:
 *
 *  - `*` keeps every variable in scope;
 *  - a bare variable name keeps that variable;
 *  - anything else — an expression, and a `<expr> AS alias` — binds a NEW
 *    name, which is credited with nothing even when the expression is the
 *    variable itself (`WITH n AS m` keeps no credit: fail-closed, as the
 *    per-pattern rule has always said of a re-bound variable).
 *
 * `projection` is the projection text with literals blanked, so a name
 * inside a string cannot be read as a variable. Items are split at top-level
 * commas only: a comma inside a call, a list, a map or a subquery brace is
 * the item's own.
 */
export function projectedNames(
  projection: string,
  source: ReadonlySet<string>,
): Set<string> {
  const kept = new Set<string>();
  let depth = 0;
  let start = 0;
  const items: string[] = [];
  for (let i = 0; i < projection.length; i += 1) {
    const ch = projection[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}")
      depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      items.push(projection.slice(start, i));
      start = i + 1;
    }
  }
  items.push(projection.slice(start));
  for (let i = 0; i < items.length; i += 1) {
    let item = items[i]!.trim();
    if (i === 0)
      item = item.replace(/^DISTINCT(?![\p{ID_Continue}\p{Sc}])\s*/iu, "");
    if (item === "*") {
      for (const name of source) kept.add(name);
    } else if (BARE_VARIABLE.test(item) && source.has(item)) {
      kept.add(item);
    }
  }
  return kept;
}

/** A span of `text` inside which `names` are bound by the expression itself. */
export interface LocalBindingRegion {
  /** Index of the `(` or `[` that opens the binding's scope. */
  readonly start: number;
  /** Index of the `)` or `]` that closes it (or `text.length` if unclosed). */
  readonly end: number;
  /** The names the bracket binds, in the order they are written. */
  readonly names: readonly string[];
}

/** The keyword `IN` at `at`, whole, case-insensitive. */
const IN_AT = /IN(?![\p{ID_Continue}\p{Sc}])/iuy;

/**
 * Every EXPRESSION-LOCAL binding in `text` — a kept WHERE projection — with the
 * bracket span it is scoped to.
 *
 * A Cypher expression can bind a name of its own, and the name lives only
 * inside the bracket that binds it: a list predicate (`any(x IN xs WHERE …)`,
 * `all`, `none`, `single`), a list comprehension (`[x IN xs WHERE … | …]`),
 * and `reduce(acc = init, x IN xs | …)`. Such a name SHADOWS a pattern
 * variable spelled the same, so
 *
 *     MATCH (n) WHERE any(n IN [{orgId: $orgId}] WHERE n.orgId = $orgId) RETURN n
 *
 * compares the list's map with itself, is true for every row, and the
 * `n.orgId = $orgId` it contains names the predicate's `n`, not the pattern's.
 * The tenancy guard reads a WHERE anchor as credit for the variable it names,
 * and that credit belongs only to an anchor OUTSIDE every region binding the
 * name.
 *
 * The binding is read at the positions the grammar puts it: the first tokens
 * after the opening bracket (`IDENT IN`, or `IDENT =` when the bracket is
 * `reduce`'s), and after each top-level comma inside the bracket (`reduce`'s
 * second argument). A bare membership test that happens to open a grouping
 * paren — `(n IN $nodes AND n.orgId = $orgId)` — reads as a binding too, and
 * costs that query its credit; that is the fail-closed direction, and no
 * query in the corpus writes it. A pattern comprehension binds nothing here:
 * a name already bound in the enclosing scope IS that variable inside it.
 */
export function expressionLocalBindings(text: string): LocalBindingRegion[] {
  const regions: LocalBindingRegion[] = [];
  const stack: Array<{ start: number; names: string[]; reduce: boolean }> = [];
  const wordBefore = (idx: number): string => {
    let k = idx - 1;
    while (k >= 0 && /\s/.test(text[k]!)) k -= 1;
    let j = k;
    while (j >= 0 && ID_PART_CHAR.test(text[j]!)) j -= 1;
    return text.slice(j + 1, k + 1).toUpperCase();
  };
  // `IDENT IN` (or `IDENT =` for reduce's accumulator) starting at `at`.
  const bindAt = (
    at: number,
    frame: { names: string[]; reduce: boolean },
    accumulator: boolean,
  ) => {
    let j = at;
    while (j < text.length && /\s/.test(text[j]!)) j += 1;
    IDENTIFIER_AT.lastIndex = j;
    const id = IDENTIFIER_AT.exec(text);
    if (!id) return;
    let k = j + id[0].length;
    while (k < text.length && /\s/.test(text[k]!)) k += 1;
    IN_AT.lastIndex = k;
    if (IN_AT.test(text) || (accumulator && frame.reduce && text[k] === "=")) {
      frame.names.push(id[0]);
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[") {
      const frame = {
        start: i,
        names: [],
        reduce: ch === "(" && wordBefore(i) === "REDUCE",
      };
      bindAt(i + 1, frame, true);
      stack.push(frame);
    } else if (ch === ")" || ch === "]") {
      const frame = stack.pop();
      if (frame && frame.names.length > 0) {
        regions.push({ start: frame.start, end: i, names: frame.names });
      }
    } else if (ch === "," && stack.length > 0) {
      bindAt(i + 1, stack[stack.length - 1]!, false);
    }
  }
  for (const frame of stack) {
    if (frame.names.length > 0) {
      regions.push({
        start: frame.start,
        end: text.length,
        names: frame.names,
      });
    }
  }
  return regions;
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
  const { text: sanitized, unterminated } = scanLiteralsAndComments(cypher);
  // THE OPPOSITE DIRECTION FROM `keepPositions`, and the asymmetry is the whole
  // point of the flag rather than an inconsistency.
  //
  // This guard is a DENYLIST: it refuses when it FINDS a write keyword, so
  // anything that hides text makes it pass. Blanking an unterminated query — the
  // fail-closed answer for the two allow-list guards — would be the most
  // permissive possible answer here, since a blank string contains no write at
  // all. So an input this module cannot faithfully project is refused outright.
  //
  // It costs nothing real: an unclosed comment, string or backtick does not lex
  // in Cypher, so the query could never have run. What it buys is that the
  // refusal happens here rather than depending on the database to reject it,
  // which is the same reason the clamps' output is now re-checked instead of
  // argued about.
  if (unterminated) {
    throw new GraphScopeError(
      `Cypher ends inside an unterminated comment, string or backtick identifier, so a read-mode scope cannot be enforced on it: ${cypher.slice(0, 80)}`,
    );
  }
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

  // Check each query scope separately. A limit inside a subquery or before
  // the final RETURN cannot bound an unlimited UNION branch.
  const code = stripLiteralsAndComments(cypher);
  const keywords = (text: string, word: string) =>
    [...text.matchAll(new RegExp(`${ID_BEGIN}${word}${ID_END}`, "giu"))].filter(
      (match) =>
        startsAClause(text, match.index, match.index + match[0].length),
    );
  const checkBranches = (text: string): void => {
    const unions = keywords(text, "UNION");
    if (unions.length === 0) return;
    const ends = [...unions.map((match) => match.index), text.length];
    let start = 0;
    for (const end of ends) {
      const branch = text.slice(start, end);
      const lastReturn = keywords(branch, "RETURN").at(-1);
      const bounded =
        lastReturn &&
        keywords(branch, "LIMIT").some(
          (limit) =>
            limit.index > lastReturn.index &&
            new RegExp(`^\\s+\\d+${ID_END}`, "u").test(
              branch.slice(limit.index + limit[0].length),
            ),
        );
      if (!bounded) {
        throw new GraphScopeError(
          "Cannot enforce maxNodes budget: every UNION branch needs a final literal LIMIT",
        );
      }
      start = end + "UNION".length;
    }
  };
  // An explicit stack also handles deeply nested queries without recursion.
  const scopes = [""];
  for (const char of code) {
    if (char === "{") {
      scopes.push("");
    } else if (char === "}") {
      if (scopes.length === 1)
        throw new GraphScopeError("Unbalanced query braces");
      checkBranches(scopes.pop()!);
      scopes[scopes.length - 1] += " {} ";
    } else {
      scopes[scopes.length - 1] += char;
    }
  }
  if (scopes.length !== 1) throw new GraphScopeError("Unbalanced query braces");
  checkBranches(scopes[0]!);

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

  // THE CLAMPS RUN FIRST, AND THE GUARDS READ WHAT THEY PRODUCED.
  //
  // The clamps REWRITE the query — `clampVarLengthHops` rebounds a `*1..5`
  // quantifier, `clampLimits` clamps a literal `LIMIT` or appends one — and it
  // is `finalCypher`, not `cypher`, that `tenant.ts` hands to `session.run`.
  // The guards used to read `cypher`, so the seam validated one string and
  // executed a different one: a decision about an artifact that is not the
  // artifact the decision governs, which is the shape of every defect this
  // module has been corrected for.
  //
  // No clamp can currently break a marker or introduce a write, and the reason
  // is bounded rather than hopeful — their whole output alphabet is digits, `*`
  // and `..` substituted strictly between an existing `[` and `]`, plus a
  // trailing "\nLIMIT <digits>". But that is a property of the clamp BODIES,
  // which whoever edits them next would have to re-derive, and this file's
  // history is of exactly that kind of reasoning holding until it did not.
  //
  // Ordering the clamps first is what makes the invariant STRUCTURAL rather than
  // a second defensive call: there is one check, it reads the executed text, and
  // no branch decides whether it happens. A `LIMIT $x` or an unlimited `UNION`
  // is refused by the clamp itself before either guard speaks, which is the same
  // fail-closed answer in a different message.
  let finalCypher = cypher;
  const budget = scope.budget;
  if (budget?.maxHops !== undefined) {
    finalCypher = clampVarLengthHops(finalCypher, budget.maxHops);
  }
  // LIMIT bounds returned read rows. Appending it to SET, CREATE, or DELETE
  // makes a write invalid and does not bound the number of rows it changes.
  if (budget?.maxNodes !== undefined && scope.mode !== "extend") {
    finalCypher = clampLimits(finalCypher, budget.maxNodes);
  }

  assertScopeMarkers(finalCypher, scope);
  if (scope.mode === "read") assertReadOnly(finalCypher);

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
