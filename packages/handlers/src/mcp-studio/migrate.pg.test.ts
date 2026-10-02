/**
 * migrate() against Postgres. Runs in the CI Postgres job and locally with
 * DATABASE_URL set; skipped otherwise.
 *
 * One workspace holds one server connected the old way, with two tools: one
 * an admin classified, and one nobody ever classified. migrate() reads the
 * rows, opens one steering PR through a fake opener, and names the moved
 * row's folder. The test reads the PR the opener received:
 *
 *   - the classified tool keeps its risk, side effect, egress, and impacts
 *   - the unclassified tool is written as risk high, side effect write, and
 *     egress third_party
 *   - the PR body lists the unclassified tool for review, and only that one
 *
 * mcp.mcp_servers, agent.tools, and agent.tool_versions carry no foreign key
 * to an organization or a workspace, so the file writes neither. afterAll
 * removes every row it wrote.
 */
import { randomUUID } from "node:crypto";
import { schema, withSystemDb } from "@oxagen/database";
import { parseServerToml, parseToolsToml } from "@oxagen/mcp-studio";
import type {
  OpenSteeringPrRequest,
  SteeringPrOpener,
} from "@oxagen/agent/runtime/steering-pr";
import {
  serverTomlPath,
  toolsTomlPath,
} from "@oxagen/oxagen/steering-repo/paths";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";

