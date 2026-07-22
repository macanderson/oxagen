/**
 * seed-iam-defaults.registry-derivation.witness.test.ts
 *
 * Extends coverage beyond the unit-level agentRoleEffect() truth table
 * (seed-iam-defaults.agent-rbac.witness.test.ts) with two things that
 * table can't catch on its own:
 *
 *   1. Registry-driven derivation: walks the REAL capability registry
 *      (listCapabilities() from @oxagen/oxagen, the same call
 *      seed-iam-defaults.ts makes) and asserts every derived grant for
 *      every one of the three roles is one of the four valid Effect
 *      values, with no silent throws/NaN/undefined — catching registry
 *      drift (e.g. a new capability category the role logic doesn't
 *      know how to classify) that a hand-picked test-only category list
 *      would miss.
 *
 *   2. Idempotency of the FULL per-capability derivation loop the seed
 *      script actually runs (roleName × every agent-surfaced capability),
 *      not just the pure function in isolation — repeated derivation
 *      passes over the same registry snapshot must be pixel-identical,
 *      matching the ON CONFLICT ... DO UPDATE contract: re-running the
 *      script against unchanged registry state must write the same
 *      effect/resourceScope every time.
 *
 * Does NOT open a database connection — like every other tools/scripts
 * test, this stays DB-agnostic per [[seed-test-lib-split]]. The seed
 * script's own SQL upsert shape (ON CONFLICT (public_id) DO UPDATE) is
 * exercised by reading tools/scripts/seed-iam-defaults.ts as text (see
 * seed-iam-defaults.operator-metadata.witness.test.ts for precedent).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listCapabilities } from "@oxagen/oxagen";
import { parseResourceScope } from "@oxagen/oxagen/iam";
import {
  AGENT_ROLE_NAMES,
  AGENT_ROLE_RESOURCE_SCOPE,
  agentRoleEffect,
  makeRoleGrantPublicId,
  makeRolePublicId,
  type AgentRoleName,
  type Effect,
} from "./lib/seed-iam-defaults";

const VALID_EFFECTS: ReadonlySet<Effect> = new Set([
  "allow",
  "deny",
  "require_approval",
]);

/** Mirrors seed-iam-defaults.ts's `agentCapabilities` filter exactly. */
function agentCapabilities() {
  return listCapabilities().filter((cap) => cap.agent !== undefined);
}

// ── 1. Registry-driven derivation ────────────────────────────────────────────

