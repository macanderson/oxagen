/**
 * The #3734 reproduction, against a real Postgres.
 *
 * The issue's five steps: an organization with a verified SSO domain maps a
 * group to `member`; a person in that group signs in and mints an API key;
 * the identity provider removes them; the key is presented and the signed-in
 * browser reloads. Before SCIM, both succeeded. Here the identity provider's
 * requests run through the real SCIM protocol and the real Postgres port, and
 * then the key and the session are presented to the same resolvers the API
 * and the app use:
 *
 *   - `resolveApiKey` answers `invalid`, which apps/api answers with 401;
 *   - the session row is gone, so `resolveSession` answers null and Better
 *     Auth finds no session on the browser's next request.
 *
 * It also proves the migration: every audit row the deprovision writes passes
 * the widened `security_events_event_type_check`. The last case proves #3740
 * item 2 against the same schema: under Require SSO, a key whose creator never
 * signed in through one of the organization's providers is refused.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/handlers exec vitest run --config vitest.integration.config.ts
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystemDb } from "@oxagen/database";
import { resolveApiKey, resolveSession } from "@oxagen/auth/resolvers";
import { hashScimToken, mintScimToken, resolveScimToken } from "@oxagen/auth/scim-token";
import { createPgScimStore } from "../src/lib/scim/pg-store";
import { ScimError } from "../src/lib/scim/protocol";
import { serveScim } from "../src/lib/scim/service";

/**
 * Run one statement through the same system seam the product uses, which sets
 * the RLS bypass for the transaction.
 */
async function q(statement: SQL): Promise<Record<string, unknown>[]> {
  const rows = await withSystemDb((tx) => tx.execute(statement));
  return rows as unknown as Record<string, unknown>[];
}

const RUN = randomBytes(2).toString("hex");
const ORG = randomUUID();
const WS = randomUUID();
const DOMAIN = `scim-${RUN}.test`;
const PROVIDER = `scim-it-${RUN}`;
const BASE = "https://app.oxagen.sh/api/scim/v2";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

async function scim(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
  return withSystemDb((tx) =>
    serveScim(createPgScimStore(tx, ORG, null), { method, path, query: {}, body }, BASE),
  );
}

function apiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `ox_${randomBytes(32).toString("base64url")}`;
  return {
    raw,
    prefix: raw.slice(0, 12),
    hash: createHash("sha256").update(raw).digest("hex"),
  };
}

beforeAll(async () => {
  {
    await q(sql`
      INSERT INTO org.organizations (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES (${ORG}, ${`scim_org_${RUN}`}, 'SCIM Org', ${`scim-org-${RUN}`}, ${`s${RUN}`}, 'enterprise', 'active', 'business')
    `);
    await q(sql`
      INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
      VALUES (${WS}, ${`scim_ws_${RUN}`}, ${ORG}, 'SCIM WS', ${`scim-ws-${RUN}`}, ${`w${RUN}`})
    `);
    await q(sql`
      INSERT INTO auth.sso_providers
        (id, issuer, oidc_config, provider_id, organization_id, domain, domain_verified,
         protocol, display_name, domain_verification_token)
      VALUES (${randomUUID()}, 'https://idp.test', '{}', ${PROVIDER}, ${ORG}, ${DOMAIN}, true,
              'oidc', 'SCIM IdP', 'tok')
    `);
    await q(sql`
      INSERT INTO org.sso_group_roles (public_id, org_id, provider_id, idp_group, role)
      VALUES (${`sgr_${RUN}`}, ${ORG}, ${PROVIDER}, 'Engineering', 'member')
    `);
  }
});

