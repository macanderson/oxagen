#!/usr/bin/env node
/**
 * check-org-sentinel-reads.mjs — refuse a read that the org-only workspace
 * sentinel silently truncates.
 *
 * THE FAILURE THIS EXISTS FOR. An organisation-level surface has no workspace,
 * so it carries `ORG_ONLY_WORKSPACE_ID` (the nil uuid) as its workspaceId.
 * `tools/scripts/gen-rls-migration.ts` generates each table's tenant_isolation
 * policy from its class in `packages/database/src/tenant-policy.manifest.ts`,
 * and only the `org_only` class ignores the workspace GUC. Under the sentinel:
 *
 *   org_only            answers in full
 *   workspace_nullable  answers PARTIALLY — only the workspace_id IS NULL rows
 *   standard            answers EMPTILY
 *   workspace_only      answers EMPTILY
 *
 * Postgres RLS hides rather than refuses, so none of that raises. No `catch`
 * can see it, no test that stubs the database can see it, and the caller gets
 * a short answer that is shaped exactly like a complete one. That is how a
 * signed SOC 2 audit export came to omit every workspace-scoped security event,
 * how a posture tile read "0 denied invocations" while the kernel was denying,
 * and how an org's API keys became invisible on the page that revokes them.
 *
 * The defect is invisible at the call site — the code reads correctly, and the
 * `where` clause usually already carries the right `eq(table.orgId, orgId)`
 * fence — and obvious at the seam, where the table's policy class is known.
 * So the check is done here, against the manifest, rather than by eye.
 *
 * WHAT IT CHECKS. Two passes, both static, both resolving every table through
 * the policy manifest:
 *
 *   A. CO-LOCATED — a `runInTenantScope({ …, workspaceId: <sentinel> }, …)`
 *      whose body reaches `withTenantDb`. Every `schema.<table>` named in that
 *      file must be `org_only`. This is the app-page and server-action form.
 *
 *   C. THE APP KERNEL SEAM — `apps/app` (the Mission Control rebuild) does not
 *      call `invoke()` in its pages at all. A data adapter under
 *      `src/data/live/` calls `kernelRead` / `kernelWrite`, and the single
 *      `invoke()` and the sentinel conversion both live in
 *      `src/server/kernel.ts`, where `capabilityContext` maps an `OrgCtx` to
 *      `ORG_ONLY_WORKSPACE_ID` and leaves a `WsCtx` its workspace. So the two
 *      halves pass B looks for are in different files by design and it matched
 *      neither. This pass models that named seam directly rather than trying to
 *      infer indirection in general: `src/data/ports.ts` declares which port
 *      methods take an `OrgCtx`, and a `kernelRead`/`kernelWrite` inside one of
 *      those methods carries the sentinel by construction.
 *
 *   B. CROSS-SURFACE — an `invoke(<capability>, …, ctx)` where ctx's
 *      workspaceId is the sentinel. The capability's handler is resolved
 *      through `packages/handlers/src/register.ts`, and every `schema.<table>`
 *      that handler names, plus the ones its relative `./lib/*` imports name,
 *      must be `org_only` unless the handler reads through `withSystemDb`.
 *      This is the form the kernel sets up, where the scope and the query are
 *      in different packages and no lint rule can see both.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody mistakes it for a proof:
 *
 *   - A table reached through a helper that is neither the handler module nor
 *     one of its direct relative imports. One hop, not a call graph.
 *   - A ctx whose sentinel workspaceId is assembled somewhere else and passed
 *     in as a variable this file never names.
 *   - Anything outside Postgres. Neo4j and ClickHouse scoping is separate.
 *   - A port method that takes an `OrgCtx` and is named in `ports.ts` with a
 *     name a `WsCtx` method also uses. Pass C drops such a name rather than
 *     guess; there are none today.
 *   - Any OTHER wrapper around `invoke()` that a future surface introduces.
 *     Pass C knows two names. The lesson pass C exists for is that a checker
 *     must be run against every tree it will guard, not only the one it was
 *     written on — this one was clean on `app-rebuild` and blind on
 *     `apps/app` for a whole review cycle.
 *
 * Both of those are why the fix also moved the sentinel itself into
 * `@oxagen/tenancy`, where its doc comment states the rule once instead of
 * thirty-odd local copies restating it unevenly. See ADR-074.
 *
 * A live instance whose fix belongs to another change is waived in
 * `org-sentinel-reads-baseline.json`, which ratchets down: an entry matching no
 * finding is itself an error, so the file cannot outlive the defect it waives.
 *
 * Usage:
 *   node tools/scripts/check-org-sentinel-reads.mjs [--json]
 *
 * Exit code 1 on any finding.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const SENTINEL = "00000000-0000-0000-0000-000000000000";

/**
 * The policy classes whose USING clause never consults the workspace GUC, and
 * which the org-only workspace sentinel therefore cannot narrow.
 *
 * Derived by reading every branch of `predicates()` in
 * `tools/scripts/gen-rls-migration.ts`, which is the one place a class becomes
 * a predicate. All five classes in `PolicyClass`, with the USING clause each
 * emits (the `app.rls_bypass` disjunct is omitted; it is on every one):
 *
 *   org_only          `org_id = ORG`                                    — safe
 *   org_or_global     `org_id IS NULL OR org_id = ORG`                  — safe
 *   workspace_nullable`org_id = ORG AND (ws IS NULL OR ws = WS)`        — narrows
 *   workspace_only    `workspace_id = WS`                               — narrows
 *   standard          `org_id = ORG AND workspace_id = WS`              — narrows
 *
 * `org_or_global` was missing here, and the omission was worse than noise: it
 * failed CI on a correct org-level read of `cost.price_entries` and told the
 * author their read was narrowed — pointing them at an RLS bypass or a baseline
 * waiver, which is the exact move this check exists to prevent. A false
 * positive that recommends the defect is not a false positive with a small
 * cost.
 *
 * `residualPolicyClasses()` publishes this split and the tests assert every
 * class appears in exactly one half, so a sixth class cannot be added to the
 * manifest without this constant being revisited.
 */
