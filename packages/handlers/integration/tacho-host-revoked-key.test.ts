/**
 * A revoked Tacho host's retired key, resolved against a real Postgres
 * (#3944, S-04).
 *
 * Revoking a host deletes its keys, and `resolveApiKey` answers
 * `host_revoked` for a deleted key only when a revoked host in the key's own
 * organization names it. The SCIM proof (scim-deprovision.test.ts) covers a
 * host key and a gateway key whose scope records the enrollment. This file
 * covers the rest of the predicate: a legacy key with no scope, named only by
 * the host's `api_key_id`; a host that is not revoked; and a revoked host in
 * another organization.
 *
 * CI: rls-integration job, "SCIM deprovision proof" step, which runs every
 * file in this directory. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/handlers exec vitest run --config vitest.integration.config.ts
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystemDb } from "@oxagen/database";
import { resolveApiKey } from "@oxagen/auth/resolvers";

/** One statement through the system seam, which bypasses RLS. */
async function q(statement: SQL): Promise<Record<string, unknown>[]> {
  const rows = await withSystemDb((tx) => tx.execute(statement));
  return rows as unknown as Record<string, unknown>[];
}

const RUN = randomBytes(2).toString("hex");
const ORG = randomUUID();
const WS = randomUUID();
const OTHER_ORG = randomUUID();
const OTHER_WS = randomUUID();
const USER = randomUUID();

/** A deleted key in `org`, as a host revoke leaves it. */
async function retiredKey(
  org: string,
  ws: string,
  name: string,
  scope: Record<string, unknown>,
): Promise<{ id: string; raw: string }> {
  const raw = `ox_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  await q(sql`
    INSERT INTO auth.api_keys (id, public_id, org_id, workspace_id, key_prefix, key_hash, name, scope, created_by_id, deleted_at)
    VALUES (${id}, ${`aky_${RUN}${name}`}, ${org}, ${ws}, ${raw.slice(0, 12)},
            ${createHash("sha256").update(raw).digest("hex")}, ${name},
            ${JSON.stringify(scope)}::jsonb, ${USER}, now())
  `);
  return { id, raw };
}

/** A host row naming `apiKeyId`, revoked or not. Returns its public id. */
async function host(
  org: string,
  ws: string,
  apiKeyId: string,
  status: "active" | "revoked",
): Promise<string> {
  const publicId = `tch_${randomBytes(11).toString("hex")}`;
  await q(sql`
    INSERT INTO tacho.hosts (id, public_id, org_id, workspace_id, agent_key, api_key_id, hostname, hostname_digest,
      platform, os_user, os_user_digest, device_public_key, device_key_fingerprint, enrollment_claims,
      enrollment_signature, expires_at, created_by_id, status, revoked_at)
    VALUES (${randomUUID()}, ${publicId}, ${org}, ${ws}, ${`agent-${publicId}`}, ${apiKeyId}, 'mbp', 'd1', 'darwin',
      'ada', 'd2', 'pk', 'fp', '{}'::jsonb, 'sig', now() + interval '1 year', ${USER}, ${status},
      ${status === "revoked" ? sql`now()` : sql`NULL`})
  `);
  return publicId;
}

beforeAll(async () => {
  await q(sql`
    INSERT INTO auth.users (id, public_id, email, status, email_verified)
    VALUES (${USER}, ${`usr_r${RUN}`}, ${`revoked-host-${RUN}@example.test`}, 'active', true)
  `);
  for (const [org, ws, tag] of [
    [ORG, WS, "a"],
    [OTHER_ORG, OTHER_WS, "b"],
  ] as const) {
    await q(sql`
      INSERT INTO org.organizations (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES (${org}, ${`rh_org_${tag}${RUN}`}, 'Revoked Host Org', ${`rh-org-${tag}${RUN}`}, ${`x${tag}${RUN}`}, 'enterprise', 'active', 'business')
    `);
    await q(sql`
      INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
      VALUES (${ws}, ${`rh_ws_${tag}${RUN}`}, ${org}, 'Revoked Host WS', ${`rh-ws-${tag}${RUN}`}, ${`y${tag}${RUN}`})
    `);
  }
});

describe("#3944 S-04: a revoked host's retired key answers host_revoked", () => {
  it("answers host_revoked for a legacy host key with no scope, named by api_key_id", async () => {
    const key = await retiredKey(ORG, WS, "legacy", {});
    await host(ORG, WS, key.id, "revoked");
    await expect(resolveApiKey(key.raw)).resolves.toEqual({
      ok: false,
      kind: "host_revoked",
    });
  });

  it("stays invalid when the host that names the key is not revoked (negative)", async () => {
    const key = await retiredKey(ORG, WS, "active", {});
    await host(ORG, WS, key.id, "active");
    await expect(resolveApiKey(key.raw)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  it("stays invalid when the revoked host its scope names is in another organization (negative)", async () => {
    // The enrollment id in a key's scope is data the key carries. A revoked
    // host elsewhere with that id says nothing about this key.
    const elsewhere = await retiredKey(OTHER_ORG, OTHER_WS, "other", {});
    const enrollment = await host(OTHER_ORG, OTHER_WS, elsewhere.id, "revoked");
    const key = await retiredKey(ORG, WS, "cross", {
      purpose: "tacho_host_v1",
      host_enrollment_id: enrollment,
    });
    await expect(resolveApiKey(key.raw)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
  });
});
