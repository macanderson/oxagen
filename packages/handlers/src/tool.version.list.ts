// tool.version.list.ts — handler for the list_tool_versions capability
// (#2958): the Tools page's registry table.
//
// audit-exempt: read-only. Lists the workspace's tools with their active
// version; nothing privileged is disclosed, and the kernel's
// capability.invoke_* audit records the access.
//
// Flow:
//   1. Role gate — org Owner or Admin, or any workspace role (assertOrgRole).
//   2. Decode the cursor (slug, id — the registry orders by slug); a cursor
//      this handler did not write is invalid_input.
//   3. Read one row past the page: tools joined to their active version,
//      optionally only those carrying the category tag in either half of the
//      consequence tags (the declared `consequence_tags` column or the
//      classified `classification` jsonb), and optionally only those imported
//      from one server, named by its `mcs_…` public id.
//   4. Decide the gate each row is under today from the switches that are on
//      — version, then server, then class (the recorded decision order,
//      INV-10) — with the same matcher the gateway's gate uses, and read the
//      30-day call counts from ClickHouse for the page's capability ids; an
//      unanswered store prints null, never 0.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  toolVersionList,
  type ToolGate,
  type ToolVersionItem,
} from "@oxagen/oxagen/contracts/tool.version.list";
import {
  toolClassificationSchema,
  toolRiskGradeSchema,
} from "@oxagen/oxagen/contracts/tool.classification";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  matchKillSwitch,
  readActiveKillSwitches,
  type KillSwitchRow,
} from "@oxagen/iam";
import { countRecentToolInvocations } from "@oxagen/telemetry";
import {
  registryCapabilityId,
  unionConsequenceTags,
} from "@oxagen/agent/runtime/tool-registry-facts";
import { and, asc, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import { logger } from "./logger";

// ---- Cursor ---------------------------------------------------------------

type RegistryCursor = { slug: string; id: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeRegistryCursor(cursor: RegistryCursor): string {
  return Buffer.from(JSON.stringify([cursor.slug, cursor.id]), "utf8").toString(
    "base64url",
  );
}

export function decodeRegistryCursor(raw: string): RegistryCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      !UUID_RE.test(value[1])
    )
      return null;
    return { slug: value[0], id: value[1] };
  } catch {
    return null;
  }
}

// ---- Rows -----------------------------------------------------------------

/** One registry row as the query reads it. */
export interface RegistryRow {
  toolId: string;
  toolPublicId: string;
  slug: string;
  name: string;
  description: string | null;
  source: string;
  mcpServerId: string | null;
  serverPublicId: string | null;
  enabled: boolean;
  updatedAt: Date;
  versionPublicId: string;
  versionNumber: number;
  readOnly: boolean;
  riskGrade: string;
  classifiedRiskGrade: string | null;
  classification: unknown;
  /** The declared half of the consequence tags (agent.tool_versions.consequence_tags). */
  consequenceTags: string[] | null;
  classifiedAt: Date | null;
  schemaOrigin: string;
  checksum: string;
}

export type PageQuery = {
  cursor: RegistryCursor | null;
  limit: number;
  category: string | null;
  /** The `mcs_…` public id of the one server whose versions the page holds. */
  serverId: string | null;
};

const tools = schema.tools;
const versions = schema.toolVersions;
const servers = schema.mcpServers;

function afterCursor(cursor: RegistryCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    gt(tools.slug, cursor.slug),
    and(eq(tools.slug, cursor.slug), gt(tools.id, cursor.id)),
  );
}

/** Tools with an active version, by slug, one past the page. */
function registryPageQuery(
  db: Pick<Tx, "select">,
  scope: { orgId: string; workspaceId: string },
  q: PageQuery,
) {
  return db
    .select({
      toolId: tools.id,
      toolPublicId: tools.publicId,
      slug: tools.slug,
      name: tools.name,
      description: tools.description,
      source: tools.source,
      mcpServerId: tools.mcpServerId,
      serverPublicId: servers.publicId,
      enabled: tools.enabled,
      updatedAt: tools.updatedAt,
      versionPublicId: versions.publicId,
      versionNumber: versions.versionNumber,
      readOnly: versions.readOnly,
      riskGrade: versions.riskGrade,
      classifiedRiskGrade: versions.classifiedRiskGrade,
      classification: versions.classification,
      consequenceTags: versions.consequenceTags,
      classifiedAt: versions.classifiedAt,
      schemaOrigin: versions.schemaOrigin,
      checksum: versions.checksum,
    })
    .from(tools)
    .innerJoin(versions, eq(versions.id, tools.activeVersionId))
    .leftJoin(servers, eq(servers.id, tools.mcpServerId))
    .where(
      and(
        eq(tools.orgId, scope.orgId),
        eq(tools.workspaceId, scope.workspaceId),
        isNull(tools.deletedAt),
        // The category is a consequence tag, and a tag lives in either half:
        // the declared text[] column or the classified jsonb. Filtering on the
        // jsonb alone hid every declared-tag tool from the page the class kill
        // switch is operated from.
        // Both halves are written with a jsonb_path_ops / array GIN index
        // (tool_versions_classification_tags_gin,
        // tool_versions_consequence_tags_gin), so `@>` on either is an index
        // lookup rather than a scan of the workspace's registry.
        q.category === null
          ? undefined
          : sql`(${versions.classification}->'consequenceTags' @> ${JSON.stringify([q.category])}::jsonb OR ${versions.consequenceTags} @> ARRAY[${q.category}]::text[])`,
        // The server is named by its public id, the one the page and the MCP
        // tool know; the join above already carries it. A declared tool has
        // no server, so the left join's null never matches.
        q.serverId === null ? undefined : eq(servers.publicId, q.serverId),
        afterCursor(q.cursor),
      ),
    )
    .orderBy(asc(tools.slug), asc(tools.id))
    .limit(q.limit + 1);
}

