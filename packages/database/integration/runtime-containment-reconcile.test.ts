/**
 * `20260930120700_runtime_containment_reconcile.sql`, applied to placements
 * written before, during, and after the #4437 deploy window (ADR-204 §4,
 * amendment of 2026-09-30, #4474).
 *
 * CI migrates this database before the suite runs, so the migration has
 * already run once against no fixture. Each test seeds one organization's
 * runtimes, agents, agent versions, host enrollments, and security events
 * inside one transaction, applies the migration file as written, reads the
 * result, and rolls everything back. The migration is read from its file, so a
 * change to it is a change to what these tests apply.
 *
 * Every seeded state is one the code could write. A move writes the agent's
 * next version the way writeAgentVersion does (packages/handlers/src/lib/
 * runtimes.ts), and an owner's choice writes the security event
 * update_runtime writes.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database exec vitest run --config vitest.integration.config.ts integration/runtime-containment-reconcile.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

/** The notices the connection receives. The migration reports its count in one. */
const notices: string[] = [];

// A JSON value is bound as text and cast in SQL (`${JSON.stringify(x)}::text::jsonb`).
// Bound straight to `::jsonb`, the parameter takes the jsonb type, and postgres.js
// serializes it with JSON.stringify a second time, so the row holds a JSON
// string where the migration reads an object.
const sql = postgres(process.env["DATABASE_URL"]!, {
  max: 1,
  prepare: false,
  onnotice: (notice) => {
    notices.push(String(notice.message));
  },
});
afterAll(() => sql.end({ timeout: 5 }));
beforeEach(() => {
  notices.length = 0;
});

type Tx = postgres.TransactionSql;

const MIGRATION = readFileSync(
  new URL(
    "../atlas/migrations/20260930120700_runtime_containment_reconcile.sql",
    import.meta.url,
  ),
  "utf8",
);

const ORG = "00000000-0000-0000-0061-000000000001";
const WS = "00000000-0000-0000-0062-000000000001";
const USER = "00000000-0000-0000-0065-000000000001";

/** When ADR-198's migration wrote each legacy agent's first version. */
const LEGACY = "2026-09-26T02:00:00Z";
/** Before the window: the backfill ran at 08:09 UTC. */
const BEFORE = "2026-09-27T07:00:00Z";
/** In the window, while the old code still served. */
const DURING = "2026-09-27T08:20:00Z";
/** After the window, once the new code served everywhere. */
const AFTER = "2026-09-28T12:00:00Z";
const LATER = "2026-09-29T12:00:00Z";

/** The legacy config ADR-198 copied from a definition file that required containment. */
const REQUIRES = { containment: { required: true } };

