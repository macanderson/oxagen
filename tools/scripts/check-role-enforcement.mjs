#!/usr/bin/env node
/**
 * check-role-enforcement.mjs — a contract's `defaultRoles` is a promise that
 * only certain org and workspace roles may call it. `checkIAM` fast-paths a
 * non-enterprise org to an unconditional allow for non-agent principals
 * (CLAUDE.md "Runtime checks that matter"), so that promise only holds when
 * the handler asserts the role itself. #3258 found `create_connection`
 * declaring org Owner/Admin (and workspace Owner) while its handler asserted
 * nothing, so any member of a non-enterprise org, which in production is
 * every organization, could call it. #4194 found 30 more on stella's agent
 * surface that this script did not look at.
 *
 * A contract that says `defaultEffect: "deny"` while the runtime allows the
 * call on most tiers is worse than a capability with no declared restriction
 * at all: it reads as protected in review and is not.
 *
 * ## What this checks
 *
 * Every non-v2, non-test contract file under `packages/oxagen/src/contracts/`
 * that declares a role restriction. A contract declares one when either:
 *
 *   1. it declares `sensitivity: "high"` and a `defaultRoles` block (the
 *      original rule, #3258); or
 *   2. its `surfaces` include `"agent"` and its `defaultRoles` do not grant the
 *      workspace `Member` role, whatever its sensitivity (#4194). A workspace
 *      Member is the narrowest role stella serves, and stella offers every
 *      agent-surface contract through `search_tools` and `load_tools`, so a
 *      contract that withholds Member is a restriction only the handler keeps.
 *
 * `defaultRoles` is parsed whether it spans lines or sits on one. A contract
 * with `platformOnly: true` is skipped: the kernel refuses it before IAM.
 *
 * The handler is found by the registered capability name: the
 * `registerHandler("<name>", … import("./<module>") …)` binding in
 * `packages/handlers/src/register.ts`, or the `<name>: () =>
 * import("./<module>")` entry in `LOADERS` in
 * `packages/agent/src/handlers/index.ts`. A contract neither binds falls back
 * to `packages/handlers/src/<contract-stem>.ts`. The handler module must
 * reference a role-gate primitive (`ROLE_ASSERTION_PATTERN`), itself or in a
 * module it imports by a relative path, one hop deep. This is a static,
 * name-based check. It proves a role-aware call exists, not that it is wired
 * correctly. Each handler's own tests and INV-29's `role-check.test.ts` prove
 * that.
 *
 * v2 contracts (`packages/oxagen/src/contracts/v2/`) are excluded: several of
 * them (`defineTool`, not `registerCapability`) wrap an existing v1
 * capability's contract and dispatch through ITS handler and ITS name, so the
 * v1 file this script does check is where the enforcement has to live.
 *
 * ## The baseline
 *
 * #3258's audit found 27 more contracts with the first shape, too many to fix
 * as one PR change (SCR-004: each needs a maintainer decision, whether the
 * answer is "assert the role" or "the contract over-declared and should
 * relax"), so they are named in `ROLE_ENFORCEMENT_BASELINE` below and reported
 * as a warning rather than a failure. Nothing may be ADDED to the baseline: it
 * is a fixed, hand-maintained list, so the moment a NEW contract takes on this
 * shape, the check fails and names it, and the only way past it is to add the
 * role assertion (preferred) or correct the contract's declared
 * `sensitivity`/`defaultRoles` to what the handler actually enforces. A stem
 * whose handler now asserts a role is reported as stale and fails the check
 * until it is removed, so a later regression cannot hide behind it.
 *
 * Exit codes:
 *   0 — no gap outside the baseline.
 *   1 — one or more contracts declare a role restriction their handler
 *       does not enforce, outside the baseline, or the baseline is stale.
 *   2 — script error.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "oxagen", "src", "contracts");
const HANDLERS_DIR = join(REPO_ROOT, "packages", "handlers", "src");
const AGENT_HANDLERS_DIR = join(
  REPO_ROOT,
  "packages",
  "agent",
  "src",
  "handlers",
);

/**
 * The role-gate primitives: the shared gates, the IAM role reads, and the
 * membership-role reads an inline check is written with (`orgMembershipRole`,
 * `isOrgAdministrator`, `resolveActorPrincipalAndRole`, or a select of
 * `schema.orgUsers.role` / `schema.workspaceUsers.role`).
 */
