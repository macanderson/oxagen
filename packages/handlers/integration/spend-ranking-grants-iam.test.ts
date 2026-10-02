/**
 * An Enterprise Admin can call the operator ranking after the backfill
 * (#4574 item 4), against a real Postgres.
 *
 * packages/database/integration/spend-ranking-grants-backfill.test.ts proves
 * the rows 20261002045000_backfill_spend_ranking_grants.sql writes, and that
 * an org's explicit deny survives it. This file proves what those rows do:
 * the kernel's own IAM check, `checkIAM`, run inside the tenant scope the
 * kernel opens, against an Enterprise org whose system roles were provisioned
 * before get_operator_ranking and set_operator_pseudonyms existed.
 *
 *   - before the replay, the org Admin is refused both by the contracts'
 *     default deny;
 *   - after it, the org Admin is allowed both by its role grant;
 *   - an org Member is refused both before and after.
 *
 * Only the audit write is stubbed: this job runs no ClickHouse, and the audit
 * row is a side effect none of these answers depends on. The tier read, the
 * role read, and the resolver are the real ones.
 *
 * The replay commits, because checkIAM reads through its own connection. It
 * is the migration CI already applied, so it adds rows only for system roles
 * created since: this org's, and any another integration file left behind.
 *
 * CI: rls-integration job, "SCIM deprovision proof" step, which runs every
 * file in this directory. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/handlers exec vitest run --config vitest.integration.config.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type SQL, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertAuditEvent: vi.fn(async () => undefined),
    latestAuditChainHash: vi.fn(async () => ""),
    captureError: vi.fn(),
  };
});

import { withSystemDb } from "@oxagen/database";
// The barrel registers every contract, so each default effect below is the
// one the contract declares.
import { getCapability, type CapabilityContext } from "@oxagen/oxagen";
import { checkIAM } from "@oxagen/iam/check-iam";
import { runInTenantScope } from "@oxagen/tenancy";

const RANKING = "get_operator_ranking";
const PSEUDONYMS = "set_operator_pseudonyms";

/** One statement through the system seam, which bypasses RLS. */
async function q(statement: SQL): Promise<void> {
  await withSystemDb((tx) => tx.execute(statement));
}

/**
 * Replay the migration in one transaction, one statement at a time, as Atlas
 * applies it. Comment lines go first, because one of them holds a semicolon.
 */
async function replayBackfill(): Promise<void> {
  const file = readFileSync(
    new URL(
      "../../database/atlas/migrations/20261002045000_backfill_spend_ranking_grants.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const statements = file
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  expect(statements).toHaveLength(2);
  await withSystemDb(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
}

const RUN = randomBytes(2).toString("hex");
const ORG = randomUUID();
const WS = randomUUID();
const ADMIN = randomUUID();
const MEMBER = randomUUID();

/** A person in the org who holds one system org role. */
async function person(userId: string, role: string, roleId: string) {
  const principalId = randomUUID();
  await q(sql`
    INSERT INTO auth.users (id, public_id, email, status, email_verified)
    VALUES (${userId}, ${`usr_${RUN}${role}`}, ${`${role}-${RUN}@ranking.test`}, 'active', true)
  `);
  await q(sql`
    INSERT INTO iam.principals (id, public_id, org_id, kind, display_name, status, parent_user_id)
    VALUES (${principalId}, ${`prn_${RUN}${role}`}, ${ORG}, 'human', ${role}, 'active', ${userId})
  `);
  await q(sql`
    INSERT INTO iam.principal_role_assignments (public_id, principal_id, role_id, org_id, workspace_id)
    VALUES (${`pra_${RUN}${role}`}, ${principalId}, ${roleId}, ${ORG}, NULL)
  `);
}

/** The kernel's IAM answer for `userId` calling `capability` in this org. */
async function decide(userId: string, capability: string) {
  const contract = getCapability(capability);
  if (!contract) throw new Error(`${capability} is not registered`);
  const ctx: CapabilityContext = {
    orgId: ORG,
    workspaceId: WS,
    userId,
    apiKeyId: null,
    requestId: `req_${RUN}`,
    surface: "api",
    messageId: null,
  };
  const { result } = await runInTenantScope(
    { orgId: ORG, workspaceId: WS },
    () =>
      checkIAM({
        capability,
        ctx,
        defaultEffect: contract.defaultEffect,
        rawInputJson: "{}",
      }),
  );
  return {
    outcome: result.outcome,
    rule: result.trace.decidedBy.rule,
  };
}

beforeAll(async () => {
  await q(sql`
    INSERT INTO org.organizations (id, public_id, name, slug, namespace, plan_type, status, type)
    VALUES (${ORG}, ${`rk_org_${RUN}`}, 'Ranking Org', ${`rk-org-${RUN}`}, ${`k${RUN}`}, 'enterprise', 'active', 'business')
  `);
  await q(sql`
    INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
    VALUES (${WS}, ${`rk_ws_${RUN}`}, ${ORG}, 'Ranking WS', ${`rk-ws-${RUN}`}, ${`v${RUN}`})
  `);
  const adminRole = randomUUID();
  const memberRole = randomUUID();
  // The system roles as an org provisioned before #4541 holds them: no grant
  // on either ranking capability.
  await q(sql`
    INSERT INTO iam.roles (id, public_id, org_id, scope_kind, name, is_system_default)
    VALUES
      (${adminRole}, ${`rol_${RUN}admin`}, ${ORG}, 'org', 'Admin', true),
      (${memberRole}, ${`rol_${RUN}member`}, ${ORG}, 'org', 'Member', true)
  `);
  await person(ADMIN, "admin", adminRole);
  await person(MEMBER, "member", memberRole);
});

describe("#4574: the ranking grants backfill, through the kernel's IAM check", () => {
  it("lets an Enterprise Admin call both ranking capabilities once the backfill runs", async () => {
    // Before: no grant, so the contracts' default deny decides.
    for (const capability of [RANKING, PSEUDONYMS]) {
      await expect(decide(ADMIN, capability)).resolves.toEqual({
        outcome: "deny",
        rule: "8:default",
      });
    }

    await replayBackfill();

    for (const capability of [RANKING, PSEUDONYMS]) {
      await expect(decide(ADMIN, capability)).resolves.toEqual({
        outcome: "allow",
        rule: "7:role_grant",
      });
    }
  });

  it("still refuses an Enterprise Member both ranking capabilities (negative)", async () => {
    await replayBackfill();
    for (const capability of [RANKING, PSEUDONYMS]) {
      await expect(decide(MEMBER, capability)).resolves.toEqual({
        outcome: "deny",
        rule: "8:default",
      });
    }
  });
});
