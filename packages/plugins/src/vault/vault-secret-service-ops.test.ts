/**
 * vault-secret-service-ops.test.ts
 *
 * Extended unit tests for vault-secret-service.ts covering operations not
 * exercised by vault-secret-service.test.ts:
 *
 *  - setSecretValue (sensitive + non-sensitive)
 *  - unsetSecretValue
 *  - listSecretKeys
 *  - deleteSecretKey
 *  - revealSecret (override, default, unset, sensitive)
 *  - exportSecrets (dotenv build, keyIds filter)
 *  - importEnv (preview mode, commit to default, commit to override)
 *  - resolveEnvironmentSecrets
 *
 * The mock tx uses a select-result queue (FIFO) so each call to
 * tx.select().from().where() pops the next expected row array.
 * Real @oxagen/crypto is used for encryption so the sensitive paths are
 * exercised end-to-end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Capture state ─────────────────────────────────────────────────────────────

interface State {
  /** FIFO queue of result arrays for each select call inside withTenantDb. */
  selectQueue: unknown[][];
  inserts: { values: unknown }[];
  updates: { set: Record<string, unknown> }[];
  deletes: number;
}

const state: State = {
  selectQueue: [],
  inserts: [],
  updates: [],
  deletes: 0,
};

function resetState() {
  state.selectQueue = [];
  state.inserts = [];
  state.updates = [];
  state.deletes = 0;
}

// ── Fake tx factory ───────────────────────────────────────────────────────────

/**
 * The chainable builder returned by select(): it's a single object with both
 * .limit() and .orderBy() so all drizzle chain forms work:
 *   - await tx.select().from().where()               → uses .then()
 *   - await tx.select().from().where().limit(1)      → awaits .limit()
 *   - await tx.select().from().where().orderBy(...)  → awaits .orderBy()
 */
function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: () => chain,
    limit: async (n: number) => result.slice(0, n),
    orderBy: async () => result,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  });
  return chain;
}

function makeTx() {
  return {
    select: (_cols: unknown) => {
      const result = state.selectQueue.shift() ?? [];
      return makeChain(result);
    },
    insert: (_table: unknown) => ({
      values: (v: unknown) => {
        state.inserts.push({ values: v });
        return {
          onConflictDoUpdate: (_opts: unknown) => Promise.resolve(),
          returning: async () => [{ publicId: "sk_pub_new" }],
        };
      },
    }),
    update: (_table: unknown) => ({
      set: (s: Record<string, unknown>) => {
        state.updates.push({ set: s });
        return {
          where: (_cond: unknown) => Promise.resolve(),
        };
      },
    }),
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => {
        state.deletes++;
        return Promise.resolve();
      },
    }),
  };
}

// ── DB mock ───────────────────────────────────────────────────────────────────

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

// ── Test data helpers ─────────────────────────────────────────────────────────

const actor = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u1",
  requestId: "req-1",
};

function makeKeyRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "sk_int_1",
    publicId: "sk_pub_1",
    key: "API_KEY",
    sensitive: false,
    memo: null,
    defaultValueEnc: null,
    defaultValueText: "default-api-key",
    defaultValueKmsKeyId: null,
    ...overrides,
  };
}

function makeEnvRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { id: "env_int_1", publicId: "env_pub_1", ...overrides };
}

// ── setSecretValue ────────────────────────────────────────────────────────────

