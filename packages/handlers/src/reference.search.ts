/**
 * reference.search handler — typed autocomplete behind the chat @-mention
 * picker.
 *
 * Composes results per reference type:
 *   - repository / branch — ingestion.source_connections (GitHub connector),
 *     repo coordinates parsed from deliveryConfig ({owner,repo,defaultBranch}
 *     or {selectedRepos:["owner/repo",…],defaultBranch} — the two shapes
 *     connection.mappings.set writes; see code-mode-data.ts).
 *   - file / directory — the pushed code graph via `search_nodes`
 *     (`:SourceFile` / `:Directory` type labels, displayName = repo path).
 *   - agent / skill / mcp_server — operational Postgres tables.
 *   - tool / capability — the in-process capability registry (+ MCP
 *     discoveredTools for external tools).
 *   - node / edge — the knowledge graph (`search_nodes` / direct scoped
 *     Cypher over relationships mirroring graph.node.search).
 *
 * Each source is best-effort: a failing store degrades to zero rows for its
 * types rather than failing the whole search (same policy as
 * command.menu.search's ontology arm).
 *
 * Security: Postgres queries filter ctx.orgId + ctx.workspaceId via
 * withTenantDb (RLS-enforced); graph reads run inside runInTenantScope with
 * org/workspace predicates in every Cypher.
 */
import type { CapabilityHandler } from "@oxagen/oxagen";
import { referenceSearch } from "@oxagen/oxagen/contracts/reference.search";
import type {
  ReferenceResultRow,
  ReferenceType,
} from "@oxagen/oxagen/contracts/reference.search";
import { capabilitiesForSurface } from "@oxagen/oxagen/kernel";
import { listCapabilities } from "@oxagen/oxagen/registry";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { invoke } from "@oxagen/oxagen/kernel";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

type Ctx = Parameters<CapabilityHandler<typeof referenceSearch>>[1];

interface SearchArgs {
  query: string;
  /** Exact public-id resolve mode; when set, `query` is ignored. */
  slug: string | null;
  limit: number;
}

function containsInsensitive(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

// ── repository / branch ───────────────────────────────────────────────────────

interface RepoEntry {
  connectionId: string; // connection publicId (con_*)
  status: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
}

/** Parse one connection's deliveryConfig into 0+ usable repos (both shapes). */
function parseRepoEntries(
  connectionId: string,
  status: string,
  deliveryConfig: unknown,
): RepoEntry[] {
  if (!deliveryConfig || typeof deliveryConfig !== "object") return [];
  const cfg = deliveryConfig as Record<string, unknown>;
  const defaultBranch = typeof cfg["defaultBranch"] === "string" ? cfg["defaultBranch"] : null;

  const owner = typeof cfg["owner"] === "string" ? cfg["owner"] : undefined;
  const repo = typeof cfg["repo"] === "string" ? cfg["repo"] : undefined;
  if (owner && repo) return [{ connectionId, status, owner, name: repo, defaultBranch }];

  const selected = Array.isArray(cfg["selectedRepos"]) ? cfg["selectedRepos"] : [];
  const out: RepoEntry[] = [];
  for (const full of selected) {
    if (typeof full !== "string") continue;
    const slash = full.indexOf("/");
    if (slash <= 0 || slash === full.length - 1) continue;
    out.push({
      connectionId,
      status,
      owner: full.slice(0, slash),
      name: full.slice(slash + 1),
      defaultBranch,
    });
  }
  return out;
}

async function loadRepoEntries(orgId: string, workspaceId: string): Promise<RepoEntry[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.sourceConnections.publicId,
        status: schema.sourceConnections.status,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, orgId),
          eq(schema.sourceConnections.workspaceId, workspaceId),
          eq(schema.sourceConnections.connectorId, "github"),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(100);
  });
  return rows.flatMap((r) => parseRepoEntries(r.publicId, r.status, r.deliveryConfig));
}

function repoRow(entry: RepoEntry): ReferenceResultRow {
  const full = `${entry.owner}/${entry.name}`;
  return {
    type: "repository",
    slug: entry.connectionId,
    location: full,
    label: full,
    description: "Connected GitHub repository",
    properties: {
      connectionId: entry.connectionId,
      owner: entry.owner,
      name: entry.name,
      defaultBranch: entry.defaultBranch,
      status: entry.status,
    },
  };
}

