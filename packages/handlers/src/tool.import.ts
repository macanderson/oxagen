// tool.import.ts — handler for the import_tools capability (#2958).
//
// Flow:
//   1. Role gate — org Owner or Admin, or workspace Owner (assertOrgRole;
//      the kernel's IAM check allows every capability for a non-enterprise
//      org, INV-29).
//   2. Resolve the server by its `mcs_…` public id in this workspace;
//      not_found otherwise.
//   3. Either publish the given declarations against it (origin `declared`),
//      or read the server's pinned descriptors (mcp.tool_snapshots, the same
//      pins the gateway executes) and publish the picked ones (origin
//      `imported`). A picked name the server has no pin for is not_found. A
//      pulled tool has no declared risk grade; it lands as `high` and
//      read_only false until an admin classifies it, the same fail-safe an
//      external tool gets at dispatch.
//   4. Stamp the server's last import: now, and a digest over the sorted
//      checksums of its tools' active versions.
//
// Each publish commits on its own transaction (publishTool holds the identity
// row's insert race), so a throw partway through leaves the tools before it
// committed. The stamp is therefore written for what ACTUALLY landed, on the
// way out of a failure too: `last_import_digest` is a digest over the active
// versions as they now are, so it never describes a registry state that does
// not exist. The failure is then rethrown — a partial import is a failed one,
// and re-running it republishes only what changed.
//
// The pull-request path the mockup shows (declarations to `.oxagen/tools/` on
// a branch) needs a bound repository, which no capability records; ADR-072.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { toolImport } from "@oxagen/oxagen/contracts/tool.import";
import { TOOL_NAME_MAX_LENGTH } from "@oxagen/oxagen/contracts/tool.declaration.publish";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { readLatestPinnedDescriptors } from "@oxagen/agent/runtime/mcp-snapshots";
import type { McpToolDescriptor } from "@oxagen/agent/dispatch/mcp-client";
import { and, eq, isNull, sql } from "drizzle-orm";
import { sha256Hex } from "./registry-digest";
import { publishTool, type PublishToolArgs } from "./lib/tool-registry";
import { logger } from "./logger";

/** A tool as the server pins it; the shape mcp-snapshots.ts reads back. */
export type PinnedDescriptor = McpToolDescriptor;

/** The reads and writes the handler makes; injectable for tests. */
export interface ToolImportDeps {
  findServer(scope: {
    orgId: string;
    workspaceId: string;
    publicId: string;
  }): Promise<{ id: string; publicId: string } | null>;
  readPins(scope: {
    orgId: string;
    workspaceId: string;
    serverId: string;
  }): Promise<PinnedDescriptor[]>;
  publish(args: PublishToolArgs): ReturnType<typeof publishTool>;
  /** Checksums of the active versions of every tool on the server, after the publishes. */
  activeChecksums(scope: {
    orgId: string;
    workspaceId: string;
    serverId: string;
  }): Promise<string[]>;
  stampImport(args: {
    serverId: string;
    digest: string;
    userId: string | null;
  }): Promise<void>;
}

const postgresToolImportDeps: ToolImportDeps = {
  findServer: async (scope) => {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.mcpServers.id,
          publicId: schema.mcpServers.publicId,
        })
        .from(schema.mcpServers)
        .where(
          and(
            eq(schema.mcpServers.orgId, scope.orgId),
            eq(schema.mcpServers.workspaceId, scope.workspaceId),
            eq(schema.mcpServers.publicId, scope.publicId),
            isNull(schema.mcpServers.deletedAt),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },
  readPins: (scope) =>
    readLatestPinnedDescriptors(scope.orgId, scope.workspaceId, scope.serverId),
  publish: publishTool,
  activeChecksums: async (scope) => {
    const rows = await withTenantDb((tx) =>
      tx
        .select({ checksum: schema.toolVersions.checksum })
        .from(schema.tools)
        .innerJoin(
          schema.toolVersions,
          eq(schema.toolVersions.id, schema.tools.activeVersionId),
        )
        .where(
          and(
            eq(schema.tools.orgId, scope.orgId),
            eq(schema.tools.workspaceId, scope.workspaceId),
            eq(schema.tools.mcpServerId, scope.serverId),
            isNull(schema.tools.deletedAt),
          ),
        ),
    );
    return rows.map((r) => r.checksum);
  },
  stampImport: async (args) => {
    await withTenantDb((tx) =>
      tx
        .update(schema.mcpServers)
        .set({
          lastImportAt: sql`now()`,
          lastImportDigest: args.digest,
          updatedAt: sql`now()`,
          updatedById: args.userId ?? undefined,
        })
        .where(eq(schema.mcpServers.id, args.serverId)),
    );
  },
};

/** sha256 over the sorted checksums: the same set of versions gives the same digest. */
export function importDigestOf(checksums: readonly string[]): string {
  return sha256Hex([...checksums].sort().join("\n"));
}