// ---- Dependencies ----------------------------------------------------------

export interface ToolVersionListDeps {
  page(
    scope: { orgId: string; workspaceId: string },
    q: PageQuery,
  ): Promise<RegistryRow[]>;
  activeSwitches(scope: {
    orgId: string;
    workspaceId: string;
  }): Promise<KillSwitchRow[]>;
  /** Calls in the last 30 days by capability id; null when the store did not answer. */
  calls30d(
    capabilityIds: readonly string[],
  ): Promise<Map<string, number> | null>;
}

const postgresToolVersionListDeps: ToolVersionListDeps = {
  page: (scope, q) => withTenantDb((tx) => registryPageQuery(tx, scope, q)),
  activeSwitches: (scope) =>
    withTenantDb((tx) => readActiveKillSwitches(tx, scope)),
  calls30d: async (capabilityIds) => {
    try {
      return await countRecentToolInvocations(capabilityIds);
    } catch (err) {
      logger.warn(
        { err },
        "tool.version.list: ClickHouse did not answer — calls30d is null",
      );
      return null;
    }
  },
};

// ---- Mapping --------------------------------------------------------------

/** The registry gate: version, then server, then class switches; scope switches belong to the page header. */
const GATE_KINDS = new Set(["tool_version", "tool_server", "class"]);

export function gateOf(
  switches: readonly KillSwitchRow[],
  facts: {
    orgId: string;
    workspaceId: string;
    capabilityId: string;
    serverId: string | null;
    consequenceTags: readonly string[];
  },
): ToolGate {
  const hit = matchKillSwitch(
    switches.filter((s) => GATE_KINDS.has(s.targetKind)),
    facts,
  );
  if (hit === null) return { kind: "open", switchId: null };
  const kind =
    hit.targetKind === "tool_version"
      ? "killed_version"
      : hit.targetKind === "tool_server"
        ? "killed_server"
        : "killed_class";
  return { kind, switchId: hit.publicId };
}

function classificationOf(row: RegistryRow): ToolVersionItem["classification"] {
  if (row.classification === null) return null;
  const parsed = toolClassificationSchema.safeParse(row.classification);
  if (!parsed.success) {
    // Written by set_tool_classification through the same schema; a row
    // outside it is a broken row and the read fails rather than guesses.
    throw new RangeError(
      `tool_versions ${row.versionPublicId}: classification outside the schema`,
    );
  }
  return parsed.data;
}

function sourceOf(row: RegistryRow): ToolVersionItem["source"] {
  switch (row.source) {
    case "builtin":
    case "custom":
    case "mcp":
    case "foundry":
      return row.source;
    default:
      throw new RangeError(
        `tools ${row.toolPublicId}: source outside the CHECK`,
      );
  }
}

function schemaOriginOf(row: RegistryRow): ToolVersionItem["schemaOrigin"] {
  if (row.schemaOrigin === "declared" || row.schemaOrigin === "imported")
    return row.schemaOrigin;
  throw new RangeError(
    `tool_versions ${row.versionPublicId}: schema_origin outside the CHECK`,
  );
}

// ---- The handler ------------------------------------------------------------

export function createToolVersionListHandler(
  deps: ToolVersionListDeps,
): CapabilityHandler<typeof toolVersionList> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      {
        org: ["Owner", "Admin"],
        workspace: ["Owner", "Member", "Viewer"],
      },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const cursor =
      input.cursor === undefined ? null : decodeRegistryCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null)
      throw new CapabilityError(
        toolVersionList.name,
        "invalid_input",
        "invalid_cursor",
      );

    const rows = await deps.page(scope, {
      cursor,
      limit: input.limit,
      category: input.category ?? null,
      serverId: input.serverId ?? null,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);

    const capabilityIds = page.map(registryCapabilityId);
    const [switches, calls] = await Promise.all([
      deps.activeSwitches(scope),
      deps.calls30d(capabilityIds),
    ]);

    const items: ToolVersionItem[] = page.map((row, i) => {
      const classification = classificationOf(row);
      const capabilityId = capabilityIds[i]!;
      return {
        id: row.versionPublicId,
        toolId: row.toolPublicId,
        slug: row.slug,
        name: row.name,
        description: row.description,
        version: row.versionNumber,
        source: sourceOf(row),
        serverId: row.serverPublicId,
        capabilityId,
        readOnly: row.readOnly,
        riskGrade: toolRiskGradeSchema.parse(
          row.classifiedRiskGrade ?? row.riskGrade,
        ),
        classification,
        classifiedAt: row.classifiedAt?.toISOString() ?? null,
        schemaOrigin: schemaOriginOf(row),
        schemaDigest: row.checksum,
        enabled: row.enabled,
        gate: gateOf(switches, {
          ...scope,
          capabilityId,
          serverId: row.mcpServerId,
          // The same union the gateway's gate matches on, so the page and the
          // gate agree about which tools a class switch stops.
          consequenceTags: unionConsequenceTags(row),
        }),
        calls30d: calls === null ? null : (calls.get(capabilityId) ?? 0),
        updatedAt: row.updatedAt.toISOString(),
      };
    });

    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? encodeRegistryCursor({ slug: last.slug, id: last.toolId })
          : null,
    };
  };
}

export const toolVersionListHandler = createToolVersionListHandler(
  postgresToolVersionListDeps,
);
