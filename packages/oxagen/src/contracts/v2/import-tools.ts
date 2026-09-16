import { defineTool } from "./_define";
import { toolImport as live } from "../tool.import";

/**
 * Appendix E: `import_tools` — "pull `tools/list`, version, store schemas".
 * Absorbs `list_tool_declarations`, `publish_tool_declaration` and
 * `list_agent_tools`.
 *
 * This tool is live: issue #2958 registered it under its Appendix E name in
 * ../tool.import.ts. The descriptor composes from the live contract so the
 * carry checks in this directory keep reading one schema, and it is not
 * registered a second time. The three absorbed v1 contracts still exist
 * beside it until the cutover deletes them (#2884).
 *
 * What the live contract carries and what it drops, each declared:
 *
 * 1. **Everything hangs off a server.** `serverId` is required on both the
 *    pulled path (`tools`, origin `imported`) and the declared path
 *    (`declarations`, origin `declared`); Appendix A keys `tool_versions` to
 *    the server, whose `kind` replaces v1's free-standing `source`.
 * 2. **The declarations carry `publish_tool_declaration`'s wire names**
 *    verbatim — JSON Schema payloads crossing a protocol boundary.
 * 3. **The list halves fold into the output.** An import returns the versions
 *    it produced; paging the registry is `list_tool_versions`.
 */
export const importTools = defineTool({
  name: live.name,
  domain: live.domain,
  description: live.description,
  mode: live.mode,
  surfaces: live.surfaces,
  layers: live.layers,
  scoped: live.scoped,
  noBillingGate: live.noBillingGate,

  absorbs: [
    "list_tool_declarations",
    "publish_tool_declaration",
    "list_agent_tools",
  ],
  drops: [
    {
      field: "source",
      from: "publish_tool_declaration",
      why: "replaced by the required serverId: every imported or declared tool is an agent.tools row of source `mcp` naming its server (mcp_server_id), so the origin is one fact held in one place",
    },
    {
      field: "source",
      from: "list_tool_declarations",
      why: "both the input filter and the output field: same collapse into the server row, and `schemaOrigin` carries the part of `source` that was really about provenance",
    },
    {
      field: "limit",
      from: "list_tool_declarations",
      why: "an import returns what this import produced, not a page of the registry; paging is list_tool_versions",
    },
    {
      field: "offset",
      from: "list_tool_declarations",
      why: "follows `limit` — the browse is a surface read, not a toolbelt call",
    },
    {
      field: "total",
      from: "list_tool_declarations",
      why: "output side of the same drop: a count of the whole registry is a browse fact",
    },
    {
      field: "includeExternal",
      from: "list_agent_tools",
      why: "the internal/external split disappears with the server row — a first-party capability is a server of kind `oxagen`, so 'external' is a filter on the server, not a boolean",
    },
    {
      field: "requiresApproval",
      from: "list_agent_tools",
      why: "approval is decided by the customer's approval rules (§6.9 part 2), not stored on the tool; freezing it into a version row would go stale on the next rule change",
    },
    {
      field: "external",
      from: "list_agent_tools",
      why: "same collapse as includeExternal — Appendix A records the kind on the server, not a boolean on the tool",
    },
  ],

  agent: live.agent,
  sensitivity: live.sensitivity,
  defaultEffect: live.defaultEffect,
  defaultRoles: live.defaultRoles,
  mutates: live.mutates,
  audit: live.audit,

  input: live.input,
  output: live.output,
});

export type ImportToolsInput = import("../tool.import").ToolImportInput;
export type ImportToolsOutput = import("../tool.import").ToolImportOutput;