describe("setSecretValue", () => {
  beforeEach(() => {
    resetState();
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
  });

  it("stores plaintext for a non-sensitive key", async () => {
    const { setSecretValue } = await import("./vault-secret-service");

    // Queue: [loadKeyByPublicId result, loadEnvironmentId result]
    state.selectQueue.push([makeKeyRow({ sensitive: false })]);
    state.selectQueue.push([makeEnvRow()]);

    const result = await setSecretValue(actor, {
      keyId: "sk_pub_1",
      environmentId: "env_pub_1",
      value: "plaintext-value",
    });

    expect(result).toEqual({ ok: true });
    expect(state.inserts).toHaveLength(1);
    const inserted = state.inserts[0]!.values as Record<string, unknown>;
    expect(inserted.valueText).toBe("plaintext-value");
    expect(inserted.valueEnc).toBeNull();
    expect(inserted.valueKmsKeyId).toBeNull();
  });

  it("encrypts the value for a sensitive key", async () => {
    const { setSecretValue } = await import("./vault-secret-service");

    state.selectQueue.push([makeKeyRow({ sensitive: true })]);
    state.selectQueue.push([makeEnvRow()]);

    await setSecretValue(actor, {
      keyId: "sk_pub_1",
      environmentId: "env_pub_1",
      value: "super-secret",
    });

    const inserted = state.inserts[0]!.values as Record<string, unknown>;
    expect(inserted.valueEnc).toBeInstanceOf(Buffer);
    expect(inserted.valueText).toBeNull();
    // Plaintext must never appear in the stored bytes
    expect(
      JSON.stringify(Array.from(inserted.valueEnc as Buffer)),
    ).not.toContain("super-secret");
  });

  it("throws when key is not found", async () => {
    const { setSecretValue } = await import("./vault-secret-service");

    // Empty result → loadKeyByPublicId throws
    state.selectQueue.push([]);

    await expect(
      setSecretValue(actor, {
        keyId: "missing",
        environmentId: "env_pub_1",
        value: "v",
      }),
    ).rejects.toThrow(/secret key not found/);
  });
});

// ── unsetSecretValue ──────────────────────────────────────────────────────────

describe("unsetSecretValue", () => {
  beforeEach(() => {
    resetState();
  });

  it("deletes the override row and returns ok", async () => {
    const { unsetSecretValue } = await import("./vault-secret-service");

    state.selectQueue.push([makeKeyRow()]);
    state.selectQueue.push([makeEnvRow()]);

    const result = await unsetSecretValue(actor, {
      keyId: "sk_pub_1",
      environmentId: "env_pub_1",
    });

    expect(result).toEqual({ ok: true });
    expect(state.deletes).toBe(1);
  });

  it("throws when environment is not found", async () => {
    const { unsetSecretValue } = await import("./vault-secret-service");

    state.selectQueue.push([makeKeyRow()]);
    state.selectQueue.push([]); // environment not found

    await expect(
      unsetSecretValue(actor, {
        keyId: "sk_pub_1",
        environmentId: "missing-env",
      }),
    ).rejects.toThrow(/environment not found/);
  });
});

// ── listSecretKeys ────────────────────────────────────────────────────────────