const SAFE_CLASSES = new Set(["org_only", "org_or_global"]);

/** The classes whose USING clause consults `app.current_workspace_id`. */
const NARROWING_CLASSES = new Set([
  "workspace_nullable",
  "workspace_only",
  "standard",
]);

/**
 * The classes this check knows about, split by whether the sentinel can narrow
 * them. Exported so the tests can assert it against `PolicyClass` — the one
 * property that makes the split maintainable rather than a snapshot of one
 * afternoon's reading of the generator.
 */
export function residualPolicyClasses() {
  return {
    safe: [...SAFE_CLASSES].sort(),
    narrowing: [...NARROWING_CLASSES].sort(),
  };
}

// ── The manifest: table -> policy class ──────────────────────────────────────

/** `{ table: "x.y", policyClass: "z" }` entries, one- or multi-line. */
export function readPolicyClasses(root = ROOT) {
  const src = readFileSync(
    join(root, "packages/database/src/tenant-policy.manifest.ts"),
    "utf8",
  );
  const out = new Map();
  const re =
    /table:\s*"([a-z0-9_.]+)"\s*,\s*(?:\/\/[^\n]*\n\s*)?policyClass:\s*"(\w+)"/g;
  for (const m of src.matchAll(re)) out.set(m[1], m[2]);
  return out;
}

/** Drizzle export name -> "schema.table", from packages/database/src/schema. */
export function readTableNames(root = ROOT) {
  const dir = join(root, "packages/database/src/schema");
  const schemas = new Map();
  for (const m of readFileSync(join(dir, "_schemas.ts"), "utf8").matchAll(
    /export const (\w+)\s*=\s*pgSchema\("([a-z0-9_]+)"\)/g,
  )) {
    schemas.set(m[1], m[2]);
  }
  const out = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(
      /export const (\w+)\s*=\s*(\w+)\.table\(\s*\n?\s*"([a-z0-9_]+)"/g,
    )) {
      out.set(m[1], `${schemas.get(m[2]) ?? "?"}.${m[3]}`);
    }
  }
  return out;
}

// ── Source walking ───────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      yield full;
    }
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────
//
// WHY A PARSER AND NOT A REGEX. The call-site analysis below started as regexes
// and failed four times in one review cycle, each time by reporting clean on a
// shape it could not read rather than by erroring: a prose mention of
// `withTenantDb` in a comment read as a call, a capability named through a
// helper, a capability named through `kernelRead`, and finally an `invoke()`
// whose third argument is an inline object literal rather than an identifier.
// Every one of those is the same failure — something reports success without
// having done the work — and in a mandatory CI check that is worse than no
// check, because it turns "nobody has verified this" into "CI says it is fine".
//
// A regex that recognises arbitrary object literals with nested braces, strings
// and comments will fail on the next shape too. `typescript` is already a
// dependency of this package (see typecheck-staged.mjs), so the calls are
// parsed. This is a SYNTACTIC parse only — no program, no type checker, no
// tsconfig — which is fast and needs no build.

/** One file's AST. Comments are not nodes, so nothing has to strip them. */
export function parse(src, fileName = "f.tsx") {
  return ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

/** Every node in the subtree, depth-first. */
export function* nodesOf(node) {
  yield node;
  for (const child of node.getChildren()) yield* nodesOf(child);
}

/** Every node in the subtree, depth-first. */
function* nodes(node) {
  yield node;
  for (const child of node.getChildren()) yield* nodes(child);
}

/** The dotted text of a callee: `withTenantDb`, `tx.query.foo`, `a.b.c`. */
function calleeText(node) {
  if (!ts.isCallExpression(node)) return null;
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.getText();
  return null;
}

/** Calls to `name` anywhere in the subtree. */
export function callsTo(root, name) {
  const out = [];
  for (const n of nodes(root)) {
    if (calleeText(n) === name) out.push(n);
  }
  return out;
}

/** The identifiers this file binds to the sentinel, plus the shared constant. */
export function sentinelNames(sourceFile) {
  const names = new Set(["ORG_ONLY_WORKSPACE_ID"]);
  for (const n of nodes(sourceFile)) {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name)) continue;
    const init = n.initializer;
    if (init && ts.isStringLiteral(init) && init.text === SENTINEL) {
      names.add(n.name.text);
    }
  }
  // An aliased import: `import { ORG_ONLY_WORKSPACE_ID as X }`.
  for (const n of nodes(sourceFile)) {
    if (!ts.isImportSpecifier(n)) continue;
    if (n.propertyName?.text === "ORG_ONLY_WORKSPACE_ID") {
      names.add(n.name.text);
    }
  }
  return names;
}

/** Does this expression node evaluate to the sentinel? */
export function isSentinelExpression(node, names) {
  if (node === undefined) return false;
  if (ts.isStringLiteral(node)) return node.text === SENTINEL;
  if (ts.isIdentifier(node)) return names.has(node.text);
  return false;
}

/**
 * How an object literal answers "what workspace does this context carry":
 * "sentinel", "real" (a workspace it names explicitly, including an override
 * over a spread), or null when it names no workspace at all.
 */
