import { z } from "zod";
import { defineTool } from "./_define";
import { toolDeclarationList } from "../tool.declaration.list";
import { toolDeclarationPublish } from "../tool.declaration.publish";
import { agentToolList } from "../agent.tool.list";

const publishInput = toolDeclarationPublish.input.shape;
const listedTool = toolDeclarationList.output.shape.tools.element.shape;

/**
 * Appendix E: `import_tools` — "pull `tools/list`, version, store schemas".
 * Absorbs `list_tool_declarations`, `publish_tool_declaration` and
 * `list_agent_tools`.
 *
 * **One tool, two origins, one table.** Appendix A's `tools.tool_versions` has
 * a `schema_origin` column with four values, and the first two — `declared` and
 * `imported` — are exactly the two v1 paths this absorbs.
 * `publish_tool_declaration` wrote a hand-authored manifest; a tool server's
 * `tools/list` produces the same row from the wire. So `declarations` is
 * optional: present, the call publishes what it was given; absent, it pulls
 * from the server. The other two origins (`observed_proposed`,
 * `observed_approved`) belong to `approve_tool_schema`, which Appendix E marks
 * new.
 *
 * **Everything is now hung off a server.** v1's `source` enum
 * (`builtin`/`custom`/`mcp`/`foundry`) described where a declaration came from
 * as a free-standing fact. Appendix A makes that a foreign key:
 * `tool_versions.server_id → tool_servers`, whose own `kind` column carries the
 * same information without letting the two disagree. `serverId` is therefore
 * required, and `source` is dropped.
 *
 * **The list halves fold into the output, not the input.** Appendix E's closing
 * note — "reads folded into the objects above" — is why neither list source
 * contributes a filter here. What `list_tool_declarations` taught is its *row*
 * shape (risk grade, policy group, checksum, pinned version), and that row is
 * what an import returns.
 */
export const importTools = defineTool({
  name: "import_tools",
  domain: "tools",
  description:
    "Import a tool server's declarations into the workspace registry: pull tools/list (or accept hand-authored declarations), freeze an immutable version per changed manifest, and return the resulting tool versions with their schema digests. Idempotent on unchanged manifests.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Carried from both `publish_tool_declaration` and `list_tool_declarations`:
  // versioning the belt is governance and spends no model tokens, so an org at
  // zero balance must still be able to do it.
  noBillingGate: true,

  absorbs: [
    "list_tool_declarations",
    "publish_tool_declaration",
    "list_agent_tools",
  ],
  drops: [
    {
      field: "source",
      from: "publish_tool_declaration",
      why: "replaced by the required serverId: Appendix A keys tool_versions to tools.tool_servers, whose `kind` column (mcp/http/harness/oxagen) is the same fact held in one place",
    },
    {
      field: "source",
      from: "list_tool_declarations",
      why: "both the input filter and the output field: same collapse into the server row, and `schemaOrigin` now carries the part of `source` that was really about provenance",
    },
    {
      field: "limit",
      from: "list_tool_declarations",
      why: "an import returns what this import produced, not a page of the registry; paging belongs to the Agents → Tools browse (§14 page 3), which reads tool_versions directly",
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
      why: "the internal/external split disappears with tools.tool_servers — a first-party capability is a server of kind `oxagen`, so 'external' is a filter on `kind`, not a boolean",
    },
    {
      field: "requiresApproval",
      from: "list_agent_tools",
      why: "approval is decided by the customer's policy version (§6.12), not stored on the tool; §6.6 computes it per call into the definition's trailer, so freezing it into a version row would go stale on the next policy change",
    },
    {
      field: "external",
      from: "list_agent_tools",
      why: "same collapse as includeExternal — Appendix A records `kind` on the server, not a boolean on the tool",
    },
  ],

  // The strictest of the three, all from `publish_tool_declaration`: the two
  // list sources are `{ requiresApproval: false, riskLevel: "low" }`
  // introspection, but this call freezes what a model is allowed to be shown,
  // which is a governance write.
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  /**
   * From `publish_tool_declaration`. The list sources also granted workspace
   * Member; that carries no further than the reads it was granted for.
   *
   * v1 spelled a workspace `Admin` grant here, which `SystemWorkspaceRole`
   * (Owner | Member | Viewer) has never had — so it granted nothing and is
   * dropped rather than reproduced.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Writes tools.tool_versions and stamps last_import_at / last_import_digest
  // on the server row.
  mutates: true,

  input: z.object({
    /**
     * Required. Both the imported and the declared path land on a server row —
     * a declaration with no server has nowhere to be dispatched to and no
     * `egress_class` for §6.12 to decide on.
     */
    serverId: z.string().min(1),

    /**
     * Omit to pull `tools/list` from the server (origin `imported`). Supply to
     * publish hand-authored manifests against it (origin `declared`).
     *
     * Every member is carried by reference from `publish_tool_declaration`, so
     * the snake_case wire names and their descriptions survive intact — these
     * are JSON Schema payloads crossing a protocol boundary, and renaming them
     * to camelCase here would break every existing publisher for cosmetics.
     */
    declarations: z
      .array(
        z
          .object({
            name: publishInput.name,
            description: publishInput.description,
            input_schema: publishInput.input_schema,
            read_only: publishInput.read_only,
            risk_grade: publishInput.risk_grade,
            policy_group: publishInput.policy_group,
            manifest: publishInput.manifest,
          })
          .strict(),
      )
      .min(1)
      .optional(),
  }),

  output: z.object({
    serverId: z.string(),

    /**
     * Appendix A's `tool_servers.last_import_digest`. New in v2: an import that
     * changed nothing and an import that never ran are indistinguishable from
     * the per-tool `published` flags alone, and §6.6 requires every definition
     * to carry a digest a run's frames can cite.
     */
    importDigest: z.string(),

    tools: z.array(
      z
        .object({
          // The registry row, carried from `list_tool_declarations` — this is
          // the shape that already knows a pinned version can be absent.
          id: listedTool.id,
          slug: listedTool.slug,
          name: listedTool.name,
          description: listedTool.description,
          readOnly: listedTool.readOnly,
          riskGrade: listedTool.riskGrade,
          policyGroup: listedTool.policyGroup,
          version: listedTool.version,
          checksum: listedTool.checksum,
          enabled: listedTool.enabled,
          updatedAt: listedTool.updatedAt,

          // Carried from `publish_tool_declaration`, per tool rather than per
          // call: an import of forty tools where two changed must say which
          // two, or the caller cannot tell a no-op from a rewrite.
          published: toolDeclarationPublish.output.shape.published,

          /**
           * Appendix A `tool_versions.schema_origin`. Only the two origins this
           * tool can produce are spelled here; `observed_proposed` and
           * `observed_approved` are `approve_tool_schema`'s to write.
           */
          schemaOrigin: z.enum(["declared", "imported"]),

          /**
           * Carried from `list_agent_tools`: the domain each tool belongs to,
           * which is what the belt's search index (§6.6) groups on.
           */
          domain: agentToolList.output.shape.tools.element.shape.domain,
        })
        .strict(),
    ),
  }),
});

export type ImportToolsInput = z.output<typeof importTools.input>;
export type ImportToolsOutput = z.output<typeof importTools.output>;