describe("listSecretKeys", () => {
  beforeEach(() => {
    resetState();
  });

  it("returns an empty array when no keys exist", async () => {
    const { listSecretKeys } = await import("./vault-secret-service");

    state.selectQueue.push([]); // keys query

    const result = await listSecretKeys(actor);

    expect(result).toEqual([]);
    // No further queries (environments, values) when there are no keys
  });

  it("returns summaries with hasDefault=true for sensitive keys with defaultValueEnc", async () => {
    const { listSecretKeys } = await import("./vault-secret-service");

    const sensitiveKey = makeKeyRow({
      sensitive: true,
      defaultValueEnc: Buffer.from("encrypted"),
      defaultValueText: null,
    });

    state.selectQueue.push([sensitiveKey]); // keys
    state.selectQueue.push([]); // environments
    state.selectQueue.push([]); // values

    const result = await listSecretKeys(actor);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("sk_pub_1");
    expect(result[0]!.key).toBe("API_KEY");
    expect(result[0]!.sensitive).toBe(true);
    expect(result[0]!.hasDefault).toBe(true);
    expect(result[0]!.overrideEnvironmentIds).toEqual([]);
  });

  it("returns hasDefault=false for a non-sensitive key with no defaultValueText", async () => {
    const { listSecretKeys } = await import("./vault-secret-service");

    const noDefaultKey = makeKeyRow({
      sensitive: false,
      defaultValueText: null,
    });

    state.selectQueue.push([noDefaultKey]); // keys
    state.selectQueue.push([]); // environments
    state.selectQueue.push([]); // values

    const result = await listSecretKeys(actor);

    expect(result[0]!.hasDefault).toBe(false);
  });

  it("populates overrideEnvironmentIds from the values batch", async () => {
    const { listSecretKeys } = await import("./vault-secret-service");

    const key = makeKeyRow({ id: "sk_int_1", publicId: "sk_pub_1" });

    state.selectQueue.push([key]); // keys
    state.selectQueue.push([
      { id: "env_int_1", publicId: "env_pub_1" },
      { id: "env_int_2", publicId: "env_pub_2" },
    ]); // environments
    state.selectQueue.push([
      { secretKeyId: "sk_int_1", environmentId: "env_int_1" },
    ]); // values: one override in env_int_1

    const result = await listSecretKeys(actor);

    expect(result[0]!.overrideEnvironmentIds).toEqual(["env_pub_1"]);
    // env_int_2 has no override for this key
    expect(result[0]!.overrideEnvironmentIds).not.toContain("env_pub_2");
  });

  it("skips value rows whose environmentId doesn't match a known environment", async () => {
    const { listSecretKeys } = await import("./vault-secret-service");

    state.selectQueue.push([makeKeyRow({ id: "sk_int_1" })]); // keys
    state.selectQueue.push([{ id: "env_int_1", publicId: "env_pub_1" }]); // environments
    state.selectQueue.push([
      { secretKeyId: "sk_int_1", environmentId: "env_orphan" }, // orphan value
    ]); // values

    const result = await listSecretKeys(actor);
    expect(result[0]!.overrideEnvironmentIds).toEqual([]);
  });
});

// ── deleteSecretKey ───────────────────────────────────────────────────────────

describe("deleteSecretKey", () => {
  beforeEach(() => {
    resetState();
  });

  it("hard-deletes override values and soft-deletes the key", async () => {
    const { deleteSecretKey } = await import("./vault-secret-service");

    state.selectQueue.push([makeKeyRow()]);

    const result = await deleteSecretKey(actor, { keyId: "sk_pub_1" });

    expect(result).toEqual({ ok: true });
    // delete for overrides + soft-delete update for key
    expect(state.deletes).toBe(1);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set.deletedAt).toBeInstanceOf(Date);
  });

  it("throws when the key is not found", async () => {
    const { deleteSecretKey } = await import("./vault-secret-service");

    state.selectQueue.push([]);

    await expect(deleteSecretKey(actor, { keyId: "missing" })).rejects.toThrow(
      /secret key not found/,
    );
  });
});

// ── revealSecret ──────────────────────────────────────────────────────────────

