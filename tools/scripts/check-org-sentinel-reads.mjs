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
/** The only policy class that ignores the workspace GUC. */
const SAFE_CLASS = "org_only";

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

/** Every `schema.<name>` and `tx.query.<name>` these subtrees name. */
export function tablesNamed(roots) {
  const out = new Set();
  for (const root of [roots].flat()) {
    for (const n of nodes(root)) {
      if (!ts.isPropertyAccessExpression(n)) continue;
      const e = n.expression;
      if (ts.isIdentifier(e) && e.text === "schema") out.add(n.name.text);
      if (
        ts.isPropertyAccessExpression(e) &&
        e.name.text === "query" &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === "tx"
      ) {
        out.add(n.name.text);
      }
    }
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
export function pinsNullWorkspace(name, roots) {
  const tableIs = (arg) =>
    arg !== undefined &&
    ts.isPropertyAccessExpression(arg) &&
    ts.isIdentifier(arg.expression) &&
    arg.expression.text === "schema" &&
    arg.name.text === name;

  /** Does this one statement pin workspace_id IS NULL on `name`? */
  const pinnedIn = (root) => {
    for (const n of nodes(root)) {
      if (calleeText(n) !== "isNull") continue;
      const arg = n.arguments[0];
      if (
        arg !== undefined &&
        ts.isPropertyAccessExpression(arg) &&
        arg.name.text === "workspaceId" &&
        tableIs(arg.expression)
      ) {
        return true;
      }
    }
    return false;
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
export function offenders(names, tableNames, policyClasses, roots) {
  const out = [];
  for (const name of names) {
    const table = tableNames.get(name);
    if (!table) continue; // not a Drizzle table export
    const cls = policyClasses.get(table);
    // A table with no manifest entry carries no tenant_isolation policy at all
    // (auth.users, org.organizations, billing.plans — platform-global rows), so
    // the sentinel cannot narrow it.
    if (cls === undefined || cls === SAFE_CLASS) continue;
    if (cls === "workspace_nullable" && pinsNullWorkspace(name, roots))
      continue;
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
    const bad = offenders(
      tablesNamed(regions),
      tableNames,
      policyClasses,
      regions,
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
  const src = readFileSync(
    join(root, "packages/handlers/src/register.ts"),
    "utf8",
  );
  const out = new Map();
  for (const m of src.matchAll(
    /registerHandler\(\s*"([\w.]+)"\s*,[\s\S]*?import\("(\.[^"]+)"\)/g,
  )) {
    out.set(m[1], m[2]);
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
export function handlerSources(modulePath, root = ROOT) {
  const base = join(root, "packages/handlers/src");
  const entry = join(base, `${modulePath.replace(/^\.\//, "")}.ts`);
  if (!existsSync(entry)) return [];
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
  const modulePath = handlerModules.get(capability);
  if (modulePath === undefined) return [];
  const out = [];
  for (const { src, file } of handlerSources(modulePath, root)) {
    const regions = tenantDbRegions(parse(src, file));
    if (regions.length === 0) continue;
    const bad = offenders(
      tablesNamed(regions),
      tableNames,
      policyClasses,
      regions,
    );
    if (bad.length > 0) {
      out.push({
        ...shape,
        capability,
        handler: `packages/handlers/src/${modulePath.replace(/^\.\//, "")}.ts`,
        tables: bad,
      });
    }
  }
  return out;
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

/** The waived findings, keyed the way a finding is identified. */
export function readBaseline(root = ROOT) {
  const file = join(root, "tools/scripts/org-sentinel-reads-baseline.json");
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed.waived) ? parsed.waived : [];
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
  return {
    files: files.length,
    policiedTables: policyClasses.size,
    findings: unwaived,
    waived: all.length - unwaived.length,
    staleWaivers,
  };
}

function main() {
  const { files, policiedTables, findings, waived, staleWaivers } =
    findSentinelNarrowedReads();

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

  const tail =
    waived > 0
      ? ` (${waived} waived, see org-sentinel-reads-baseline.json)`
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