describe.skipIf(!process.env.DATABASE_URL)(
  "migrate() against Postgres",
  () => {
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const serverId = randomUUID();
    const refundId = randomUUID();
    const lookupId = randomUUID();
    const now = new Date("2026-10-01T12:00:00.000Z");

    function fakeOpener(): SteeringPrOpener & {
      requests: OpenSteeringPrRequest[];
    } {
      const requests: OpenSteeringPrRequest[] = [];
      return {
        requests,
        hasSteeringRepo: async () => true,
        readFile: async () => null,
        open: async (request) => {
          requests.push(request);
          return {
            number: 100 + requests.length,
            url: `https://github.com/acme/steering/pull/${100 + requests.length}`,
            branch: request.branch,
          };
        },
      };
    }

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        await tx.insert(schema.mcpServers).values({
          id: serverId,
          orgId,
          workspaceId,
          name: "Billing",
          transportType: "streamable-http",
          endpointUrl: "https://mcp.billing.example.com/mcp",
          authStrategy: "none",
          authConfig: {},
          healthStatus: "unknown",
          enabled: true,
          origin: "legacy",
        });
        // agent.tools.active_version_id is the one foreign key, so each tool
        // goes in first, then its version, then the pointer to it.
        for (const id of [refundId, lookupId]) {
          const name = id === refundId ? "refund" : "lookup";
          await tx.insert(schema.tools).values({
            id,
            orgId,
            workspaceId,
            name,
            slug: `mcp.${serverId}.${name}`,
            description: `The ${name} tool.`,
            source: "mcp",
            enabled: true,
            mcpServerId: serverId,
          });
        }
        const refundVersion = randomUUID();
        await tx.insert(schema.toolVersions).values({
          id: refundVersion,
          orgId,
          workspaceId,
          toolId: refundId,
          versionNumber: 1,
          isLatest: true,
          inputSchema: {
            type: "object",
            properties: { amount: { type: "number" } },
          },
          riskGrade: "medium",
          manifest: {},
          checksum: "a".repeat(64),
          schemaOrigin: "imported",
          impacts: ["moves_money"],
          classification: {
            sideEffect: "irreversible",
            egress: "third_party",
            impacts: ["moves_money"],
            measures: {},
            dataClasses: [],
          },
          classifiedRiskGrade: "high",
          classifiedAt: now,
        });
        // Never classified: no classification, no classifier's grade.
        const lookupVersion = randomUUID();
        await tx.insert(schema.toolVersions).values({
          id: lookupVersion,
          orgId,
          workspaceId,
          toolId: lookupId,
          versionNumber: 1,
          isLatest: true,
          inputSchema: { type: "object" },
          riskGrade: "low",
          manifest: {},
          checksum: "b".repeat(64),
          schemaOrigin: "imported",
        });
        await tx
          .update(schema.tools)
          .set({ activeVersionId: refundVersion })
          .where(eq(schema.tools.id, refundId));
        await tx
          .update(schema.tools)
          .set({ activeVersionId: lookupVersion })
          .where(eq(schema.tools.id, lookupId));
      });
    });

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        // tools.active_version_id references tool_versions.id, so tools go first.
        await tx
          .delete(schema.tools)
          .where(eq(schema.tools.workspaceId, workspaceId));
        await tx
          .delete(schema.toolVersions)
          .where(eq(schema.toolVersions.workspaceId, workspaceId));
        await tx
          .delete(schema.mcpServers)
          .where(eq(schema.mcpServers.workspaceId, workspaceId));
      });
    });

    it("opens one PR that keeps the classified tool's classification and flags the unclassified one", async () => {
      const opener = fakeOpener();

      const { opened, plan } = await migrate(
        { orgId, workspaceId },
        { opener, now },
      );

      expect(opened.map((pr) => pr.number)).toEqual([101]);
      expect(plan.notMoved).toEqual([]);
      expect(plan.toolsNotMoved).toEqual([]);
      expect(opener.requests).toHaveLength(1);
      const request = opener.requests[0] as OpenSteeringPrRequest;
      expect(request.orgId).toBe(orgId);
      expect(request.actorUserId).toBeNull();
      expect(request.title).toBe(
        "Move connected MCP servers into the steering repo (batch 1 of 1)",
      );

      const fileText = (path: string): string => {
        const file = request.files.find((f) => f.path === path);
        if (!file) throw new Error(`the PR has no ${path}`);
        return file.content;
      };
      const server = parseServerToml(fileText(serverTomlPath("billing")));
      if (!server.ok) throw new Error(JSON.stringify(server.issues));
      expect(server.value).toMatchObject({
        name: "billing",
        label: "Billing",
        source: {
          type: "remote",
          url: "https://mcp.billing.example.com/mcp",
          transport: "http",
        },
        auth: { mode: "none" },
      });

      const tools = parseToolsToml(fileText(toolsTomlPath("billing")));
      if (!tools.ok) throw new Error(JSON.stringify(tools.issues));
      expect(tools.value.tools).toEqual({
        // The classifier's grade, side effect, egress, and impacts carry over.
        refund: {
          risk: "high",
          side_effect: "irreversible",
          egress: "third_party",
          impacts: ["moves_money"],
        },
        // A tool nobody classified gets the defaults, whatever its declared grade.
        lookup: {
          risk: "high",
          side_effect: "write",
          egress: "third_party",
        },
      });

      const [folder] = plan.batches[0]?.folders ?? [];
      expect(folder?.folder).toBe("billing");
      expect(folder?.unclassified).toEqual(["billing__lookup"]);

      // The body lists the unclassified tool for review, and not the other.
      const heading = "## Tools with no classification";
      expect(request.body).toContain(heading);
      const section = (request.body.split(heading)[1] ?? "").split("\n## ")[0];
      expect(section).toContain("- `billing__lookup`");
      expect(section).not.toContain("billing__refund");

      // The moved row names its folder and stays legacy until the first
      // publish after the PR merges takes it over.
      const [row] = await withSystemDb((tx) =>
        tx
          .select({
            steeringName: schema.mcpServers.steeringName,
            origin: schema.mcpServers.origin,
            enabled: schema.mcpServers.enabled,
          })
          .from(schema.mcpServers)
          .where(eq(schema.mcpServers.id, serverId)),
      );
      expect(row).toEqual({
        steeringName: "billing",
        origin: "legacy",
        enabled: true,
      });
    });

    it("opens nothing on a second run while the first PR is open", async () => {
      const opener = fakeOpener();

      const { opened, plan } = await migrate(
        { orgId, workspaceId },
        { opener, now },
      );

      expect(opened).toEqual([]);
      expect(plan.batches).toEqual([]);
      expect(opener.requests).toEqual([]);
    });
  },
);
