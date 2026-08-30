/**
 * install-templates-from-pack.test.ts
 *
 * Covers installTemplatesFromPack (plugin-pack distribution of portable
 * sandbox templates):
 *  - seeds the template into the workspace DEFAULT environment (non-default)
 *  - re-install is idempotent (updates in place, no duplicate)
 *  - a bare-slug collision with an UNRELATED template (in another environment)
 *    falls back to a pack-namespaced slug
 *  - missing secret keys are upserted by NAME only (never a value); existing
 *    keys are left untouched
 *
 * The vault service is mocked (its own tx is out of scope here); @oxagen/database
 * withTenantDb runs the callback against a queue-driven fake tx.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxTemplateManifest } from "@oxagen/oxagen/contracts";

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
  inserts: InsertCall[];
  updates: UpdateCall[];
  deletes: unknown[];
}

const state: State = {
  selectQueue: [],
  insertReturning: [],
  inserts: [],
  updates: [],
  deletes: [],
};

function resetState() {
  state.selectQueue = [];
  state.insertReturning = [];
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
          // Awaited directly (tools insert has no .returning()).
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(undefined).then(res, rej),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        state.updates.push({ table, set });
        return {
          where: () => Promise.resolve(undefined),
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

import { installTemplatesFromPack } from "./sandbox-template-service";
import { schema } from "@oxagen/database";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const actor = { orgId: "org-1", workspaceId: "ws-1", userId: "user-1" };
const PACK_ID = "oxagen/swe-bench-evals";

const templateManifest: SandboxTemplateManifest = {
  kind: "oxagen.sandbox-template",
  version: 1,
  name: "SWE-bench prewarmed",
  slug: "swe-bench-prewarmed",
  description: "prewarmed eval sandbox",
  provider: "modal",
  runtime: "ghcr.io/x/y@sha256:" + "0".repeat(64),
  resources: { vcpu: 2, memoryMb: 4096, timeoutMs: 300_000, diskMb: 10_240 },
  network: { mode: "public" },
  secretSelection: "all",
  literalEnv: {},
  packages: [{ manager: "pip", names: ["pytest", "swebench"] }],
  tools: [
    { kind: "capability", ref: "execute_code" },
    { kind: "agent_skill", ref: "swe-bench" },
  ],
  secretKeys: [
    {
      key: "AI_GATEWAY_API_KEY",
      sensitive: true,
      required: true,
      memo: "gateway key",
    },
  ],
};

const DEFAULT_ENV = [{ id: "env-default" }];

beforeEach(() => {
  resetState();
  vaultMocks.listSecretKeys.mockReset();
  vaultMocks.upsertSecretKey.mockReset();
  vaultMocks.upsertSecretKey.mockResolvedValue({ id: "key-pub" });
});

function templateInserts() {
  return state.inserts.filter((c) => c.table === schema.sandboxTemplates);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("installTemplatesFromPack — seed into default environment", () => {
  it("creates a non-default template in the workspace default environment", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([]); // key missing → upserted
    state.selectQueue = [DEFAULT_ENV, /* existing slug rows */ []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    const result = await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [templateManifest],
    });

    expect(result.installed).toEqual([
      { slug: "swe-bench-prewarmed", templateId: "sbx-pub", created: true },
    ]);
    const inserts = templateInserts();
    expect(inserts).toHaveLength(1);
    const values = inserts[0]!.values as Record<string, unknown>;
    expect(values.environmentId).toBe("env-default");
    expect(values.isDefault).toBe(false);
    expect(values.slug).toBe("swe-bench-prewarmed");
    expect(values.workspaceId).toBe("ws-1");
    // Tools were preloaded (replace-set) → advisory warnings returned.
    expect(result.warnings.length).toBe(2);
  });

  it("upserts the missing secret key by NAME only — no value fields", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([]);
    state.selectQueue = [DEFAULT_ENV, []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [templateManifest],
    });

    expect(vaultMocks.upsertSecretKey).toHaveBeenCalledTimes(1);
    const [, keyInput] = vaultMocks.upsertSecretKey.mock.calls[0]!;
    expect(keyInput).toEqual({
      key: "AI_GATEWAY_API_KEY",
      sensitive: true,
      memo: "gateway key",
    });
    expect("defaultValue" in (keyInput as object)).toBe(false);
    expect("value" in (keyInput as object)).toBe(false);
  });

  it("does not re-upsert a secret key that already exists", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([
      { id: "k1", key: "AI_GATEWAY_API_KEY", sensitive: true, memo: null },
    ]);
    state.selectQueue = [DEFAULT_ENV, []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [templateManifest],
    });

    expect(vaultMocks.upsertSecretKey).not.toHaveBeenCalled();
  });
});

describe("installTemplatesFromPack — idempotent re-install", () => {
  it("updates the existing default-env template in place, no duplicate insert", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([
      { id: "k1", key: "AI_GATEWAY_API_KEY", sensitive: true, memo: null },
    ]);
    // Existing template already holds the bare slug in the default environment.
    state.selectQueue = [
      DEFAULT_ENV,
      [
        {
          id: "sbx-int",
          publicId: "sbx-pub",
          slug: "swe-bench-prewarmed",
          environmentId: "env-default",
        },
      ],
    ];

    const result = await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [templateManifest],
    });

    expect(result.installed).toEqual([
      { slug: "swe-bench-prewarmed", templateId: "sbx-pub", created: false },
    ]);
    // No new template row — updated in place.
    expect(templateInserts()).toHaveLength(0);
    const tplUpdates = state.updates.filter(
      (u) => u.table === schema.sandboxTemplates,
    );
    expect(tplUpdates).toHaveLength(1);
    expect(tplUpdates[0]!.set.isActive).toBe(true);
  });
});