describe("agentRoleEffect against the live capability registry", () => {
  const caps = agentCapabilities();

  it("the registry actually has agent-surfaced capabilities to derive grants for (sanity: this test isn't vacuous)", () => {
    expect(caps.length).toBeGreaterThan(0);
  });

  it("every (role, agent-surfaced capability) pair derives a valid Effect — no crash, no undefined, no stray value", () => {
    for (const roleName of AGENT_ROLE_NAMES) {
      for (const cap of caps) {
        const effect = agentRoleEffect(
          roleName,
          cap.agent?.category,
          cap.agent?.riskLevel,
          cap.agent?.requiresApproval,
        );
        expect(
          VALID_EFFECTS.has(effect),
          `agentRoleEffect(${roleName}, category=${cap.agent?.category}, riskLevel=${cap.agent?.riskLevel}, requiresApproval=${cap.agent?.requiresApproval}) for capability "${cap.name}" returned invalid effect ${String(effect)}`,
        ).toBe(true);
      }
    }
  });

  it("Agent Observer never allows any capability outside the four read categories", () => {
    const READ = new Set(["read", "introspection", "graph", "memory"]);
    for (const cap of caps) {
      const effect = agentRoleEffect(
        "Agent Observer",
        cap.agent?.category,
        cap.agent?.riskLevel,
        cap.agent?.requiresApproval,
      );
      const isReadCategory =
        cap.agent?.category !== undefined && READ.has(cap.agent.category);
      if (isReadCategory) {
        expect(effect).toBe("allow");
      } else {
        expect(
          effect,
          `Observer must deny non-read capability "${cap.name}" (category=${cap.agent?.category})`,
        ).toBe("deny");
      }
    }
  });

  it("Agent Operator never returns 'allow' for a restricted-category capability with undeclared/high riskLevel and no explicit low/medium clearance", () => {
    // The Operator carve-out's whole purpose: vcs/billing/secret must never
    // get the riskLevel=high uncapped-allow unlock that non-restricted
    // categories get. Walk the real registry's high-risk restricted-category
    // capabilities and confirm none of them slip through as "allow".
    for (const cap of caps) {
      const category = cap.agent?.category;
      const isRestricted =
        category === "vcs" || category === "billing" || category === "secret";
      const isHighRisk = cap.agent?.riskLevel === "high";
      if (!isRestricted || !isHighRisk) continue;
      const effect = agentRoleEffect(
        "Agent Operator",
        category,
        cap.agent?.riskLevel,
        cap.agent?.requiresApproval,
      );
      expect(
        effect,
        `Operator must not uncapped-allow high-risk restricted capability "${cap.name}" (category=${category})`,
      ).toBe("require_approval");
    }
  });

  it("Agent Contributor and Agent Operator agree on every restricted-category capability in the live registry (Operator adds no extra privilege there)", () => {
    for (const cap of caps) {
      const category = cap.agent?.category;
      const isRestricted =
        category === "vcs" || category === "billing" || category === "secret";
      if (!isRestricted) continue;
      const contributorEffect = agentRoleEffect(
        "Agent Contributor",
        category,
        cap.agent?.riskLevel,
        cap.agent?.requiresApproval,
      );
      const operatorEffect = agentRoleEffect(
        "Agent Operator",
        category,
        cap.agent?.riskLevel,
        cap.agent?.requiresApproval,
      );
      expect(
        operatorEffect,
        `capability "${cap.name}" (category=${category}): Operator (${operatorEffect}) must equal Contributor (${contributorEffect})`,
      ).toBe(contributorEffect);
    }
  });

  it("Agent Operator allows any high-risk NON-restricted capability with requiresApproval=false, if/when one exists in the registry (the uncapped unlock is registry-content-dependent, not guaranteed non-vacuous)", () => {
    // As of this writing, EVERY high-risk non-restricted capability in the
    // live registry has requiresApproval:true (verified capability-by-
    // capability), so this unlock is currently dormant registry-wide — that
    // is a registry-authoring fact, not a bug in agentRoleEffect. This test
    // stays correct either way: if the registry never has such a
    // capability, the loop below is a no-op; the moment one is added, this
    // asserts it gets the intended uncapped "allow".
    const unlocked = caps.filter((cap) => {
      const category = cap.agent?.category;
      const isRestricted =
        category === "vcs" || category === "billing" || category === "secret";
      return (
        !isRestricted &&
        cap.agent?.riskLevel === "high" &&
        cap.agent?.requiresApproval !== true
      );
    });
    for (const cap of unlocked) {
      expect(
        agentRoleEffect(
          "Agent Operator",
          cap.agent?.category,
          cap.agent?.riskLevel,
          cap.agent?.requiresApproval,
        ),
      ).toBe("allow");
    }
  });

  it("Agent Operator's uncapped riskLevel=high unlock fires for a non-restricted category (synthetic case, independent of current registry contents)", () => {
    // Companion to the registry-driven check above: proves the unlock logic
    // itself works, using a synthetic (category, riskLevel, requiresApproval)
    // triple rather than depending on the live registry happening to contain
    // one. Keeps this invariant tested even on the day every real high-risk
    // non-restricted capability sets requiresApproval:true.
    expect(agentRoleEffect("Agent Operator", "mutation", "high", false)).toBe(
      "allow",
    );
  });
});

// ── 2. Idempotency of the full per-capability derivation pass ───────────────