async function searchRepositories(
  args: SearchArgs,
  entriesPromise: Promise<RepoEntry[]>,
): Promise<ReferenceResultRow[]> {
  const entries = await entriesPromise;
  const matched = args.slug
    ? entries.filter((e) => e.connectionId === args.slug)
    : entries.filter(
        (e) => !args.query.trim() || containsInsensitive(`${e.owner}/${e.name}`, args.query),
      );
  return matched.slice(0, args.limit).map(repoRow);
}

/**
 * Branch search covers each connected repo's configured default branch only —
 * the platform keeps no branch index, and live GitHub enumeration is too slow
 * for a per-keystroke typeahead. Slug format: `<connectionId>#<branch>`.
 */
async function searchBranches(
  args: SearchArgs,
  entriesPromise: Promise<RepoEntry[]>,
): Promise<ReferenceResultRow[]> {
  const entries = (await entriesPromise).filter(
    (e): e is RepoEntry & { defaultBranch: string } => e.defaultBranch !== null,
  );
  const matched = args.slug
    ? entries.filter((e) => `${e.connectionId}#${e.defaultBranch}` === args.slug)
    : entries.filter(
        (e) =>
          !args.query.trim() ||
          containsInsensitive(e.defaultBranch, args.query) ||
          containsInsensitive(`${e.owner}/${e.name}`, args.query),
      );
  return matched.slice(0, args.limit).map((e) => ({
    type: "branch" as const,
    slug: `${e.connectionId}#${e.defaultBranch}`,
    location: `${e.owner}/${e.name}#${e.defaultBranch}`,
    label: e.defaultBranch,
    description: `Default branch of ${e.owner}/${e.name}`,
    properties: {
      connectionId: e.connectionId,
      repository: `${e.owner}/${e.name}`,
      branch: e.defaultBranch,
      isDefault: true,
    },
  }));
}

// ── file / directory / node (code graph + knowledge graph) ───────────────────

interface GraphSearchNode {
  nodeId: string;
  label: string;
  displayName: string;
  description: string | null;
  score: number;
}

async function graphNodeRows(
  args: SearchArgs,
  ctx: Ctx,
  opts: { type: ReferenceType; labels?: string[] },
): Promise<ReferenceResultRow[]> {
  // Resolve mode — exact publicId lookup with the full property bag.
  if (args.slug) {
    const out = (await invoke("get_node", { nodeId: args.slug }, ctx)) as {
      node: {
        nodeId: string;
        label: string;
        displayName: string;
        description: string | null;
        properties: Record<string, unknown>;
      } | null;
    };
    if (!out.node) return [];
    if (opts.labels && !opts.labels.includes(out.node.label)) return [];
    return [
      {
        type: opts.type,
        slug: out.node.nodeId,
        location:
          opts.type === "node"
            ? `graph://node/${out.node.nodeId}`
            : out.node.displayName,
        label:
          opts.type === "file" || opts.type === "directory"
            ? (out.node.displayName.split("/").pop() ?? out.node.displayName)
            : out.node.displayName,
        description: out.node.description,
        properties: { label: out.node.label, ...out.node.properties },
      },
    ];
  }

  if (!args.query.trim()) return [];
  const out = (await invoke(
    "search_nodes",
    { query: args.query, labels: opts.labels, limit: Math.min(args.limit, 25) },
    ctx,
  )) as { nodes: GraphSearchNode[] };

  return out.nodes.map((n) => ({
    type: opts.type,
    slug: n.nodeId,
    location: opts.type === "node" ? `graph://node/${n.nodeId}` : n.displayName,
    label:
      opts.type === "file" || opts.type === "directory"
        ? (n.displayName.split("/").pop() ?? n.displayName)
        : n.displayName,
    description: n.description,
    properties: { label: n.label, path: n.displayName, score: n.score },
  }));
}

// ── edge (knowledge graph relationships) ─────────────────────────────────────

const EDGE_SLUG_SEPARATOR = ":";

