import { sql } from "drizzle-orm";
import { withTenantDb } from "@oxagen/database";
import type { CapabilityContext } from "@oxagen/oxagen";
import { scopedSession } from "@oxagen/ontology/tenant";
import { toLabelKey } from "@oxagen/ontology/labels";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

/**
 * Ingestion vocabulary — what graph.ingest extraction is allowed/encouraged to
 * produce. Without it the LLM invents inconsistent labels (the same submarine
 * was "Submarine" in one run and "Vessel" in the next) and captures no domain
 * properties. We ground extraction in two sources, in priority order:
 *
 *   1. The workspace's pinned + enabled Schema Registry (Postgres
 *      `schema_registry.*`) — the authoritative, typed contract of node labels,
 *      their properties, and relationship types. AUTHORITATIVE when present.
 *   2. The labels already in the workspace's Neo4j graph (with the property keys
 *      observed on existing nodes) — so ingestion stays self-consistent even
 *      before a registry is configured, and reuses keys verbatim.
 *
 * The registry read is best-effort: any failure (tables absent, no pin, no
 * enabled schema, RLS) degrades to the graph-derived vocabulary rather than
 * failing ingestion.
 */

export type EnforcementMode = "strict" | "lenient" | "off";

export interface VocabularyProperty {
  key: string;
  dataType?: string;
  required?: boolean;
  description?: string;
  enumValues?: string[];
  example?: string;
}

export interface VocabularyLabel {
  name: string;
  displayName?: string;
  description?: string;
  /** Typed property contract from the registry (empty for graph-only labels). */
  properties: VocabularyProperty[];
  /** Property keys seen on existing nodes of this label (graph-derived). */
  observedPropertyKeys: string[];
  /** How many nodes with this label already exist in the workspace. */
  existingCount: number;
}

export interface VocabularyEdge {
  name: string;
  startLabel?: string;
  endLabel?: string;
  description?: string;
}

export interface IngestVocabulary {
  /** "registry": a pinned+enabled schema drives it. "graph": only existing graph
   *  labels seed it. "none": the workspace graph is empty and no registry. */
  source: "registry" | "graph" | "none";
  enforcement: EnforcementMode;
  /** Labels the extractor should PREFER, richest first. */
  labels: VocabularyLabel[];
  /** Registry relationship types (advisory — edge writes stay constrained to the
   *  graph.edge.upsert contract enum). */
  edges: VocabularyEdge[];
}

/** Neo4j integers arrive as {low, high} | bigint | number. */
function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (v && typeof v === "object" && "low" in (v as Record<string, unknown>)) {
    return Number((v as { low: number }).low);
  }
  return 0;
}

function normalizeEnforcement(mode: string | null | undefined): EnforcementMode {
  return mode === "strict" || mode === "lenient" || mode === "off" ? mode : "off";
}

/** Distinct labels already in the workspace graph, with observed property keys. */
async function readGraphLabels(ctx: CapabilityContext): Promise<VocabularyLabel[]> {
  const { orgId, workspaceId } = ctx;
  try {
    return await runInTenantScope({ orgId, workspaceId }, async () => {
      const session = scopedSession();
      try {
        // scopedSession() also auto-injects $orgId/$workspaceId as a safety
        // net; bound explicitly below too (OXA-2062). Sample a few nodes per
        // label to mine the JSON-encoded `properties` for the keys customers
        // actually use.
        const res = await session.run(
          `MATCH (n:GraphNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId AND n.label IS NOT NULL
           WITH n.label AS label, count(n) AS c, collect(n.properties)[0..8] AS samples
           RETURN label, c, samples ORDER BY c DESC LIMIT 100`,
          { orgId, workspaceId },
        );
        return res.records.map((r) => {
          const name = r.get("label") as string;
          const existingCount = toNumber(r.get("c"));
          const samples = (r.get("samples") as unknown[]) ?? [];
          const keys = new Set<string>();
          for (const s of samples) {
            if (typeof s !== "string") continue;
            try {
              const parsed = JSON.parse(s) as Record<string, unknown>;
              for (const k of Object.keys(parsed)) {
                // confidence/source are provenance we always add — not domain props.
                if (k !== "confidence" && k !== "source") keys.add(k);
              }
            } catch {
              /* a non-JSON properties value is ignored */
            }
          }
          return {
            name,
            properties: [],
            observedPropertyKeys: [...keys].slice(0, 30),
            existingCount,
          };
        });
      } finally {
        await session.close();
      }
    });
  } catch (err) {
    logger.warn({ err, orgId, workspaceId }, "graph.ingest: failed to read existing graph labels");
    return [];
  }
}

interface RegistryVocabulary {
  enforcement: EnforcementMode;
  labels: VocabularyLabel[];
  edges: VocabularyEdge[];
}

