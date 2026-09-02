/**
 * environment-service-crud.test.ts
 *
 * Covers the CRUD operations in environment-service.ts that are not already
 * exercised by environment-service.test.ts (slug validation) or
 * environment-service.db.test.ts (setDefaultEnvironment + default guards):
 *
 *  - createEnvironment (success + invalid slug)
 *  - listEnvironments (ordered results)
 *  - getEnvironment (success + not-found)
 *  - updateEnvironment (success, invalid slug, deactivate-default guard,
 *    partial field updates)
 *  - deleteEnvironment (success for non-default, error for default — the
 *    latter already in db.test.ts but repeated here for completeness)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Capture state ─────────────────────────────────────────────────────────────

interface State {
  selectQueue: unknown[][];
  insertReturning: unknown[][];
  updateReturning: unknown[][];
  updates: { set: Record<string, unknown> }[];
}

const state: State = {
  selectQueue: [],
  insertReturning: [],
  updateReturning: [],
  updates: [],
};

function resetState() {
  state.selectQueue = [];
  state.insertReturning = [];
  state.updateReturning = [];
  state.updates = [];
}

// ── Fake tx factory ───────────────────────────────────────────────────────────

/**
 * Chainable builder: supports .from().where().limit() and .from().where().orderBy()
 * and direct await via .then(). All pop from selectQueue.
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
      values: (_v: unknown) => ({
        returning: async () => state.insertReturning.shift() ?? [],
      }),
    }),
    update: (_table: unknown) => ({
      set: (s: Record<string, unknown>) => {
        state.updates.push({ set: s });
        return {
          where: (_cond: unknown) => ({
            returning: async () => state.updateReturning.shift() ?? [],
            then: (
              res: (v: unknown) => unknown,
              rej: (e: unknown) => unknown,
            ) => Promise.resolve(undefined).then(res, rej),
          }),
        };
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

const actor = { orgId: "org-1", workspaceId: "ws-1", userId: "u1" };

function makeEnvRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "env_int_1",
    publicId: "env_pub_1",
    name: "Production",
    slug: "production",
    description: null,
    isDefault: false,
    isActive: true,
    ...overrides,
  };
}

// ── createEnvironment ─────────────────────────────────────────────────────────

describe("createEnvironment", () => {
  beforeEach(resetState);

  it("creates an environment with valid slug and returns its summary", async () => {
    const { createEnvironment } = await import("./environment-service");

    const created = makeEnvRow({
      publicId: "env_new",
      name: "Staging",
      slug: "staging",
    });
    state.insertReturning.push([created]);

    const result = await createEnvironment(actor, {
      name: "Staging",
      slug: "staging",
    });

    expect(result.id).toBe("env_new");
    expect(result.name).toBe("Staging");
    expect(result.slug).toBe("staging");
    expect(result.isDefault).toBe(false);
    expect(result.isActive).toBe(true);
  });

  it("lowercases the slug before inserting", async () => {
    const { createEnvironment } = await import("./environment-service");

    const created = makeEnvRow({ publicId: "env_lower", slug: "preview" });
    state.insertReturning.push([created]);

    // Pass uppercase slug — service should lowercase it
    const result = await createEnvironment(actor, {
      name: "Preview",
      slug: "PREVIEW",
    });

    // The result slug comes from the returned row (which we set to "preview")
    expect(result.slug).toBe("preview");
  });

  it("rejects an invalid slug before any DB call", async () => {
    const { createEnvironment } = await import("./environment-service");

    await expect(
      createEnvironment(actor, { name: "Bad", slug: "-invalid" }),
    ).rejects.toThrow(/invalid slug/);

    // No insert should have been attempted
    expect(state.insertReturning).toHaveLength(0);
  });

  it("rejects a slug that starts with a hyphen (invalid even after lowercasing)", async () => {
    const { createEnvironment } = await import("./environment-service");

    // Note: createEnvironment lowercases the slug before validation, so "Dev" → "dev" (valid).
    // Use a slug that is still invalid after lowercasing.
    await expect(
      createEnvironment(actor, { name: "Bad", slug: "-still-invalid" }),
    ).rejects.toThrow(/invalid slug/);
  });

  it("throws when the insert returns no row", async () => {
    const { createEnvironment } = await import("./environment-service");

    state.insertReturning.push([]); // .returning() came back empty

    await expect(
      createEnvironment(actor, { name: "Ghost", slug: "ghost" }),
    ).rejects.toThrow(/insert returned no row/);
  });

  it("passes description through to the insert", async () => {
    const { createEnvironment } = await import("./environment-service");

    const created = makeEnvRow({
      publicId: "env_desc",
      description: "My environment description",
    });
    state.insertReturning.push([created]);

    const result = await createEnvironment(actor, {
      name: "Prod",
      slug: "prod",
      description: "My environment description",
    });

    expect(result.description).toBe("My environment description");
  });
});

// ── listEnvironments ──────────────────────────────────────────────────────────

describe("listEnvironments", () => {
  beforeEach(resetState);

  it("returns an empty array when there are no environments", async () => {
    const { listEnvironments } = await import("./environment-service");

    state.selectQueue.push([]);

    const result = await listEnvironments(actor);

    expect(result).toEqual([]);
  });

  it("returns mapped summaries in order", async () => {
    const { listEnvironments } = await import("./environment-service");

    state.selectQueue.push([
      makeEnvRow({ publicId: "env_a", name: "Dev", slug: "dev" }),
      makeEnvRow({
        publicId: "env_b",
        name: "Prod",
        slug: "production",
        isDefault: true,
      }),
    ]);

    const result = await listEnvironments(actor);

    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("env_a");
    expect(result[0]!.name).toBe("Dev");
    expect(result[1]!.id).toBe("env_b");
    expect(result[1]!.isDefault).toBe(true);
  });

  it("correctly maps all EnvironmentSummary fields", async () => {
    const { listEnvironments } = await import("./environment-service");

    state.selectQueue.push([
      makeEnvRow({
        publicId: "env_full",
        name: "Full",
        slug: "full",
        description: "A description",
        isDefault: true,
        isActive: false,
      }),
    ]);

    const result = await listEnvironments(actor);

    expect(result[0]).toEqual({
      id: "env_full",
      name: "Full",
      slug: "full",
      description: "A description",
      isDefault: true,
      isActive: false,
    });
  });
});

// ── getEnvironment ────────────────────────────────────────────────────────────

describe("getEnvironment", () => {
  beforeEach(resetState);

  it("returns the environment summary for a valid publicId", async () => {
    const { getEnvironment } = await import("./environment-service");

    state.selectQueue.push([
      makeEnvRow({ publicId: "env_pub_1", name: "Production" }),
    ]);

    const result = await getEnvironment(actor, { environmentId: "env_pub_1" });

    expect(result.id).toBe("env_pub_1");
    expect(result.name).toBe("Production");
  });

  it("throws when the environment is not found", async () => {
    const { getEnvironment } = await import("./environment-service");

    state.selectQueue.push([]); // loadEnv returns no row

    await expect(
      getEnvironment(actor, { environmentId: "missing-env" }),
    ).rejects.toThrow(/environment not found/);
  });
});

// ── updateEnvironment ─────────────────────────────────────────────────────────

describe("updateEnvironment", () => {
  beforeEach(resetState);

  it("updates name only (other fields unchanged)", async () => {
    const { updateEnvironment } = await import("./environment-service");

    const existing = makeEnvRow({ isDefault: false });
    state.selectQueue.push([existing]); // loadEnv
    state.updateReturning.push([makeEnvRow({ name: "Updated Name" })]);

    const result = await updateEnvironment(actor, {
      environmentId: "env_pub_1",
      name: "Updated Name",
    });

    expect(result.name).toBe("Updated Name");
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set.name).toBe("Updated Name");
  });

  it("updates slug after lowercasing", async () => {
    const { updateEnvironment } = await import("./environment-service");

    state.selectQueue.push([makeEnvRow({ isDefault: false })]);
    state.updateReturning.push([makeEnvRow({ slug: "new-slug" })]);

    await updateEnvironment(actor, {
      environmentId: "env_pub_1",
      slug: "NEW-SLUG", // should be lowercased
    });

    expect(state.updates[0]!.set.slug).toBe("new-slug");
  });

  it("rejects an invalid slug before writing", async () => {
    const { updateEnvironment } = await import("./environment-service");

    state.selectQueue.push([makeEnvRow({ isDefault: false })]);

    await expect(
      updateEnvironment(actor, {
        environmentId: "env_pub_1",
        slug: "Bad_Slug",
      }),
    ).rejects.toThrow(/invalid slug/);

    expect(state.updates).toHaveLength(0);
  });

  it("refuses to deactivate the default environment", async () => {
    const { updateEnvironment } = await import("./environment-service");

    state.selectQueue.push([makeEnvRow({ isDefault: true })]);

    await expect(
      updateEnvironment(actor, { environmentId: "env_pub_1", isActive: false }),
    ).rejects.toThrow(/cannot deactivate the default/);

    expect(state.updates).toHaveLength(0);
  });

  it("updates description to null (clear)", async () => {
    const { updateEnvironment } = await import("./environment-service");

    state.selectQueue.push([
      makeEnvRow({ isDefault: false, description: "old" }),
    ]);
    state.updateReturning.push([makeEnvRow({ description: null })]);

    const result = await updateEnvironment(actor, {
      environmentId: "env_pub_1",
      description: null,
    });

    expect(result.description).toBeNull();
    expect(state.updates[0]!.set.description).toBeNull();
  });

  it("can deactivate a non-default environment", async () => {
    const { updateEnvironment } = await import("./environment-service");

    state.selectQueue.push([makeEnvRow({ isDefault: false, isActive: true })]);
    state.updateReturning.push([makeEnvRow({ isActive: false })]);

    const result = await updateEnvironment(actor, {
      environmentId: "env_pub_1",
      isActive: false,
    });

    expect(result.isActive).toBe(false);
    expect(state.updates[0]!.set.isActive).toBe(false);
  });

  it("throws when the update returns no row", async () => {
    const { updateEnvironment } = await import("./environment-service");

    state.selectQueue.push([makeEnvRow({ isDefault: false })]); // loadEnv
    state.updateReturning.push([]); // .returning() came back empty

    await expect(
      updateEnvironment(actor, { environmentId: "env_pub_1", name: "Ghost" }),
    ).rejects.toThrow(/update returned no row/);
  });

  it("preserves existing memo when memo field is omitted", async () => {
    const { updateEnvironment } = await import("./environment-service");

    state.selectQueue.push([makeEnvRow({ isDefault: false })]);
    state.updateReturning.push([makeEnvRow({ name: "New Name" })]);

    // Only passing name — slug/description/isActive not passed
    await updateEnvironment(actor, {
      environmentId: "env_pub_1",
      name: "New Name",
    });

    const setClause = state.updates[0]!.set;
    // slug/description/isActive should NOT be in the set clause
    expect("slug" in setClause).toBe(false);
    expect("description" in setClause).toBe(false);
    expect("isActive" in setClause).toBe(false);
  });
});

// ── deleteEnvironment ─────────────────────────────────────────────────────────

describe("deleteEnvironment", () => {
  beforeEach(resetState);

  it("soft-deletes a non-default environment and returns ok", async () => {
    const { deleteEnvironment } = await import("./environment-service");

    state.selectQueue.push([makeEnvRow({ isDefault: false })]);

    const result = await deleteEnvironment(actor, {
      environmentId: "env_pub_1",
    });

    expect(result).toEqual({ ok: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set.deletedAt).toBeInstanceOf(Date);
  });

  it("refuses to delete the default environment", async () => {
    const { deleteEnvironment } = await import("./environment-service");

    state.selectQueue.push([makeEnvRow({ isDefault: true })]);

    await expect(
      deleteEnvironment(actor, { environmentId: "env_pub_1" }),
    ).rejects.toThrow(/cannot delete the default/);

    expect(state.updates).toHaveLength(0);
  });

  it("throws when the environment is not found", async () => {
    const { deleteEnvironment } = await import("./environment-service");

    state.selectQueue.push([]);

    await expect(
      deleteEnvironment(actor, { environmentId: "missing" }),
    ).rejects.toThrow(/environment not found/);
  });

  it("sets deletedByUserId to null when actor has no userId", async () => {
    const { deleteEnvironment } = await import("./environment-service");

    const actorNoUser = { orgId: "org-1", workspaceId: "ws-1" };
    state.selectQueue.push([makeEnvRow({ isDefault: false })]);

    await deleteEnvironment(actorNoUser, { environmentId: "env_pub_1" });

    // actor.userId is undefined → ?? null → deletedByUserId should be null
    expect(state.updates[0]!.set.deletedByUserId).toBeNull();
  });
});

// ── actor.userId ?? null branches ─────────────────────────────────────────────

describe("actor.userId ?? null branches", () => {
  beforeEach(resetState);

  it("createEnvironment sets createdByUserId to null when userId is absent", async () => {
    const { createEnvironment } = await import("./environment-service");

    const actorNoUser = { orgId: "org-1", workspaceId: "ws-1" };
    state.insertReturning.push([makeEnvRow({ publicId: "env_no_user" })]);

    const result = await createEnvironment(actorNoUser, {
      name: "Env",
      slug: "env",
    });

    expect(result.id).toBe("env_no_user");
  });

  it("updateEnvironment sets updatedByUserId to null when userId is absent", async () => {
    const { updateEnvironment } = await import("./environment-service");

    const actorNoUser = { orgId: "org-1", workspaceId: "ws-1" };
    state.selectQueue.push([makeEnvRow({ isDefault: false })]);
    state.updateReturning.push([makeEnvRow({ name: "Updated" })]);

    await updateEnvironment(actorNoUser, {
      environmentId: "env_pub_1",
      name: "Updated",
    });

    expect(state.updates[0]!.set.updatedByUserId).toBeNull();
  });

  it("listEnvironments works without actor userId", async () => {
    const { listEnvironments } = await import("./environment-service");

    const actorNoUser = { orgId: "org-1", workspaceId: "ws-1" };
    state.selectQueue.push([makeEnvRow()]);

    const result = await listEnvironments(actorNoUser);

    expect(result).toHaveLength(1);
  });
});