async function searchEdges(
  args: SearchArgs,
  orgId: string,
  workspaceId: string,
): Promise<ReferenceResultRow[]> {
  // Resolve mode uses the composite identity `<srcPublicId>:<TYPE>:<dstPublicId>`
  // (same identity graph.relationship.upsert merges by).
  let resolveParts: { srcId: string; relType: string; dstId: string } | null = null;
  if (args.slug) {
    const [srcId, relType, dstId, ...rest] = args.slug.split(EDGE_SLUG_SEPARATOR);
    if (!srcId || !relType || !dstId || rest.length > 0) return [];
    resolveParts = { srcId, relType, dstId };
  } else if (!args.query.trim()) {
    return [];
  }

  const rows: ReferenceResultRow[] = [];
  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const where = resolveParts
        ? `a.publicId = $srcId AND b.publicId = $dstId AND type(r) = $relType`
        : `(
             toLower(type(r)) CONTAINS toLower($query)
          OR toLower(coalesce(a.displayName, '')) CONTAINS toLower($query)
          OR toLower(coalesce(b.displayName, '')) CONTAINS toLower($query)
        )`;
      const result = await session.run(
        `MATCH (a:GraphNode)-[r]->(b:GraphNode)
         WHERE a.orgId = $orgId AND a.workspaceId = $workspaceId
           AND b.orgId = $orgId AND b.workspaceId = $workspaceId
           AND ${where}
         RETURN
           a.publicId AS srcId,
           coalesce(a.displayName, a.name, a.publicId) AS srcName,
           a.label AS srcLabel,
           type(r) AS relType,
           b.publicId AS dstId,
           coalesce(b.displayName, b.name, b.publicId) AS dstName,
           b.label AS dstLabel
         LIMIT $limit`,
        {
          orgId,
          workspaceId,
          query: args.query,
          srcId: resolveParts?.srcId ?? null,
          dstId: resolveParts?.dstId ?? null,
          relType: resolveParts?.relType ?? null,
          // BigInt forces the Bolt driver to send INTEGER — plain numbers
          // become Float and Neo4j rejects them for LIMIT.
          limit: BigInt(Math.min(args.limit, 25)),
        },
      );
      for (const record of result.records) {
        const srcId = record.get("srcId") as string;
        const dstId = record.get("dstId") as string;
        const relType = record.get("relType") as string;
        const srcName = record.get("srcName") as string;
        const dstName = record.get("dstName") as string;
        const srcLabel = record.get("srcLabel") as string | null;
        const dstLabel = record.get("dstLabel") as string | null;
        const slug = [srcId, relType, dstId].join(EDGE_SLUG_SEPARATOR);
        rows.push({
          type: "edge",
          slug,
          location: `graph://edge/${slug}`,
          label: `${srcName} → ${dstName}`,
          description: relType,
          properties: {
            relationshipType: relType,
            source: { id: srcId, label: srcLabel, displayName: srcName },
            target: { id: dstId, label: dstLabel, displayName: dstName },
          },
        });
      }
    } finally {
      await session.close();
    }
  });
  return rows;
}

// ── agent / skill / mcp_server (Postgres) ────────────────────────────────────

async function searchAgents(
  args: SearchArgs,
  orgId: string,
  workspaceId: string,
): Promise<ReferenceResultRow[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.agents.publicId,
        slug: schema.agents.slug,
        name: schema.agents.name,
        description: schema.agents.description,
        status: schema.agents.status,
      })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, orgId),
          eq(schema.agents.workspaceId, workspaceId),
          isNull(schema.agents.deletedAt),
          args.slug
            ? eq(schema.agents.publicId, args.slug)
            : args.query.trim()
              ? or(
                  ilike(schema.agents.name, `%${args.query}%`),
                  ilike(schema.agents.slug, `%${args.query}%`),
                )
              : undefined,
        ),
      )
      .limit(args.limit);
  });
  return rows.map((r) => ({
    type: "agent" as const,
    slug: r.publicId,
    location: "",
    label: r.name,
    description: r.description,
    properties: { slug: r.slug, status: r.status },
  }));
}