export function workspaceOfObject(obj, names) {
  if (!ts.isObjectLiteralExpression(obj)) return null;
  let answer = null;
  for (const prop of obj.properties) {
    // `{ ...ctx, workspaceId }` — a later property wins, which is the fix
    // shape, so this loop deliberately keeps the LAST answer.
    if (ts.isShorthandPropertyAssignment(prop)) {
      if (prop.name.text === "workspaceId") answer = "real";
      continue;
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    const key =
      ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    if (key !== "workspaceId") continue;
    answer = isSentinelExpression(prop.initializer, names)
      ? "sentinel"
      : "real";
  }
  return answer;
}

/**
 * The object literals a locally-declared function returns. A context is very
 * often built by a small local factory — `buildCtx(...)`, `buildApiKeyCtx(...)`,
 * `capabilityContext(...)` — and the shape that matters is what it returns.
 */
export function returnedObjects(sourceFile, fnName) {
  const out = [];
  for (const n of nodesOf(sourceFile)) {
    const isNamed =
      (ts.isFunctionDeclaration(n) &&
        n.name !== undefined &&
        n.name.text === fnName) ||
      (ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === fnName &&
        n.initializer !== undefined &&
        (ts.isArrowFunction(n.initializer) ||
          ts.isFunctionExpression(n.initializer)));
    if (!isNamed) continue;
    const body = ts.isFunctionDeclaration(n) ? n.body : n.initializer;
    if (body === undefined) continue;
    for (const inner of nodesOf(body)) {
      if (ts.isReturnStatement(inner) && inner.expression !== undefined) {
        out.push(inner.expression);
      }
      // `const f = () => ({ … })`
      if (
        ts.isArrowFunction(inner) &&
        inner.body !== undefined &&
        ts.isParenthesizedExpression(inner.body)
      ) {
        out.push(inner.body.expression);
      }
    }
  }
  return out;
}

/** The initializer of `const <name> = …` in this file, if there is one. */
export function declarationOf(sourceFile, name) {
  for (const n of nodes(sourceFile)) {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name
    ) {
      return n.initializer;
    }
  }
  return undefined;
}

/**
 * Does this expression carry the sentinel as its workspace? An object literal
 * is read directly; an identifier is resolved to its declaration in the same
 * file and read the same way, so both paths are one piece of code rather than
 * two patterns that drift. A `capabilityContext(c, { requireWorkspace: false })`
 * call is the API surface's named seam (ADR-068) and carries it by
 * construction.
 */
export function carriesSentinel(expr, sourceFile, names, depth = 0) {
  if (expr === undefined || depth > 3) return false;
  if (ts.isObjectLiteralExpression(expr)) {
    return workspaceOfObject(expr, names) === "sentinel";
  }
  if (ts.isIdentifier(expr)) {
    return carriesSentinel(
      declarationOf(sourceFile, expr.text),
      sourceFile,
      names,
      depth + 1,
    );
  }
  if (ts.isAwaitExpression(expr)) {
    return carriesSentinel(expr.expression, sourceFile, names, depth + 1);
  }
  if (ts.isCallExpression(expr)) {
    const callee = calleeText(expr);
    if (callee === "capabilityContext") {
      const options = expr.arguments[1];
      if (options !== undefined && ts.isObjectLiteralExpression(options)) {
        return options.properties.some(
          (prop) =>
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === "requireWorkspace" &&
            prop.initializer.kind === ts.SyntaxKind.FalseKeyword,
        );
      }
      return false;
    }
    // A local factory: `const ctx = buildCtx({ … })`. What matters is the
    // object it returns, and that object is in this file.
    if (callee !== null) {
      return returnedObjects(sourceFile, callee).some((obj) =>
        carriesSentinel(obj, sourceFile, names, depth + 1),
      );
    }
  }
  return false;
}

/** The `withTenantDb(…)` calls in this subtree. */
export function tenantDbRegions(root) {
  return callsTo(root, "withTenantDb");
}

/**
 * How this file names tables.
 *
 * A read does not have to spell `schema.apiKeys`. Three forms in the tree do
 * not, and each one made the check report clean on a table it could not see:
 *
 *   import { schema as db }        `db.apiKeys`      schema.relationship.delete.ts
 *   const se = schema.apiKeys      `.from(se)`       audit.shared.ts, run.list.ts
 *   const { apiKeys } = schema     `.from(apiKeys)`  (not in the tree today)
 *
 * All three are answerable from this file's own declarations, which is what
 * this builds: the local names that mean the schema namespace, and the local
 * names bound to a specific table. What it cannot answer is in
 * `residualTableForms` below — a table imported directly from a schema module,
 * one passed in as a parameter, one chosen at runtime. Those need symbol
 * resolution or dataflow, and the last is not decidable at all.
 */