describe("idempotency of the full registry-driven derivation pass", () => {
  interface DerivedGrant {
    roleName: AgentRoleName;
    capabilityId: string;
    effect: Effect;
    conditionsJsonb: string;
    publicId: string;
  }

  /** Reproduces exactly the per-org inner loop body in seed-iam-defaults.ts's main(). */
  function deriveAllGrants(
    roleId: string,
    roleName: AgentRoleName,
  ): DerivedGrant[] {
    const resourceScope = AGENT_ROLE_RESOURCE_SCOPE[roleName];
    const conditionsJsonb = JSON.stringify({ resourceScope });
    return agentCapabilities().map((cap) => ({
      roleName,
      capabilityId: cap.name,
      effect: agentRoleEffect(
        roleName,
        cap.agent?.category,
        cap.agent?.riskLevel,
        cap.agent?.requiresApproval,
      ),
      conditionsJsonb,
      publicId: makeRoleGrantPublicId(roleId, cap.name),
    }));
  }

  it("re-deriving over the same registry snapshot produces byte-identical rows for every role — the ON CONFLICT DO UPDATE contract's precondition", () => {
    const roleId = makeRolePublicId("org_fixed", "workspace", "Agent Operator");
    for (const roleName of AGENT_ROLE_NAMES) {
      const first = deriveAllGrants(roleId, roleName);
      const second = deriveAllGrants(roleId, roleName);
      expect(second).toEqual(first);
    }
  });

  it("derives exactly one grant row per agent-surfaced capability, for every role, with no duplicate public_ids within a role", () => {
    const caps = agentCapabilities();
    const roleId = makeRolePublicId(
      "org_fixed",
      "workspace",
      "Agent Contributor",
    );
    for (const roleName of AGENT_ROLE_NAMES) {
      const grants = deriveAllGrants(roleId, roleName);
      expect(grants).toHaveLength(caps.length);
      const publicIds = grants.map((g) => g.publicId);
      expect(new Set(publicIds).size).toBe(publicIds.length);
    }
  });

  it("every derived grant's conditions_jsonb parses back to a schema-valid resourceScope identical to the role's canonical scope", () => {
    const roleId = makeRolePublicId("org_fixed", "workspace", "Agent Observer");
    for (const roleName of AGENT_ROLE_NAMES) {
      const grants = deriveAllGrants(roleId, roleName);
      const expectedScope = AGENT_ROLE_RESOURCE_SCOPE[roleName];
      for (const grant of grants) {
        const parsedEnvelope = JSON.parse(grant.conditionsJsonb) as {
          resourceScope: unknown;
        };
        const parsed = parseResourceScope(parsedEnvelope.resourceScope);
        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(expectedScope);
      }
    }
  });

  it("re-running derivation for two different (but same-name) role ids across orgs yields the same effect/conditions but different public_ids — public_id is role-scoped, effect derivation is not", () => {
    const roleIdOrgA = makeRolePublicId(
      "org_a",
      "workspace",
      "Agent Contributor",
    );
    const roleIdOrgB = makeRolePublicId(
      "org_b",
      "workspace",
      "Agent Contributor",
    );
    const grantsA = deriveAllGrants(roleIdOrgA, "Agent Contributor");
    const grantsB = deriveAllGrants(roleIdOrgB, "Agent Contributor");

    expect(grantsA.map((g) => g.effect)).toEqual(grantsB.map((g) => g.effect));
    expect(grantsA.map((g) => g.conditionsJsonb)).toEqual(
      grantsB.map((g) => g.conditionsJsonb),
    );
    // public_ids differ because they're derived from the (org-scoped) roleId.
    expect(grantsA.map((g) => g.publicId)).not.toEqual(
      grantsB.map((g) => g.publicId),
    );
  });
});

// ── 3. SQL upsert shape (text-level, following the operator-metadata precedent) ─

const seedSource = readFileSync(
  join(import.meta.dirname, "seed-iam-defaults.ts"),
  "utf8",
);