export function createToolImportHandler(
  deps: ToolImportDeps,
): CapabilityHandler<typeof toolImport> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const server = await deps.findServer({
      ...scope,
      publicId: input.serverId,
    });
    if (!server) {
      throw new HandlerError({
        code: "not_found",
        reason: "server_not_found",
        message: `No MCP server ${input.serverId} in this workspace`,
      });
    }

    const publishes: Array<
      Omit<
        PublishToolArgs,
        "orgId" | "workspaceId" | "userId" | "source" | "mcpServerId"
      >
    > = [];
    if (input.declarations) {
      for (const d of input.declarations) {
        publishes.push({
          name: d.name,
          description: d.description,
          inputSchema: d.input_schema,
          readOnly: d.read_only,
          riskGrade: d.risk_grade,
          policyGroup: d.policy_group ?? null,
          manifest: d.manifest,
          schemaOrigin: "declared",
          consequenceTags: d.consequence_tags,
          measures: d.measures,
          effectIdPath: d.effect_id_path ?? null,
        });
      }
    } else {
      const pins = await deps.readPins({ ...scope, serverId: server.id });
      const byName = new Map(pins.map((p) => [p.name, p] as const));
      const picked = input.tools ?? pins.map((p) => p.name);
      for (const name of picked) {
        const pin = byName.get(name);
        if (!pin) {
          throw new HandlerError({
            code: "not_found",
            reason: "tool_not_pinned",
            message: `Server ${input.serverId} has no pinned tool named ${name}`,
          });
        }
        publishes.push({
          name: pin.name,
          description: pin.description ?? pin.name,
          inputSchema: pin.inputSchema,
          readOnly: false,
          riskGrade: "high",
          policyGroup: null,
          // The pinned descriptor verbatim: what the gateway executes is
          // what the registry versions.
          manifest: {
            name: pin.name,
            description: pin.description,
            inputSchema: pin.inputSchema,
          },
          schemaOrigin: "imported",
          // A pulled descriptor states no consequences: it lands unclassified
          // and an admin classifies it, the same fail-safe as the risk grade.
          consequenceTags: [],
          measures: {},
          effectIdPath: null,
        });
      }
    }

    // A pulled descriptor's name is the server's, not ours: `tools/list` is an
    // external party's answer and nothing upstream bounds it. It matters
    // because an imported tool is GOVERNED under `mcp.<server uuid>.<name>`,
    // and that identity goes into the run spec's tool policy — which pins
    // EVERY materialized tool. So a single over-long name landing in the
    // registry does not break that tool; it fails spec admission for every
    // assistant turn in the workspace. Refuse it at the door, where the error
    // names the tool that caused it, rather than at the door of every turn,
    // where it names nothing.
    //
    // The declarations path is already bounded by the contract; this covers
    // both, because both arrive here.
    for (const p of publishes) {
      if (p.name.length > TOOL_NAME_MAX_LENGTH) {
        throw new HandlerError({
          // `conflict`: the write would leave the registry in a state the
          // domain forbids — a tool nothing could name in a run spec, and so
          // a tool no turn in this workspace could run alongside.
          code: "conflict",
          reason: "tool_name_too_long",
          message:
            `Tool name is ${p.name.length} characters; the limit is ` +
            `${TOOL_NAME_MAX_LENGTH}. A longer name cannot be named in a ` +
            `run's tool policy, so it could not be governed.`,
        });
      }
    }

    const stampWhatLanded = async (): Promise<string> => {
      const digest = importDigestOf(
        await deps.activeChecksums({ ...scope, serverId: server.id }),
      );
      await deps.stampImport({
        serverId: server.id,
        digest,
        userId: actingUserId,
      });
      return digest;
    };

    const tools = [];
    let landed = 0;
    try {
      for (const p of publishes) {
        const published = await deps.publish({
          ...p,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId: actingUserId,
          source: "mcp",
          capability: "import_tools",
          mcpServerId: server.id,
        });
        landed += 1;
        tools.push({
          id: published.versionPublicId,
          toolId: published.publicId,
          slug: published.slug,
          name: p.name,
          version: published.version,
          checksum: published.checksum,
          schemaOrigin: p.schemaOrigin,
          consequenceTags: [...(p.consequenceTags ?? [])],
          measures: p.measures ?? {},
          effectIdPath: p.effectIdPath ?? null,
          published: published.published,
        });
      }
    } catch (err) {
      // Publishes before the throw are committed. Stamp the registry as it now
      // is so the recorded digest describes a state that exists, then surface
      // the failure. A stamp that itself fails must not mask the real error.
      if (landed > 0) {
        try {
          await stampWhatLanded();
        } catch (stampErr) {
          logger.error(
            { err: stampErr, serverId: server.publicId, landed },
            "tool.import: partial import could not be stamped",
          );
        }
      }
      throw err;
    }

    const importDigest = await stampWhatLanded();

    return { serverId: server.publicId, importDigest, tools };
  };
}

export const toolImportHandler = createToolImportHandler(
  postgresToolImportDeps,
);
