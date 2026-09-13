import type { ContextRecordListOutput } from "@oxagen/oxagen/contracts/context.record.list";
import { getScope } from "@oxagen/tenancy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NO_GAP } from "@/data/not-backed";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";

// The fake transaction answers the two query shapes the supplement read builds:
// the promotions subquery (`…where().groupBy().as()`) and the record read
// (`…where()`, awaited).
const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(
      readonly capability: string,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "CapabilityError";
    }
  }
  const calls = {
    scopes: [] as unknown[],
    from: [] as unknown[],
    selected: [] as string[][],
    joins: [] as string[],
    wheres: [] as unknown[],
  };
  const rows: { value: unknown[] } = { value: [] };
  const tx = {
    select: (fields: Record<string, unknown>) => {
      calls.selected.push(Object.keys(fields));
      const chain = {
        from: (table: unknown) => {
          calls.from.push(table);
          return chain;
        },
        innerJoin: () => {
          calls.joins.push("inner");
          return chain;
        },
        leftJoin: () => {
          calls.joins.push("left");
          return chain;
        },
        groupBy: () => chain,
        // The subquery stands in for its own columns in the outer query.
        as: () => fields,
        // The subquery continues with groupBy(); the outer read awaits here.
        where: (clause: unknown) => {
          calls.wheres.push(clause);
          return Object.assign(Promise.resolve(rows.value), chain);
        },
      };
      return chain;
    },
  };
  return {
    CapabilityError,
    calls,
    rows,
    registry: { loaded: 0 },
    tx,
    invoke:
      vi.fn<
        (
          name: string,
          input: unknown,
          ctx: Record<string, unknown>,
        ) => Promise<unknown>
      >(),
    getCapability: vi.fn<(name: string) => unknown>(),
    getSession: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    withTenantDb: vi.fn<(fn: (t: unknown) => unknown) => Promise<unknown>>(),
  };
});

vi.mock("@oxagen/handlers/register", () => {
  mocks.registry.loaded += 1;
  return {};
});
vi.mock("@oxagen/oxagen", () => ({
  CapabilityError: mocks.CapabilityError,
  invoke: mocks.invoke,
  getCapability: mocks.getCapability,
}));
vi.mock("@/server/session", () => ({ getSession: mocks.getSession }));
vi.mock("@oxagen/database", async () => ({
  schema: await vi.importActual("@oxagen/database/schema"),
  withTenantDb: mocks.withTenantDb,
}));

import * as schema from "@oxagen/database/schema";
import {
  RECORD_PAGE_SIZE,
  type RecordSupplement,
  SUPPLEMENT_CHUNK,
  type SteeringLiveDeps,
  WORKSPACE_SCOPE_REQUIRED,
  createLiveSteering,
  isCapabilityDenial,
  liveSteering,
  liveSteeringDeps,
} from "./steering";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0de1",
};
const USER = "0192d4a8-7c1e-7a00-8000-0000000000ab";

const LINEAGE = "ctx.acme.platform.release-order";
const PUBLIC_ID = "ctr_01K5RU4A8XQ2P0M7N3JH5B";
const BODY = `schema = "context-record/v0.1"
[[record]]
lineage_id = "${LINEAGE}"
kind = "procedure"
statement = "Freeze main, dry-run the migrations, tag, then publish the notes."
sharing_scope = "workspace"
[record.steering]
force = "should"
`;

const EXPECTED_RECORD = {
  lineage: LINEAGE,
  kind: "procedure",
  force: "should",
  enforcement: null,
  scope: "workspace",
  status: "published",
  statement:
    "Freeze main, dry-run the migrations, tag, then publish the notes.",
  effect: null,
  commitSha: "d17e40b",
  publishedOn: "2026-08-21",
};

type Listed = ContextRecordListOutput["records"][number];

function listed(over: Partial<Listed> = {}): Listed {
  return {
    id: PUBLIC_ID,
    recordId: LINEAGE,
    title: "Release order",
    status: "active",
    version: 1,
    checksum: "c".repeat(64),
    updatedAt: "2026-08-21T09:00:00.000Z",
    ...over,
  };
}