export function tableResolver(sourceFile) {
  const schemaNames = new Set(["schema"]);
  const bindings = new Map(); // local name -> table export name

  for (const n of nodesOf(sourceFile)) {
    // import { schema as db } from "@oxagen/database"
    if (ts.isImportSpecifier(n)) {
      if (n.propertyName?.text === "schema") schemaNames.add(n.name.text);
      continue;
    }
    if (!ts.isVariableDeclaration(n) || n.initializer === undefined) continue;
    const init = n.initializer;

    // const se = schema.securityEvents
    if (
      ts.isIdentifier(n.name) &&
      ts.isPropertyAccessExpression(init) &&
      ts.isIdentifier(init.expression) &&
      schemaNames.has(init.expression.text)
    ) {
      bindings.set(n.name.text, init.name.text);
      continue;
    }

    // const { apiKeys, users: u } = schema
    if (
      ts.isObjectBindingPattern(n.name) &&
      ts.isIdentifier(init) &&
      schemaNames.has(init.text)
    ) {
      for (const el of n.name.elements) {
        if (!ts.isIdentifier(el.name)) continue;
        const exported =
          el.propertyName !== undefined && ts.isIdentifier(el.propertyName)
            ? el.propertyName.text
            : el.name.text;
        bindings.set(el.name.text, exported);
      }
    }
  }

  return {
    /** The table this expression denotes, or null. */
    tableOf(node) {
      if (node === undefined) return null;
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        schemaNames.has(node.expression.text)
      ) {
        return node.name.text;
      }
      if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null;
      return null;
    },
    /**
     * Every table name this subtree could be referring to.
     *
     * Statements after a `setTransactionWorkspaceScope(tx, id)` call are
     * skipped. That is ADR-068 §5's sanctioned move: the one place allowed to
     * re-point an open transaction's workspace GUC, used by
     * workspace-bootstrap because the workspace being written does not exist
     * until the transaction is under way. After that call the transaction is
     * at a REAL workspace, so the sentinel no longer narrows anything — and
     * modelling it by name is the same treatment the other named seams get.
     * Positions are compared rather than exempting the whole unit, so a
     * statement BEFORE the re-entry is still judged.
     */
    tablesIn(root) {
      const out = new Set();
      let reentry = Number.POSITIVE_INFINITY;
      for (const n of nodesOf(root)) {
        if (calleeText(n) === "setTransactionWorkspaceScope") {
          reentry = Math.min(reentry, n.getStart());
        }
      }
      for (const n of nodesOf(root)) {
        if (n.getStart() > reentry) continue;
        const direct = this.tableOf(n);
        if (direct !== null) out.add(direct);
        // tx.query.<table>
        if (
          ts.isPropertyAccessExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === "query" &&
          ts.isIdentifier(n.expression.expression) &&
          n.expression.expression.text === "tx"
        ) {
          out.add(n.name.text);
        }
      }
      return out;
    },
  };
}

/**
 * The ways of naming a table this check CANNOT resolve, listed so the limit is
 * a written fact rather than the next finding. See ADR-074 — none of these is
 * closed by more syntax, and the last is not decidable by any analysis.
 */
export const residualTableForms = [
  'import { apiKeys } from "@oxagen/database/schema/auth" — a table imported straight from a schema module, which needs module resolution across packages. MISSED.',
  "function read(tx, table) { tx.select().from(table) } — a table as a parameter, which needs dataflow. MISSED.",
  "tx.select().from(cond ? a : b) — a table chosen at runtime. Over-approximated when both candidates are spelled in the file (a false positive, the safe direction), missed when they are not.",
];

/** Every table these subtrees name, through any form this file can resolve. */
export function tablesNamed(roots, resolver) {
  const out = new Set();
  for (const root of [roots].flat()) {
    for (const t of resolver.tablesIn(root)) out.add(t);
  }
  return out;
}

/**
 * The outermost expression of the Drizzle chain this node sits in — the
 * statement it belongs to. `.from(t)` and the `.where(…)` that qualifies it are
 * links on one chain, so walking out to the root and searching THAT subtree
 * associates a predicate with its own statement instead of with the file.
 */