describe("revealSecret", () => {
  beforeEach(() => {
    resetState();
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
  });

  it("returns the non-sensitive default value when no environment is specified", async () => {
    const { revealSecret } = await import("./vault-secret-service");

    state.selectQueue.push([
      makeKeyRow({ sensitive: false, defaultValueText: "my-default" }),
    ]);
    // writeAccessLog insert is captured but we don't check it here

    const result = await revealSecret(actor, { keyId: "sk_pub_1" });

    expect(result.key).toBe("API_KEY");
    expect(result.value).toBe("my-default");
    expect(result.source).toBe("default");
    // Access log insert should have been written
    expect(state.inserts).toHaveLength(1);
  });

  it("returns the environment override value when one exists", async () => {
    const { revealSecret } = await import("./vault-secret-service");

    state.selectQueue.push([
      makeKeyRow({ sensitive: false, defaultValueText: "default" }),
    ]);
    state.selectQueue.push([makeEnvRow()]); // loadEnvironmentId
    state.selectQueue.push([
      { valueEnc: null, valueText: "override-val", valueKmsKeyId: null },
    ]); // loadValue

    const result = await revealSecret(actor, {
      keyId: "sk_pub_1",
      environmentId: "env_pub_1",
    });

    expect(result.value).toBe("override-val");
    expect(result.source).toBe("override");
  });

  it("falls back to default when environment has no override", async () => {
    const { revealSecret } = await import("./vault-secret-service");

    state.selectQueue.push([
      makeKeyRow({ sensitive: false, defaultValueText: "fallback" }),
    ]);
    state.selectQueue.push([makeEnvRow()]); // loadEnvironmentId
    state.selectQueue.push([]); // no override row

    const result = await revealSecret(actor, {
      keyId: "sk_pub_1",
      environmentId: "env_pub_1",
    });

    expect(result.value).toBe("fallback");
    expect(result.source).toBe("default");
  });

  it("returns { value: null, source: 'unset' } when no default and no override", async () => {
    const { revealSecret } = await import("./vault-secret-service");

    state.selectQueue.push([
      makeKeyRow({ sensitive: false, defaultValueText: null }),
    ]);
    state.selectQueue.push([makeEnvRow()]);
    state.selectQueue.push([]); // no override

    const result = await revealSecret(actor, {
      keyId: "sk_pub_1",
      environmentId: "env_pub_1",
    });

    expect(result.value).toBeNull();
    expect(result.source).toBe("unset");
  });

  it("decrypts a sensitive default value", async () => {
    const { revealSecret } = await import("./vault-secret-service");
    const { encrypt } = await import("@oxagen/crypto");
    const { createLocalKmsAdapter, loadMasterKey } = await import(
      "@oxagen/crypto/kms"
    );
    const { WORKSPACE_VAULT_KEY_ID } = await import("./vault-kms");

    const key64 = Buffer.alloc(32, 7).toString("base64");
    const adapter = createLocalKmsAdapter(loadMasterKey(key64));
    const encDefault = await encrypt(
      "encrypted-default",
      WORKSPACE_VAULT_KEY_ID,
      { adapter },
    );

    state.selectQueue.push([
      makeKeyRow({
        sensitive: true,
        defaultValueEnc: encDefault,
        defaultValueText: null,
        defaultValueKmsKeyId: WORKSPACE_VAULT_KEY_ID,
      }),
    ]);

    const result = await revealSecret(actor, { keyId: "sk_pub_1" });

    expect(result.value).toBe("encrypted-default");
    expect(result.source).toBe("default");
  });

  it("decrypts a sensitive override value", async () => {
    const { revealSecret } = await import("./vault-secret-service");
    const { encrypt } = await import("@oxagen/crypto");
    const { createLocalKmsAdapter, loadMasterKey } = await import(
      "@oxagen/crypto/kms"
    );
    const { WORKSPACE_VAULT_KEY_ID } = await import("./vault-kms");

    const key64 = Buffer.alloc(32, 7).toString("base64");
    const adapter = createLocalKmsAdapter(loadMasterKey(key64));
    const encOverride = await encrypt(
      "encrypted-override",
      WORKSPACE_VAULT_KEY_ID,
      { adapter },
    );

    state.selectQueue.push([
      makeKeyRow({
        sensitive: true,
        defaultValueEnc: null,
        defaultValueText: null,
      }),
    ]);
    state.selectQueue.push([makeEnvRow()]);
    state.selectQueue.push([
      {
        valueEnc: encOverride,
        valueText: null,
        valueKmsKeyId: WORKSPACE_VAULT_KEY_ID,
      },
    ]);

    const result = await revealSecret(actor, {
      keyId: "sk_pub_1",
      environmentId: "env_pub_1",
    });

    expect(result.value).toBe("encrypted-override");
    expect(result.source).toBe("override");
  });
});

// ── exportSecrets ─────────────────────────────────────────────────────────────