export const ROLE_ASSERTION_PATTERN =
  /\bassertCallerRole\b|\bassertContractRole\b|\bassertOrgRole\b|\bassertWorkspaceRole\b|\bassertOrgOrWorkspaceRole\b|\bassertConsequenceRole\b|\bresolveActorOrgRoles?\b|\bresolveActorWorkspaceRoles?\b|\bresolveActorPrincipalAndRole\b|\borgMembershipRole\b|\bisOrgAdministrator\b|\bschema\.(?:orgUsers|workspaceUsers)\.role\b|\brequireRole\b|\bassertRole\b/;

/**
 * Contracts whose handler authorizes by something other than a role, by
 * design, each with the reason. This is not the baseline: nothing here is a
 * deferred fix.
 */
export const ROLE_ENFORCEMENT_EXEMPT = new Map([
  [
    "org.member_invite.accept",
    "the invitee accepts their own invitation, matched by token and email; they hold no role until it is accepted",
  ],
  [
    "scim.request",
    "the identity provider's SCIM token authorizes the call, and the handler refuses a user or an API key",
  ],
]);

/**
 * Contracts already known to declare a role restriction their handler does
 * not enforce, tracked by #3258's follow-up rather than fixed in that PR
 * (each needs its own "assert the role, or relax the contract" decision).
 * A stem here is the contract file's basename without `.ts`. #4194 took out
 * seven whose handlers enforce through a helper or an inline check the old
 * scan could not see: `api.key.list`, `api.key.rotate`, `context.pr.merge`,
 * `org.member.add`, `org.member.remove`, `org.member_role.change`, and
 * `privacy.data.export`.
 */
export const ROLE_ENFORCEMENT_BASELINE = new Set([
  "integration.install",
  "org.create",
  "run.frame_body.get",
  "run.transcript.get",
  "schema.delete",
  "schema.label.delete",
  "schema.property.delete",
  "schema.relationship.delete",
  "tacho.bundle.get",
  "tacho.command.fetch",
  "tacho.events.ingest",
  "tacho.host.enroll",
  "telemetry.stella.ingest",
]);

/** Non-recursive: only the top-level contract files, never `v2/`. */
function listContractFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (f) =>
        f.isFile() && f.name.endsWith(".ts") && !f.name.endsWith(".test.ts"),
    )
    .map((f) => join(dir, f.name));
}

/**
 * The text of the brace-balanced object literal that starts at the first `{`
 * at or after `from`, or null when there is none.
 */
