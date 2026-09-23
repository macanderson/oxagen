import { describe, expect, it, vi, beforeEach } from "vitest";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  orgFindFirst: vi.fn(),
  txInsertOrg: vi.fn(),
  txInsertOrgReturning: vi.fn(),
  txInsertOrgUsers: vi.fn(),
  // withSystemDbFn tracks each withSystemDb call so tests can assert the org
  // creation wraps its writes in the system-bypass transaction.
  withSystemDbFn: vi.fn(),
  bootstrapOrgIAM: vi.fn(),
  bootstrapWorkspace: vi.fn(),
  grantSignupCredits: vi.fn(),
  openOnboardingGate: vi.fn(),
  provisionOrgGraph: vi.fn(),
  recordOrgGraphDatabase: vi.fn(),
  provisionAssistantModelKey: vi.fn(),
}));

const ORG_ROW = {
  publicId: "org_pub_1",
  name: "Acme Corp",
  slug: "acme",
  type: "business",
  createdAt: new Date("2026-05-01T00:00:00Z"),
  id: "internal_org_id",
};

const WORKSPACE_ROW = {
  id: "internal_ws_id",
  publicId: "ws_pub_1",
  name: "Core",
  slug: "core",
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

// Stub the INSERT chain: insert().values().returning()
const orgValuesStub = { returning: mocks.txInsertOrgReturning };
mocks.txInsertOrg.mockReturnValue({ values: () => orgValuesStub });
// Stub orgUsers insert: insert().values() (no returning)
mocks.txInsertOrgUsers.mockReturnValue({
  values: vi.fn(async () => undefined),
});

/** A fake system transaction: the slug pre-check reads, the main body writes. */
function makeTx(): Record<string, unknown> {
  let insertCount = 0;
  return {
    query: {
      organizations: { findFirst: mocks.orgFindFirst },
    },
    // Namespace derivation reads existing org namespaces before the insert;
    // an empty set means the slug-derived namespace is used verbatim.
    select: () => ({ from: async () => [] }),
    insert: (table: unknown): unknown => {
      insertCount++;
      if (insertCount === 1) return mocks.txInsertOrg(table) as unknown;
      return mocks.txInsertOrgUsers(table) as unknown;
    },
  };
}

function passthrough(): void {
  mocks.withSystemDbFn.mockImplementation(
    async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
      fn(makeTx()),
  );
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ): Promise<unknown> => mocks.withSystemDbFn(fn) as Promise<unknown>,
  };
});

// The signup grant is written on the org transaction (grants.test.ts covers
// the ledger, lot and balance rows it writes). The mock exposes only
// grantSignupCredits, so any other billing call fails the test.
mocks.grantSignupCredits.mockResolvedValue(true);
vi.mock("@oxagen/billing", () => ({
  grantSignupCredits: mocks.grantSignupCredits,
}));

// IAM provisioning is tested in iam-provision.test.ts and the workspace
// bootstrap in workspace-bootstrap.test.ts; here we verify both are called on
// the org transaction with the right arguments.
mocks.bootstrapOrgIAM.mockResolvedValue(undefined);
vi.mock("./iam-provision", () => ({
  bootstrapOrgIAM: mocks.bootstrapOrgIAM,
}));
mocks.bootstrapWorkspace.mockResolvedValue(WORKSPACE_ROW);
vi.mock("./workspace-bootstrap", () => ({
  bootstrapWorkspace: mocks.bootstrapWorkspace,
}));
vi.mock("./lib/onboarding", () => ({
  openOnboardingGate: mocks.openOnboardingGate,
}));

// The graph provisioner is tested in @oxagen/ontology (provision.test.ts) and
// the routing row writer in @oxagen/database (data-plane-resolver.test.ts);
// here we verify org creation calls them on the org transaction.
vi.mock("@oxagen/ontology/provision", () => ({
  provisionOrgGraph: mocks.provisionOrgGraph,
}));
vi.mock("@oxagen/database/data-plane", () => ({
  recordOrgGraphDatabase: mocks.recordOrgGraphDatabase,
}));

// Minting the organisation's own OpenRouter key (ADR-131) is covered by
// assistant-key-provision.test.ts in @oxagen/ai; what belongs here is that
// org.create fires it with the right arguments, only after the transaction
// commits, and never lets it break signup.
vi.mock("./assistant-key-bootstrap", () => ({
  provisionAssistantModelKey: mocks.provisionAssistantModelKey,
}));