describe("exportSecrets", () => {
  beforeEach(() => {
    resetState();
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
  });

  it("returns empty env and minimal dotenv when no keys have set values", async () => {
    const { exportSecrets } = await import("./vault-secret-service");

    // keys with no default and no overrides
    state.selectQueue.push([
      makeKeyRow({ sensitive: false, defaultValueText: null }),
    ]);

    const result = await exportSecrets(actor, {});

    expect(result.env).toEqual([]);
    // dotenv is just a trailing newline when empty
    expect(result.dotenv).toBe("\n");
  });

  it("builds a dotenv string from keys with set default values", async () => {
    const { exportSecrets } = await import("./vault-secret-service");

    state.selectQueue.push([
      makeKeyRow({
        key: "API_KEY",
        sensitive: false,
        defaultValueText: "my-api-key",
      }),
      makeKeyRow({
        id: "sk_int_2",
        publicId: "sk_pub_2",
        key: "LOG_LEVEL",
        sensitive: false,
        defaultValueText: "debug",
      }),
    ]);

    const result = await exportSecrets(actor, {});

    expect(result.env).toHaveLength(2);
    expect(result.dotenv).toContain("API_KEY=my-api-key");
    expect(result.dotenv).toContain("LOG_LEVEL=debug");
  });

  it("quotes dotenv values that contain spaces", async () => {
    const { exportSecrets } = await import("./vault-secret-service");

    state.selectQueue.push([
      makeKeyRow({
        key: "MSG",
        sensitive: false,
        defaultValueText: "hello world",
      }),
    ]);

    const result = await exportSecrets(actor, {});

    // The value contains a space so it should be quoted
    expect(result.dotenv).toMatch(/MSG='hello world'/);
  });

  it("uses environment overrides when environmentId is provided", async () => {
    const { exportSecrets } = await import("./vault-secret-service");

    state.selectQueue.push([
      makeKeyRow({
        key: "DB_URL",
        sensitive: false,
        defaultValueText: "default-url",
      }),
    ]);
    state.selectQueue.push([makeEnvRow()]); // loadEnvironmentId
    state.selectQueue.push([
      {
        secretKeyId: "sk_int_1",
        valueEnc: null,
        valueText: "override-url",
        valueKmsKeyId: null,
      },
    ]); // values for the environment

    const result = await exportSecrets(actor, { environmentId: "env_pub_1" });

    expect(result.env[0]!.value).toBe("override-url");
  });

  it("filters to specific keyIds when provided", async () => {
    const { exportSecrets } = await import("./vault-secret-service");

    // When keyIds is set, the WHERE clause includes an inArray — the mock returns
    // what we seed regardless, so we seed only the targeted key.
    state.selectQueue.push([
      makeKeyRow({
        key: "TARGETED",
        sensitive: false,
        defaultValueText: "val",
      }),
    ]);

    const result = await exportSecrets(actor, { keyIds: ["sk_pub_1"] });

    expect(result.env).toHaveLength(1);
    expect(result.env[0]!.key).toBe("TARGETED");
  });

  it("writes an access log entry", async () => {
    const { exportSecrets } = await import("./vault-secret-service");

    state.selectQueue.push([
      makeKeyRow({ sensitive: false, defaultValueText: "v" }),
    ]);

    await exportSecrets(actor, {});

    // writeAccessLog calls tx.insert(schema.secretAccessLog)
    expect(state.inserts).toHaveLength(1);
    const logged = state.inserts[0]!.values as Record<string, unknown>;
    expect(logged.action).toBe("export");
    expect(logged.orgId).toBe("org-1");
  });
});

// ── importEnv ─────────────────────────────────────────────────────────────────

