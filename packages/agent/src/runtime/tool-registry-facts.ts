// tool-registry-facts.ts — the two pure facts a registry row carries into a
// governance decision: the capability id its calls are governed under, and the
// consequence tags it answers a class kill switch with (#2958).
//
// A leaf module on purpose. The gateway's kill-switch gate and three read
// handlers all need these, and importing them from kill-switch-gate.ts dragged
// that module's transitive deps (@oxagen/database, @oxagen/iam,
// @oxagen/tenancy, drizzle) into callers that wanted a dozen lines of string
// handling. Nothing here touches a store.
//
// The mirror of `toolSlugOf` in packages/handlers/src/lib/tool-registry.ts: a
// tool imported from an MCP server is governed under `mcp.<server id>.<name>`,
// the same synthetic capability id materializeTools presents it under, so two
// servers exposing `search` are two governed identities. Every other source is
// governed under its slug.

/** The capability id a registry row's calls are governed under. */
export function registryCapabilityId(row: {
  source: string;
  slug: string;
  name: string;
  mcpServerId: string | null;
}): string {
  return row.source === "mcp" && row.mcpServerId
    ? `mcp.${row.mcpServerId}.${row.name}`
    : row.slug;
}

/**
 * The consequence tags a version carries, from BOTH halves, deduped.
 *
 * `agent.tool_versions.consequence_tags` (text[]) is the declared half — what
 * `publish_tool_declaration` and `import_tools` write from the descriptor and
 * what the mandate gate reads. `classification->'consequenceTags'` is the
 * classified half, what `set_tool_classification` writes. Both draw on one
 * vocabulary (`consequenceTagSchema`), so a tool tagged in either is in a
 * class kill switch's reach. Reading only the jsonb left every declared-tag
 * tool running while `list_kill_switches` reported the switch on.
 */
export function unionConsequenceTags(row: {
  consequenceTags: readonly string[] | null;
  classification: unknown;
}): string[] {
  const tags = new Set<string>();
  for (const t of row.consequenceTags ?? []) {
    if (typeof t === "string" && t.length > 0) tags.add(t);
  }
  const classified = (
    row.classification as { consequenceTags?: unknown } | null
  )?.consequenceTags;
  if (Array.isArray(classified)) {
    for (const t of classified) {
      if (typeof t === "string" && t.length > 0) tags.add(t);
    }
  }
  return [...tags];
}