function balancedBlock(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/** `{ Owner: "allow", … }` as a map of role to effect. Comments are ignored. */
function parseGrants(block) {
  const grants = {};
  if (!block) return grants;
  const text = block.replace(/\/\/.*$/gm, "");
  for (const m of text.matchAll(
    /["']?(\w+)["']?\s*:\s*["'](allow|deny|require_approval)["']/g,
  )) {
    grants[m[1]] = m[2];
  }
  return grants;
}

/**
 * The contract's `defaultRoles`, as `{ org, workspace }` maps of role to
 * effect, or null when it declares none. Parses a block that spans lines and
 * one that sits on one line alike.
 */
export function parseDefaultRoles(src) {
  const at = src.search(/\bdefaultRoles\s*:/);
  if (at < 0) return null;
  const block = balancedBlock(src, at);
  if (!block) return null;
  const side = (key) => {
    const i = block.search(new RegExp(`\\b${key}\\s*:`));
    return i < 0 ? {} : parseGrants(balancedBlock(block, i));
  };
  return { org: side("org"), workspace: side("workspace") };
}

/** The `surfaces` array a contract declares, or null when it is not a literal. */
export function parseSurfaces(src) {
  const m = src.match(/\bsurfaces\s*:\s*\[([^\]]*)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/["']([a-z]+)["']/g)].map((s) => s[1]);
}

/**
 * Whether `src` declares `sensitivity: "high"` and a `defaultRoles` block,
 * the shape #3258 calls a declared role restriction.
 */
export function declaresRoleRestriction(src) {
  if (!/sensitivity:\s*["']high["']/.test(src)) return false;
  return parseDefaultRoles(src) !== null;
}

/**
 * Whether an agent-surface contract withholds the workspace Member role, the
 * shape #4194 calls a declared role restriction.
 */
export function declaresAgentRoleRestriction(src) {
  const surfaces = parseSurfaces(src);
  if (!surfaces?.includes("agent")) return false;
  const roles = parseDefaultRoles(src);
  if (roles === null) return false;
  return roles.workspace.Member !== "allow";
}

/** The capability `name` a contract file registers, or null if none is found. */
export function declaredCapabilityName(src) {
  const m = src.match(/name:\s*["']([a-zA-Z0-9_]+)["']/);
  return m ? m[1] : null;
}

/**
 * Capability name → handler module path, from the two registries: the
 * `registerHandler` calls in `register.ts` and the `LOADERS` entries in the
 * agent package's `index.ts`. Either source may be null.
 *
 * @param {{
 *   registerSrc?: string | null,
 *   registerDir?: string,
 *   agentIndexSrc?: string | null,
 *   agentDir?: string,
 * }} [sources]
 * @returns {Map<string, string>}
 */
export function handlerModules({
  registerSrc = null,
  registerDir = HANDLERS_DIR,
  agentIndexSrc = null,
  agentDir = AGENT_HANDLERS_DIR,
} = {}) {
  const modules = new Map();
  if (registerSrc) {
    for (const chunk of registerSrc.split(/\bregisterHandler\s*\(/).slice(1)) {
      const name = chunk.match(/^\s*["']([a-z0-9_]+)["']/)?.[1];
      const module = chunk.match(/import\(\s*["'](\.\/[^"']+)["']\s*\)/)?.[1];
      if (name && module) modules.set(name, join(registerDir, module));
    }
  }
  if (agentIndexSrc) {
    for (const m of agentIndexSrc.matchAll(
      /["']?([a-z0-9_]+)["']?\s*:\s*\(\)\s*=>\s*import\(\s*["'](\.\/[^"']+)["']\s*\)/g,
    )) {
      if (!modules.has(m[1])) modules.set(m[1], join(agentDir, m[2]));
    }
  }
  return modules;
}

/** A module specifier resolved to a TypeScript file, or null. */
function resolveModuleFile(fromDir, spec) {
  const base = resolve(fromDir, spec);
  for (const candidate of [
    base.endsWith(".ts") ? base : `${base}.ts`,
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether the handler module, or a module it imports by a relative path, one
 * hop deep, references a role-gate primitive.
 */
export function handlerAssertsRole(handlerFile) {
  const src = readFileSync(handlerFile, "utf8");
  if (ROLE_ASSERTION_PATTERN.test(src)) return true;
  const dir = dirname(handlerFile);
  for (const m of src.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const file = resolveModuleFile(dir, m[1]);
    if (file && ROLE_ASSERTION_PATTERN.test(readFileSync(file, "utf8"))) {
      return true;
    }
  }
  return false;
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Scan the contracts directory (excluding `v2/`) and return every gap: a
 * contract that declares a role restriction whose handler exists but carries
 * no role-assertion call, outside `ROLE_ENFORCEMENT_BASELINE`. `checked` is
 * how many contracts declared a restriction and had a handler to read.
 */
export function findGaps({
  contractsDir = CONTRACTS_DIR,
  handlersDir = HANDLERS_DIR,
  agentHandlersDir = AGENT_HANDLERS_DIR,
  baseline = ROLE_ENFORCEMENT_BASELINE,
  exempt = ROLE_ENFORCEMENT_EXEMPT,
} = {}) {
  const modules = handlerModules({
    registerSrc: readIfExists(join(handlersDir, "register.ts")),
    registerDir: handlersDir,
    agentIndexSrc: readIfExists(join(agentHandlersDir, "index.ts")),
    agentDir: agentHandlersDir,
  });
  const gaps = [];
  const baselineHits = [];
  // Stems the baseline still lists but whose handler now carries a role
  // assertion (Codex P2 on #3487). Left in place, a stale entry is a live
  // hole: if the assertion is later deleted, the stem falls straight back into
  // `baselineHits` as a known gap instead of a new one, so the regression
  // never fails the build.
  const staleBaselineEntries = [];
  let checked = 0;

  for (const file of listContractFiles(contractsDir)) {
    const src = readFileSync(file, "utf8");
    if (/\bplatformOnly\s*:\s*true\b/.test(src)) continue;
    const agentRule = declaresAgentRoleRestriction(src);
    if (!agentRule && !declaresRoleRestriction(src)) continue;

    const stem = basename(file, ".ts");
    if (exempt.has(stem)) continue;
    const name = declaredCapabilityName(src) ?? "?";
    // An agent-surface contract is found by its registered name, so a handler
    // in packages/agent or under another file name is read too. The
    // high-sensitivity rule keeps the path it always read.
    const bound = agentRule ? modules.get(name) : undefined;
    const handlerPath =
      (bound && resolveModuleFile(dirname(bound), basename(bound))) ||
      join(handlersDir, `${stem}.ts`);
    if (!existsSync(handlerPath)) continue; // a different gap; check:manifest's job
    checked += 1;

    if (handlerAssertsRole(handlerPath)) {
      if (baseline.has(stem)) staleBaselineEntries.push({ stem, name });
      continue;
    }

    if (baseline.has(stem)) {
      baselineHits.push({ stem, name });
      continue;
    }
    gaps.push({
      stem,
      name,
      rule: agentRule ? "agent_surface" : "high_sensitivity",
      contractFile: file,
      handlerPath,
    });
  }

  return { gaps, baselineHits, staleBaselineEntries, checked };
}

function main() {
  if (!existsSync(CONTRACTS_DIR) || !existsSync(HANDLERS_DIR)) {
    console.error(
      `check-role-enforcement: expected both ${CONTRACTS_DIR} and ${HANDLERS_DIR} to exist. ` +
        "Run this from the monorepo root; if the layout genuinely changed, update the script " +
        "rather than let it pass vacuously.",
    );
    process.exit(2);
  }

  const { gaps, baselineHits, staleBaselineEntries, checked } = findGaps();

  if (baselineHits.length > 0) {
    console.log(
      `check-role-enforcement: ${baselineHits.length} known gap(s) tracked by #3258's follow-up ` +
        "(not failing the build):",
    );
    for (const g of baselineHits) console.log(`  - ${g.stem} -> ${g.name}`);
  }

  if (staleBaselineEntries.length > 0) {
    console.error(
      "\nSTALE ROLE_ENFORCEMENT_BASELINE ENTRIES: the handler now asserts the role " +
        "the contract declares, so the exception covers nothing. Left in place, it " +
        "would absorb a later regression (the assertion removed again) as a known gap " +
        "instead of failing the build:",
    );
    for (const g of staleBaselineEntries) {
      console.error(
        `  - ${g.stem} -> ${g.name} (remove from ROLE_ENFORCEMENT_BASELINE)`,
      );
    }
  }

  if (gaps.length > 0) {
    console.error(
      "\nROLE ENFORCEMENT GAPS: contracts whose defaultRoles restriction is not " +
        "enforced by their handler:",
    );
    for (const g of gaps) {
      console.error(
        `  - ${g.stem} -> ${g.name} [${g.rule}] (${g.handlerPath.replace(`${REPO_ROOT}/`, "")} ` +
          "has no assertContractRole/assertOrgRole/… call)",
      );
    }
    console.error(
      "\nFix: call assertContractRole(<contract>, ctx) first in the handler " +
        "(packages/handlers/src/lib/capability-role-guard.ts), or correct the " +
        "contract's defaultRoles to describe what the handler enforces. A deferred " +
        "fix goes in ROLE_ENFORCEMENT_BASELINE with a tracking issue, never silently.",
    );
  }

  if (gaps.length > 0 || staleBaselineEntries.length > 0) {
    process.exit(1);
  }

  console.log(
    `check-role-enforcement: ${checked} role-restricted contract(s) checked; ` +
      "no role-enforcement gap outside the baseline.",
  );
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(
      `check-role-enforcement: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }
}