describe("importEnv", () => {
  beforeEach(() => {
    resetState();
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
  });

  it("preview mode (commit=false) returns row metadata without writing", async () => {
    const { importEnv } = await import("./vault-secret-service");

    // existingKeys query
    state.selectQueue.push([]);

    const result = await importEnv(actor, {
      text: "NEW_KEY=some-value\nANOTHER=foo",
      commit: false,
    });

    expect(result.committed).toBe(false);
    expect(result.rows).toHaveLength(2);
    // Both keys are new (not in existingKeys)
    expect(result.rows[0]!.isNewKey).toBe(true);
    expect(result.rows[0]!.key).toBe("NEW_KEY");
    expect(result.rows[0]!.sensitive).toBe(true); // new keys default sensitive=true
    expect(result.rows[0]!.target).toBe("default");
    expect(result.rows[0]!.willOverride).toBe(false);
    // No writes since commit=false
    expect(state.inserts).toHaveLength(0);
  });

  it("commit=true to default target calls upsert for each entry", async () => {
    const { importEnv } = await import("./vault-secret-service");

    // existingKeys query → empty (all new)
    state.selectQueue.push([]);
    // upsertSecretKeyTx select (check existing for "API_KEY")
    state.selectQueue.push([]);
    // upsertSecretKeyTx select (check existing for "LOG_LEVEL")
    state.selectQueue.push([]);

    const result = await importEnv(actor, {
      text: "API_KEY=secret\nLOG_LEVEL=debug",
      commit: true,
    });

    expect(result.committed).toBe(true);
    // Two inserts: one per key
    expect(state.inserts).toHaveLength(2);
  });

  it("preview with environmentId reports willOverride=true for existing overrides", async () => {
    const { importEnv } = await import("./vault-secret-service");

    const existingKey = makeKeyRow({ id: "sk_int_1", key: "DB_URL" });
    state.selectQueue.push([existingKey]); // existingKeys
    state.selectQueue.push([makeEnvRow()]); // loadEnvironmentId
    // existing overrides: DB_URL already has one
    state.selectQueue.push([{ secretKeyId: "sk_int_1" }]);

    const result = await importEnv(actor, {
      text: "DB_URL=new-url",
      environmentId: "env_pub_1",
      commit: false,
    });

    expect(result.rows[0]!.willOverride).toBe(true);
    expect(result.rows[0]!.target).toBe("override");
    expect(result.rows[0]!.isNewKey).toBe(false);
  });

  it("empty text produces no rows", async () => {
    const { importEnv } = await import("./vault-secret-service");

    state.selectQueue.push([]); // existingKeys

    const result = await importEnv(actor, { text: "", commit: false });

    expect(result.rows).toHaveLength(0);
    expect(result.committed).toBe(false);
  });

  it("commit=true with environmentId (override path) calls upsertSecretKeyTx + setSecretValueTx", async () => {
    const { importEnv } = await import("./vault-secret-service");

    // The override commit path goes through:
    // 1. existingKeys query              → []
    // 2. loadEnvironmentId (overrides)   → [{ id: "env_int_1" }]
    // 3. existing override ids query     → []
    // 4. upsertSecretKeyTx: check-existing → []  (new key → insert)
    // 5. loadKeyByKeyName                → [{ publicId: "sk_pub_new" }]
    // 6. setSecretValueTx: loadKeyByPublicId → [keyRow]
    // 7. setSecretValueTx: loadEnvironmentId → [{ id: "env_int_1" }]

    state.selectQueue.push([]); // 1. existingKeys
    state.selectQueue.push([{ id: "env_int_1" }]); // 2. loadEnvironmentId for overrides
    state.selectQueue.push([]); // 3. existing overrides
    state.selectQueue.push([]); // 4. upsertSecretKeyTx check-existing
    state.selectQueue.push([{ publicId: "sk_pub_new" }]); // 5. loadKeyByKeyName
    state.selectQueue.push([
      makeKeyRow({
        id: "sk_int_new",
        publicId: "sk_pub_new",
        sensitive: false,
      }),
    ]); // 6. loadKeyByPublicId
    state.selectQueue.push([{ id: "env_int_1" }]); // 7. loadEnvironmentId for setSecretValueTx

    const result = await importEnv(actor, {
      text: "OVERRIDE_KEY=override-value",
      environmentId: "env_pub_1",
      commit: true,
    });

    expect(result.committed).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.target).toBe("override");
    expect(result.rows[0]!.isNewKey).toBe(true);

    // Two inserts: one from upsertSecretKeyTx (new key) + one from setSecretValueTx (override)
    expect(state.inserts).toHaveLength(2);
  });
});