describe("#3734: removing a person at the identity provider ends their Oxagen access", () => {
  it("the SCIM token resolves to its organization and to nothing else", async () => {
    const minted = mintScimToken();
    {
        await q(sql`
        INSERT INTO org.scim_tokens (public_id, org_id, token_prefix, token_hash)
        VALUES (${`sct_${RUN}`}, ${ORG}, ${minted.tokenPrefix}, ${minted.tokenHash})
      `);
    }
    await expect(resolveScimToken(minted.token)).resolves.toMatchObject({ ok: true, orgId: ORG });
    await expect(resolveScimToken(`${minted.token}x`)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(hashScimToken(minted.token)).toBe(minted.tokenHash);
  });

  it("deprovisioning revokes the API key (401) and signs the browser out", async () => {
    // 1. The identity provider provisions the person: they exist before
    //    their first sign-in, with no role yet.
    const created = await scim("POST", "/Users", {
      userName: `ada@${DOMAIN}`,
      name: { givenName: "Ada", familyName: "Lovelace" },
      externalId: "00u-ada",
      active: true,
    });
    expect(created.status).toBe(201);
    const userId = (created.body as { id: string }).id;
    const [user] = await q(sql`SELECT email FROM auth.users WHERE id = ${userId}`);
    expect(user?.email).toBe(`ada@${DOMAIN}`);

    // 2. A group mapped to member makes them a member.
    const group = await scim("POST", "/Groups", {
      displayName: "Engineering",
      members: [{ value: userId }],
    });
    expect(group.status).toBe(201);
    const [membership] = await q(sql`
      SELECT role FROM org.org_users WHERE org_id = ${ORG} AND user_id = ${userId}
    `);
    expect(membership?.role).toBe("member");

    // 3. They sign in and mint an API key. (The rows Better Auth and
    //    create_api_key write, written directly.)
    const key = apiKey();
    const cli = apiKey();
    const sessionToken = randomBytes(24).toString("hex");
    {
        await q(sql`INSERT INTO workspace.workspace_users (public_id, workspace_id, user_id, role, joined_at) VALUES (${`wsu_${RUN}`}, ${WS}, ${userId}, 'member', now())`);
      await q(sql`
        INSERT INTO auth.sessions (id, user_id, token, expires_at, auth_method)
        VALUES (${randomUUID()}, ${userId}, ${sessionToken}, now() + interval '30 days', ${`sso:${PROVIDER}`})
      `);
      await q(sql`
        INSERT INTO auth.api_keys (public_id, org_id, workspace_id, key_prefix, key_hash, name, scope, created_by_id)
        VALUES (${`aky_${RUN}a`}, ${ORG}, ${WS}, ${key.prefix}, ${key.hash}, 'laptop', '{}'::jsonb, ${userId}),
               (${`aky_${RUN}b`}, ${ORG}, ${WS}, ${cli.prefix}, ${cli.hash}, 'cli', '{"purpose":"cli_session_v1"}'::jsonb, ${userId})
      `);
    }
    // A Tacho host they enrolled, with its control-plane and gateway keys.
    const hostKey = apiKey();
    const gatewayKey = apiKey();
    const hostId = randomUUID();
    const hostPublicId = `tch_${RUN}${"a".repeat(18)}`;
    const hostKeyId = randomUUID();
    await q(sql`
      INSERT INTO auth.api_keys (id, public_id, org_id, workspace_id, key_prefix, key_hash, name, scope, created_by_id)
      VALUES (${hostKeyId}, ${`aky_${RUN}h`}, ${ORG}, ${WS}, ${hostKey.prefix}, ${hostKey.hash}, 'host',
              ${JSON.stringify({ purpose: "tacho_host_v1", host_enrollment_id: hostPublicId })}::jsonb, ${userId}),
             (${randomUUID()}, ${`aky_${RUN}x`}, ${ORG}, ${WS}, ${gatewayKey.prefix}, ${gatewayKey.hash}, 'gateway',
              ${JSON.stringify({ purpose: "tacho_gateway_v1", host_enrollment_id: hostPublicId })}::jsonb, ${userId})
    `);
    await q(sql`
      INSERT INTO tacho.hosts (id, public_id, org_id, workspace_id, agent_key, api_key_id, hostname, hostname_digest,
        platform, os_user, os_user_digest, device_public_key, device_key_fingerprint, enrollment_claims,
        enrollment_signature, expires_at, created_by_id)
      VALUES (${hostId}, ${hostPublicId}, ${ORG}, ${WS}, 'claude-code', ${hostKeyId}, 'ada-mbp', 'd1', 'darwin',
        'ada', 'd2', 'pk', 'fp', '{}'::jsonb, 'sig', now() + interval '1 year', ${userId})
    `);
    await expect(resolveApiKey(key.raw)).resolves.toMatchObject({ ok: true, orgId: ORG });
    await expect(resolveApiKey(cli.raw)).resolves.toMatchObject({ ok: true, userId });
    await expect(resolveSession(sessionToken)).resolves.toEqual({ userId });

    // 4. The identity provider deactivates them.
    const deactivated = await scim("PATCH", `/Users/${userId}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(deactivated.status).toBe(200);
    expect((deactivated.body as { active: boolean }).active).toBe(false);

    // 5. The key and the browser are refused; the member list no longer
    //    shows them.
    await expect(resolveApiKey(key.raw)).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(resolveApiKey(cli.raw)).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(resolveSession(sessionToken)).resolves.toBeNull();
    expect(
      await q(sql`SELECT 1 FROM org.org_users WHERE org_id = ${ORG} AND user_id = ${userId}`),
    ).toHaveLength(0);
    expect(
      await q(sql`SELECT 1 FROM workspace.workspace_users WHERE workspace_id = ${WS} AND user_id = ${userId}`),
    ).toHaveLength(0);

    // The removal is on the record, one row per credential, in the same
    // transaction.
    const events = await q(sql`
      SELECT event_type FROM security.security_events
      WHERE org_id = ${ORG} ORDER BY event_type
    `);
    const types = events.map((e) => e.event_type as string);
    expect(types).toEqual(
      expect.arrayContaining([
        "scim.user_provisioned",
        "scim.group_changed",
        "scim.user_deprovisioned",
        "api_key.revoked",
        "security.session_revoked",
        "auth.sign_out",
      ]),
    );
    expect(types.filter((t) => t === "api_key.revoked")).toHaveLength(4);
    expect(types).toContain("tacho.host_revoked");
    // The host is revoked through revokeHostEnrollment: both of its keys are
    // retired and the collector is told to stop.
    const [host] = await q(sql`SELECT status FROM tacho.hosts WHERE id = ${hostId}`);
    expect(host?.status).toBe("revoked");
    await expect(resolveApiKey(hostKey.raw)).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(resolveApiKey(gatewayKey.raw)).resolves.toEqual({ ok: false, kind: "invalid" });
    const commands = await q(sql`
      SELECT command FROM tacho.control_commands WHERE host_id = ${hostId}
    `);
    expect(commands.map((c) => c.command)).toEqual(["revoke"]);

    // 6. A later SSO sign-in's role write cannot re-admit them: only a SCIM
    //    reactivation does, and it restores the role their groups map to.
    const reactivated = await scim("PATCH", `/Users/${userId}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "replace", value: { active: true } }],
    });
    expect((reactivated.body as { active: boolean }).active).toBe(true);
    const [back] = await q(sql`
      SELECT role FROM org.org_users WHERE org_id = ${ORG} AND user_id = ${userId}
    `);
    expect(back?.role).toBe("member");
    // The revoked key stays revoked.
    await expect(resolveApiKey(key.raw)).resolves.toEqual({ ok: false, kind: "invalid" });
  });

  it("leaving the last mapped group removes membership and keys but keeps the session", async () => {
    // The same removal an SSO sign-in runs when no mapped group admits the
    // person (#3740 item 2): the membership, workspace membership and every
    // key go, and the session stays because it is not this organization's.
    const created = await scim("POST", "/Users", { userName: `grace@${DOMAIN}` });
    const userId = (created.body as { id: string }).id;
    const group = await scim("POST", "/Groups", {
      displayName: `Engineering-${RUN}`,
      externalId: "Engineering",
      members: [{ value: userId }],
    });
    const groupId = (group.body as { id: string }).id;
    const key = apiKey();
    const sessionToken = randomBytes(24).toString("hex");
    await q(sql`
      INSERT INTO auth.api_keys (public_id, org_id, workspace_id, key_prefix, key_hash, name, scope, created_by_id)
      VALUES (${`aky_${RUN}g`}, ${ORG}, ${WS}, ${key.prefix}, ${key.hash}, 'laptop', '{}'::jsonb, ${userId})
    `);
    await q(sql`
      INSERT INTO auth.sessions (id, user_id, token, expires_at)
      VALUES (${randomUUID()}, ${userId}, ${sessionToken}, now() + interval '30 days')
    `);
    // Mapped through the group's external ID, the way an Entra ID object id is.
    const [member] = await q(sql`
      SELECT role FROM org.org_users WHERE org_id = ${ORG} AND user_id = ${userId}
    `);
    expect(member?.role).toBe("member");

    await scim("PATCH", `/Groups/${groupId}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: "Remove", path: "members", value: [{ value: userId }] }],
    });

    expect(
      await q(sql`SELECT 1 FROM org.org_users WHERE org_id = ${ORG} AND user_id = ${userId}`),
    ).toHaveLength(0);
    await expect(resolveApiKey(key.raw)).resolves.toEqual({ ok: false, kind: "invalid" });
    await expect(resolveSession(sessionToken)).resolves.toEqual({ userId });
    const [removed] = await q(sql`
      SELECT detail FROM security.security_events
      WHERE org_id = ${ORG} AND event_type = 'org.member_removed'
        AND detail->>'userId' = ${userId}
    `);
    expect(removed?.detail).toMatchObject({ trigger: "scim_group_change", apiKeysRevoked: 1 });
  });

  it("refuses to deprovision an Owner and changes nothing", async () => {
    const created = await scim("POST", "/Users", { userName: `owner@${DOMAIN}` });
    const userId = (created.body as { id: string }).id;
    {
        await q(sql`INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at) VALUES (${`ou_${RUN}`}, ${ORG}, ${userId}, 'owner', now())`);
    }
    const refused = await scim("DELETE", `/Users/${userId}`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(ScimError);
    expect(refused).toMatchObject({ status: 403, denial: "owner_protected" });
    const [still] = await q(sql`
      SELECT role FROM org.org_users WHERE org_id = ${ORG} AND user_id = ${userId}
    `);
    expect(still?.role).toBe("owner");
  });
});

describe("#3740 item 2: Require SSO reaches API keys", () => {
  it("refuses a key whose creator never signed in through SSO, and admits Owners and SSO users", async () => {
    const org = randomUUID();
    const ws = randomUUID();
    const provider = `req-it-${RUN}`;
    const tag = `r${RUN}`;
    await q(sql`
      INSERT INTO org.organizations (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES (${org}, ${`req_org_${RUN}`}, 'Require Org', ${`req-org-${RUN}`}, ${tag}, 'enterprise', 'active', 'business')
    `);
    await q(sql`
      INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
      VALUES (${ws}, ${`req_ws_${RUN}`}, ${org}, 'Require WS', ${`req-ws-${RUN}`}, ${`q${RUN}`})
    `);
    await q(sql`
      INSERT INTO auth.sso_providers
        (id, issuer, oidc_config, provider_id, organization_id, domain, domain_verified,
         protocol, display_name, domain_verification_token)
      VALUES (${randomUUID()}, 'https://idp.test', '{}', ${provider}, ${org}, ${`req-${RUN}.test`}, true,
              'oidc', 'Require IdP', 'tok')
    `);
    await q(sql`INSERT INTO security.org_security_policy (org_id, sso_required) VALUES (${org}, true)`);

    const person = async (role: string, ssoAccount: boolean) => {
      const userId = randomUUID();
      const key = apiKey();
      const suffix = randomBytes(3).toString("hex");
      await q(sql`
        INSERT INTO auth.users (id, public_id, email, status)
        VALUES (${userId}, ${`usr_${suffix}`}, ${`${suffix}@req-${RUN}.test`}, 'active')
      `);
      await q(sql`
        INSERT INTO org.org_users (public_id, org_id, user_id, role, joined_at)
        VALUES (${`ou_${suffix}`}, ${org}, ${userId}, ${role}, now())
      `);
      if (ssoAccount) {
        await q(sql`
          INSERT INTO auth.accounts (id, user_id, account_id, provider_id)
          VALUES (${randomUUID()}, ${userId}, ${`sub-${suffix}`}, ${provider})
        `);
      }
      await q(sql`
        INSERT INTO auth.api_keys (public_id, org_id, workspace_id, key_prefix, key_hash, name, scope, created_by_id)
        VALUES (${`aky_${suffix}`}, ${org}, ${ws}, ${key.prefix}, ${key.hash}, 'k', '{}'::jsonb, ${userId})
      `);
      return key.raw;
    };

    await expect(resolveApiKey(await person("member", false))).resolves.toEqual({
      ok: false,
      kind: "sso_required",
    });
    await expect(resolveApiKey(await person("member", true))).resolves.toMatchObject({ ok: true });
    await expect(resolveApiKey(await person("owner", false))).resolves.toMatchObject({ ok: true });
  });
});