function supplement(over: Partial<RecordSupplement> = {}): RecordSupplement {
  return {
    publicId: PUBLIC_ID,
    body: BODY,
    provenance: [{ type: "commit", digest: "d17e40b" }],
    versionPublishedAt: new Date("2026-08-21T09:00:00Z"),
    promotedAt: null,
    ...over,
  };
}

type Call = { contract: string; input: unknown; userId: string };

/** Fake I/O: records every capability and supplement call. */
function fakeDeps(
  records: Listed[],
  supplements: RecordSupplement[],
  overrides?: Partial<SteeringLiveDeps>,
) {
  const calls: Call[] = [];
  const supplementCalls: string[][] = [];
  const deps: SteeringLiveDeps = {
    principal: () => Promise.resolve(USER),
    invoke: <I, O>(call: {
      scope: typeof SCOPE;
      userId: string;
      contract: ToolContract<I, O>;
      input: I;
    }) => {
      calls.push({
        contract: call.contract.name,
        input: call.input,
        userId: call.userId,
      });
      const { limit, offset } = call.input as { limit: number; offset: number };
      return Promise.resolve({
        records: records.slice(offset, offset + limit),
        total: records.length,
      } as O);
    },
    recordSupplements: (_scope, ids) => {
      supplementCalls.push([...ids]);
      return Promise.resolve(
        supplements.filter((s) => ids.includes(s.publicId)),
      );
    },
    ...overrides,
  };
  return { deps, calls, supplementCalls };
}

beforeEach(() => {
  mocks.rows.value = [];
  mocks.calls.scopes.length = 0;
  mocks.calls.from.length = 0;
  mocks.calls.selected.length = 0;
  mocks.calls.joins.length = 0;
  mocks.calls.wheres.length = 0;
  mocks.invoke.mockReset();
  mocks.getCapability.mockReset();
  mocks.withTenantDb.mockReset();
  mocks.withTenantDb.mockImplementation((fn) => {
    mocks.calls.scopes.push(getScope());
    return Promise.resolve(fn(mocks.tx));
  });
});