function statementRoot(node) {
  let current = node;
  while (
    current.parent !== undefined &&
    (ts.isPropertyAccessExpression(current.parent) ||
      ts.isCallExpression(current.parent) ||
      ts.isAwaitExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * Whether EVERY statement in these subtrees that touches `name` pins
 * `workspace_id IS NULL`.
 *
 * This is the one exemption, and it applies only to `workspace_nullable`. That
 * class's policy admits exactly the rows whose workspace_id IS NULL plus the
 * ones matching the workspace GUC, so a query that already asks for the NULL
 * rows and nothing else gets the same answer under the sentinel as it would
 * under any scope. An INSERT that names no workspaceId writes NULL, which the
 * class's WITH CHECK accepts under any scope, so it counts as pinned.
 *
 * PER STATEMENT, NOT IN AGGREGATE. This compared two totals once — how many
 * statements touched the table, how many `isNull` predicates appeared anywhere
 * near them — and inferred a per-statement property from the pair. A single
 * query carrying the predicate twice (`and(isNull(x), or(isNull(x), …))`) made
 * the totals match while a second, entirely unpinned organisation-wide read of
 * the same table went unreported, and the check said clean. Pooling regions
 * from different `runInTenantScope` callbacks leaked the same way across
 * scopes. Every statement now answers for itself.
 */
export function pinsNullWorkspace(name, roots, resolver) {
  const tableIs = (arg) => resolver.tableOf(arg) === name;

  /** Is this node exactly `isNull(<table>.workspaceId)`? */
  const isThePin = (n) => {
    if (calleeText(n) !== "isNull") return false;
    const arg = n.arguments[0];
    return (
      arg !== undefined &&
      ts.isPropertyAccessExpression(arg) &&
      arg.name.text === "workspaceId" &&
      tableIs(arg.expression)
    );
  };

  /**
   * Is the pin a MANDATORY CONJUNCT of this predicate — true on every path
   * through it — rather than merely present somewhere in its AST?
   *
   * `where(or(isNull(t.workspaceId), eq(t.workspaceId, requested)))` reads both
   * the org-wide rows and one workspace's on purpose, and the sentinel still
   * truncates the second branch. Asking whether an `isNull` call appears
   * anywhere exempted that query; an `isNull` inside an `or` is an alternative,
   * not a constraint. Only `and` propagates the guarantee.
   */
  const isMandatoryPin = (n) => {
    if (n === undefined) return false;
    if (isThePin(n)) return true;
    if (ts.isCallExpression(n) && calleeText(n) === "and") {
      return n.arguments.some((a) => isMandatoryPin(a));
    }
    if (ts.isParenthesizedExpression(n)) return isMandatoryPin(n.expression);
    return false;
  };

  /** Does this one statement pin workspace_id IS NULL on `name`? */
  const pinnedIn = (root) => {
    const predicates = [];
    for (const n of nodes(root)) {
      // `.where(<predicate>)`
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "where"
      ) {
        // Every argument of a where() is a conjunct.
        predicates.push(...n.arguments);
      }
      // `tx.query.t.findFirst({ where: <predicate> })`
      if (
        ts.isPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "where"
      ) {
        predicates.push(n.initializer);
      }
    }
    return predicates.some((predicate) => isMandatoryPin(predicate));
  };

  const statements = [];
  for (const region of [roots].flat()) {
    for (const n of nodes(region)) {
      if (!ts.isCallExpression(n)) continue;
      const callee = n.expression;
      if (!ts.isPropertyAccessExpression(callee)) continue;
      if (!tableIs(n.arguments[0])) continue;
      const method = callee.name.text;
      if (["from", "update", "delete", "insert"].includes(method)) {
        statements.push({ method, node: n });
      }
    }
  }
  if (statements.length === 0) return false;

  return statements.every(({ method, node }) => {
    const root = statementRoot(node);
    if (method === "insert") {
      // `.insert(t).values({ … })` — the values object is on this same chain.
      for (const x of nodes(root)) {
        if (!ts.isCallExpression(x)) continue;
        if (!ts.isPropertyAccessExpression(x.expression)) continue;
        if (x.expression.name.text !== "values") continue;
        const obj = x.arguments[0];
        if (obj === undefined || !ts.isObjectLiteralExpression(obj)) continue;
        const ws = workspaceOfObject(obj, new Set());
        return ws === null || ws === "sentinel";
      }
      return true; // no values() found: nothing names a workspace
    }
    return pinnedIn(root);
  });
}

/** The offending (export, table, class) triples among the names given. */
export function offenders(names, tableNames, policyClasses, roots, resolver) {
  const out = [];
  for (const name of names) {
    const table = tableNames.get(name);
    if (!table) continue; // not a Drizzle table export
    const cls = policyClasses.get(table);
    // A table with no manifest entry carries no tenant_isolation policy at all
    // (auth.users, org.organizations, billing.plans — platform-global rows), so
    // the sentinel cannot narrow it.
    if (cls === undefined || SAFE_CLASSES.has(cls)) continue;
    if (
      cls === "workspace_nullable" &&
      pinsNullWorkspace(name, roots, resolver)
    ) {
      continue;
    }
    out.push({ export: name, table, policyClass: cls });
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

// ── Pass A: co-located scope and query ───────────────────────────────────────

export function passColocated(files, tableNames, policyClasses, root = ROOT) {
  const findings = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("runInTenantScope") || !src.includes("withTenantDb")) {
      continue;
    }
    const sourceFile = parse(src, file);
    const names = sentinelNames(sourceFile);
    // Only the withTenantDb calls lexically INSIDE a sentinel-carrying
    // runInTenantScope callback. A file-level answer conflates a sentinel scope
    // wrapping one org_only read with real-workspace scopes elsewhere in the
    // same file, which is a false positive and was one:
    // _shared/conversation-page.tsx scopes an org-only credit_lots read to the
    // sentinel and everything else to the real workspace.
    const regions = [];
    for (const call of callsTo(sourceFile, "runInTenantScope")) {
      if (!carriesSentinel(call.arguments[0], sourceFile, names)) continue;
      const body = call.arguments[1];
      if (body === undefined) continue;
      regions.push(...tenantDbRegions(body));
    }
    if (regions.length === 0) continue;
    const resolver = tableResolver(sourceFile);
    const bad = offenders(
      tablesNamed(regions, resolver),
      tableNames,
      policyClasses,
      regions,
      resolver,
    );
    if (bad.length > 0) {
      findings.push({ pass: "co-located", file: rel(file, root), tables: bad });
    }
  }
  return findings;
}

// ── Pass C: the apps/app kernelRead / kernelWrite seam ───────────────────────

/**
 * The port methods that take an `OrgCtx`, from `apps/app/src/data/ports.ts`.
 * `capabilityContext` in `src/server/kernel.ts` gives exactly those the
 * sentinel; a `WsCtx` method keeps its real workspace. A name declared both
 * ways is dropped rather than guessed.
 */
export function readOrgCtxMethods(root = ROOT) {
  const file = join(root, "apps/app/src/data/ports.ts");
  if (!existsSync(file)) return new Set();
  const sourceFile = parse(readFileSync(file, "utf8"), file);
  const org = new Set();
  const ws = new Set();
  for (const n of nodesOf(sourceFile)) {
    if (!ts.isMethodSignature(n) && !ts.isMethodDeclaration(n)) continue;
    const first = n.parameters[0];
    if (first === undefined || first.type === undefined) continue;
    const kind = first.type.getText();
    if (!ts.isIdentifier(n.name)) continue;
    if (kind === "OrgCtx") org.add(n.name.text);
    else if (kind === "WsCtx") ws.add(n.name.text);
  }
  for (const name of ws) org.delete(name);
  return org;
}

/** The `<name>(ctx…) { … }` methods this file declares, by name. */
function methodsNamed(sourceFile, names) {
  const out = [];
  for (const n of nodesOf(sourceFile)) {
    if (!ts.isMethodDeclaration(n) && !ts.isPropertyAssignment(n)) continue;
    const fn = ts.isMethodDeclaration(n) ? n : n.initializer;
    if (fn === undefined) continue;
    if (
      !ts.isMethodDeclaration(fn) &&
      !ts.isFunctionExpression(fn) &&
      !ts.isArrowFunction(fn)
    ) {
      continue;
    }
    const nameNode = ts.isMethodDeclaration(n) ? n.name : n.name;
    if (!ts.isIdentifier(nameNode) || !names.has(nameNode.text)) continue;
    out.push({ method: nameNode.text, node: fn });
  }
  return out;
}

export function passAppKernelSeam(
  files,
  tableNames,
  policyClasses,
  handlerModules,
  contractNames,
  root = ROOT,
) {
  const orgMethods = readOrgCtxMethods(root);
  if (orgMethods.size === 0) return [];
  const findings = [];
  for (const file of files) {
    if (!rel(file, root).startsWith("apps/app/src/data/live/")) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("kernelRead") && !src.includes("kernelWrite")) continue;
    const sourceFile = parse(src, file);
    for (const { method, node } of methodsNamed(sourceFile, orgMethods)) {
      const capabilities = new Set();
      for (const call of [
        ...callsTo(node, "kernelRead"),
        ...callsTo(node, "kernelWrite"),
      ]) {
        for (const arg of call.arguments) {
          if (ts.isIdentifier(arg)) {
            const name = contractNames.get(arg.text);
            if (name !== undefined) capabilities.add(name);
          }
          if (!ts.isObjectLiteralExpression(arg)) continue;
          for (const prop of arg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "contract" &&
              ts.isIdentifier(prop.initializer)
            ) {
              const name = contractNames.get(prop.initializer.text);
              if (name !== undefined) capabilities.add(name);
            }
          }
        }
      }
      for (const capability of capabilities) {
        findings.push(
          ...handlerFindings(
            capability,
            handlerModules,
            tableNames,
            policyClasses,
            root,
            {
              pass: "app-kernel-seam",
              file: `${rel(file, root)} (${method})`,
            },
          ),
        );
      }
    }
  }
  return findings;
}

