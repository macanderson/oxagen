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
 * Re-exported, not implemented here. The one implementation lives in
 * `@oxagen/oxagen/contracts/tool.classification`, beside the vocabulary it
 * draws on, because `@oxagen/rules` also has to read it for the auto-approval
 * floor and the rule-authoring gate, and `@oxagen/agent` depends on
 * `@oxagen/rules` — so this module cannot be where both of them get it.
 *
 * The path stays so every caller #2958 wired keeps working unchanged.
 */
export {
  unionConsequenceTags,
  effectiveSideEffect,
  type ClassificationHalves,
} from "@oxagen/oxagen/contracts/tool.classification";
