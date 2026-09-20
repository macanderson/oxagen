#!/usr/bin/env node
/**
 * check-role-enforcement.mjs — a contract that declares `sensitivity: "high"`
 * and a restrictive `defaultRoles` is a promise that only certain org/workspace
 * roles may call it. `checkIAM` fast-paths a non-enterprise org to an
 * unconditional allow for non-agent principals (CLAUDE.md "Gotchas"), so that
 * promise only holds when the handler asserts the role itself — and nothing
 * before this script checked that it does. #3258 found `create_connection`
 * declaring org Owner/Admin (and workspace Owner) while its handler asserted
 * nothing, so any member of a non-enterprise org — which, in production, is
 * every organization — could call it.
 *
 * A contract that says `defaultEffect: "deny"` while the runtime allows the
 * call on most tiers is worse than a capability with no declared restriction
 * at all: it reads as protected in review and is not.
 *
 * ## What this checks
 *
 * For every non-v2, non-test contract file under
 * `packages/oxagen/src/contracts/` that declares `sensitivity: "high"` and a
 * `defaultRoles` block, resolve the handler at
 * `packages/handlers/src/<contract-stem>.ts` (the naming convention every
 * contract/handler pair in this repo follows — AGENTS.md "Capability
 * System") and require it to reference one of the role-gate primitives:
 * `assertOrgRole`, `assertWorkspaceRole`, `assertOrgOrWorkspaceRole`,
 * `assertConsequenceRole`, `resolveActorOrgRole(s)`,
 * `resolveActorWorkspaceRole(s)`, `requireRole`, or `assertRole`. This is a
 * static, name-based check — it proves a role-aware call exists in the
 * handler, not that it is wired correctly; `pnpm gate`'s coverage
 * threshold and each handler's own tests are what prove that.
 *
 * v2 contracts (`packages/oxagen/src/contracts/v2/`) are excluded: several of
 * them (`defineTool`, not `registerCapability`) wrap an existing v1
 * capability's contract and dispatch through ITS handler and ITS name, so
 * there is no separate `packages/handlers/src/<v2-stem>.ts` to check — the
 * v1 file this script does check is where the enforcement has to live.
 *
 * ## The baseline
 *
 * #3258's audit found 27 more contracts with this shape, none of them
 * `create_connection` — too many to fix as one PR change (SCR-004: it needs a
 * maintainer decision per capability, whether the intended answer is "assert
 * the role" or "the contract over-declared and should relax"), so they are
 * named in `ROLE_ENFORCEMENT_BASELINE` below and reported as a warning
 * rather than a failure. Nothing may be ADDED to the baseline by this
 * script — it is a fixed, hand-maintained list — so the moment a NEW
 * contract takes on this shape, the check fails and names it, and the only
 * way past it is to add the role assertion (preferred) or correct the
 * contract's declared `sensitivity`/`defaultRoles` to what the handler
 * actually enforces. Removing a stem from the baseline is a strict subset
 * of "the gap was fixed" and needs no version bump; adding one back needs
 * the same one-line justification any exception here does.
 *
 * Exit codes:
 *   0 — no gap outside the baseline.
 *   1 — one or more contracts declare a role restriction their handler
 *       does not enforce, outside the baseline.
 *   2 — script error.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACTS_DIR = join(REPO_ROOT, "packages", "oxagen", "src", "contracts");
const HANDLERS_DIR = join(REPO_ROOT, "packages", "handlers", "src");

const ROLE_ASSERTION_PATTERN =
  /\bassertCallerRole\b|\bassertOrgRole\b|\bassertWorkspaceRole\b|\bassertOrgOrWorkspaceRole\b|\bassertConsequenceRole\b|\bresolveActorOrgRoles?\b|\bresolveActorWorkspaceRoles?\b|\brequireRole\b|\bassertRole\b/;

/**
 * Contracts already known to declare a role restriction their handler does
 * not enforce, tracked by #3258's follow-up rather than fixed in that PR
 * (each needs its own "assert the role, or relax the contract" decision).
 * A stem here is the contract file's basename without `.ts`.
 */
