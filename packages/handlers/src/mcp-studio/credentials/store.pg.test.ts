// store.pg.test.ts: the credential store's setCredential against a migrated
// Postgres. It runs wherever DATABASE_URL points at a migrated database, as in
// CI's unit job, and skips without one. afterAll removes every row it writes.
//
// setCredential inserts on a new name and updates in place on a name the
// workspace already holds, keyed on (workspace_id, name). A replace keeps the
// row id, because mcp.operator_tokens points at it.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { decryptCredentialSecrets, encryptCredentialSecrets } from "@oxagen/plugins";
import { eq } from "drizzle-orm";
import { type CredentialScope, type CredentialValue, postgresCredentialStore } from "./store";
import { testKms } from "./test-support";

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("the credential store's setCredential against Postgres", () => {
  const kms = testKms();
  const orgId = randomUUID();
  const scope: CredentialScope = { orgId, workspaceId: randomUUID() };
  const otherScope: CredentialScope = { orgId, workspaceId: randomUUID() };
  const actorUserId = randomUUID();

  async function value(fields: {
    name: string;
    secret?: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<CredentialValue> {
    const isSecret = fields.secret !== undefined;
    return {
      name: fields.name,
      authKind: isSecret ? "secret" : "oauth",
      oauthClientId: isSecret ? null : (fields.clientId ?? null),
      sealed: await encryptCredentialSecrets(
        isSecret ? { secret: fields.secret } : { oauthClientSecret: fields.clientSecret },
        kms,
      ),
      actorUserId,
    };
  }

  /** The named row's secrets, decrypted. */
  async function opened(at: CredentialScope, name: string) {
    const row = await postgresCredentialStore(at).credentialByName(name);
    if (row === null) throw new Error(`no credential named ${name}`);
    return decryptCredentialSecrets(row, kms);
  }

  afterAll(async () => {
    await withSystemDb((tx) => tx.delete(schema.mcpCredentials).where(eq(schema.mcpCredentials.orgId, orgId)));
    await closeDatabase();
  });

  it("creates a row, then replaces its value in place", async () => {
    const store = postgresCredentialStore(scope);

    const first = await store.setCredential(await value({ name: "stripe-live", secret: "sk_test_fake_1" }));
    expect(first.created).toBe(true);

    const second = await store.setCredential(await value({ name: "stripe-live", secret: "sk_test_fake_2" }));
    expect(second).toEqual({ id: first.id, created: false });

    const row = await store.credentialByName("stripe-live");
    expect(row).toMatchObject({ id: first.id, authKind: "secret", status: "active", oauthClientId: null });
    await expect(opened(scope, "stripe-live")).resolves.toMatchObject({ secret: "sk_test_fake_2" });
  });

  it("clears the old kind's columns when a replace changes the kind", async () => {
    const store = postgresCredentialStore(scope);
    await store.setCredential(await value({ name: "partner-api", secret: "sk_test_fake_3" }));

    await store.setCredential(
      await value({ name: "partner-api", clientId: "client-9", clientSecret: "cs_test_fake_4" }),
    );

    const row = await store.credentialByName("partner-api");
    expect(row).toMatchObject({ authKind: "oauth", oauthClientId: "client-9", secretEnc: null });
    await expect(opened(scope, "partner-api")).resolves.toMatchObject({
      oauthClientSecret: "cs_test_fake_4",
      secret: null,
    });
  });

  it("reads nothing from another workspace", async () => {
    await postgresCredentialStore(scope).setCredential(await value({ name: "github-app", secret: "sk_test_fake_5" }));

    await expect(postgresCredentialStore(otherScope).credentialByName("github-app")).resolves.toBeNull();
  });

  it("lets two workspaces hold the same name apart", async () => {
    const mine = await postgresCredentialStore(scope).setCredential(await value({ name: "shared-name", secret: "sk_test_fake_6" }));
    const theirs = await postgresCredentialStore(otherScope).setCredential(
      await value({ name: "shared-name", secret: "sk_test_fake_7" }),
    );

    expect(theirs.created).toBe(true);
    expect(theirs.id).not.toBe(mine.id);
    await expect(opened(scope, "shared-name")).resolves.toMatchObject({ secret: "sk_test_fake_6" });
  });
});