async function searchSkills(
  args: SearchArgs,
  orgId: string,
  workspaceId: string,
): Promise<ReferenceResultRow[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.skills.publicId,
        slug: schema.skills.slug,
        name: schema.skills.name,
        description: schema.skills.description,
        source: schema.skills.source,
        enabled: schema.skills.enabled,
        usageCount: schema.skills.usageCount,
      })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.orgId, orgId),
          eq(schema.skills.workspaceId, workspaceId),
          isNull(schema.skills.deletedAt),
          args.slug
            ? eq(schema.skills.publicId, args.slug)
            : args.query.trim()
              ? or(
                  ilike(schema.skills.name, `%${args.query}%`),
                  ilike(schema.skills.slug, `%${args.query}%`),
                )
              : undefined,
        ),
      )
      .limit(args.limit);
  });
  return rows.map((r) => ({
    type: "skill" as const,
    slug: r.publicId,
    location: "",
    label: r.name,
    description: r.description,
    properties: {
      slug: r.slug,
      source: r.source,
      enabled: r.enabled,
      usageCount: r.usageCount,
    },
  }));
}

async function searchMcpServers(
  args: SearchArgs,
  orgId: string,
  workspaceId: string,
): Promise<ReferenceResultRow[]> {
  const rows = await withTenantDb(async (tx) => {
    return tx
      .select({
        publicId: schema.mcpServers.publicId,
        name: schema.mcpServers.name,
        transportType: schema.mcpServers.transportType,
        endpointUrl: schema.mcpServers.endpointUrl,
        healthStatus: schema.mcpServers.healthStatus,
        enabled: schema.mcpServers.enabled,
      })
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.orgId, orgId),
          eq(schema.mcpServers.workspaceId, workspaceId),
          isNull(schema.mcpServers.deletedAt),
          args.slug
            ? eq(schema.mcpServers.publicId, args.slug)
            : args.query.trim()
              ? ilike(schema.mcpServers.name, `%${args.query}%`)
              : undefined,
        ),
      )
      .limit(args.limit);
  });
  return rows.map((r) => ({
    type: "mcp_server" as const,
    slug: r.publicId,
    location: r.endpointUrl,
    label: r.name,
    description: `${r.transportType} MCP server`,
    properties: {
      transportType: r.transportType,
      endpointUrl: r.endpointUrl,
      healthStatus: r.healthStatus,
      enabled: r.enabled,
    },
  }));
}

// ── tool / capability (in-process registry) ──────────────────────────────────

function humanizeCapabilityName(name: string): string {
  return name.replaceAll("_", " ");
}

function searchCapabilities(args: SearchArgs): ReferenceResultRow[] {
  const caps = listCapabilities().filter((c) =>
    args.slug
      ? c.name === args.slug
      : !args.query.trim() ||
        containsInsensitive(c.name, args.query) ||
        containsInsensitive(c.domain, args.query) ||
        containsInsensitive(c.description, args.query),
  );
  return caps.slice(0, args.limit).map((c) => ({
    type: "capability" as const,
    slug: c.name,
    location: `docs/capabilities/${c.name}`,
    label: humanizeCapabilityName(c.name),
    description: c.description.length > 160 ? `${c.description.slice(0, 157)}…` : c.description,
    properties: {
      domain: c.domain,
      mode: c.mode,
      riskLevel: c.agent?.riskLevel ?? null,
      category: c.agent?.category ?? null,
    },
  }));
}