// ── Pass B: a sentinel ctx handed to invoke() ────────────────────────────────

/** capability name -> handler module path, from register.ts. */
export function readHandlerModules(root = ROOT) {
  const out = new Map();

  // packages/handlers: registerHandler("name", () => import("./module"))
  const handlers = join(root, "packages/handlers/src/register.ts");
  if (existsSync(handlers)) {
    const src = readFileSync(handlers, "utf8");
    for (const m of src.matchAll(
      /registerHandler\(\s*"([\w.]+)"\s*,[\s\S]*?import\("(\.[^"]+)"\)/g,
    )) {
      out.set(m[1], { base: "packages/handlers/src", module: m[2] });
    }
  }

  // packages/agent: a LOADERS map, registered in bulk by ./register.ts. A whole
  // package — agent registry, approval, MCP, memory, role, trace — was outside
  // this check until this was added, because it read only the handlers
  // registry. That is a coverage hole rather than an analysis limit: the check
  // was not looking, not looking and reading wrong.
  const agent = join(root, "packages/agent/src/handlers/index.ts");
  if (existsSync(agent)) {
    const src = readFileSync(agent, "utf8");
    for (const m of src.matchAll(
      /([\w]+):\s*\(\)\s*=>\s*import\("(\.[^"]+)"\)/g,
    )) {
      out.set(m[1], { base: "packages/agent/src/handlers", module: m[2] });
    }
  }

  return out;
}

/**
 * Contract export identifier -> capability name, from
 * packages/oxagen/src/contracts. A surface names a capability as
 * `<contractExport>.name` at least as often as it spells the string, and the
 * two forms have to resolve to the same handler or the check sees half the
 * call sites.
 */
export function readContractNames(root = ROOT) {
  const dir = join(root, "packages/oxagen/src/contracts");
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(
      /export const (\w+)\s*=\s*registerCapability\(\{\s*\n?\s*name:\s*"([\w.]+)"/g,
    )) {
      out.set(m[1], m[2]);
    }
  }
  return out;
}

/** The handler module's own source plus its direct relative imports. */
export function handlerSources(entryRef, root = ROOT) {
  const base = join(root, entryRef.base);
  const entry = join(base, `${entryRef.module.replace(/^\.\//, "")}.ts`);
  if (!existsSync(entry)) {
    // An empty result here would be indistinguishable from "looked and found
    // nothing", which is the failure shape this whole check exists to refuse.
    // A capability whose module cannot be found is the one condition under
    // which the check's silence means nothing, so it is loud.
    throw new Error(
      `check-org-sentinel-reads: registered handler module not found: ${entryRef.base}/${entryRef.module}.ts — the registry names it but the file is not there, so this capability would be silently unexamined.`,
    );
  }
  const head = readFileSync(entry, "utf8");
  const sources = [{ src: head, file: entry }];
  for (const m of head.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
    const dep = join(dirname(entry), `${m[1]}.ts`);
    if (existsSync(dep)) {
      sources.push({ src: readFileSync(dep, "utf8"), file: dep });
    }
  }
  return sources;
}

/**
 * The findings a capability's handler produces, shared by the passes so the
 * handler side is one piece of code rather than three copies.
 */
