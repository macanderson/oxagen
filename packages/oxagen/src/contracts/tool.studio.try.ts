import { z } from "zod";
import { registerCapability } from "../registry";
import { studioServerNameSchema, studioToolNameSchema } from "./tool.studio.draft.save";

/** The longest request text a Try it result carries, as save_studio_draft's test op stores it. */
export const TRY_REQUEST_MAX = 65_536;
/** The longest raw or shaped text a Try it result carries. */
export const TRY_RESULT_MAX = 262_144;
/** The longest arguments object Try it sends, as JSON text. */
export const TRY_ARGUMENTS_MAX = 65_536;

const cutPartSchema = z.enum(["request", "raw", "shaped"]);

/**
 * One call to one tool, for the Try it button on Studio's tool panel
 * (mcp-studio-spec, lane M9). The handler builds the folder the way
 * list_studio_findings does, decides the call under the workspace's published
 * policies and kill switches, then sends it once to the environment the person
 * chose, with the environment's credential.
 *
 * The call is a governed action: the kernel meters it once, the way it meters
 * a call served through Oxagen's MCP gateway. A call the policy denies still
 * counts. Try it saves nothing. A person who keeps the result saves it as a
 * test op with save_studio_draft.
 */
export const toolStudioTry = registerCapability({
  name: "try_studio_tool",
  domain: "tool",
  description:
    "Send one call to one tool in a Studio server folder, against one of its environments, after the workspace's policies and kill switches allow it. Returns the request with credentials removed, the upstream's raw answer, and the result the agent would see.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  // The upstream call can change data on the API the tool fronts.
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  audit: { targetKind: "tool_server_folder", targetIdField: "server" },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
      /** The tool's tools.toml key, its served name, or the upstream name it selects. */
      tool: studioToolNameSchema,
      /** The environment in server.toml to call, such as staging. */
      environment: z.string().min(1).max(64),
      /** The tool's arguments, checked against its input schema before the call. */
      arguments: z
        .record(z.unknown())
        .refine((value) => JSON.stringify(value).length <= TRY_ARGUMENTS_MAX, {
          message: `The arguments must be at most ${TRY_ARGUMENTS_MAX} characters as JSON.`,
        }),
      /**
       * The published agent whose policies decide the call. It may be left out
       * when the workspace publishes exactly one agent.
       */
      agent: z.string().min(1).max(128).optional(),
    })
    .strict(),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      server: z.string(),
      /** The tool as the agent sees it. */
      tool: z.string(),
      environment: z.string(),
      /** The agent whose policies allowed the call. */
      agent: z.string(),
      /** The first upstream request, as JSON, with every credential removed. */
      request: z.string().max(TRY_REQUEST_MAX),
      /** The upstream's first answer, unshaped, as JSON. */
      raw: z.string().max(TRY_RESULT_MAX),
      /** What the agent would receive after shaping, as JSON or text. */
      shaped: z.string().max(TRY_RESULT_MAX),
      /** How many upstream requests the call made. A paged call makes more than one. */
      exchanges: z.number().int().min(0),
      /** The parts cut to fit their limit. Each cut part ends with a note that says so. */
      cut: z.array(cutPartSchema),
    }),
    z.object({
      ok: z.literal(false),
      /** denied: a policy or kill switch stopped the call. failed: it was sent, or meant to be, and did not succeed. */
      reason: z.enum(["denied", "failed"]),
      message: z.string().min(1),
      /** The request the upstream refused, with every credential removed, when one was sent. */
      request: z.string().max(TRY_REQUEST_MAX).optional(),
      /** The upstream's answer to that request, when it sent one. */
      raw: z.string().max(TRY_RESULT_MAX).optional(),
    }),
  ]),
});

export type ToolStudioTryInput = z.output<typeof toolStudioTry.input>;
export type ToolStudioTryOutput = z.output<typeof toolStudioTry.output>;