// ── resolveEnvironmentSecrets ─────────────────────────────────────────────────

describe("resolveEnvironmentSecrets", () => {
  beforeEach(() => {
    resetState();
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
  });

  it("returns an empty object when there are no keys", async () => {
    const { resolveEnvironmentSecrets } = await import(
      "./vault-secret-service"
    );

    state.selectQueue.push([makeEnvRow()]); // loadEnvironmentId
    state.selectQueue.push([]); // keys
    state.selectQueue.push([]); // values

    const result = await resolveEnvironmentSecrets({
      orgId: "org-1",
      workspaceId: "ws-1",
      environmentId: "env_pub_1",
    });

    expect(result).toEqual({});
  });

  it("returns env map merging default and override values", async () => {
    const { resolveEnvironmentSecrets } = await import(
      "./vault-secret-service"
    );

    const keyWithDefault = makeKeyRow({
      id: "sk_int_1",
      key: "ONLY_DEFAULT",
      sensitive: false,
      defaultValueText: "default-val",
    });
    const keyWithOverride = makeKeyRow({
      id: "sk_int_2",
      publicId: "sk_pub_2",
      key: "HAS_OVERRIDE",
      sensitive: false,
      defaultValueText: "fallback",
    });

    state.selectQueue.push([makeEnvRow()]); // loadEnvironmentId
    state.selectQueue.push([keyWithDefault, keyWithOverride]); // keys
    state.selectQueue.push([
      // values: only keyWithOverride has a value row
      {
        secretKeyId: "sk_int_2",
        valueEnc: null,
        valueText: "override-val",
        valueKmsKeyId: null,
      },
    ]);

    const result = await resolveEnvironmentSecrets({
      orgId: "org-1",
      workspaceId: "ws-1",
      environmentId: "env_pub_1",
    });

    expect(result["ONLY_DEFAULT"]).toBe("default-val");
    expect(result["HAS_OVERRIDE"]).toBe("override-val");
  });

  it("skips keys with no default and no override (unset)", async () => {
    const { resolveEnvironmentSecrets } = await import(
      "./vault-secret-service"
    );

    const unsetKey = makeKeyRow({
      key: "UNSET",
      sensitive: false,
      defaultValueText: null,
    });

    state.selectQueue.push([makeEnvRow()]); // loadEnvironmentId
    state.selectQueue.push([unsetKey]); // keys
    state.selectQueue.push([]); // no values

    const result = await resolveEnvironmentSecrets({
      orgId: "org-1",
      workspaceId: "ws-1",
      environmentId: "env_pub_1",
    });

    expect("UNSET" in result).toBe(false);
  });
});

// ── upsertSecretKey — update path ─────────────────────────────────────────────

describe("upsertSecretKey — update path (existing key)", () => {
  beforeEach(() => {
    resetState();
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      "base64",
    );
  });

  it("updates an existing key's memo without touching the default value", async () => {
    await import("./vault-secret-service");
    vi.resetModules();
    const { upsertSecretKey: upsert2 } = await import("./vault-secret-service");

    const existing = makeKeyRow({ id: "sk_int_1", sensitive: false });

    // The check-existing select inside upsertSecretKeyTx
    state.selectQueue.push([existing]);

    // We need a capturing tx for the update path
    const result = await upsert2(actor, {
      key: "API_KEY",
      sensitive: false,
      // no defaultValue → preserve existing
    });

    // Should return the existing public id, and issue an update
    expect(result.id).toBe("sk_pub_1");
    expect(state.updates).toHaveLength(1);
    expect(state.inserts).toHaveLength(0);
  });
});