/** The pinned + enabled Schema Registry vocabulary for the workspace, or null. */
async function readRegistryVocabulary(
  ctx: CapabilityContext,
): Promise<RegistryVocabulary | null> {
  const { orgId, workspaceId } = ctx;
  try {
    return await runInTenantScope({ orgId, workspaceId }, () =>
      withTenantDb(async (tx) => {
        const regRows = (await tx.execute(sql`
          SELECT pinned_version_id, enforcement_mode
          FROM schema_registry.registries
          WHERE org_id = ${orgId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
          LIMIT 1
        `)) as unknown as Array<{
          pinned_version_id: string | null;
          enforcement_mode: string | null;
        }>;
        const reg = regRows[0];
        if (!reg?.pinned_version_id) return null;
        const versionId = reg.pinned_version_id;
        const enforcement = normalizeEnforcement(reg.enforcement_mode);

        // Node labels of the pinned version that belong to a workspace-enabled schema.
        const labelRows = (await tx.execute(sql`
          SELECT nl.id, nl.name, nl.display_name, nl.description
          FROM schema_registry.node_labels nl
          JOIN schema_registry.schemas s
            ON s.id = nl.schema_id AND s.deleted_at IS NULL
          JOIN schema_registry.schema_activations sa
            ON sa.schema_name = s.name
           AND sa.workspace_id = nl.workspace_id
           AND sa.enabled = true
           AND sa.deleted_at IS NULL
          WHERE nl.version_id = ${versionId}
            AND nl.org_id = ${orgId}
            AND nl.workspace_id = ${workspaceId}
            AND nl.deleted_at IS NULL
        `)) as unknown as Array<{
          id: string;
          name: string;
          display_name: string | null;
          description: string | null;
        }>;
        if (labelRows.length === 0) return null;

        // Property contracts, keyed to their node label by name (avoids array params).
        const propRows = (await tx.execute(sql`
          SELECT nl.name AS label_name, p.key, p.data_type, p.required,
                 p.description, p.enum_values, p.example
          FROM schema_registry.properties p
          JOIN schema_registry.node_labels nl
            ON nl.id = p.node_label_id AND nl.deleted_at IS NULL
          JOIN schema_registry.schemas s
            ON s.id = nl.schema_id AND s.deleted_at IS NULL
          JOIN schema_registry.schema_activations sa
            ON sa.schema_name = s.name
           AND sa.workspace_id = nl.workspace_id
           AND sa.enabled = true
           AND sa.deleted_at IS NULL
          WHERE p.version_id = ${versionId}
            AND p.org_id = ${orgId}
            AND p.workspace_id = ${workspaceId}
            AND p.deleted_at IS NULL
        `)) as unknown as Array<{
          label_name: string;
          key: string;
          data_type: string | null;
          required: boolean | null;
          description: string | null;
          enum_values: string[] | null;
          example: string | null;
        }>;

        const edgeRows = (await tx.execute(sql`
          SELECT rt.name, rt.start_label, rt.end_label, rt.description
          FROM schema_registry.relationship_types rt
          JOIN schema_registry.schemas s
            ON s.id = rt.schema_id AND s.deleted_at IS NULL
          JOIN schema_registry.schema_activations sa
            ON sa.schema_name = s.name
           AND sa.workspace_id = rt.workspace_id
           AND sa.enabled = true
           AND sa.deleted_at IS NULL
          WHERE rt.version_id = ${versionId}
            AND rt.org_id = ${orgId}
            AND rt.workspace_id = ${workspaceId}
            AND rt.deleted_at IS NULL
        `)) as unknown as Array<{
          name: string;
          start_label: string | null;
          end_label: string | null;
          description: string | null;
        }>;

        const propsByLabel = new Map<string, VocabularyProperty[]>();
        for (const p of propRows) {
          const arr = propsByLabel.get(p.label_name) ?? [];
          arr.push({
            key: p.key,
            dataType: p.data_type ?? undefined,
            required: p.required ?? undefined,
            description: p.description ?? undefined,
            enumValues: Array.isArray(p.enum_values) ? p.enum_values : undefined,
            example: p.example ?? undefined,
          });
          propsByLabel.set(p.label_name, arr);
        }

        const labels: VocabularyLabel[] = labelRows.map((l) => ({
          name: l.name,
          displayName: l.display_name ?? undefined,
          description: l.description ?? undefined,
          properties: propsByLabel.get(l.name) ?? [],
          observedPropertyKeys: [],
          existingCount: 0,
        }));
        const edges: VocabularyEdge[] = edgeRows.map((e) => ({
          name: e.name,
          startLabel: e.start_label ?? undefined,
          endLabel: e.end_label ?? undefined,
          description: e.description ?? undefined,
        }));
        return { enforcement, labels, edges };
      }),
    );
  } catch (err) {
    logger.warn(
      { err, orgId, workspaceId },
      "graph.ingest: registry vocabulary read failed (using graph-derived vocabulary)",
    );
    return null;
  }
}

