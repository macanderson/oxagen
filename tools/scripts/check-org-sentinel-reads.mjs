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
 *
 * Both of those are why the fix also moved the sentinel itself into
 * `@oxagen/tenancy`, where its doc comment states the rule once instead of
 * thirty-odd local copies restating it unevenly. See ADR-074.
 *
 * Usage:
 *   node tools/scripts/check-org-sentinel-reads.mjs [--json]
 *
 * Exit code 1 on any finding.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** The identifiers a file binds to the sentinel, plus the literal itself. */
export function sentinelNames(src) {
  const names = new Set();
  for (const m of src.matchAll(
    new RegExp(`(?:const|let)\\s+(\\w+)[^=\\n]*=\\s*"${SENTINEL}"`, "g"),
  )) {
    names.add(m[1]);
  }
  // The shared constant, however it was imported or aliased.
  for (const m of src.matchAll(/ORG_ONLY_WORKSPACE_ID(?:\s+as\s+(\w+))?/g)) {
    names.add(m[1] ?? "ORG_ONLY_WORKSPACE_ID");
  }
  return names;
}

/** Does `value` name the sentinel in this file? */
export function isSentinelValue(value, names) {
  const v = value.trim().replace(/[,)}\s].*$/s, "");
  return v === `"${SENTINEL}"` || v === `'${SENTINEL}'` || names.has(v);
}

/**
 * Source with comments blanked out. Every prose mention of `withTenantDb` in a
 * header comment — including the ones the fixes this check enforces left behind
 * explaining why the seam changed — would otherwise read as a call.
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (m, p) => p + " ".repeat(m.length - p.length),
    );
}

/**
 * The regions of `src` that are `withTenantDb(...)` calls, brace-matched from
 * the call's opening paren. Collecting tables from the whole file instead would
 * report a file that does its workspace-scoped work through withSystemDb — the
 * correct shape — merely because some other read in it is tenant-scoped.
 */