import { organizationCreateHandler } from "./org.create";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const INPUT = organizationCreate.input.parse({
  name: "Acme Corp",
  slug: "acme",
  workspace: { name: "Core", slug: "core" },
});

describe("organizationCreateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.orgFindFirst.mockClear();
    mocks.txInsertOrg.mockClear();
    mocks.txInsertOrgReturning.mockClear();
    mocks.txInsertOrgUsers.mockClear();
    mocks.bootstrapOrgIAM.mockClear();
    mocks.bootstrapWorkspace.mockClear();
    mocks.grantSignupCredits.mockReset();
    // Restore defaults
    mocks.orgFindFirst.mockResolvedValue(null);
    mocks.txInsertOrgReturning.mockResolvedValue([ORG_ROW]);
    mocks.bootstrapOrgIAM.mockResolvedValue(undefined);
    mocks.bootstrapWorkspace.mockResolvedValue(WORKSPACE_ROW);
    mocks.grantSignupCredits.mockResolvedValue(true);
    mocks.provisionOrgGraph.mockReset();
    mocks.provisionOrgGraph.mockResolvedValue({ mode: "pooled" });
    mocks.recordOrgGraphDatabase.mockReset();
    mocks.recordOrgGraphDatabase.mockResolvedValue(undefined);
    mocks.provisionAssistantModelKey.mockReset();
    mocks.provisionAssistantModelKey.mockResolvedValue(undefined);
    mocks.withSystemDbFn.mockReset();
    passthrough();
  });

  // ── graph placement (spec §5.3, ADR-098) ───────────────────────────────────

  it("places a free org in the pooled graph and records no binding", async () => {
    await organizationCreateHandler(INPUT, CTX);
    expect(mocks.provisionOrgGraph).toHaveBeenCalledWith({
      orgId: ORG_ROW.id,
      namespace: expect.stringMatching(/^[a-z0-9]{2,6}$/),
      planType: "free",
    });
    expect(mocks.recordOrgGraphDatabase).not.toHaveBeenCalled();
  });

  it("records the routing row on the org transaction when a database is provisioned", async () => {
    mocks.provisionOrgGraph.mockResolvedValue({
      mode: "database",
      database: "org-acme",
    });
    await organizationCreateHandler(INPUT, CTX);
    expect(mocks.recordOrgGraphDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ insert: expect.any(Function) }),
      { orgId: ORG_ROW.id, database: "org-acme", actorUserId: CTX.userId },
    );
  });

  it("rolls the org back when provisioning fails, rethrowing the typed error", async () => {
    const failure = Object.assign(new Error("CREATE DATABASE failed"), {
      code: "org_graph_provision_failed",
    });
    mocks.provisionOrgGraph.mockRejectedValue(failure);
    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toBe(failure);
    expect(mocks.bootstrapOrgIAM).not.toHaveBeenCalled();
    expect(mocks.grantSignupCredits).not.toHaveBeenCalled();
  });

  // ── auth guard ───────────────────────────────────────────────────────────

  it("throws when userId is null (unauthenticated request)", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(organizationCreateHandler(INPUT, anonCtx)).rejects.toThrow(
      "organization.create requires an authenticated user",
    );
    expect(mocks.withSystemDbFn).not.toHaveBeenCalled();
  });

  // ── slug conflict guard ──────────────────────────────────────────────────

  it("refuses a taken slug as a conflict (pre-check path)", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce({ id: "existing_id" });

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slug_taken",
      message: 'slug "acme" already in use',
    });
    expect(mocks.txInsertOrg).not.toHaveBeenCalled();
  });

  it("refuses a slug taken by a concurrent create as a conflict (race condition path)", async () => {
    // Pre-check passes (no row), but the second withSystemDb call (main body)
    // races and hits the unique index.
    let callIdx = 0;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) return fn(makeTx());
        throw Object.assign(new Error("dup"), {
          code: "23505",
          constraint_name: "organizations_slug_idx",
        });
      },
    );

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "slug_taken",
    });
  });

  it("re-throws a unique violation on another index unchanged", async () => {
    let callIdx = 0;
    const namespaceRace = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "organizations_namespace_idx",
    });
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) return fn(makeTx());
        throw namespaceRace;
      },
    );

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toBe(
      namespaceRace,
    );
  });

  it("re-throws non-slug database errors unchanged", async () => {
    let callIdx = 0;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) return fn(makeTx());
        throw new Error("connection refused");
      },
    );

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toThrow(
      "connection refused",
    );
  });

  it("throws when the organization insert returns no row", async () => {
    mocks.txInsertOrgReturning.mockResolvedValueOnce([]);

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toThrow(
      "organization insert returned no row",
    );
    expect(mocks.bootstrapOrgIAM).not.toHaveBeenCalled();
    expect(mocks.bootstrapWorkspace).not.toHaveBeenCalled();
  });

  // ── a namespace the operator chose (onboarding step 1) ───────────────────

  /** A system transaction whose namespace read answers the given taken set. */
  function withTakenNamespaces(taken: string[]): void {
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
        fn({
          ...makeTx(),
          select: () => ({
            from: async () => taken.map((namespace) => ({ namespace })),
          }),
        }),
    );
  }

  it("stores a chosen namespace verbatim rather than deriving one", async () => {
    await organizationCreateHandler(
      organizationCreate.input.parse({ ...INPUT, namespace: "aintel" }),
      CTX,
    );
    expect(mocks.provisionOrgGraph).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "aintel" }),
    );
  });

  it("refuses a chosen namespace another organization holds, writing nothing", async () => {
    withTakenNamespaces(["aintel"]);
    await expect(
      organizationCreateHandler(
        organizationCreate.input.parse({ ...INPUT, namespace: "aintel" }),
        CTX,
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "namespace_taken" });
    expect(mocks.txInsertOrg).not.toHaveBeenCalled();
  });

  it("derives past a taken namespace when none was chosen", async () => {
    withTakenNamespaces(["acme"]);
    await organizationCreateHandler(INPUT, CTX);
    expect(mocks.provisionOrgGraph).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "acme1" }),
    );
  });

  it("answers a chosen namespace lost to a concurrent create as namespace_taken", async () => {
    let callIdx = 0;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) return fn(makeTx());
        throw Object.assign(new Error("dup"), {
          code: "23505",
          constraint_name: "organizations_namespace_idx",
        });
      },
    );
    await expect(
      organizationCreateHandler(
        organizationCreate.input.parse({ ...INPUT, namespace: "aintel" }),
        CTX,
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "namespace_taken" });
  });

  it("refuses a namespace outside the column's shape at the contract", () => {
    for (const namespace of ["a", "a-intel", "ABC", "toolong7"]) {
      expect(
        organizationCreate.input.safeParse({ ...INPUT, namespace }).success,
      ).toBe(false);
    }
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it("returns the new org and its first workspace", async () => {
    const result = await organizationCreateHandler(INPUT, CTX);

    expect(result).toEqual({
      publicId: "org_pub_1",
      name: "Acme Corp",
      slug: "acme",
      type: "business",
      createdAt: "2026-05-01T00:00:00.000Z",
      workspace: { publicId: "ws_pub_1", slug: "core" },
    });
  });

  it("writes the org, the owner membership, IAM and the first workspace on one system transaction", async () => {
    await organizationCreateHandler(INPUT, CTX);

    // withSystemDb is called twice: (1) the slug pre-check, (2) the bootstrap.
    expect(mocks.withSystemDbFn).toHaveBeenCalledTimes(2);
    expect(mocks.txInsertOrg).toHaveBeenCalledTimes(1);
    expect(mocks.txInsertOrgUsers).toHaveBeenCalledTimes(1);

    const iamTx = mocks.bootstrapOrgIAM.mock.calls[0]?.[0]?.tx;
    const wsTx = mocks.bootstrapWorkspace.mock.calls[0]?.[0]?.tx;
    expect(iamTx).toBeDefined();
    expect(wsTx).toBe(iamTx);
    // The onboarding gate opens on the same transaction, on the first
    // workspace, timed from the organization's own creation (#2967).
    expect(mocks.openOnboardingGate).toHaveBeenCalledTimes(1);
    expect(mocks.openOnboardingGate.mock.calls[0]?.[0]).toBe(iamTx);
    expect(mocks.openOnboardingGate.mock.calls[0]?.[1]).toEqual({
      orgId: "internal_org_id",
      workspaceId: "internal_ws_id",
      now: ORG_ROW.createdAt,
    });

    expect(mocks.bootstrapOrgIAM).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "internal_org_id",
        ownerUserId: "u_1",
        actorUserId: "u_1",
      }),
    );
    expect(mocks.bootstrapWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "internal_org_id",
        userId: "u_1",
        name: "Core",
        slug: "core",
      }),
    );
  });

  it("writes the $5 signup grant for the new org on the org transaction", async () => {
    await organizationCreateHandler(INPUT, CTX);

    const iamTx = mocks.bootstrapOrgIAM.mock.calls[0]?.[0]?.tx;
    expect(mocks.grantSignupCredits).toHaveBeenCalledTimes(1);
    expect(mocks.grantSignupCredits).toHaveBeenCalledWith(
      iamTx,
      "internal_org_id",
    );
  });

  it("surfaces a signup grant failure so the org transaction cannot commit without it", async () => {
    mocks.grantSignupCredits.mockRejectedValueOnce(new Error("ledger down"));

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toThrow(
      "ledger down",
    );
  });

  it("creates the Default workspace when the input names none", async () => {
    const input = organizationCreate.input.parse({
      name: "Acme Corp",
      slug: "acme",
    });
    mocks.bootstrapWorkspace.mockResolvedValueOnce({
      ...WORKSPACE_ROW,
      name: "Default",
      slug: "default",
    });

    const result = await organizationCreateHandler(input, CTX);

    expect(mocks.bootstrapWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Default", slug: "default" }),
    );
    expect(result.workspace.slug).toBe("default");
  });

  it("surfaces a workspace bootstrap failure so the org transaction cannot commit without it", async () => {
    mocks.bootstrapWorkspace.mockRejectedValueOnce(
      new Error("workspace insert returned no row"),
    );

    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toThrow(
      "workspace insert returned no row",
    );
  });

  // ── the organisation's own model key (ADR-131) ────────────────────────────

  it("asks for the organisation's own model key with the slug it was created under", async () => {
    // The slug is passed by value and baked into the key's name, which is why
    // renaming the organisation later cannot rewrite it.
    await organizationCreateHandler(INPUT, CTX);

    expect(mocks.provisionAssistantModelKey).toHaveBeenCalledTimes(1);
    expect(mocks.provisionAssistantModelKey).toHaveBeenCalledWith({
      orgId: ORG_ROW.id,
      orgSlug: ORG_ROW.slug,
      userId: CTX.userId,
    });
  });

  it("asks only after the transaction has committed", async () => {
    // Minting inside the transaction would let a rollback strand a live,
    // spendable key at the vendor with no row in Postgres to find it by.
    let committed = false;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        const out = await fn(makeTx());
        committed = true;
        return out;
      },
    );
    mocks.provisionAssistantModelKey.mockImplementation(async () => {
      expect(committed).toBe(true);
    });

    await organizationCreateHandler(INPUT, CTX);
    expect(mocks.provisionAssistantModelKey).toHaveBeenCalledTimes(1);
  });

  it("does not ask when the organisation was never created", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce({ id: "existing_id" });
    await expect(organizationCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(mocks.provisionAssistantModelKey).not.toHaveBeenCalled();
  });

  it("returns the created organisation even when the key cannot be minted", async () => {
    // The whole point of detaching it: an OpenRouter outage must not turn
    // into a failed signup. The organisation serves on the shared key, which
    // is what every organisation did before ADR-131.
    mocks.provisionAssistantModelKey.mockRejectedValue(
      new Error("openrouter unreachable"),
    );

    const result = await organizationCreateHandler(INPUT, CTX);

    expect(result.slug).toBe("acme");
    expect(result.workspace.slug).toBe("core");
  });

  it("does not wait for the key before answering the person signing up", async () => {
    // A vendor's latency is not the signup's latency. If this ever becomes an
    // await, the promise below never settles and this test times out rather
    // than passing slowly.
    let release: (() => void) | undefined;
    mocks.provisionAssistantModelKey.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    await expect(organizationCreateHandler(INPUT, CTX)).resolves.toMatchObject({
      slug: "acme",
    });
    release?.();
  });
});
