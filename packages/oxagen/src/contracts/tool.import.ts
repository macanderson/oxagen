import { z } from "zod";
import { registerCapability } from "../registry";
import { toolDeclarationPublish } from "./tool.declaration.publish";

const publishInput = toolDeclarationPublish.input.shape;

/**
 * `import_tools` (MC spec App. E, #2958): pull a registered MCP server's
 * pinned `tools/list` into the workspace registry, or publish hand-authored
 * declarations against that server.
 *
 * Every tool lands as an `agent.tools` row of source `mcp` naming the server
 * (`mcp_server_id`), with an immutable `agent.tool_versions` row per changed
 * manifest. A pulled tool's version carries `schema_origin = "imported"`, a
 * declared one `"declared"`. The server row is stamped with the import time
 * and a digest over the versions it now has. Re-importing an unchanged server
 * changes nothing and reports `published: false` on every tool.
 *
 * The declarations path carries `publish_tool_declaration`'s wire field names
 * verbatim: these are JSON Schema payloads crossing a protocol boundary.
 *
 * Registers directly. The pull-request path the mockup shows (declarations
 * written to `.oxagen/tools/` on a branch) needs a bound repository, which no
 * capability records today; it lands with the lane that binds one (ADR-065).
 */
/**
 * The input's base object, before the one-of rule: MCP tools spread `.shape`
 * for their argument schema, and a refined schema has none. `invoke()`
 * re-parses the refined contract input, so the rule still holds on a call.
 */
export const toolImportInputObject = z
  .object({
    /** `mcs_…` — the registered server the tools belong to. */
    serverId: z.string().min(1),
    /**
     * Names of the server's pinned tools to import. Omit to import every
     * pinned tool. A name the server has no pin for is `not_found`.
     */
    tools: z.array(z.string().min(1)).min(1).max(200).optional(),
    /**
     * Hand-authored declarations to publish against the server instead of
     * pulling its pins (origin `declared`).
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
      .max(200)
      .optional(),
  })
  .strict();

export const toolImport = registerCapability({
  name: "import_tools",
  domain: "tool",
  description:
    "Import a registered MCP server's pinned tools into the workspace registry, or publish hand-authored declarations against it: one immutable tool version per changed manifest, idempotent on an unchanged one; stamps the server's last import.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Versioning the registry is governance and spends no model tokens, so an
  // org at zero balance can still do it.
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  audit: { targetKind: "mcp_server", targetIdField: "serverId" },
  input: toolImportInputObject.superRefine((input, ctx) => {
    if (input.tools && input.declarations) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["declarations"],
        message:
          "pick the server's pinned tools or supply declarations, not both",
      });
    }
  }),
  output: z.object({
    serverId: z.string(),
    /** sha256 over the sorted checksums of the server's tool versions after this import. */
    importDigest: z.string(),
    tools: z.array(
      z.object({
        /** `tlv_…` of the version now active. */
        id: z.string(),
        /** `tol_…` */
        toolId: z.string(),
        slug: z.string(),
        name: z.string(),
        version: z.number().int().positive(),
        checksum: z.string(),
        schemaOrigin: z.enum(["declared", "imported"]),
        /** True when this import created the version; false when it was already there. */
        published: z.boolean(),
      }),
    ),
  }),
});

export type ToolImportInput = z.output<typeof toolImport.input>;
export type ToolImportOutput = z.output<typeof toolImport.output>;
