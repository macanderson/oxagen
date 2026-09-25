/**
 * Unit tests for the list_tool_versions handler (#2958). Tier-free org; the
 * role gate runs for real against a tx double. The page read is an
 * in-memory store applying the query's semantics (scope, category, server,
 * order, cursor, limit + 1); the gate is decided by the real matcher against
 * switches built the way set_kill_switch writes them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { schema } from "@oxagen/database";
import { resourceScopeDigestOf, type KillSwitchRow } from "@oxagen/iam";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...real, countRecentToolInvocations: vi.fn(async () => new Map()) };
});

import {
  createToolVersionListHandler,
  decodeRegistryCursor,
  encodeRegistryCursor,
  gateOf,
  type PageQuery,
  type RegistryRow,
  type ToolVersionListDeps,
} from "./tool.version.list";
import { makeCTX } from "./test-utils/fixtures";
import { unionConsequenceTags } from "@oxagen/agent/runtime/tool-registry-facts";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const SERVER = "0192d4a8-7c1e-7a00-8000-0000000000aa";

const ctx = () => makeCTX({ orgId: ORG, workspaceId: WS, userId: USER });

function stubRole(orgRole: string | null, wsRole: string | null = null) {
  let leg: 1 | 2 = 2;
  let legResolved = true;
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) {
      leg = leg === 1 && !legResolved ? 2 : 1;
      return [{ id: "prn_1" }];
    }
    if (table === schema.principalRoleAssignments) {
      const role = leg === 1 ? orgRole : wsRole;
      legResolved = role !== null;
      return role ? [{ roleName: role }] : [];
    }
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

let seq = 0;
const uuid = (n: number) =>
  `0192d4a8-7c1e-7a00-8000-${String(n).padStart(12, "0")}`;

function row(over: Partial<RegistryRow> & { slug: string }): RegistryRow {
  seq += 1;
  return {
    toolId: uuid(seq),
    toolPublicId: `tol_${seq}`,
    name: over.slug,
    description: null,
    source: "mcp",
    mcpServerId: SERVER,
    serverPublicId: "mcs_github",
    enabled: true,
    updatedAt: new Date("2026-09-15T00:00:00.000Z"),
    versionPublicId: `tlv_${seq}`,
    versionNumber: 1,
    readOnly: false,
    riskGrade: "high",
    classifiedRiskGrade: null,
    classification: null,
    consequenceTags: [],
    classifiedAt: null,
    schemaOrigin: "imported",
    checksum: "a".repeat(64),
    ...over,
  };
}

const classified = {
  sideEffect: "irreversible",
  egress: "third_party",
  consequenceTags: ["moves_money"],
  measures: {},
  dataClasses: [],
};

/** The query's semantics over arrays. */
function memoryPage(rows: RegistryRow[]) {
  return async (_scope: unknown, q: PageQuery): Promise<RegistryRow[]> =>
    rows
      .filter((r) => {
        if (q.category === null) return true;
        // The SQL matches either half of the consequence tags; so does this.
        return unionConsequenceTags(r).includes(q.category);
      })
      .filter((r) => q.serverId === null || r.serverPublicId === q.serverId)
      .filter((r) => {
        if (!q.cursor) return true;
        return (
          r.slug > q.cursor.slug ||
          (r.slug === q.cursor.slug && r.toolId > q.cursor.id)
        );
      })
      .sort(
        (a, b) =>
          a.slug.localeCompare(b.slug) || a.toolId.localeCompare(b.toolId),
      )
      .slice(0, q.limit + 1);
}

function switchRow(
  targetKind: KillSwitchRow["targetKind"],
  over: Partial<KillSwitchRow>,
): KillSwitchRow {
  seq += 1;
  return {
    id: uuid(seq),
    publicId: `emd_${seq}`,
    targetKind,
    targetId: "x",
    scopeKind: "workspace",
    workspaceId: WS,
    capabilityId: null,
    resourceScopeDigest: null,
    principalId: null,
    reason: "incident",
    active: true,
    activatedAt: new Date("2026-09-15T00:00:00.000Z"),
    deactivatedAt: null,
    flippedByUserId: USER,
    updatedById: USER,
    ...over,
  };
}

function handlerOver(
  rows: RegistryRow[],
  switches: KillSwitchRow[] = [],
  calls: Map<string, number> | null = new Map(),
) {
  const deps: ToolVersionListDeps = {
    page: memoryPage(rows),
    activeSwitches: async () => switches,
    calls30d: async () => calls,
  };
  return createToolVersionListHandler(deps);
}

beforeEach(() => {
  stubRole(null, "Viewer");
});