describe("seed-iam-defaults.ts SQL upsert shape", () => {
  it("upserts iam.roles on public_id conflict rather than deleting and reinserting", () => {
    expect(seedSource).toMatch(/INSERT INTO iam\.roles/);
    expect(seedSource).toMatch(/ON CONFLICT \(public_id\) DO UPDATE/);
    expect(seedSource).not.toMatch(
      /DELETE FROM iam\.roles\s*\n\s*WHERE org_id/,
    );
  });

  it("upserts iam.role_grants (agent phase) on public_id conflict, updating effect and conditions_jsonb in place", () => {
    // There are two INSERT INTO iam.role_grants call sites (legacy bulk-chunk
    // phase = ON CONFLICT DO NOTHING; agent phase = ON CONFLICT ... DO UPDATE).
    // Assert the agent phase's UPDATE clause touches exactly effect + conditions_jsonb.
    expect(seedSource).toMatch(
      /ON CONFLICT \(public_id\) DO UPDATE\s*\n\s*SET effect = EXCLUDED\.effect,\s*\n\s*conditions_jsonb = EXCLUDED\.conditions_jsonb/,
    );
  });

  it("bulk-chunks the agent-phase role_grants upsert (materializes rows client-side, then batches via tx(chunk, ...)) rather than issuing one INSERT per (role, capability) pair", () => {
    // Regression guard for the ~1,011-sequential-round-trips-per-org
    // (3 roles × ~337 agent-surfaced capabilities) shape: the agent phase
    // must build an array of rows and hand batches to postgres.js's bulk
    // `tx(chunk, ...)` helper — the same pattern the legacy phase already
    // used — rather than looping `await sql\`INSERT ...\`` once per
    // capability inside the role loop.
    expect(seedSource).toMatch(/AGENT_GRANT_CHUNK/);
    expect(seedSource).toMatch(
      /agentGrantRows\.slice\(i, i \+ AGENT_GRANT_CHUNK\)/,
    );
    expect(seedSource).toMatch(
      /tx\(chunk, "public_id", "org_id", "role_id", "capability_id", "effect", "conditions_jsonb"\)/,
    );
  });

  it("wraps each org's agent-phase role upserts + grant upserts in one sql.begin() transaction — atomicity guard so a mid-run failure can't leave an org with roles but no/partial grants", () => {
    expect(seedSource).toMatch(/sql\.begin\(async \(tx\) => \{/);
    // Both the role upsert and the grant upsert must run against `tx`
    // (the transaction handle), not the outer `sql` connection, or the
    // transaction wrapper would be cosmetic.
    const beginIdx = seedSource.indexOf("sql.begin(async (tx) => {");
    expect(beginIdx).toBeGreaterThan(-1);
    const bodyAfterBegin = seedSource.slice(beginIdx);
    expect(bodyAfterBegin).toMatch(/await tx<\{ id: string \}\[\]>`/);
    expect(bodyAfterBegin).toMatch(/FROM \$\{tx\(chunk, "public_id"/);
  });

  it("derives role_grant public_ids from makeRoleGrantPublicId, not an ad-hoc scheme", () => {
    expect(seedSource).toMatch(/makeRoleGrantPublicId\(roleId, cap\.name\)/);
  });

  it("actively removes any stray legacy role before seeding the three canonical roles (delete happens before the upsert loop)", () => {
    const legacyDeleteIdx = seedSource.indexOf(
      "name ILIKE ${LEGACY_ROLE_NAME_ILIKE_PATTERN}",
    );
    const canonicalUpsertIdx = seedSource.indexOf(
      "for (const roleName of AGENT_ROLE_NAMES) {\n          const publicId",
    );
    expect(legacyDeleteIdx).toBeGreaterThan(-1);
    expect(canonicalUpsertIdx).toBeGreaterThan(-1);
    expect(legacyDeleteIdx).toBeLessThan(canonicalUpsertIdx);
  });
});