export function tenantDbRegions(src) {
  const out = [];
  for (const m of src.matchAll(/\bwithTenantDb\s*\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

/** Every `schema.<name>` and `tx.query.<name>` these sources name. */
export function tablesNamed(sources) {
  const out = new Set();
  for (const src of [sources].flat()) {
    for (const m of src.matchAll(/\bschema\.(\w+)/g)) out.add(m[1]);
    for (const m of src.matchAll(/\btx\.query\.(\w+)\./g)) out.add(m[1]);
  }
  return out;
}

/**
 * Whether every statement in `regions` that touches `name` already pins
 * `workspace_id IS NULL`.
 *
 * This is the one exemption, and it applies only to `workspace_nullable`. That
 * class's policy admits exactly the rows whose workspace_id IS NULL plus the
 * ones matching the workspace GUC, so a query that already asks for the NULL
 * rows and nothing else gets the same answer under the sentinel as it would
 * under any scope: the predicate and the policy agree, and there is nothing to
 * truncate. Counting rather than merely looking for one `isNull` keeps a
 * second, unpinned read of the same table in the same region from riding the
 * first one's exemption.
 */
export function pinsNullWorkspace(name, regions) {
  let statements = 0;
  let pinned = 0;
  const stmt = new RegExp(
    `\\.(?:from|update|delete)\\(\\s*schema\\.${name}\\b`,
    "g",
  );
  const pin = new RegExp(`isNull\\(\\s*schema\\.${name}\\.workspaceId`, "g");
  // An INSERT that names no workspaceId writes NULL, which the class's WITH
  // CHECK accepts under any scope; one that names a value is a statement like
  // any other and has to account for it.
  const insert = new RegExp(
    `\\.insert\\(\\s*schema\\.${name}\\b[\\s\\S]{0,600}?\\.values\\(([\\s\\S]{0,600}?)\\)`,
    "g",
  );
  for (const region of regions) {
    statements += [...region.matchAll(stmt)].length;
    pinned += [...region.matchAll(pin)].length;
    for (const m of region.matchAll(insert)) {
      statements += 1;
      if (
        !/workspaceId\s*:/.test(m[1]) ||
        /workspaceId\s*:\s*null/.test(m[1])
      ) {
        pinned += 1;
      }
    }
  }
  return statements > 0 && pinned >= statements;
}

/** The offending (export, table, class) triples among the names given. */
export function offenders(names, tableNames, policyClasses, regions) {
  const out = [];
  for (const name of names) {
    const table = tableNames.get(name);
    if (!table) continue; // not a Drizzle table export
    const cls = policyClasses.get(table);
    // A table with no manifest entry carries no tenant_isolation policy at all
    // (auth.users, org.organizations, billing.plans — platform-global rows), so
    // the sentinel cannot narrow it.
    if (cls === undefined || cls === SAFE_CLASS) continue;
    if (cls === "workspace_nullable" && pinsNullWorkspace(name, regions)) {
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
    const src = stripComments(readFileSync(file, "utf8"));
    if (!src.includes("runInTenantScope")) continue;
    const regions = tenantDbRegions(src);
    if (regions.length === 0) continue;
    const names = sentinelNames(src);
    if (names.size === 0) continue;
    const scoped = [...src.matchAll(/runInTenantScope\(\s*\{([^}]*)\}/g)].some(
      (m) => {
        const ws = m[1].match(/workspaceId\s*:\s*([^,}]+)/);
        return ws !== null && isSentinelValue(ws[1], names);
      },
    );
    if (!scoped) continue;
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
  const sources = [stripComments(readFileSync(entry, "utf8"))];
  for (const m of sources[0].matchAll(/from\s+"(\.\/[^"]+)"/g)) {
    const dep = join(dirname(entry), `${m[1]}.ts`);
    if (existsSync(dep)) sources.push(stripComments(readFileSync(dep, "utf8")));
  }
  return sources;
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
    const src = stripComments(readFileSync(file, "utf8"));
    if (!src.includes("invoke(")) continue;
    const names = sentinelNames(src);
    if (names.size === 0) continue;
    // The ctx object identifiers this file builds with a sentinel workspaceId.
    const sentinelCtx = new Set();
    for (const m of src.matchAll(
      /(?:const|return)\s+(?:(\w+)\s*(?::[^=]+)?=\s*)?\{([\s\S]{0,600}?)\}/g,
    )) {
      const ws = m[2].match(/workspaceId\s*:\s*([^,}\n]+)/);
      if (ws === null || !isSentinelValue(ws[1], names)) continue;
      if (m[1]) sentinelCtx.add(m[1]);
      else sentinelCtx.add("*"); // returned inline from a ctx builder
    }
    if (sentinelCtx.size === 0) continue;

    // The capabilities this file invokes under a sentinel ctx.
    const invoked = new Set();
    // An indirect call — `invoke(name, …)` behind a readCapability(viewer,
    // name, …) helper — names the capability at the helper's call sites and
    // not at the invoke. A real one was found on `main`
    // (apps/app/src/app/[orgSlug]/billing/governed-actions/data.ts), where the
    // sentinel scope and the invoke are one function and every capability is
    // named at the helper's call sites three lines away. When the invoke's
    // first argument resolves to neither a literal nor a contract export,
    // every capability this file names in either form is checked instead. That
    // over-approximates — the file could name one it invokes under a real
    // scope — which is the same direction the co-located pass errs in, and the
    // remedy is identical either way.
    let indirect = false;
    for (const m of src.matchAll(
      /\binvoke\(\s*(?:"([\w.]+)"|(\w+)(?:\.name)?)\s*,[\s\S]{0,400}?,\s*(?:\{\s*\.\.\.\s*)?(\w+)/g,
    )) {
      const ctxName = m[3];
      if (!sentinelCtx.has("*") && !sentinelCtx.has(ctxName)) continue;
      // A call that overrides workspaceId with a real value is the fix, not the
      // defect: `{ ...ctx, workspaceId }`.
      const call = src.slice(m.index, m.index + 400);
      if (/\.\.\.\s*\w+\s*,\s*workspaceId/.test(call)) continue;
      if (m[1] !== undefined) invoked.add(m[1]);
      else if (contractNames.has(m[2])) invoked.add(contractNames.get(m[2]));
      else indirect = true;
    }
    if (indirect) {
      for (const m of src.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
        if (handlerModules.has(m[1])) invoked.add(m[1]);
      }
      for (const m of src.matchAll(/\b(\w+)\.name\b/g)) {
        const name = contractNames.get(m[1]);
        if (name !== undefined) invoked.add(name);
      }
    }

    for (const capability of invoked) {
      const modulePath = handlerModules.get(capability);
      if (modulePath === undefined) continue;
      for (const handlerSrc of handlerSources(modulePath, root)) {
        const regions = tenantDbRegions(handlerSrc);
        if (regions.length === 0) continue;
        const bad = offenders(
          tablesNamed(regions),
          tableNames,
          policyClasses,
          regions,
        );
        if (bad.length > 0) {
          findings.push({
            pass: "cross-surface",
            file: rel(file, root),
            capability,
            handler: `packages/handlers/src/${modulePath.replace(/^\.\//, "")}.ts`,
            tables: bad,
          });
        }
      }
    }
  }
  return findings;
}

function rel(file, root = ROOT) {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
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
  return {
    files: files.length,
    policiedTables: policyClasses.size,
    findings: [...byKey.values()],
  };
}

function main() {
  const { files, policiedTables, findings } = findSentinelNarrowedReads();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ findings }, null, 2));
    process.exit(findings.length === 0 ? 0 : 1);
  }

  if (findings.length === 0) {
    console.log(
      `check-org-sentinel-reads: ${files} files, ${policiedTables} policied tables — no read is narrowed by the org-only workspace sentinel.`,
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