describe("list_tool_versions", () => {
  it("reports the grade set with the classification over the declared one", async () => {
    const rows = [
      row({ slug: "search" }),
      row({
        slug: "create_payment",
        riskGrade: "high",
        classifiedRiskGrade: "critical",
        classification: classified,
        classifiedAt: new Date("2026-09-15T01:00:00.000Z"),
      }),
    ];
    const out = await handlerOver(rows, [], new Map())({ limit: 50 }, ctx());
    expect(out.items.map((i) => [i.slug, i.riskGrade])).toEqual([
      ["create_payment", "critical"],
      ["search", "high"],
    ]);
  });

  it("lists versions by slug with their capability id, classification, origin, digest and calls", async () => {
    const rows = [
      row({ slug: "search" }),
      row({
        slug: "create_payment",
        classification: classified,
        classifiedAt: new Date("2026-09-15T01:00:00.000Z"),
      }),
      row({
        slug: "list_runs",
        source: "builtin",
        mcpServerId: null,
        serverPublicId: null,
        schemaOrigin: "declared",
      }),
    ];
    const calls = new Map([[`mcp.${SERVER}.create_payment`, 12]]);
    const out = await handlerOver(rows, [], calls)({ limit: 50 }, ctx());

    expect(out.items.map((i) => i.slug)).toEqual([
      "create_payment",
      "list_runs",
      "search",
    ]);
    expect(out.items[0]).toMatchObject({
      capabilityId: `mcp.${SERVER}.create_payment`,
      serverId: "mcs_github",
      classification: classified,
      classifiedAt: "2026-09-15T01:00:00.000Z",
      schemaOrigin: "imported",
      schemaDigest: "a".repeat(64),
      gate: { kind: "open", switchId: null },
      calls30d: 12,
    });
    expect(out.items[1]).toMatchObject({
      capabilityId: "list_runs",
      serverId: null,
      classification: null,
      schemaOrigin: "declared",
      calls30d: 0,
    });
    expect(out.nextCursor).toBeNull();
  });

  it("prints calls30d as null when ClickHouse did not answer", async () => {
    const out = await handlerOver(
      [row({ slug: "search" })],
      [],
      null,
    )({ limit: 50 }, ctx());
    expect(out.items[0]?.calls30d).toBeNull();
  });

  it("filters by consequence tag", async () => {
    const rows = [
      row({ slug: "search" }),
      row({
        slug: "create_payment",
        classification: classified,
        classifiedAt: new Date(),
      }),
    ];
    const out = await handlerOver(rows)(
      { limit: 50, category: "moves_money" },
      ctx(),
    );
    expect(out.items.map((i) => i.slug)).toEqual(["create_payment"]);
  });

  it("filters by the server a version was imported from, alone and with a tag", async () => {
    const rows = [
      row({ slug: "search" }),
      row({
        slug: "create_issue",
        mcpServerId: uuid(900),
        serverPublicId: "mcs_linear",
      }),
      row({
        slug: "create_payment",
        mcpServerId: uuid(901),
        serverPublicId: "mcs_stripe",
        classification: classified,
        classifiedAt: new Date(),
      }),
      row({
        slug: "list_charges",
        mcpServerId: uuid(901),
        serverPublicId: "mcs_stripe",
      }),
      // Declared here: no server, so no server filter selects it.
      row({
        slug: "summarize_invoice",
        source: "custom",
        mcpServerId: null,
        serverPublicId: null,
      }),
    ];
    const handler = handlerOver(rows);
    const stripe = await handler({ limit: 50, serverId: "mcs_stripe" }, ctx());
    expect(stripe.items.map((i) => i.slug)).toEqual([
      "create_payment",
      "list_charges",
    ]);
    expect(stripe.items.every((i) => i.serverId === "mcs_stripe")).toBe(true);
    const both = await handler(
      { limit: 50, serverId: "mcs_stripe", category: "moves_money" },
      ctx(),
    );
    expect(both.items.map((i) => i.slug)).toEqual(["create_payment"]);
    const none = await handler({ limit: 50, serverId: "mcs_gone" }, ctx());
    expect(none.items).toEqual([]);
    expect(none.nextCursor).toBeNull();
  });

  it("pages on an opaque cursor and refuses a foreign one", async () => {
    const rows = [row({ slug: "a" }), row({ slug: "b" }), row({ slug: "c" })];
    const handler = handlerOver(rows);
    const first = await handler({ limit: 2 }, ctx());
    expect(first.items.map((i) => i.slug)).toEqual(["a", "b"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await handler(
      { limit: 2, cursor: first.nextCursor! },
      ctx(),
    );
    expect(second.items.map((i) => i.slug)).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();

    await expect(
      handler({ limit: 2, cursor: "nope" }, ctx()),
    ).rejects.toBeInstanceOf(CapabilityError);
    expect(
      decodeRegistryCursor(encodeRegistryCursor({ slug: "b", id: uuid(2) })),
    ).toEqual({ slug: "b", id: uuid(2) });
  });

  it("prints the gate each version is under: version, then server, then class, in that order", async () => {
    const pay = row({
      slug: "create_payment",
      classification: classified,
      classifiedAt: new Date(),
    });
    const search = row({ slug: "search" });
    const versionSwitch = switchRow("tool_version", {
      capabilityId: `mcp.${SERVER}.create_payment`,
      targetId: pay.versionPublicId,
    });
    const serverSwitch = switchRow("tool_server", {
      resourceScopeDigest: resourceScopeDigestOf({
        kind: "tool_server",
        id: SERVER,
      }),
      targetId: "mcs_github",
    });
    const classSwitch = switchRow("class", {
      scopeKind: "org",
      workspaceId: null,
      resourceScopeDigest: resourceScopeDigestOf({
        kind: "class",
        id: "moves_money",
      }),
      targetId: "moves_money",
    });

    const all = await handlerOver(
      [pay, search],
      [classSwitch, serverSwitch, versionSwitch],
    )({ limit: 50 }, ctx());
    expect(all.items.find((i) => i.slug === "create_payment")?.gate).toEqual({
      kind: "killed_version",
      switchId: versionSwitch.publicId,
    });
    expect(all.items.find((i) => i.slug === "search")?.gate).toEqual({
      kind: "killed_server",
      switchId: serverSwitch.publicId,
    });

    const classOnly = await handlerOver([pay, search], [classSwitch])(
      { limit: 50 },
      ctx(),
    );
    expect(
      classOnly.items.find((i) => i.slug === "create_payment")?.gate,
    ).toEqual({ kind: "killed_class", switchId: classSwitch.publicId });
    expect(classOnly.items.find((i) => i.slug === "search")?.gate).toEqual({
      kind: "open",
      switchId: null,
    });
  });

  it("a class switch reaches a tool tagged only in the declared column", async () => {
    // The page and the gateway's gate have to agree, or the operator flips a
    // class switch, sees `open` on the Tools page and concludes it missed. A
    // tool published through import_tools or publish_tool_declaration carries
    // its tags in agent.tool_versions.consequence_tags and has no
    // classification jsonb at all until an admin classifies it.
    const declaredOnly = row({
      slug: "wire_transfer",
      consequenceTags: ["moves_money"],
      classification: null,
      classifiedAt: null,
    });
    const classSwitch = switchRow("class", {
      scopeKind: "org",
      workspaceId: null,
      resourceScopeDigest: resourceScopeDigestOf({
        kind: "class",
        id: "moves_money",
      }),
      targetId: "moves_money",
    });
    const page = await handlerOver([declaredOnly], [classSwitch])(
      { limit: 50 },
      ctx(),
    );
    expect(page.items[0]?.gate).toEqual({
      kind: "killed_class",
      switchId: classSwitch.publicId,
    });
    // The classification itself stays absent — the tag is declared, not set.
    expect(page.items[0]?.classification).toBeNull();
  });

  it("filters by category on either half of the consequence tags", async () => {
    const declared = row({
      slug: "wire_transfer",
      consequenceTags: ["moves_money"],
    });
    const classifiedRow = row({
      slug: "create_payment",
      classification: classified,
      classifiedAt: new Date(),
    });
    const neither = row({ slug: "search" });
    const page = await handlerOver([declared, classifiedRow, neither])(
      { limit: 50, category: "moves_money" },
      ctx(),
    );
    expect(page.items.map((i) => i.slug).sort()).toEqual([
      "create_payment",
      "wire_transfer",
    ]);
  });

  it("a workspace or organisation switch is the page header's, never a version's gate", () => {
    const orgSwitch = switchRow("org", {
      scopeKind: "org",
      workspaceId: null,
      resourceScopeDigest: resourceScopeDigestOf({ kind: "org", id: ORG }),
      targetId: ORG,
    });
    expect(
      gateOf([orgSwitch], {
        orgId: ORG,
        workspaceId: WS,
        capabilityId: "search",
        serverId: null,
        consequenceTags: [],
      }),
    ).toEqual({ kind: "open", switchId: null });
  });

  it("a broken classification row fails the read rather than guessing", async () => {
    const bad = row({
      slug: "x",
      classification: { sideEffect: "explode" },
      classifiedAt: new Date(),
    });
    await expect(handlerOver([bad])({ limit: 50 }, ctx())).rejects.toThrow(
      /classification outside the schema/,
    );
  });

  it("a Viewer may read; a user with no role in the org or workspace may not", async () => {
    stubRole(null, null);
    const err = await handlerOver([row({ slug: "a" })])(
      { limit: 50 },
      ctx(),
    ).catch((e: unknown) => e);
    expect(isHandlerError(err) && err.code).toBe("forbidden");
  });
});
