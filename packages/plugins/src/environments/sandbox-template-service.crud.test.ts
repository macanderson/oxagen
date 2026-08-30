/**
 * sandbox-template-service.crud.test.ts
 *
 * Direct unit coverage for the sandbox-template CRUD + binding surface that the
 * pack-install and run-resolution specs don't touch:
 *   createTemplate / listTemplates / getTemplate / updateTemplate /
 *   deleteTemplate / setDefaultTemplate / setTemplateTools /
 *   exportTemplate / importTemplate /
 *   bindAgentEnvironment / unbindAgentEnvironment / listAgentBindings
 *
 * Both the happy path and the guard branches are exercised: invalid-slug throws,
 * the delete-/deactivate-default guards, atomic default demote-then-promote,
 * replace-set tool semantics, the only-one-primary binding swap, and the
 * secretSelection { keyPublicIds } export→import round-trip (manifests travel by
 * NAME; import remaps names → this workspace's key public ids, or falls back to
 * "all" when nothing resolves).
 *
 * The vault service is mocked (its own tx is out of scope); @oxagen/database
 * withTenantDb runs the callback against a queue-driven fake tx: each select()
 * shifts one result set off `selectQueue`, each insert().returning() shifts off
 * `insertReturning`. Seed the queues in the exact order the service issues them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxTemplateManifest,
  SandboxTemplatePackages,
} from "@oxagen/oxagen/contracts";

// ── Capture state ─────────────────────────────────────────────────────────────

interface InsertCall {
  table: unknown;
  values: unknown;
}
interface UpdateCall {
  table: unknown;
  set: Record<string, unknown>;
}
interface State {
  selectQueue: unknown[][];
  insertReturning: unknown[][];
  updateReturning: unknown[][];
  inserts: InsertCall[];
  updates: UpdateCall[];
  deletes: unknown[];
}

const state: State = {
  selectQueue: [],
  insertReturning: [],
  updateReturning: [],
  inserts: [],
  updates: [],
  deletes: [],
};

function resetState() {
  state.selectQueue = [];
  state.insertReturning = [];
  state.updateReturning = [];
  state.inserts = [];
  state.updates = [];
  state.deletes = [];
}

// ── Fake tx factory ───────────────────────────────────────────────────────────

function makeChain(result: unknown[]) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    innerJoin: () => chain,
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
    select: (_cols: unknown) => makeChain(state.selectQueue.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        state.inserts.push({ table, values });
        return {
          returning: async () => state.insertReturning.shift() ?? [],
          // Awaited directly (the tools insert has no .returning()).
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(undefined).then(res, rej),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        state.updates.push({ table, set });
        return {
          where: () => ({
            returning: async () => state.updateReturning.shift() ?? [],
            // Most update() calls in this service are awaited directly (no
            // .returning()) — keep that thenable path working too.
            then: (
              res: (v: unknown) => unknown,
              rej: (e: unknown) => unknown,
            ) => Promise.resolve(undefined).then(res, rej),
          }),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        state.deletes.push(table);
        return Promise.resolve(undefined);
      },
    }),
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const vaultMocks = vi.hoisted(() => ({
  listSecretKeys: vi.fn(),
  upsertSecretKey: vi.fn(),
}));

vi.mock("../vault/vault-secret-service", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../vault/vault-secret-service")>();
  return {
    ...real,
    listSecretKeys: vaultMocks.listSecretKeys,
    upsertSecretKey: vaultMocks.upsertSecretKey,
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

import {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  setDefaultTemplate,
  setTemplateTools,
  exportTemplate,
  importTemplate,
  bindAgentEnvironment,
  unbindAgentEnvironment,
  listAgentBindings,
} from "./sandbox-template-service";
import { schema } from "@oxagen/database";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const actor = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };

/** A template row as projected by TEMPLATE_COLUMNS (loadTemplateRow). */
function tplRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sbx-int",
    publicId: "sbx-pub",
    environmentInternalId: "env-int",
    environmentPublicId: "env-pub",
    environmentName: "Prod",
    environmentSlug: "prod",
    name: "Base Runner",
    slug: "base-runner",
    description: null,
    isDefault: false,
    isActive: true,
    provider: "modal",
    runtime: null,
    resources: { vcpu: 2 },
    network: { mode: "public" },
    secretSelection: "all",
    literalEnv: {},
    ...overrides,
  };
}

function envRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "env-int",
    name: "Prod",
    slug: "prod",
    isActive: true,
    ...overrides,
  };
}

function toolSelectRow(overrides: Record<string, unknown> = {}) {
  return {
    sandboxTemplateId: "sbx-int",
    publicId: "tool-pub",
    kind: "capability",
    ref: "execute_code",
    config: {},
    ...overrides,
  };
}

function templateInserts() {
  return state.inserts.filter((c) => c.table === schema.sandboxTemplates);
}
function toolInserts() {
  return state.inserts.filter((c) => c.table === schema.sandboxTemplateTools);
}
function templateUpdates() {
  return state.updates.filter((u) => u.table === schema.sandboxTemplates);
}

beforeEach(() => {
  resetState();
  vaultMocks.listSecretKeys.mockReset();
  vaultMocks.upsertSecretKey.mockReset();
  vaultMocks.upsertSecretKey.mockResolvedValue({ id: "key-pub" });
});

// ── createTemplate ─────────────────────────────────────────────────────────────

describe("createTemplate", () => {
  it("inserts a non-default template with provider defaults and returns the summary", async () => {
    state.selectQueue = [[envRow()], [tplRow()], []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    const result = await createTemplate(actor, {
      environmentId: "env-pub",
      name: "Base Runner",
      slug: "Base-Runner", // upper-cased → lowered before insert
    });

    expect(result.id).toBe("sbx-pub");
    expect(result.slug).toBe("base-runner");
    const values = templateInserts()[0]!.values as Record<string, unknown>;
    expect(values.environmentId).toBe("env-int");
    expect(values.isDefault).toBe(false);
    expect(values.slug).toBe("base-runner");
    expect(values.provider).toBe("modal"); // default
    expect(values.workspaceId).toBe("ws-1");
  });

  it("throws on an invalid slug before touching the DB", async () => {
    await expect(
      createTemplate(actor, {
        environmentId: "env-pub",
        name: "x",
        slug: "Bad Slug!",
      }),
    ).rejects.toThrow(/invalid slug/i);
    expect(templateInserts()).toHaveLength(0);
  });

  it("replace-set inserts the initial tools when provided", async () => {
    state.selectQueue = [[envRow()], [tplRow()], [toolSelectRow()]];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    const result = await createTemplate(actor, {
      environmentId: "env-pub",
      name: "Base Runner",
      slug: "base-runner",
      tools: [{ kind: "capability", ref: "execute_code" }],
    });

    // Old rows cleared, new rows inserted (replace-set).
    expect(state.deletes).toContain(schema.sandboxTemplateTools);
    expect(toolInserts()).toHaveLength(1);
    expect(result.tools).toEqual([
      { id: "tool-pub", kind: "capability", ref: "execute_code", config: {} },
    ]);
  });

  it("setAsDefault clears the env default then promotes atomically", async () => {
    state.selectQueue = [[envRow()], [tplRow({ isDefault: true })], []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    await createTemplate(actor, {
      environmentId: "env-pub",
      name: "Base Runner",
      slug: "base-runner",
      setAsDefault: true,
    });

    const ups = templateUpdates();
    // clearEnvDefaultTx (isDefault:false) THEN promote (isDefault:true) — same tx.
    expect(ups[0]!.set.isDefault).toBe(false);
    expect(ups[1]!.set.isDefault).toBe(true);
  });
});

// ── listTemplates / getTemplate ─────────────────────────────────────────────────

describe("listTemplates", () => {
  it("returns summaries with batched tools, no env filter", async () => {
    state.selectQueue = [
      [
        tplRow(),
        tplRow({ id: "sbx-2", publicId: "sbx-2-pub", slug: "swe-runner" }),
      ],
      [
        toolSelectRow(),
        toolSelectRow({ sandboxTemplateId: "sbx-2", publicId: "tool-2" }),
      ],
    ];

    const result = await listTemplates(actor);

    expect(result).toHaveLength(2);
    expect(result[0]!.tools).toHaveLength(1);
    expect(result[1]!.slug).toBe("swe-runner");
  });

  it("resolves the environment first when filtered by environmentId", async () => {
    state.selectQueue = [[envRow()], [tplRow()], []];
    const result = await listTemplates(actor, { environmentId: "env-pub" });
    expect(result).toHaveLength(1);
    expect(result[0]!.environmentId).toBe("env-pub");
  });
});

describe("getTemplate", () => {
  it("loads the template with its tools", async () => {
    state.selectQueue = [[tplRow()], [toolSelectRow()]];
    const result = await getTemplate(actor, { templateId: "sbx-pub" });
    expect(result.id).toBe("sbx-pub");
    expect(result.tools).toHaveLength(1);
  });
});

// ── updateTemplate ──────────────────────────────────────────────────────────────

describe("updateTemplate", () => {
  it("applies the changed fields and returns the reloaded summary", async () => {
    state.selectQueue = [[tplRow()], [tplRow({ name: "Renamed" })], []];
    const result = await updateTemplate(actor, {
      templateId: "sbx-pub",
      name: "Renamed",
    });
    expect(result.name).toBe("Renamed");
    expect(templateUpdates()[0]!.set.name).toBe("Renamed");
  });

  it("throws on an invalid slug", async () => {
    state.selectQueue = [[tplRow()]];
    await expect(
      updateTemplate(actor, { templateId: "sbx-pub", slug: "Bad Slug!" }),
    ).rejects.toThrow(/invalid slug/i);
  });

  it("refuses to deactivate the default template", async () => {
    state.selectQueue = [[tplRow({ isDefault: true })]];
    await expect(
      updateTemplate(actor, { templateId: "sbx-pub", isActive: false }),
    ).rejects.toThrow(/cannot deactivate the default template/i);
    expect(templateUpdates()).toHaveLength(0);
  });
});

// ── deleteTemplate ──────────────────────────────────────────────────────────────

describe("deleteTemplate", () => {
  it("soft-deletes a non-default template", async () => {
    state.selectQueue = [[tplRow({ isDefault: false })]];
    const result = await deleteTemplate(actor, { templateId: "sbx-pub" });
    expect(result).toEqual({ ok: true });
    expect(templateUpdates()[0]!.set.deletedAt).toBeInstanceOf(Date);
  });

  it("refuses to delete the default template", async () => {
    state.selectQueue = [[tplRow({ isDefault: true })]];
    await expect(
      deleteTemplate(actor, { templateId: "sbx-pub" }),
    ).rejects.toThrow(/cannot delete the default template/i);
    expect(templateUpdates()).toHaveLength(0);
  });
});

// ── setDefaultTemplate ──────────────────────────────────────────────────────────

describe("setDefaultTemplate", () => {
  it("demotes the previous sibling then promotes the target atomically", async () => {
    state.selectQueue = [[tplRow()], [tplRow({ isDefault: true })], []];
    const result = await setDefaultTemplate(actor, { templateId: "sbx-pub" });

    const ups = templateUpdates();
    expect(ups).toHaveLength(2);
    // clearEnvDefaultTx demotes the env's current default…
    expect(ups[0]!.set.isDefault).toBe(false);
    // …then the target is promoted (and reactivated) in the same tx.
    expect(ups[1]!.set.isDefault).toBe(true);
    expect(ups[1]!.set.isActive).toBe(true);
    expect(result.id).toBe("sbx-pub");
  });
});

// ── setTemplateTools ────────────────────────────────────────────────────────────

describe("setTemplateTools", () => {
  it("replaces the tool set — old rows deleted, new rows inserted", async () => {
    state.selectQueue = [
      [tplRow()],
      [tplRow()],
      [
        toolSelectRow({
          kind: "agent_skill",
          ref: "swe-bench",
          publicId: "t-new",
        }),
      ],
    ];

    const result = await setTemplateTools(actor, {
      templateId: "sbx-pub",
      tools: [{ kind: "agent_skill", ref: "swe-bench" }],
    });

    expect(state.deletes).toContain(schema.sandboxTemplateTools);
    const inserted = toolInserts()[0]!.values as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.kind).toBe("agent_skill");
    expect(inserted[0]!.ref).toBe("swe-bench");
    // Reloaded summary reflects the new set.
    expect(result.tools).toEqual([
      { id: "t-new", kind: "agent_skill", ref: "swe-bench", config: {} },
    ]);
  });
});

// ── export / import secret-selection round-trip ─────────────────────────────────

describe("exportTemplate — secretSelection { keyPublicIds }", () => {
  it("carries only the selected key NAMES in the manifest (never ids or values)", async () => {
    state.selectQueue = [
      [tplRow({ secretSelection: { keyPublicIds: ["kp1"] } })],
      [],
    ];
    vaultMocks.listSecretKeys.mockResolvedValue([
      {
        id: "kp1",
        key: "AWS_KEY",
        sensitive: true,
        memo: null,
        hasDefault: false,
        overrideEnvironmentIds: [],
      },
      {
        id: "kp2",
        key: "OTHER_KEY",
        sensitive: false,
        memo: "note",
        hasDefault: false,
        overrideEnvironmentIds: [],
      },
    ]);

    const manifest = await exportTemplate(actor, { templateId: "sbx-pub" });

    // Only the SELECTED key surfaces, by NAME, and marked required.
    expect(manifest.secretKeys).toEqual([
      { key: "AWS_KEY", sensitive: true, memo: null, required: true },
    ]);
    // No public id / raw value ever leaks into a manifest secret entry.
    for (const k of manifest.secretKeys) {
      expect("id" in k).toBe(false);
      expect("publicId" in k).toBe(false);
      expect("value" in k).toBe(false);
    }
  });

  it("emits every live key as an optional entry when the selection is 'all'", async () => {
    state.selectQueue = [[tplRow({ secretSelection: "all" })], []];
    vaultMocks.listSecretKeys.mockResolvedValue([
      {
        id: "kp1",
        key: "AWS_KEY",
        sensitive: true,
        memo: null,
        hasDefault: false,
        overrideEnvironmentIds: [],
      },
      {
        id: "kp2",
        key: "OTHER_KEY",
        sensitive: false,
        memo: "note",
        hasDefault: false,
        overrideEnvironmentIds: [],
      },
    ]);

    const manifest = await exportTemplate(actor, { templateId: "sbx-pub" });

    expect(manifest.secretSelection).toBe("all");
    expect(manifest.secretKeys.map((k) => k.key)).toEqual([
      "AWS_KEY",
      "OTHER_KEY",
    ]);
    expect(manifest.secretKeys.every((k) => k.required === false)).toBe(true);
  });
});

const IMPORT_MANIFEST: SandboxTemplateManifest = {
  kind: "oxagen.sandbox-template",
  version: 1,
  name: "Base Runner",
  slug: "base-runner",
  description: null,
  provider: "modal",
  runtime: null,
  resources: { vcpu: 2, memoryMb: 2048, timeoutMs: 60_000, diskMb: 4096 },
  network: { mode: "public" },
  // The manifest's ids are FOREIGN — import must ignore them and remap by name.
  secretSelection: { keyPublicIds: ["remote-kp1"] },
  literalEnv: {},
  packages: [{ manager: "apt", names: ["git", "curl"] }],
  tools: [],
  secretKeys: [{ key: "AWS_KEY", sensitive: true, memo: null, required: true }],
};

describe("importTemplate — secretSelection round-trip", () => {
  it("remaps the required key NAME to this workspace's local public id", async () => {
    // Same NAME, DIFFERENT local public id than the manifest carried.
    vaultMocks.listSecretKeys.mockResolvedValue([
      {
        id: "local-99",
        key: "AWS_KEY",
        sensitive: true,
        memo: null,
        hasDefault: false,
        overrideEnvironmentIds: [],
      },
    ]);
    state.selectQueue = [
      [envRow()],
      [] /* no slug collision */,
      [tplRow({ id: "new-int", publicId: "new-pub" })],
      [],
    ];
    state.insertReturning = [[{ id: "new-int", publicId: "new-pub" }]];

    const { template } = await importTemplate(actor, {
      environmentId: "env-pub",
      manifest: IMPORT_MANIFEST,
    });

    expect(template.id).toBe("new-pub");
    // AWS_KEY resolved to the LOCAL id, never the foreign "remote-kp1".
    const values = templateInserts()[0]!.values as Record<string, unknown>;
    expect(values.secretSelection).toEqual({ keyPublicIds: ["local-99"] });
    // No pre-existing key means no upsert — the name already resolves.
    expect(vaultMocks.upsertSecretKey).not.toHaveBeenCalled();
  });

  it("falls back to 'all' when no required name resolves in the workspace", async () => {
    // The name is missing → upserted → but the re-read still doesn't surface it,
    // so nothing resolves and the selection degrades to 'all'.
    vaultMocks.listSecretKeys.mockResolvedValue([]);
    state.selectQueue = [[envRow()], [], [tplRow()], []];
    state.insertReturning = [[{ id: "new-int", publicId: "new-pub" }]];

    await importTemplate(actor, {
      environmentId: "env-pub",
      manifest: IMPORT_MANIFEST,
    });

    const values = templateInserts()[0]!.values as Record<string, unknown>;
    expect(values.secretSelection).toBe("all");
    // The missing key was still upserted by NAME only.
    expect(vaultMocks.upsertSecretKey).toHaveBeenCalledTimes(1);
    const [, keyInput] = vaultMocks.upsertSecretKey.mock.calls[0]!;
    expect(keyInput).toEqual({ key: "AWS_KEY", sensitive: true, memo: null });
  });

  it("hard-errors on a slug collision unless a slug override is given", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([]);
    state.selectQueue = [[envRow()], [{ id: "existing-int" }] /* slug taken */];

    await expect(
      importTemplate(actor, {
        environmentId: "env-pub",
        manifest: IMPORT_MANIFEST,
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("replace-sets the manifest's tools and promotes to default when setAsDefault is true", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([
      {
        id: "local-99",
        key: "AWS_KEY",
        sensitive: true,
        memo: null,
        hasDefault: false,
        overrideEnvironmentIds: [],
      },
    ]);
    const manifestWithTools: SandboxTemplateManifest = {
      ...IMPORT_MANIFEST,
      tools: [{ kind: "capability", ref: "execute_code" }],
    };
    state.selectQueue = [
      [envRow()],
      [] /* no slug collision */,
      [tplRow({ id: "new-int", publicId: "new-pub" })],
      [toolSelectRow({ sandboxTemplateId: "new-int", publicId: "tool-new" })],
    ];
    state.insertReturning = [[{ id: "new-int", publicId: "new-pub" }]];

    const { template, warnings } = await importTemplate(actor, {
      environmentId: "env-pub",
      manifest: manifestWithTools,
      setAsDefault: true,
    });

    expect(template.id).toBe("new-pub");
    expect(warnings).toEqual([
      expect.stringContaining(
        'tool "capability:execute_code" is referenced by the manifest',
      ),
    ]);
    // Replace-set: old rows cleared, new rows inserted.
    expect(state.deletes).toContain(schema.sandboxTemplateTools);
    expect(toolInserts()).toHaveLength(1);
    // clearEnvDefaultTx demotes the env's current default, THEN promotes this one.
    const ups = templateUpdates();
    expect(ups).toHaveLength(2);
    expect(ups[0]!.set.isDefault).toBe(false);
    expect(ups[1]!.set.isDefault).toBe(true);
    expect(ups[1]!.set.isActive).toBe(true);
  });
});

// ── agent-environment bindings ──────────────────────────────────────────────────

function bindingRow(overrides: Record<string, unknown> = {}) {
  return {
    publicId: "bind-pub",
    agentId: "11111111-1111-4111-8111-111111111111",
    environmentInternalId: "env-int",
    sandboxTemplateInternalId: null,
    isPrimary: true,
    ...overrides,
  };
}
function envSummaryRow(overrides: Record<string, unknown> = {}) {
  return { publicId: "env-pub", name: "Prod", slug: "prod", ...overrides };
}

describe("bindAgentEnvironment", () => {
  it("creates the agent's first binding as primary", async () => {
    state.selectQueue = [
      [envRow()],
      [] /* existingForAgent: none */,
      [bindingRow()],
      [envSummaryRow()],
    ];
    state.insertReturning = [[{ publicId: "bind-pub" }]];

    const result = await bindAgentEnvironment(actor, {
      agentId: "11111111-1111-4111-8111-111111111111",
      environmentId: "env-pub",
    });

    expect(result.isPrimary).toBe(true);
    expect(result.environmentName).toBe("Prod");
    expect(result.sandboxTemplateId).toBeNull();
  });

  it("resolves an agt_ public id to the internal uuid before querying bindings", async () => {
    // The app UI sends the agent's PUBLIC id; the agent_id column is a uuid,
    // so the id must resolve before it reaches the query.
    state.selectQueue = [
      [
        { id: "33333333-3333-4333-8333-333333333333" },
      ] /* agent lookup by publicId */,
      [envRow()],
      [] /* existingForAgent: none */,
      [bindingRow()],
      [envSummaryRow()],
    ];
    state.insertReturning = [[{ publicId: "bind-pub" }]];

    const result = await bindAgentEnvironment(actor, {
      agentId: "agt_e2etest123",
      environmentId: "env-pub",
    });

    expect(result.isPrimary).toBe(true);
    const inserted = state.inserts.find(
      (i) => i.table === schema.agentEnvironmentBindings,
    );
    expect(inserted?.values).toMatchObject({
      agentId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("demotes the agent's current primary when a new primary is bound (only-one-primary)", async () => {
    state.selectQueue = [
      [envRow({ id: "env-b-int" })],
      [{ id: "b1", environmentInternalId: "env-a-int", isPrimary: true }],
      [bindingRow({ publicId: "bind2", environmentInternalId: "env-b-int" })],
      [envSummaryRow()],
    ];
    state.insertReturning = [[{ publicId: "bind2" }]];

    const result = await bindAgentEnvironment(actor, {
      agentId: "11111111-1111-4111-8111-111111111111",
      environmentId: "env-pub-b",
      isPrimary: true,
    });

    // The previous primary was demoted in the same tx.
    const demote = state.updates.find(
      (u) =>
        u.table === schema.agentEnvironmentBindings &&
        u.set.isPrimary === false,
    );
    expect(demote).toBeDefined();
    expect(result.isPrimary).toBe(true);
  });

  it("accepts a sandboxTemplateId that matches the bound environment and resolves its name in the summary", async () => {
    state.selectQueue = [
      [envRow()], // loadEnvironment
      [tplRow()], // loadTemplateRow (sandboxTemplateId check, same environment)
      [] /* existingForAgent: none */,
      [
        bindingRow({
          publicId: "bind-pub-new",
          sandboxTemplateInternalId: "sbx-int",
          isPrimary: true,
        }),
      ],
      [envSummaryRow()],
      [{ publicId: "sbx-pub", name: "Base Runner" }], // bindingSummary's template lookup
    ];
    state.insertReturning = [[{ publicId: "bind-pub-new" }]];

    const result = await bindAgentEnvironment(actor, {
      agentId: "11111111-1111-4111-8111-111111111111",
      environmentId: "env-pub",
      sandboxTemplateId: "sbx-pub",
    });

    expect(result.sandboxTemplateId).toBe("sbx-pub");
    expect(result.sandboxTemplateName).toBe("Base Runner");
    expect(result.isPrimary).toBe(true);
  });

  it("rebinds an existing (agent, environment) pair by updating it in place (no duplicate insert)", async () => {
    state.selectQueue = [
      [envRow()], // loadEnvironment
      [
        { id: "bind-int-1", environmentInternalId: "env-int", isPrimary: true },
      ] /* existingForAgent */,
      [
        bindingRow({
          publicId: "bind-pub-rebind",
          sandboxTemplateInternalId: null,
          isPrimary: false,
        }),
      ],
      [envSummaryRow()],
    ];
    state.updateReturning = [[{ publicId: "bind-pub-rebind" }]];

    const result = await bindAgentEnvironment(actor, {
      agentId: "11111111-1111-4111-8111-111111111111",
      environmentId: "env-pub",
      // Agent already has a primary binding elsewhere, and doesn't ask to
      // become primary here — desiredPrimary resolves to false, so this
      // exercises the update-in-place branch without the demote step.
    });

    expect(result.id).toBe("bind-pub-rebind");
    expect(result.isPrimary).toBe(false);
    // Updated in place, not inserted.
    const bindingUpdates = state.updates.filter(
      (u) => u.table === schema.agentEnvironmentBindings,
    );
    expect(bindingUpdates).toHaveLength(1);
    const inserted = state.inserts.find(
      (i) => i.table === schema.agentEnvironmentBindings,
    );
    expect(inserted).toBeUndefined();
  });

  it("rejects a template that belongs to a different environment", async () => {
    state.selectQueue = [
      [envRow({ id: "env-a-int" })],
      [tplRow({ environmentInternalId: "env-b-int" })],
    ];

    await expect(
      bindAgentEnvironment(actor, {
        agentId: "11111111-1111-4111-8111-111111111111",
        environmentId: "env-pub",
        sandboxTemplateId: "sbx-pub",
      }),
    ).rejects.toThrow(/must belong to the bound environment/i);
  });
});

describe("unbindAgentEnvironment", () => {
  it("deletes the (agent, environment) binding", async () => {
    state.selectQueue = [[envRow()]];
    const result = await unbindAgentEnvironment(actor, {
      agentId: "11111111-1111-4111-8111-111111111111",
      environmentId: "env-pub",
    });
    expect(result).toEqual({ ok: true });
    expect(state.deletes).toContain(schema.agentEnvironmentBindings);
  });
});

describe("listAgentBindings", () => {
  it("returns each binding resolved to its environment names", async () => {
    state.selectQueue = [[bindingRow()], [envSummaryRow()]];
    const result = await listAgentBindings(actor, {
      agentId: "11111111-1111-4111-8111-111111111111",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.environmentName).toBe("Prod");
    expect(result[0]!.isPrimary).toBe(true);
  });
});

// ── packages round-trip (create → get/list → update → export) ────────────────────

describe("sandbox-template packages", () => {
  const initial: SandboxTemplatePackages = [
    { manager: "npm", names: ["react", "typescript"] },
  ];
  const changed: SandboxTemplatePackages = [
    { manager: "pip", names: ["fastapi", "pydantic==2.5"] },
  ];

  it("createTemplate persists packages and returns them in the summary", async () => {
    // env lookup, reloaded template row (carries packages), tools.
    state.selectQueue = [[envRow()], [tplRow({ packages: initial })], []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    const result = await createTemplate(actor, {
      environmentId: "env-pub",
      name: "Base Runner",
      slug: "base-runner",
      packages: initial,
    });

    // The insert carried the packages payload through to the DB.
    const values = templateInserts()[0]!.values as Record<string, unknown>;
    expect(values.packages).toEqual(initial);
    // The reloaded summary surfaces them.
    expect(result.packages).toEqual(initial);
  });

  it("defaults packages to [] when the create input omits them", async () => {
    // tplRow() has no packages key → toSummary coalesces to [].
    state.selectQueue = [[envRow()], [tplRow()], []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    const result = await createTemplate(actor, {
      environmentId: "env-pub",
      name: "Base Runner",
      slug: "base-runner",
    });

    const values = templateInserts()[0]!.values as Record<string, unknown>;
    expect(values.packages).toEqual([]);
    expect(result.packages).toEqual([]);
  });

  it("getTemplate returns the stored packages", async () => {
    state.selectQueue = [[tplRow({ packages: initial })], []];
    const result = await getTemplate(actor, { templateId: "sbx-pub" });
    expect(result.packages).toEqual(initial);
  });

  it("listTemplates carries packages on each summary", async () => {
    state.selectQueue = [[tplRow({ packages: initial })], []];
    const result = await listTemplates(actor);
    expect(result).toHaveLength(1);
    expect(result[0]!.packages).toEqual(initial);
  });

  it("updateTemplate writes the new packages and reflects them in the summary", async () => {
    // existing row (old packages), reloaded row (new packages), tools.
    state.selectQueue = [
      [tplRow({ packages: initial })],
      [tplRow({ packages: changed })],
      [],
    ];
    const result = await updateTemplate(actor, {
      templateId: "sbx-pub",
      packages: changed,
    });
    // The update SET carried the new packages payload.
    expect(templateUpdates()[0]!.set.packages).toEqual(changed);
    // The reloaded summary reflects the change.
    expect(result.packages).toEqual(changed);
  });

  it("updateTemplate leaves packages untouched when the input omits them", async () => {
    state.selectQueue = [
      [tplRow({ packages: initial })],
      [tplRow({ packages: initial })],
      [],
    ];
    await updateTemplate(actor, { templateId: "sbx-pub", name: "Renamed" });
    // packages is only written when input.packages !== undefined.
    expect("packages" in templateUpdates()[0]!.set).toBe(false);
  });

  it("exportTemplate includes the template's packages in the manifest", async () => {
    // getTemplate: reloaded row + tools; then listSecretKeys is mocked below.
    state.selectQueue = [[tplRow({ packages: initial })], []];
    vaultMocks.listSecretKeys.mockResolvedValue([]);

    const manifest = await exportTemplate(actor, { templateId: "sbx-pub" });
    expect(manifest.packages).toEqual(initial);
  });
});