function handlerFindings(
  capability,
  handlerModules,
  tableNames,
  policyClasses,
  root,
  shape,
) {
  const entryRef = handlerModules.get(capability);
  if (entryRef === undefined) return [];
  const sources = handlerSources(entryRef, root);
  const entry = sources[0];
  const entrySf = parse(entry.src, entry.file);
  const entryRegions = tenantDbRegions(entrySf);
  // No transaction anywhere in the handler: nothing here runs under the
  // sentinel's tenant scope.
  if (entryRegions.length === 0) return [];

  // The units to judge, each with the resolver of the file it came from.
  //
  // A handler often opens withTenantDb and hands `tx` to a helper —
  // plugin.registry.add.ts opens the transaction and calls addRegistry, which
  // is where schema.mcpRegistries is touched. Skipping a helper for having no
  // transaction OF ITS OWN is backwards: it has none BECAUSE the caller opened
  // one, and its queries run inside it. So once the entry has a tenant region,
  // each direct import is judged whole. That over-approximates a helper whose
  // tables are only used outside a transaction, which is the safe direction —
  // a false positive rather than a call site missing from the inventory.
  const units = entryRegions.map((region) => ({
    root: region,
    resolver: tableResolver(entrySf),
  }));
  for (const helper of sources.slice(1)) {
    const sf = parse(helper.src, helper.file);
    units.push({ root: sf, resolver: tableResolver(sf) });
  }

  const byTable = new Map();
  for (const unit of units) {
    const bad = offenders(
      tablesNamed([unit.root], unit.resolver),
      tableNames,
      policyClasses,
      [unit.root],
      unit.resolver,
    );
    for (const t of bad) if (!byTable.has(t.table)) byTable.set(t.table, t);
  }
  if (byTable.size === 0) return [];

  return [
    {
      ...shape,
      capability,
      handler: `${entryRef.base}/${entryRef.module.replace(/^\.\//, "")}.ts`,
      tables: [...byTable.values()].sort((a, b) =>
        a.table.localeCompare(b.table),
      ),
    },
  ];
}

export function passCrossSurface(
  files,
  tableNames,
  policyClasses,
  handlerModules,
  contractNames,
  root = ROOT,
) {
  const findings = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("invoke(") && !src.includes("invokeOrgCapability")) {
      continue;
    }
    const sourceFile = parse(src, file);
    const names = sentinelNames(sourceFile);
    const invoked = new Set();
    let indirect = false;

    // invoke(capability, input, ctx, …) — the ctx is read as a node, so an
    // inline object literal and a named const are the same path.
    for (const call of callsTo(sourceFile, "invoke")) {
      const ctxArg = call.arguments[2];
      if (!carriesSentinel(ctxArg, sourceFile, names)) continue;
      const nameArg = call.arguments[0];
      if (nameArg === undefined) continue;
      if (ts.isStringLiteral(nameArg)) {
        invoked.add(nameArg.text);
      } else if (
        ts.isPropertyAccessExpression(nameArg) &&
        nameArg.name.text === "name" &&
        ts.isIdentifier(nameArg.expression) &&
        contractNames.has(nameArg.expression.text)
      ) {
        invoked.add(contractNames.get(nameArg.expression.text));
      } else {
        indirect = true;
      }
    }

    // invokeOrgCapability(orgId, userId, capability, input) builds the ctx,
    // enters the scope and calls invoke() itself, so a caller names the
    // capability and nothing else.
    for (const call of callsTo(sourceFile, "invokeOrgCapability")) {
      const nameArg = call.arguments[2];
      if (nameArg !== undefined && ts.isStringLiteral(nameArg)) {
        invoked.add(nameArg.text);
      } else {
        // Called through a local wrapper — governance/page.tsx has a
        // safeInvoke(orgId, userId, name, input) that forwards its `name`
        // parameter, so the capability strings are at the WRAPPER's call
        // sites. Same situation as an indirect invoke(), and it gets the same
        // answer: scan every capability this file names.
        indirect = true;
      }
    }

    // A capability named nowhere the parse can follow — an invoke() behind a
    // readCapability(viewer, name, input) helper, as on `main`. Check every
    // capability the file names in either form. Over-approximates in the same
    // direction the co-located pass does.
    if (indirect) {
      for (const n of nodesOf(sourceFile)) {
        if (ts.isStringLiteral(n) && handlerModules.has(n.text)) {
          invoked.add(n.text);
        }
        if (
          ts.isPropertyAccessExpression(n) &&
          n.name.text === "name" &&
          ts.isIdentifier(n.expression) &&
          contractNames.has(n.expression.text)
        ) {
          invoked.add(contractNames.get(n.expression.text));
        }
      }
    }

    for (const capability of invoked) {
      findings.push(
        ...handlerFindings(
          capability,
          handlerModules,
          tableNames,
          policyClasses,
          root,
          { pass: "cross-surface", file: rel(file, root) },
        ),
      );
    }
  }
  return findings;
}

function rel(file, root = ROOT) {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}

/**
 * The findings this check does not fail on, in two kinds.
 *
 * `waived` — a real defect whose fix belongs to another change, named in
 * `fixedBy`. It goes when that change lands.
 *
 * `acknowledged` — NOT a defect: something this check reports that a more
 * precise analysis would not, with `needs` naming which analysis. These exist
 * because the check is best-effort (ADR-074), and each one is evidence about
 * where its precision ends rather than a problem to be hidden. `needs` is
 * required so the category cannot become a place to put anything inconvenient.
 *
 * Both kinds ratchet the same way: an entry matching no finding is an error.
 */
export function readBaseline(root = ROOT) {
  const file = join(root, "tools/scripts/org-sentinel-reads-baseline.json");
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const waived = Array.isArray(parsed.waived) ? parsed.waived : [];
  const acknowledged = Array.isArray(parsed.acknowledged)
    ? parsed.acknowledged
    : [];
  for (const entry of acknowledged) {
    if (typeof entry.needs !== "string" || entry.needs.length === 0) {
      throw new Error(
        `org-sentinel-reads-baseline.json: acknowledged entry for ${entry.file} has no "needs" — say which analysis would resolve it, or it is a waiver rather than an acknowledgement.`,
      );
    }
  }
  return [
    ...waived.map((w) => ({ ...w, kind: "waived" })),
    ...acknowledged.map((a) => ({ ...a, kind: "acknowledged" })),
  ];
}