async function searchTools(
  args: SearchArgs,
  orgId: string,
  workspaceId: string,
): Promise<ReferenceResultRow[]> {
  const builtins = capabilitiesForSurface("agent")
    .filter((c) =>
      args.slug
        ? c.name === args.slug
        : !args.query.trim() ||
          containsInsensitive(c.name, args.query) ||
          containsInsensitive(c.description, args.query),
    )
    .map(
      (c): ReferenceResultRow => ({
        type: "tool",
        slug: c.name,
        location: "",
        label: humanizeCapabilityName(c.name),
        description:
          c.description.length > 160 ? `${c.description.slice(0, 157)}…` : c.description,
        properties: {
          domain: c.domain,
          category: c.agent?.category ?? null,
          riskLevel: c.agent?.riskLevel ?? null,
          requiresApproval: c.agent?.requiresApproval ?? false,
          external: false,
        },
      }),
    );

  // External tools discovered on enabled MCP servers, exposed as
  // `<server>.<tool>` — the same naming agent.tool.list materializes.
  const servers = await withTenantDb(async (tx) => {
    return tx
      .select({
        name: schema.mcpServers.name,
        publicId: schema.mcpServers.publicId,
        discoveredTools: schema.mcpServers.discoveredTools,
      })
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.orgId, orgId),
          eq(schema.mcpServers.workspaceId, workspaceId),
          eq(schema.mcpServers.enabled, true),
          isNull(schema.mcpServers.deletedAt),
        ),
      )
      .limit(50);
  });
  const external = servers.flatMap((s) =>
    (Array.isArray(s.discoveredTools) ? (s.discoveredTools as string[]) : [])
      .map((t) => `${s.name}.${t}`)
      .filter((full) =>
        args.slug ? full === args.slug : !args.query.trim() || containsInsensitive(full, args.query),
      )
      .map(
        (full): ReferenceResultRow => ({
          type: "tool",
          slug: full,
          location: "",
          label: full,
          description: `External tool on MCP server ${s.name}`,
          properties: { server: s.name, serverConnectionId: s.publicId, external: true },
        }),
      ),
  );

  return [...builtins, ...external].slice(0, args.limit);
}

// ── main handler ─────────────────────────────────────────────────────────────

export const referenceSearchHandler: CapabilityHandler<typeof referenceSearch> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;
  const args: SearchArgs = {
    query: input.query ?? "",
    slug: input.slug ?? null,
    limit: input.limit,
  };
  const want = (t: ReferenceType) => !input.types || input.types.includes(t);

  // The repository and branch arms both derive from the same sourceConnections
  // SELECT. Memoize it per request (lazily — only triggered when either arm is
  // actually requested) so the identical query runs at most once when both are
  // wanted (the default). No module-level state; this closure dies with the call.
  let repoEntriesPromise: Promise<RepoEntry[]> | undefined;
  const repoEntries = () =>
    (repoEntriesPromise ??= loadRepoEntries(orgId, workspaceId));

  // Every arm is best-effort — a failing store yields zero rows for its types.
  const safe = async (
    type: ReferenceType,
    fn: () => Promise<ReferenceResultRow[]> | ReferenceResultRow[],
  ): Promise<ReferenceResultRow[]> => {
    if (!want(type)) return [];
    try {
      return await fn();
    } catch (err) {
      logger.warn(
        { err, type, orgId, workspaceId },
        "reference.search: source failed — degrading to empty",
      );
      return [];
    }
  };

  const resultsByType = await Promise.all([
    safe("repository", () => searchRepositories(args, repoEntries())),
    safe("branch", () => searchBranches(args, repoEntries())),
    safe("file", () => graphNodeRows(args, ctx, { type: "file", labels: ["SourceFile"] })),
    safe("directory", () => graphNodeRows(args, ctx, { type: "directory", labels: ["Directory"] })),
    safe("agent", () => searchAgents(args, orgId, workspaceId)),
    safe("skill", () => searchSkills(args, orgId, workspaceId)),
    safe("tool", () => searchTools(args, orgId, workspaceId)),
    safe("mcp_server", () => searchMcpServers(args, orgId, workspaceId)),
    safe("capability", () => searchCapabilities(args)),
    safe("node", () => graphNodeRows(args, ctx, { type: "node" })),
    safe("edge", () => searchEdges(args, orgId, workspaceId)),
  ]);

  const seen = new Set<string>();
  const merged: ReferenceResultRow[] = [];
  for (const row of resultsByType.flat()) {
    const key = `${row.type} ${row.slug} ${row.location}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(row);
    }
  }
  const results = merged.slice(0, input.limit);

  logger.info(
    {
      orgId,
      workspaceId,
      query: input.query,
      slug: input.slug ?? null,
      types: input.types ?? null,
      resultCount: results.length,
    },
    "reference.search: search completed",
  );

  return { results };
};