/**
 * Resolve the ingestion vocabulary for the current workspace. Registry is
 * authoritative when present; existing graph labels are always folded in so the
 * extractor reuses real labels/keys instead of inventing new ones.
 */
export async function resolveIngestVocabulary(
  ctx: CapabilityContext,
): Promise<IngestVocabulary> {
  const [graphLabels, registry] = await Promise.all([
    readGraphLabels(ctx),
    readRegistryVocabulary(ctx),
  ]);

  if (registry && registry.labels.length > 0) {
    const observedByName = new Map(
      graphLabels.map((l) => [l.name.toLowerCase(), l] as const),
    );
    // Enrich registry labels with what the graph has actually observed.
    const enriched: VocabularyLabel[] = registry.labels.map((l) => {
      const obs = observedByName.get(l.name.toLowerCase());
      return {
        ...l,
        observedPropertyKeys: obs?.observedPropertyKeys ?? [],
        existingCount: obs?.existingCount ?? 0,
      };
    });
    // In lenient/off, also surface graph-only labels so existing types aren't lost.
    const registryNames = new Set(registry.labels.map((l) => l.name.toLowerCase()));
    const extra =
      registry.enforcement === "strict"
        ? []
        : graphLabels.filter((l) => !registryNames.has(l.name.toLowerCase()));
    return {
      source: "registry",
      enforcement: registry.enforcement,
      labels: [...enriched, ...extra],
      edges: registry.edges,
    };
  }

  if (graphLabels.length > 0) {
    return { source: "graph", enforcement: "off", labels: graphLabels, edges: [] };
  }
  return { source: "none", enforcement: "off", labels: [], edges: [] };
}

/**
 * Render the vocabulary as prompt guidance: which labels to prefer, their typed
 * properties, and relationship types. Empty string when there is nothing to say.
 */
export function renderVocabularyPrompt(vocab: IngestVocabulary): string {
  if (vocab.labels.length === 0) return "";
  const lines: string[] = [];
  lines.push(
    `KNOWLEDGE-GRAPH VOCABULARY (source: ${vocab.source}). PREFER these entity types — reuse the EXACT type name; do NOT invent a synonym (e.g. do not emit "Vessel" when "Submarine" already exists). Only introduce a new type when NONE of these fit:`,
  );
  for (const l of vocab.labels.slice(0, 60)) {
    const facts: string[] = [];
    if (l.existingCount > 0) facts.push(`${l.existingCount} existing`);
    if (l.description) facts.push(l.description.slice(0, 120));
    const header = `- ${l.name}${facts.length ? ` (${facts.join("; ")})` : ""}`;
    const propBits: string[] = [];
    for (const p of l.properties.slice(0, 20)) {
      const t = p.dataType ? `:${p.dataType}` : "";
      const req = p.required ? "*" : "";
      propBits.push(`${p.key}${t}${req}`);
    }
    // Observed keys the registry didn't declare still help the model reuse casing.
    for (const k of l.observedPropertyKeys) {
      if (!l.properties.some((p) => p.key === k)) propBits.push(k);
    }
    lines.push(propBits.length ? `${header} — properties: ${propBits.slice(0, 30).join(", ")}` : header);
  }
  if (vocab.edges.length > 0) {
    const edgeBits = vocab.edges
      .slice(0, 40)
      .map((e) =>
        e.startLabel && e.endLabel ? `${e.name} (${e.startLabel}→${e.endLabel})` : e.name,
      );
    lines.push(`RELATIONSHIP TYPES (configured): ${edgeBits.join(", ")}`);
  }
  if (vocab.enforcement === "strict") {
    lines.push(
      "ENFORCEMENT=strict: do NOT emit any entity whose type is not listed above; drop anything that does not fit.",
    );
  }
  return lines.join("\n");
}

/**
 * The set of allowed label identity keys under strict enforcement. Keyed via
 * `toLabelKey` (separator- and case-insensitive) so an extracted type matches its
 * vocabulary entry regardless of how either was cased/separated — "pull_request",
 * "PullRequest", and "pull request" all resolve to one key. The membership check
 * in graph.ingest MUST key the extracted type the same way.
 */
export function strictAllowedLabels(vocab: IngestVocabulary): Set<string> | null {
  if (vocab.enforcement !== "strict" || vocab.source !== "registry") return null;
  return new Set(vocab.labels.map((l) => toLabelKey(l.name)));
}