/**
 * A finding's identity for baseline matching: where it is, what it invokes, AND
 * which tables it reports.
 *
 * The tables are part of the identity on purpose. Keyed on site and capability
 * alone, a waiver would go on matching after the handler grew a SECOND narrowed
 * table — suppressing a new defect and still reading as live rather than stale,
 * which is the rot the baseline exists to prevent, one level down. With the
 * table set in the key, a new table is a new finding AND the old waiver goes
 * stale, so both halves are reported.
 */
export function findingKey(f) {
  const tables = (f.tables ?? [])
    .map((t) => (typeof t === "string" ? t : t.table))
    .slice()
    .sort()
    .join(",");
  return `${f.file}::${f.capability ?? ""}::${tables}`;
}

// ── Run ──────────────────────────────────────────────────────────────────────

/** Every finding in the tree, deduplicated. Exported so the test can drive it. */
export function findSentinelNarrowedReads(root = ROOT) {
  const policyClasses = readPolicyClasses(root);
  const tableNames = readTableNames(root);
  const handlerModules = readHandlerModules(root);
  const contractNames = readContractNames(root);

  const roots = ["apps", "packages", "tools"]
    .map((d) => join(root, d))
    .filter((d) => existsSync(d));
  const files = roots.flatMap((d) => [...walk(d)]);

  const findings = [
    ...passColocated(files, tableNames, policyClasses, root),
    ...passCrossSurface(
      files,
      tableNames,
      policyClasses,
      handlerModules,
      contractNames,
      root,
    ),
    ...passAppKernelSeam(
      files,
      tableNames,
      policyClasses,
      handlerModules,
      contractNames,
      root,
    ),
  ];
  // One (file, capability) can be reported more than once — by both passes, or
  // by a handler and one of its relative imports naming different tables. Merge
  // them into one finding carrying the union of the tables.
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.pass}:${f.file}:${f.capability ?? ""}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, { ...f, tables: [...f.tables] });
      continue;
    }
    for (const t of f.tables) {
      if (!seen.tables.some((x) => x.table === t.table)) seen.tables.push(t);
    }
    seen.tables.sort((a, b) => a.table.localeCompare(b.table));
  }
  // Subtract the waived findings, and report any entry that matched nothing —
  // a stale waiver is the failure mode a baseline has, so it is an error too.
  const all = [...byKey.values()];
  const baseline = readBaseline(root);
  const matched = new Set();
  const unwaived = all.filter((f) => {
    const hit = baseline.find((w) => findingKey(w) === findingKey(f));
    if (hit === undefined) return true;
    matched.add(findingKey(hit));
    return false;
  });
  const staleWaivers = baseline.filter((w) => !matched.has(findingKey(w)));
  // Counted apart, because the two lists mean different things: a waiver is a
  // live defect with an owner and an end, an acknowledgement is not a defect at
  // all. Pooling them under one "waived" number reports a waiver that does not
  // exist and hides an acknowledgement that does.
  const suppressed = baseline.filter((w) => matched.has(findingKey(w)));
  return {
    files: files.length,
    policiedTables: policyClasses.size,
    findings: unwaived,
    waived: suppressed.filter((w) => w.kind === "waived").length,
    acknowledged: suppressed.filter((w) => w.kind === "acknowledged").length,
    staleWaivers,
  };
}

function main() {
  const {
    files,
    policiedTables,
    findings,
    waived,
    acknowledged,
    staleWaivers,
  } = findSentinelNarrowedReads();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ findings, waived, staleWaivers }, null, 2));
    process.exit(findings.length === 0 && staleWaivers.length === 0 ? 0 : 1);
  }

  if (staleWaivers.length > 0) {
    console.error(
      `check-org-sentinel-reads: ${staleWaivers.length} baseline entr(y/ies) match no finding. The defect is gone; remove the waiver so the file cannot outlive it.\n`,
    );
    for (const w of staleWaivers) {
      console.error(`  ${w.file}  (${w.capability ?? "—"})`);
      if (w.fixedBy) console.error(`    fixedBy: ${w.fixedBy}`);
    }
    process.exit(1);
  }

  const parts = [];
  if (waived > 0) parts.push(`${waived} waived`);
  if (acknowledged > 0) parts.push(`${acknowledged} acknowledged`);
  const tail =
    parts.length > 0
      ? ` (${parts.join(", ")}, see org-sentinel-reads-baseline.json)`
      : "";

  if (findings.length === 0) {
    console.log(
      `check-org-sentinel-reads: ${files} files, ${policiedTables} policied tables — no read is narrowed by the org-only workspace sentinel${tail}.`,
    );
    process.exit(0);
  }

  console.error(
    `check-org-sentinel-reads: ${findings.length} read(s) the org-only workspace sentinel narrows.\n`,
  );
  for (const f of findings) {
    console.error(`  ${f.file}`);
    if (f.capability) {
      console.error(`    invokes ${f.capability} -> ${f.handler}`);
    }
    for (const t of f.tables) {
      const effect =
        t.policyClass === "workspace_nullable"
          ? "answers PARTIALLY (only workspace_id IS NULL rows)"
          : "answers EMPTILY";
      console.error(
        `    schema.${t.export} (${t.table}, ${t.policyClass}) ${effect}`,
      );
    }
    console.error("");
  }
  console.error(
    "Read it through withSystemDb with an explicit eq(table.orgId, orgId) fence,\n" +
      "or re-enter a real workspace's scope. ADR-074 has the reasoning;\n" +
      "packages/handlers/src/audit.log.query.ts and iam.role.list.ts are the shape.",
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