async function seedRuntime(
  tx: Tx,
  slug: string,
  containmentRequired = false,
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    INSERT INTO agent.runtimes
      (public_id, org_id, workspace_id, name, slug, containment_required)
    VALUES
      (${`rtm_rcn_${slug}`}, ${ORG}, ${WS}, ${slug}, ${slug}, ${containmentRequired})
    RETURNING id
  `;
  if (!row) throw new Error(`runtime ${slug} was not written`);
  return row.id;
}

/**
 * An agent on no runtime with one legacy version, the shape ADR-198's
 * migration left an agent it could not place.
 */
async function seedAgent(
  tx: Tx,
  slug: string,
  config: Record<string, unknown>,
): Promise<string> {
  const [agent] = await tx<{ id: string }[]>`
    INSERT INTO agent.agents
      (public_id, org_id, workspace_id, slug, name, agent_type, status)
    VALUES
      (${`agt_rcn_${slug}`}, ${ORG}, ${WS}, ${slug}, ${slug}, 'custom', 'active')
    RETURNING id
  `;
  if (!agent) throw new Error(`agent ${slug} was not written`);
  const [version] = await tx<{ id: string }[]>`
    INSERT INTO agent.agent_versions
      (agent_id, version, is_published, config, created_by_id, created_at, change_kind)
    VALUES
      (${agent.id}, 1, true, ${JSON.stringify(config)}::text::jsonb, ${USER}, ${LEGACY}, 'legacy')
    RETURNING id
  `;
  if (!version) throw new Error(`agent ${slug} got no version`);
  await tx`
    UPDATE agent.agents SET active_version_id = ${version.id} WHERE id = ${agent.id}
  `;
  return agent.id;
}

/**
 * The agent's next version, written the way writeAgentVersion writes it: the
 * active version's config copied, the runtime and the change kind named, and
 * the agent pointed at the new version and runtime.
 */
async function writeVersion(
  tx: Tx,
  agentId: string,
  runtimeId: string,
  changeKind: "runtime_changed" | "toolbelt_changed",
  at: string,
): Promise<void> {
  const [written] = await tx<{ id: string }[]>`
    INSERT INTO agent.agent_versions
      (agent_id, version, is_published, config, created_by_id, created_at, runtime_id, change_kind)
    SELECT
      a.id,
      (SELECT coalesce(max(v.version), 0) + 1 FROM agent.agent_versions AS v WHERE v.agent_id = a.id),
      true,
      coalesce(active.config, '{}'::jsonb),
      ${USER}::uuid,
      ${at}::timestamptz,
      ${runtimeId}::uuid,
      ${changeKind}::text
    FROM agent.agents AS a
    LEFT JOIN agent.agent_versions AS active ON active.id = a.active_version_id
    WHERE a.id = ${agentId}
    RETURNING id
  `;
  if (!written) throw new Error(`agent ${agentId} got no version`);
  await tx`
    UPDATE agent.agents
       SET active_version_id = ${written.id}, runtime_id = ${runtimeId}
     WHERE id = ${agentId}
  `;
}

/** move_agent: the agent's next version names the runtime. */
async function moveAgent(
  tx: Tx,
  agentId: string,
  runtimeId: string,
  at: string,
): Promise<void> {
  await writeVersion(tx, agentId, runtimeId, "runtime_changed", at);
}

/** One host enrollment of the agent, bound to the runtime. */
async function enrollHost(
  tx: Tx,
  agentId: string,
  agentKey: string,
  runtimeId: string,
  at: string,
  revokedAt: string | null,
): Promise<void> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 22);
  await tx`
    INSERT INTO tacho.hosts
      (public_id, org_id, workspace_id, agent_key, agent_id, api_key_id, runtime_id,
       hostname, hostname_digest, platform, os_user, os_user_digest,
       device_public_key, device_key_fingerprint, enrollment_claims,
       enrollment_signature, expires_at, status, revoked_at, created_at, updated_at)
    VALUES
      (${`tch_${suffix}`}, ${ORG}, ${WS}, ${agentKey}, ${agentId}, ${randomUUID()}, ${runtimeId},
       ${`host-${suffix}`}, ${`digest-${suffix}`}, 'linux', 'dev', 'dev-digest',
       ${`ed25519:${suffix}`}, ${`fp-${suffix}`}, '{}'::jsonb,
       'signature', '2027-01-01T00:00:00Z',
       ${revokedAt === null ? "active" : "revoked"}, ${revokedAt}, ${at}, ${at})
  `;
}

/** update_runtime's security event for a containment change. */
async function ownerSetsContainment(
  tx: Tx,
  runtimeId: string,
  enabled: boolean,
  at: string,
): Promise<void> {
  const [runtime] = await tx<{ public_id: string }[]>`
    SELECT public_id FROM agent.runtimes WHERE id = ${runtimeId}
  `;
  if (!runtime) throw new Error(`runtime ${runtimeId} is missing`);
  await tx`
    UPDATE agent.runtimes
       SET containment_required = ${enabled}, updated_at = ${at}, updated_by_id = ${USER}
     WHERE id = ${runtimeId}
  `;
  const detail = {
    feature: "runtime_containment",
    change: "containment_required",
    runtimeId: runtime.public_id,
    previous: !enabled,
    enabled,
    reason: null,
  };
  await tx`
    INSERT INTO security.security_events
      (occurred_at, event_type, actor_user_id, org_id, workspace_id, capability, outcome, detail)
    VALUES
      (${at}, 'capability.invoke_allowed', ${USER}, ${ORG}, ${WS}, 'update_runtime', 'success',
       ${JSON.stringify(detail)}::text::jsonb)
  `;
}

/**
 * The fixture, one runtime per case. The comment on each names the write and
 * what the reconcile does with it.
 */
async function seedFixture(tx: Tx): Promise<void> {
  // Moved onto the runtime by the old move_agent in the window: switches.
  {
    const runtime = await seedRuntime(tx, "moved-during");
    const agent = await seedAgent(tx, "rcn-moved-during", REQUIRES);
    await moveAgent(tx, agent, runtime, DURING);
  }
  // Moved in the window, and its toolbelt changed after. The move is still
  // the latest placement: switches.
  {
    const runtime = await seedRuntime(tx, "moved-then-belt");
    const agent = await seedAgent(tx, "rcn-moved-belt", REQUIRES);
    await moveAgent(tx, agent, runtime, DURING);
    await writeVersion(tx, agent, runtime, "toolbelt_changed", AFTER);
  }
  // Moved by the new code, which leaves containment to the runtime: stays off.
  {
    const runtime = await seedRuntime(tx, "moved-after");
    const agent = await seedAgent(tx, "rcn-moved-after", REQUIRES);
    await moveAgent(tx, agent, runtime, AFTER);
  }
  // Moved in the window, then away and back by the new code. The latest
  // placement is the new code's: both runtimes stay off.
  {
    const runtime = await seedRuntime(tx, "moved-back");
    const other = await seedRuntime(tx, "moved-between");
    const agent = await seedAgent(tx, "rcn-moved-back", REQUIRES);
    await moveAgent(tx, agent, runtime, DURING);
    await moveAgent(tx, agent, other, AFTER);
    await moveAgent(tx, agent, runtime, LATER);
  }
  // Moved in the window, and an owner turned containment off with
  // update_runtime after: stays off.
  {
    const runtime = await seedRuntime(tx, "owner-off");
    const agent = await seedAgent(tx, "rcn-owner-off", REQUIRES);
    await moveAgent(tx, agent, runtime, DURING);
    await ownerSetsContainment(tx, runtime, true, AFTER);
    await ownerSetsContainment(tx, runtime, false, LATER);
  }
  // Moved in the window, but its version never required containment: stays off.
  {
    const runtime = await seedRuntime(tx, "not-required");
    const agent = await seedAgent(tx, "rcn-not-required", {});
    await moveAgent(tx, agent, runtime, DURING);
  }
  // Moved in the window, then retired. retire_agent archives the agent and
  // keeps its runtime_id: stays off.
  {
    const runtime = await seedRuntime(tx, "retired");
    const agent = await seedAgent(tx, "rcn-retired", REQUIRES);
    await moveAgent(tx, agent, runtime, DURING);
    await tx`UPDATE agent.agents SET status = 'archived' WHERE id = ${agent}`;
  }
  // Already on, with a placement in the window: stays on and is not counted.
  {
    const runtime = await seedRuntime(tx, "already-on", true);
    const agent = await seedAgent(tx, "rcn-already-on", REQUIRES);
    await moveAgent(tx, agent, runtime, DURING);
  }
  // An agent on no runtime, first enrolled here by the old code in the
  // window, and still enrolled: switches.
  {
    const runtime = await seedRuntime(tx, "enrolled-during");
    const agent = await seedAgent(tx, "rcn-enrolled", REQUIRES);
    await enrollHost(tx, agent, "rcn.ws.enrolled", runtime, DURING, null);
  }
  // First enrolled in the window, revoked, and enrolled again by the new code.
  // The window's host spent the carry, so the new code carried nothing:
  // switches.
  {
    const runtime = await seedRuntime(tx, "re-enrolled");
    const agent = await seedAgent(tx, "rcn-re-enrolled", REQUIRES);
    await enrollHost(tx, agent, "rcn.ws.re-enrolled", runtime, DURING, AFTER);
    await enrollHost(tx, agent, "rcn.ws.re-enrolled", runtime, AFTER, null);
  }
  // First enrolled before the backfill and revoked before it ran, then
  // enrolled again in the window. That is the gap ADR-204 §4 records, not the
  // window's: stays off.
  {
    const runtime = await seedRuntime(tx, "gap-before");
    const agent = await seedAgent(tx, "rcn-gap-before", REQUIRES);
    await enrollHost(tx, agent, "rcn.ws.gap-before", runtime, BEFORE, BEFORE);
    await enrollHost(tx, agent, "rcn.ws.gap-before", runtime, DURING, null);
  }
  // Enrolled in the window and revoked since, with no live host left. The
  // agent is not on the runtime any more: stays off.
  {
    const runtime = await seedRuntime(tx, "host-revoked");
    const agent = await seedAgent(tx, "rcn-host-revoked", REQUIRES);
    await enrollHost(tx, agent, "rcn.ws.host-revoked", runtime, DURING, AFTER);
  }
}

/** Each fixture runtime's slug and whether it requires containment after the apply. */
const EXPECTED: Record<string, boolean> = {
  "already-on": true,
  "enrolled-during": true,
  "gap-before": false,
  "host-revoked": false,
  "moved-after": false,
  "moved-back": false,
  "moved-between": false,
  "moved-during": true,
  "moved-then-belt": true,
  "not-required": false,
  "owner-off": false,
  "re-enrolled": true,
  retired: false,
};

/** The notice the first apply raises: four runtimes switch, two of them with a live host. */
const FIRST_NOTICE =
  "runtime_containment_reconcile: 4 runtime(s) now require containment, with 2 live host(s) on them";

async function containmentBySlug(tx: Tx): Promise<Record<string, boolean>> {
  const rows = await tx<{ slug: string; containment_required: boolean }[]>`
    SELECT slug::text AS slug, containment_required
      FROM agent.runtimes
     WHERE org_id = ${ORG}
     ORDER BY slug
  `;
  return Object.fromEntries(rows.map((row) => [row.slug, row.containment_required]));
}

/** Applies the migration file and turns the bypass back on for the reads after it. */
async function applyMigration(tx: Tx): Promise<void> {
  await tx.unsafe(MIGRATION);
  await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
}

/**
 * Runs `body` against the fixture inside one transaction, after one apply,
 * then rolls the transaction back.
 */
async function withReconciledFixture(body: (tx: Tx) => Promise<void>): Promise<void> {
  const rollback = new Error("roll back the containment reconcile fixture");
  await expect(
    sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      await seedFixture(tx);
      await applyMigration(tx);
      await body(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

describe("20260930120700: containment for placements written during the #4437 deploy", () => {
  it("turns containment on only where the window's placement left it off", async () => {
    await withReconciledFixture(async (tx) => {
      expect(await containmentBySlug(tx)).toEqual(EXPECTED);
    });
  });

  // The count covers the whole database. Only this fixture holds placements
  // stamped inside the 2026-09-27 window, so the count is the fixture's.
  it("reports how many runtimes it switched and how many live hosts sit on them", async () => {
    await withReconciledFixture(async () => {
      expect(notices).toContain(FIRST_NOTICE);
    });
  });

  it("switches nothing on a second run", async () => {
    await withReconciledFixture(async (tx) => {
      const before = await containmentBySlug(tx);
      notices.length = 0;
      await applyMigration(tx);
      expect(await containmentBySlug(tx)).toEqual(before);
      expect(notices).toContain(
        "runtime_containment_reconcile: 0 runtime(s) now require containment, with 0 live host(s) on them",
      );
    });
  });
});
