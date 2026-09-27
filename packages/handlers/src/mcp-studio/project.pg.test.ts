/**
 * project() against Postgres. Runs in the CI Postgres job and locally with
 * DATABASE_URL set; skipped otherwise.
 *
 * One workspace goes through a sequence of steering versions built from MCP
 * Studio's fixture manifest (billing and stripe, two tools each):
 *
 *   1. the first version inserts both servers and publishes all four tools
 *   2. a changed classification edits the version in place and bumps the
 *      deny generation
 *   3. a new definition_hash publishes version 2 and makes it active
 *   4. the old hash again makes version 1 active, which is a restore
 *   5. a tool the folder drops is disabled, and listing it again enables it
 *   6. a folder the version drops retires its server and disables its tools
 *   7. projecting the same version again writes nothing
 *   8. the folder coming back revives its server and enables its tools
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schema, withSystemDb } from "@oxagen/database";
import { toolManifestSchema, type ToolManifest } from "@oxagen/mcp-studio";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { project, type ProjectionSummary } from "./project";

const fixture: ToolManifest = toolManifestSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../mcp-studio/fixtures/expected/tool-manifest.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ),
);

type ManifestServer = ToolManifest["servers"][number];
type ManifestTool = ManifestServer["tools"][string];

function editTool(
  manifest: ToolManifest,
  server: string,
  key: string,
  edit: (tool: ManifestTool) => ManifestTool,
): ToolManifest {
  return {
    ...manifest,
    servers: manifest.servers.map((s) => {
      if (s.name !== server) return s;
      const tool = s.tools[key];
      if (!tool) throw new Error(`fixture has no tool ${server}.${key}`);
      return { ...s, tools: { ...s.tools, [key]: edit(tool) } };
    }),
  };
}

function dropTool(
  manifest: ToolManifest,
  server: string,
  key: string,
): ToolManifest {
  return {
    ...manifest,
    servers: manifest.servers.map((s) =>
      s.name === server
        ? {
            ...s,
            tools: Object.fromEntries(
              Object.entries(s.tools).filter(([k]) => k !== key),
            ),
          }
        : s,
    ),
  };
}

function dropServer(manifest: ToolManifest, server: string): ToolManifest {
  return {
    ...manifest,
    servers: manifest.servers.filter((s) => s.name !== server),
  };
}

const ZERO: ProjectionSummary = {
  servers: { inserted: 0, updated: 0, revived: 0, takenOver: 0, retired: 0 },
  tools: {
    published: 0,
    activated: 0,
    reclassified: 0,
    refreshed: 0,
    disabled: 0,
    enabled: 0,
  },
};

/** ZERO with the counts a step expects. */
function counts(
  servers: Partial<ProjectionSummary["servers"]>,
  tools: Partial<ProjectionSummary["tools"]>,
): ProjectionSummary {
  return {
    servers: { ...ZERO.servers, ...servers },
    tools: { ...ZERO.tools, ...tools },
  };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "project() against Postgres",
  () => {
    const tag = randomUUID().replace(/-/g, "").slice(0, 8);
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const orgSlug = `m13-project-${tag}`;
    const workspaceSlug = "tools";
    let version = 0;

    /**
     * A bundle carrying the fields project() reads: its scope, its
     * organization and workspace, its version, and its tool manifest. The
     * records, policies and agents are S5's and play no part here.
     */
    function bundle(tools: ToolManifest): Bundle {
      version += 1;
      return {
        schema: "bundle/v1",
        scope: "workspace",
        organization: orgSlug,
        workspace: workspaceSlug,
        version,
        tools,
      } as unknown as Bundle;
    }

    async function toolRows() {
      return withSystemDb((tx) =>
        tx
          .select({
            id: schema.tools.id,
            slug: schema.tools.slug,
            enabled: schema.tools.enabled,
            source: schema.tools.source,
            mcpServerId: schema.tools.mcpServerId,
            activeVersionId: schema.tools.activeVersionId,
            deletedAt: schema.tools.deletedAt,
          })
          .from(schema.tools)
          .where(eq(schema.tools.workspaceId, workspaceId)),
      );
    }

    async function serverRows() {
      return withSystemDb((tx) =>
        tx
          .select({
            id: schema.mcpServers.id,
            steeringName: schema.mcpServers.steeringName,
            origin: schema.mcpServers.origin,
            transportType: schema.mcpServers.transportType,
            endpointUrl: schema.mcpServers.endpointUrl,
            discoveredTools: schema.mcpServers.discoveredTools,
            deletedAt: schema.mcpServers.deletedAt,
          })
          .from(schema.mcpServers)
          .where(eq(schema.mcpServers.workspaceId, workspaceId)),
      );
    }

    async function activeVersion(slug: string) {
      const tools = await toolRows();
      const activeId = tools.find((t) => t.slug === slug)?.activeVersionId;
      if (!activeId) throw new Error(`${slug} has no active version`);
      const [row] = await withSystemDb((tx) =>
        tx
          .select({
            versionNumber: schema.toolVersions.versionNumber,
            checksum: schema.toolVersions.checksum,
            riskGrade: schema.toolVersions.riskGrade,
            readOnly: schema.toolVersions.readOnly,
            impacts: schema.toolVersions.impacts,
            classification: schema.toolVersions.classification,
            classifiedRiskGrade: schema.toolVersions.classifiedRiskGrade,
          })
          .from(schema.toolVersions)
          .where(eq(schema.toolVersions.id, activeId)),
      );
      if (!row) throw new Error(`${slug}'s active version is missing`);
      return row;
    }

    /** The organization's deny generations, summed: any bump raises it. */
    async function denyGeneration(): Promise<number> {
      const rows = await withSystemDb((tx) =>
        tx
          .select({ generation: schema.authorizationDenyGenerations.generation })
          .from(schema.authorizationDenyGenerations)
          .where(eq(schema.authorizationDenyGenerations.orgId, orgId)),
      );
      return rows.reduce((sum, r) => sum + r.generation, 0);
    }

    const hexOf = (hash: string) => hash.replace(/^sha256:/, "");

    const reclassified = editTool(fixture, "stripe", "list_charges", (t) => ({
      ...t,
      classification: { ...t.classification, impacts: ["exports_data"] },
    }));
    const refundHash = (() => {
      const stripe = fixture.servers.find((s) => s.name === "stripe");
      const refund = stripe?.tools.create_refund;
      if (!refund) throw new Error("fixture changed");
      return refund.definition_hash;
    })();
    const newHash = `sha256:${"a".repeat(64)}`;

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.organizations).values({
          id: orgId,
          name: `M13 projection ${tag}`,
          slug: orgSlug,
          namespace: `p${tag.slice(0, 5)}`,
          planType: "free",
          status: "active",
        });
        await tx.insert(schema.workspaces).values({
          id: workspaceId,
          orgId,
          name: "Tools",
          slug: workspaceSlug,
          namespace: `w${tag.slice(0, 5)}`,
        });
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        // tools.active_version_id references tool_versions.id and
        // tools.mcp_server_id references mcp_servers.id, so tools go first.
        await tx
          .delete(schema.tools)
          .where(eq(schema.tools.workspaceId, workspaceId));
        await tx
          .delete(schema.toolVersions)
          .where(eq(schema.toolVersions.workspaceId, workspaceId));
        await tx
          .delete(schema.mcpServers)
          .where(eq(schema.mcpServers.workspaceId, workspaceId));
        await tx
          .delete(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId));
        await tx
          .delete(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
      });
    });

    it("walks a workspace through eight steering versions", async () => {
      // 1. The first version.
      expect(await project(bundle(fixture))).toEqual(
        counts({ inserted: 2 }, { published: 4 }),
      );
      const servers = await serverRows();
      expect(
        servers
          .map((s) => [s.steeringName, s.origin, s.transportType, s.deletedAt])
          .sort(),
      ).toEqual([
        ["billing", "steering", "openapi", null],
        ["stripe", "steering", "streamable-http", null],
      ]);
      const stripeId = servers.find((s) => s.steeringName === "stripe")?.id;
      const tools = await toolRows();
      expect(tools.map((t) => t.slug).sort()).toEqual([
        "billing__create_refund",
        "billing__list_charges",
        "stripe__create_refund",
        "stripe__list_charges",
      ]);
      expect(tools.every((t) => t.enabled && t.source === "mcp")).toBe(true);
      expect(
        tools
          .filter((t) => t.slug.startsWith("stripe__"))
          .every((t) => t.mcpServerId === stripeId),
      ).toBe(true);
      const refundV1 = await activeVersion("stripe__create_refund");
      expect(refundV1).toMatchObject({
        versionNumber: 1,
        checksum: hexOf(refundHash),
        riskGrade: "high",
        classifiedRiskGrade: "high",
        readOnly: false,
        impacts: ["moves_money"],
        classification: {
          sideEffect: "irreversible",
          egress: "third_party",
          impacts: ["moves_money"],
        },
      });
      expect((await activeVersion("stripe__list_charges")).readOnly).toBe(true);

      // 2. A changed classification edits the version in place.
      const beforeReclassify = await denyGeneration();
      expect(await project(bundle(reclassified))).toEqual(
        counts({}, { reclassified: 1 }),
      );
      const listed = await activeVersion("stripe__list_charges");
      expect(listed.versionNumber).toBe(1);
      expect(listed.impacts).toEqual(["exports_data"]);
      expect(listed.classification).toMatchObject({
        impacts: ["exports_data"],
      });
      expect(await denyGeneration()).toBeGreaterThan(beforeReclassify);

      // 3. A new definition_hash publishes version 2.
      const withNewHash = editTool(
        reclassified,
        "stripe",
        "create_refund",
        (t) => ({ ...t, definition_hash: newHash }),
      );
      expect(await project(bundle(withNewHash))).toEqual(
        counts({}, { published: 1 }),
      );
      const refundV2 = await activeVersion("stripe__create_refund");
      expect(refundV2.versionNumber).toBe(2);
      expect(refundV2.checksum).toBe(hexOf(newHash));

      // 4. The old hash again makes version 1 active.
      const beforeRestore = await denyGeneration();
      expect(await project(bundle(reclassified))).toEqual(
        counts({}, { activated: 1 }),
      );
      expect((await activeVersion("stripe__create_refund")).versionNumber).toBe(
        1,
      );
      expect(await denyGeneration()).toBeGreaterThan(beforeRestore);

      // 5. A dropped tool is disabled, and listing it again enables it.
      expect(
        await project(bundle(dropTool(reclassified, "billing", "list_charges"))),
      ).toEqual(counts({ updated: 1 }, { disabled: 1 }));
      expect(
        (await toolRows()).find((t) => t.slug === "billing__list_charges")
          ?.enabled,
      ).toBe(false);
      expect(await project(bundle(reclassified))).toEqual(
        counts({ updated: 1 }, { enabled: 1 }),
      );
      expect(
        (await toolRows()).find((t) => t.slug === "billing__list_charges")
          ?.enabled,
      ).toBe(true);

      // 6. A dropped folder retires its server and disables its tools.
      const withoutStripe = dropServer(reclassified, "stripe");
      expect(await project(bundle(withoutStripe))).toEqual(
        counts({ retired: 1 }, { disabled: 2 }),
      );
      const retired = (await serverRows()).find(
        (s) => s.steeringName === "stripe",
      );
      expect(retired?.deletedAt).not.toBeNull();
      expect(
        (await toolRows())
          .filter((t) => t.slug.startsWith("stripe__"))
          .every((t) => !t.enabled),
      ).toBe(true);

      // 7. The same version again writes nothing.
      expect(await project(bundle(withoutStripe))).toEqual(ZERO);

      // 8. The folder coming back revives its server, under the same id.
      expect(await project(bundle(reclassified))).toEqual(
        counts({ revived: 1 }, { enabled: 2 }),
      );
      const revived = (await serverRows()).find(
        (s) => s.steeringName === "stripe",
      );
      expect(revived?.id).toBe(stripeId);
      expect(revived?.deletedAt).toBeNull();
      expect(
        (await toolRows())
          .filter((t) => t.slug.startsWith("stripe__"))
          .every((t) => t.enabled),
      ).toBe(true);
    });

    it("leaves the rows of a folder that did not compile", async () => {
      const before = await serverRows();
      expect(
        await project(bundle(dropServer(reclassified, "stripe")), {
          folders: ["billing", "stripe"],
        }),
      ).toEqual(ZERO);
      expect(await serverRows()).toEqual(before);
    });

    it("refuses a workspace no organization holds", async () => {
      await expect(
        project({
          ...bundle(fixture),
          organization: `missing-${tag}`,
        } as Bundle),
      ).rejects.toThrow(/No workspace/);
    });
  },
);