describe("installTemplatesFromPack — slug collision with an unrelated template", () => {
  it("falls back to a pack-namespaced slug when the bare slug lives in another environment", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([
      { id: "k1", key: "AI_GATEWAY_API_KEY", sensitive: true, memo: null },
    ]);
    // A DIFFERENT, unrelated template already owns the bare slug in another env.
    state.selectQueue = [
      DEFAULT_ENV,
      [
        {
          id: "sbx-other",
          publicId: "sbx-other-pub",
          slug: "swe-bench-prewarmed",
          environmentId: "env-other",
        },
      ],
    ];
    state.insertReturning = [[{ id: "sbx-new", publicId: "sbx-new-pub" }]];

    const result = await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [templateManifest],
    });

    expect(result.installed).toEqual([
      {
        slug: "swe-bench-evals-swe-bench-prewarmed",
        templateId: "sbx-new-pub",
        created: true,
      },
    ]);
    const inserts = templateInserts();
    expect(inserts).toHaveLength(1);
    expect((inserts[0]!.values as Record<string, unknown>).slug).toBe(
      "swe-bench-evals-swe-bench-prewarmed",
    );
  });
});

describe("installTemplatesFromPack — re-install onto an already-prefixed slug", () => {
  it("finds and updates the pack's own prior namespaced-slug install (byPrefixed match)", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([
      { id: "k1", key: "AI_GATEWAY_API_KEY", sensitive: true, memo: null },
    ]);
    // A prior install already claimed the pack-namespaced slug directly
    // (e.g. because the bare slug collided with an unrelated template last
    // time) — a re-install must find THAT row via the prefixed match, not
    // treat it as a fresh bare-slug install.
    state.selectQueue = [
      DEFAULT_ENV,
      [
        {
          id: "sbx-prefixed",
          publicId: "sbx-prefixed-pub",
          slug: "swe-bench-evals-swe-bench-prewarmed",
          environmentId: "env-default",
        },
      ],
    ];

    const result = await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [templateManifest],
    });

    expect(result.installed).toEqual([
      {
        slug: "swe-bench-evals-swe-bench-prewarmed",
        templateId: "sbx-prefixed-pub",
        created: false,
      },
    ]);
    expect(templateInserts()).toHaveLength(0);
    const tplUpdates = state.updates.filter(
      (u) => u.table === schema.sandboxTemplates,
    );
    expect(tplUpdates).toHaveLength(1);
  });
});

describe("installTemplatesFromPack — explicit secretSelection (not 'all')", () => {
  it("resolves required key NAMES to this workspace's key ids in the per-template loop", async () => {
    const manifestWithSelection: SandboxTemplateManifest = {
      ...templateManifest,
      secretSelection: { keyPublicIds: ["remote-kp"] },
    };
    vaultMocks.listSecretKeys.mockResolvedValue([
      {
        id: "local-kp",
        key: "AI_GATEWAY_API_KEY",
        sensitive: true,
        memo: null,
      },
    ]);
    state.selectQueue = [DEFAULT_ENV, []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [manifestWithSelection],
    });

    const values = templateInserts()[0]!.values as Record<string, unknown>;
    expect(values.secretSelection).toEqual({ keyPublicIds: ["local-kp"] });
  });

  it("falls back to 'all' when no required key name resolves locally", async () => {
    const manifestWithSelection: SandboxTemplateManifest = {
      ...templateManifest,
      secretSelection: { keyPublicIds: ["remote-kp"] },
      secretKeys: [
        { key: "MISSING_KEY", sensitive: true, required: true, memo: null },
      ],
    };
    vaultMocks.listSecretKeys.mockResolvedValue([]);
    state.selectQueue = [DEFAULT_ENV, []];
    state.insertReturning = [[{ id: "sbx-int", publicId: "sbx-pub" }]];

    await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [manifestWithSelection],
    });

    const values = templateInserts()[0]!.values as Record<string, unknown>;
    expect(values.secretSelection).toBe("all");
  });
});

describe("installTemplatesFromPack — invalid template slug", () => {
  it("throws a clear error before writing anything", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([]);
    const badManifest: SandboxTemplateManifest = {
      ...templateManifest,
      slug: "Bad Slug!",
    };
    state.selectQueue = [DEFAULT_ENV];

    await expect(
      installTemplatesFromPack(actor, {
        packId: PACK_ID,
        templates: [badManifest],
      }),
    ).rejects.toThrow(/invalid slug/i);
    expect(templateInserts()).toHaveLength(0);
  });
});

describe("installTemplatesFromPack — edge cases", () => {
  it("returns empty for a pack with no templates without touching the DB", async () => {
    const result = await installTemplatesFromPack(actor, {
      packId: PACK_ID,
      templates: [],
    });
    expect(result).toEqual({ installed: [], warnings: [] });
    expect(vaultMocks.listSecretKeys).not.toHaveBeenCalled();
  });

  it("throws a clear error when the workspace has no default environment", async () => {
    vaultMocks.listSecretKeys.mockResolvedValue([]);
    state.selectQueue = [[] /* no default env */];

    await expect(
      installTemplatesFromPack(actor, {
        packId: PACK_ID,
        templates: [templateManifest],
      }),
    ).rejects.toThrow(/no default environment/i);
  });
});
