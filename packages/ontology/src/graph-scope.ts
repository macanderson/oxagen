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

// Bypass-guard markers. Two conditions, and BOTH are load-bearing.
//
// 1) A membership test (`… IN $__scopeLabels`). Both allow-lists are
//    list-valued, so every legitimate consumption of one is a membership test —
//    `l IN $__scopeLabels`, `type(r) IN $__scopeRelTypes` — which is what all
//    five production call sites in packages/handlers write. `\b` after the name
//    prevents a prefix collision ($__scopeLabelsExtra).
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
const LABELS_MARKER = new RegExp(`\\bIN\\s*\\$${SCOPE_LABELS_PARAM}\\b`, "i");
const REL_TYPES_MARKER = new RegExp(
  `\\bIN\\s*\\$${SCOPE_REL_TYPES_PARAM}\\b`,
  "i",
);

// ── Write-clause detection (read-mode defense in depth) ──────────────────────
// Note: the capability layer is the primary gate (graph_write-category
// capabilities resolve to deny under a read scope, spec §3.6). This is a
// belt-and-braces seam check. It is a conservative denylist — string literals
// and comments are stripped first so a keyword inside a literal never
// false-rejects a legitimate read.

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
 * class is the same one ADR-082 records, and the answer to it is to construct
 * the scoping rather than validate it.
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
 */
function opensPattern(src: string, openIdx: number): boolean {
  let k = openIdx - 1;
  while (k >= 0 && /\s/.test(src[k]!)) k -= 1;
  if (k < 0) return true;
  const prev = src[k]!;

  if (src[openIdx] === "[") return prev === "-";

  if (",-><=|([".includes(prev)) return true;
  if (/[A-Za-z0-9_]/.test(prev)) {
    let j = k;
    while (j >= 0 && /[A-Za-z0-9_]/.test(src[j]!)) j -= 1;
    return PATTERN_INTRODUCERS.has(src.slice(j + 1, k + 1).toUpperCase());
  }
  return false;
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
  const bracketIsPattern: boolean[] = [];
  // One entry per open `{`: true when that brace opened inside a pattern.
  const braceIsPattern: boolean[] = [];
  let clause = "";
  // True once a clause has introduced a graph variable, and the condition under
  // which a MERGE map counts as filtering (see below).
  let boundAGraphVariable = false;
  let mergeMapFilters = false;

  const enclosingIsPattern = () =>
    bracketIsPattern[bracketIsPattern.length - 1] === true;
  const inPatternMap = () => braceIsPattern[braceIsPattern.length - 1] === true;
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
  const keeping = () =>
    clause === "WHERE" ||
    (policy === "filtering" &&
      inPatternMap() &&
      (ROW_SELECTING_CLAUSES.has(clause) ||
        (clause === "MERGE" && mergeMapFilters)));

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    // Words: a clause keyword at depth 0 switches the current clause. Depth 0
    // also excludes the inside of a pattern property map, because the pattern's
    // own `(`/`[` is still open around it.
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      const word = src.slice(i, j).toUpperCase();
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
      bracketIsPattern.push(opensPattern(src, i));
    } else if (ch === ")") {
      paren = Math.max(0, paren - 1);
      bracketIsPattern.pop();
    } else if (ch === "[") {
      bracket += 1;
      bracketIsPattern.push(opensPattern(src, i));
    } else if (ch === "]") {
      bracket = Math.max(0, bracket - 1);
      bracketIsPattern.pop();
    } else if (ch === "{") braceIsPattern.push(enclosingIsPattern());
    else if (ch === "}") braceIsPattern.pop();

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
 * 6–7 are REACHABILITY, which is the class ADR-082 records as undecidable for
 * the tenancy guard by the same argument: a full Cypher parse reports
 * structure, and in each of these the structure is correct. The durable answer
 * for both guards is to CONSTRUCT the scoping rather than validate it (ADR-082,
 * #3199). This seam is a lint. It is not the mandate.
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

  if (/\bLIMIT\s+\$\w+/i.test(cypher)) {
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