describe("liveSteering.records", () => {
  it("lists records through list_context_records as the viewer, then maps them with their active version", async () => {
    const { deps, calls, supplementCalls } = fakeDeps(
      [listed()],
      [supplement()],
    );
    await expect(createLiveSteering(deps).records(SCOPE)).resolves.toEqual({
      ok: true,
      value: [EXPECTED_RECORD],
    });
    expect(calls).toEqual([
      {
        contract: "list_context_records",
        input: { limit: RECORD_PAGE_SIZE, offset: 0 },
        userId: USER,
      },
    ]);
    // The supplement read is restricted to what the capability returned.
    expect(supplementCalls).toEqual([[PUBLIC_ID]]);
  });

  it("takes slug and status from the capability, not from the supplement read", async () => {
    const { deps } = fakeDeps([listed({ status: "retired" })], [supplement()]);
    const read = await createLiveSteering(deps).records(SCOPE);
    expect(read).toEqual({
      ok: true,
      value: [{ ...EXPECTED_RECORD, status: "archived" }],
    });
  });

  it("pages with offset until the reported total is reached, never a truncated set", async () => {
    const many = Array.from({ length: RECORD_PAGE_SIZE * 2 + 3 }, (_, n) =>
      listed({ id: `ctr_${String(n)}`, version: null }),
    );
    const { deps, calls } = fakeDeps(many, []);
    await expect(createLiveSteering(deps).records(SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(calls.map((c) => c.input)).toEqual([
      { limit: RECORD_PAGE_SIZE, offset: 0 },
      { limit: RECORD_PAGE_SIZE, offset: RECORD_PAGE_SIZE },
      { limit: RECORD_PAGE_SIZE, offset: RECORD_PAGE_SIZE * 2 },
    ]);
  });

  it("is an error when the pages stop short of the reported total (negative)", async () => {
    const { deps } = fakeDeps([], [], {
      invoke: (() =>
        Promise.resolve({
          records: [],
          total: 3,
        })) as unknown as SteeringLiveDeps["invoke"],
    });
    await expect(createLiveSteering(deps).records(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "record_index_unavailable",
      status: 503,
    });
  });

  it("leaves out records with no pinned version and never reads a supplement for them", async () => {
    const { deps, supplementCalls } = fakeDeps([listed({ version: null })], []);
    await expect(createLiveSteering(deps).records(SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(supplementCalls).toEqual([]);
  });

  it("is an error, not a shorter list, when a returned id is missing from the supplement read (negative)", async () => {
    const { deps } = fakeDeps(
      [listed(), listed({ id: "ctr_gone", recordId: "ctx.acme.gone" })],
      [supplement()],
    );
    await expect(createLiveSteering(deps).records(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "record_index_unavailable",
      status: 503,
    });
  });

  it("is denied without a signed-in person, and never reaches the kernel or the store (negative)", async () => {
    const { deps, calls, supplementCalls } = fakeDeps(
      [listed()],
      [supplement()],
      { principal: () => Promise.resolve(null) },
    );
    await expect(createLiveSteering(deps).records(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "denied",
      permission: "steering.read",
    });
    expect(calls).toEqual([]);
    expect(supplementCalls).toEqual([]);
  });

  it.each([
    "authz_denied",
    "pending_approval",
    "surface_denied",
    "capability_not_installed",
  ])(
    "turns a kernel %s into a denied read and reads no bodies (negative)",
    async (code) => {
      const { deps, supplementCalls } = fakeDeps([], [supplement()], {
        invoke: () =>
          Promise.reject(
            new mocks.CapabilityError("list_context_records", code, "no"),
          ),
      });
      await expect(createLiveSteering(deps).records(SCOPE)).resolves.toEqual({
        ok: false,
        reason: "denied",
        permission: "steering.read",
      });
      expect(supplementCalls).toEqual([]);
    },
  );

  it("rethrows a kernel error that is not a denial (negative)", async () => {
    const failure = new mocks.CapabilityError(
      "list_context_records",
      "invalid_output",
      "bad",
    );
    const { deps } = fakeDeps([], [], {
      invoke: () => Promise.reject(failure),
    });
    await expect(createLiveSteering(deps).records(SCOPE)).rejects.toBe(failure);
  });

  it("lets a store failure propagate to the page's error boundary (negative)", async () => {
    const failure = new Error("connection refused");
    const { deps } = fakeDeps([listed()], [], {
      recordSupplements: () => Promise.reject(failure),
    });
    await expect(createLiveSteering(deps).records(SCOPE)).rejects.toBe(failure);
  });

  it("is not backed when a record carries no publication commit", async () => {
    const { deps } = fakeDeps([listed()], [supplement({ provenance: [] })]);
    await expect(createLiveSteering(deps).records(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M3",
      gap: "G0",
    });
  });

  it("refuses the organization-only scope before reaching the kernel or the store (negative)", async () => {
    const { deps, calls, supplementCalls } = fakeDeps(
      [listed()],
      [supplement()],
    );
    await expect(
      createLiveSteering(deps).records({
        ...SCOPE,
        workspaceId: ORG_ONLY_WORKSPACE_ID,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      code: WORKSPACE_SCOPE_REQUIRED,
      status: 400,
    });
    expect(calls).toEqual([]);
    expect(supplementCalls).toEqual([]);
  });
});

describe("isCapabilityDenial", () => {
  it("does not treat a plain error or a non-denial code as a denial (negative)", () => {
    expect(isCapabilityDenial(new Error("authz_denied"))).toBe(false);
    expect(
      isCapabilityDenial(new mocks.CapabilityError("x", "no_handler", "")),
    ).toBe(false);
    expect(isCapabilityDenial({ code: "authz_denied" })).toBe(false);
  });
});

describe("liveSteering methods with no store", () => {
  it.each(["proposals", "effect", "retirementCandidates"] as const)(
    "%s is not backed until M3 and never touches the store",
    async (method) => {
      await expect(liveSteering[method](SCOPE)).resolves.toEqual({
        ok: false,
        reason: "not_backed",
        milestone: "M3",
        gap: NO_GAP,
      });
      expect(mocks.withTenantDb).not.toHaveBeenCalled();
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );
});

describe("liveSteeringDeps (production I/O)", () => {
  const contract = {
    name: "list_context_records",
    input: z.object({}),
    output: z.object({ records: z.array(z.object({ id: z.string() })) }),
  };

  it("reads the principal from the request session", async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: USER } });
    await expect(liveSteeringDeps.principal()).resolves.toBe(USER);
    mocks.getSession.mockResolvedValueOnce(null);
    await expect(liveSteeringDeps.principal()).resolves.toBeNull();
  });

  it("invokes as the viewer inside the tenant scope, loads handlers once, and parses the output", async () => {
    mocks.getCapability.mockReturnValue({ name: "list_context_records" });
    let scopeSeen: unknown = null;
    mocks.invoke.mockImplementation(() => {
      scopeSeen = getScope();
      return Promise.resolve({ records: [{ id: "ctr_1" }] });
    });
    const call = { scope: SCOPE, userId: USER, contract, input: {} };
    await expect(liveSteeringDeps.invoke(call)).resolves.toEqual({
      records: [{ id: "ctr_1" }],
    });
    await liveSteeringDeps.invoke(call);
    expect(mocks.registry.loaded).toBe(1);
    expect(scopeSeen).toMatchObject(SCOPE);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_context_records",
      {},
      expect.objectContaining({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        userId: USER,
        apiKeyId: null,
        surface: "app",
        messageId: null,
      }),
    );
  });

  it("throws ToolNotRegistered for a contract the kernel does not know (negative)", async () => {
    mocks.getCapability.mockReturnValue(undefined);
    await expect(
      liveSteeringDeps.invoke({
        scope: SCOPE,
        userId: USER,
        contract,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ToolNotRegistered);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("throws ContractOutputMismatch rather than pass an unparsed result on (negative)", async () => {
    mocks.getCapability.mockReturnValue({ name: "list_context_records" });
    mocks.invoke.mockResolvedValue({ records: "not a list" });
    await expect(
      liveSteeringDeps.invoke({
        scope: SCOPE,
        userId: USER,
        contract,
        input: {},
      }),
    ).rejects.toBeInstanceOf(ContractOutputMismatch);
  });

  it("reads supplements in the tenant scope, from the three steering tables, restricted to the given ids", async () => {
    mocks.rows.value = [supplement()];
    await expect(
      liveSteeringDeps.recordSupplements(SCOPE, [PUBLIC_ID]),
    ).resolves.toEqual([supplement()]);
    expect(mocks.calls.scopes).toEqual([expect.objectContaining(SCOPE)]);
    expect(mocks.calls.from).toEqual([
      schema.contextPromotions,
      schema.contextRecords,
    ]);
    expect(mocks.calls.joins).toEqual(["inner", "left"]);
    expect(mocks.calls.selected).toEqual([
      ["recordId", "versionId", "promotedAt"],
      ["publicId", "body", "provenance", "versionPublishedAt", "promotedAt"],
    ]);
    expect(mocks.calls.wheres).toHaveLength(2);
  });

  it("chunks a large id set so no query exceeds the bind-parameter budget", async () => {
    const ids = Array.from(
      { length: SUPPLEMENT_CHUNK + 1 },
      (_, n) => `ctr_${String(n)}`,
    );
    await liveSteeringDeps.recordSupplements(SCOPE, ids);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
  });

  it("refuses to read supplements outside a valid tenant scope (negative)", async () => {
    await expect(
      liveSteeringDeps.recordSupplements({ orgId: "", workspaceId: "" }, [
        PUBLIC_ID,
      ]),
    ).rejects.toThrow();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