export const ROLE_ENFORCEMENT_BASELINE = new Set([
  "api.key.list",
  "api.key.rotate",
  "context.pr.merge",
  "integration.install",
  "org.create",
  "org.member.add",
  "org.member.remove",
  "org.member_role.change",
  "privacy.data.export",
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
 * Whether `src` declares `sensitivity: "high"` and a `defaultRoles` block —
 * the shape #3258 calls a declared role restriction. A quoted-string,
 * single-line match on `sensitivity` and a brace-balanced-enough regex on
 * `defaultRoles` (non-greedy up to the first `\n  },` at the block's own
 * indentation, the shape every contract in this repo uses) are deliberately
 * simple: this script proves a role-aware call exists in the handler, not
 * that the contract's TypeScript is well-formed, which `tsc` already does.
 */
export function declaresRoleRestriction(src) {
  if (!/sensitivity:\s*["']high["']/.test(src)) return false;
  return /defaultRoles:\s*\{[\s\S]*?\n\s*\},/.test(src);
}

/** The capability `name` a contract file registers, or null if none is found. */
export function declaredCapabilityName(src) {
  const m = src.match(/name:\s*["']([a-zA-Z0-9_]+)["']/);
  return m ? m[1] : null;
}

/**
 * Scan the contracts directory (excluding `v2/`) and return every gap: a
 * contract that declares a role restriction whose handler exists but carries
 * no role-assertion call, outside `ROLE_ENFORCEMENT_BASELINE`.
 */
export function findGaps({
  contractsDir = CONTRACTS_DIR,
  handlersDir = HANDLERS_DIR,
  baseline = ROLE_ENFORCEMENT_BASELINE,
} = {}) {
  const gaps = [];
  const baselineHits = [];
  // Stems the baseline still lists but whose handler now carries a role
  // assertion (Codex P2 on #3487): the early `continue` above would
  // otherwise let a fixed handler skip the baseline check entirely, so
  // nothing ever asks for the exception's removal. Left in place, that
  // stale entry is a live hole — if the assertion is later deleted (a
  // regression, not a fix), the stem falls straight back into
  // `baselineHits` as a "known, already-tracked" gap instead of a NEW one,
  // so the regression never fails the build.
  const staleBaselineEntries = [];

  for (const file of listContractFiles(contractsDir)) {
    const src = readFileSync(file, "utf8");
    if (!declaresRoleRestriction(src)) continue;

    const stem = basename(file, ".ts");
    const name = declaredCapabilityName(src) ?? "?";
    const handlerPath = join(handlersDir, `${stem}.ts`);
    if (!existsSync(handlerPath)) continue; // a different gap; check:manifest's job

    const handlerSrc = readFileSync(handlerPath, "utf8");
    if (ROLE_ASSERTION_PATTERN.test(handlerSrc)) {
      if (baseline.has(stem)) staleBaselineEntries.push({ stem, name });
      continue;
    }

    if (baseline.has(stem)) {
      baselineHits.push({ stem, name });
      continue;
    }
    gaps.push({ stem, name, contractFile: file, handlerPath });
  }

  return { gaps, baselineHits, staleBaselineEntries };
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

  const { gaps, baselineHits, staleBaselineEntries } = findGaps();

  if (baselineHits.length > 0) {
    console.log(
      `check-role-enforcement: ${baselineHits.length} known gap(s) tracked by #3258's follow-up ` +
        "(not failing the build):",
    );
    for (const g of baselineHits) console.log(`  - ${g.stem} -> ${g.name}`);
  }

  if (staleBaselineEntries.length > 0) {
    console.error(
      "\nSTALE ROLE_ENFORCEMENT_BASELINE ENTRIES — the handler now asserts the role " +
        "the contract declares, so the exception is no longer covering anything real. " +
        "Left in place, it would silently re-absorb a later regression (the assertion " +
        "removed again) as an already-known gap instead of failing the build:",
    );
    for (const g of staleBaselineEntries) {
      console.error(
        `  - ${g.stem} -> ${g.name} (remove from ROLE_ENFORCEMENT_BASELINE)`,
      );
    }
  }

  if (gaps.length > 0) {
    console.error(
      '\nROLE ENFORCEMENT GAPS — sensitivity: "high" contracts whose defaultRoles ' +
        "restriction is not enforced by their handler:",
    );
    for (const g of gaps) {
      console.error(
        `  - ${g.stem} -> ${g.name} (packages/handlers/src/${g.stem}.ts has no ` +
          "assertOrgRole/assertWorkspaceRole/… call)",
      );
    }
    console.error(
      "\nFix: add the role assertion the contract's defaultRoles declares (see " +
        "connection.create.ts / #3258 for the pattern), or correct the contract's " +
        "sensitivity/defaultRoles to describe what the handler actually enforces. " +
        "A genuinely deferred fix goes in tools/scripts/check-role-enforcement.mjs's " +
        "ROLE_ENFORCEMENT_BASELINE with a tracking issue, never silently.",
    );
  }

  if (gaps.length > 0 || staleBaselineEntries.length > 0) {
    process.exit(1);
  }

  console.log(
    "check-role-enforcement: no role-enforcement gap outside the baseline.",
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
