/**
 * publishTool against a stateful double of agent.tools and
 * agent.tool_versions: an identity row, its versions, and the one marked
 * latest. The double answers each statement publishTool issues by table and
 * by the row it tracks, so a sequence of publishes and a reclassification in
 * between reads back what the registry would hold.
 *
 * The case the double exists for: a server ships a changed descriptor after
 * an admin tagged the tool `moves_money` while a class kill switch is on. The
 * new active version keeps the tag, so the switch still stops the tool.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resourceScopeDigestOf, type KillSwitchRow } from "@oxagen/iam";

type VersionRow = Record<string, unknown> & { id: string; publicId: string };

vi.mock("../_approval_rule", () => ({ lockWorkspaceRuleSet: vi.fn() }));
vi.mock("./approval-rule-invalidation", () => ({
  invalidateApprovalRules: vi.fn(),
}));

const db = vi.hoisted(() => ({
  tool: null as null | { id: string; publicId: string; slug: string },
  versions: [] as Array<Record<string, unknown> & { id: string }>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const latest = () => db.versions.find((v) => v.isLatest === true);
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === real.schema.tools) return db.tool ? [db.tool] : [];
            const l = latest();
            return l ? [l] : [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          if (table === real.schema.tools) {
            db.tool = {
              id: "tool-1",
              publicId: "tol_1",
              slug: String(values["slug"]),
            };
            return [db.tool];
          }
          const n = db.versions.length + 1;
          const row = { ...values, id: `v${n}`, publicId: `tlv_${n}` };
          db.versions.push(row);
          return [row];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const target =
            table === real.schema.toolVersions ? latest() : undefined;
          if (target) Object.assign(target, values);
          // RETURNING yields the selected columns only, as drizzle does.
          return Object.assign(Promise.resolve(), {
            returning: async (columns: Record<string, unknown>) =>
              target
                ? [
                    Object.fromEntries(
                      Object.keys(columns).map((k) => [k, target[k]]),
                    ),
                  ]
                : [],
          });
        },
      }),
    }),
  };
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (t: unknown) => unknown) => fn(tx),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { publishTool, type PublishToolArgs } from "./tool-registry";
import { gateOf } from "../tool.version.list";
import { registryCapabilityId } from "@oxagen/agent/runtime/tool-registry-facts";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const ADMIN = "0192d4a8-7c1e-7a00-8000-0000000005e2";
const SERVER = "0192d4a8-7c1e-7a00-8000-0000000000aa";

function imported(inputSchema: Record<string, unknown>): PublishToolArgs {
  return {
    orgId: ORG,
    workspaceId: WS,
    userId: USER,
    name: "create_payment",
    description: "create_payment",
    inputSchema,
    readOnly: false,
    riskGrade: "high",
    policyGroup: null,
    manifest: { name: "create_payment", description: null, inputSchema },
    source: "mcp",
    mcpServerId: SERVER,
    schemaOrigin: "imported",
  };
}

const tagged = {
  sideEffect: "irreversible",
  egress: "third_party",
  consequenceTags: ["moves_money"],
  measures: {},
  dataClasses: [],
};
const CLASSIFIED_AT = new Date("2026-09-15T01:00:00.000Z");

/** The UPDATE set_tool_classification issues against the active version. */
function classifyLatest() {
  const row = db.versions.find((v) => v.isLatest === true)!;
  Object.assign(row, {
    classification: tagged,
    classifiedRiskGrade: "critical",
    classifiedByUserId: ADMIN,
    classifiedAt: CLASSIFIED_AT,
    classificationReason: "moves customer funds",
  });
}

const moneySwitch: KillSwitchRow = {
  id: "id_1",
  publicId: "emd_1",
  targetKind: "class",
  targetId: "moves_money",
  scopeKind: "org",
  workspaceId: null,
  capabilityId: null,
  resourceScopeDigest: resourceScopeDigestOf({
    kind: "class",
    id: "moves_money",
  }),
  principalId: null,
  reason: "processor incident",
  active: true,
  activatedAt: new Date("2026-09-15T00:00:00Z"),
  deactivatedAt: null,
  flippedByUserId: ADMIN,
  updatedById: ADMIN,
};

beforeEach(() => {
  db.tool = null;
  db.versions.length = 0;
});

describe("publishTool", () => {
  it("a changed descriptor after a reclassification publishes a version that keeps the classification, and a class switch still stops it", async () => {
    const v1 = await publishTool(imported({ type: "object" }));
    classifyLatest();

    const v2 = await publishTool(
      imported({
        type: "object",
        properties: { amount: { type: "number" } },
      }),
    );

    expect(v2).toMatchObject({ published: true, version: 2 });
    const [first, second] = db.versions as VersionRow[];
    expect(first).toMatchObject({
      publicId: v1.versionPublicId,
      isLatest: false,
    });
    expect(second).toMatchObject({
      publicId: v2.versionPublicId,
      isLatest: true,
      parentVersionId: first!.id,
      // The declared grade and the checksum are the manifest's.
      riskGrade: "high",
      checksum: v2.checksum,
      // The classification is the one the previous version carried.
      classification: tagged,
      classifiedRiskGrade: "critical",
      classifiedByUserId: ADMIN,
      classifiedAt: CLASSIFIED_AT,
      classificationReason: "moves customer funds",
    });

    const capabilityId = registryCapabilityId({
      source: "mcp",
      slug: db.tool!.slug,
      name: "create_payment",
      mcpServerId: SERVER,
    });
    expect(
      gateOf([moneySwitch], {
        orgId: ORG,
        workspaceId: WS,
        capabilityId,
        serverId: SERVER,
        consequenceTags: (second!.classification as typeof tagged)
          .consequenceTags,
      }),
    ).toEqual({ kind: "killed_class", switchId: "emd_1" });
  });

  it("an unchanged descriptor after a reclassification publishes nothing: the classification is outside the checksum", async () => {
    const v1 = await publishTool(imported({ type: "object" }));
    classifyLatest();

    const again = await publishTool(imported({ type: "object" }));

    expect(again).toMatchObject({
      published: false,
      version: 1,
      versionPublicId: v1.versionPublicId,
      checksum: v1.checksum,
    });
    expect(db.versions).toHaveLength(1);
  });

  it("a first version carries no classification", async () => {
    await publishTool(imported({ type: "object" }));
    expect(db.versions[0]).not.toHaveProperty("classification");
    expect(db.tool?.slug).toBe(`mcp.${SERVER}.create_payment`);
  });
});
