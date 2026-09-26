// Shapes shared by the toolbelt contracts and every contract that names a
// toolbelt (ADR-192). No capability registers here.
//
// A toolbelt is the set of tools an agent is shown. It narrows what the agent
// can reach and never widens a grant: roles, mandates and kill switches still
// decide each call.
//
// - `all_tools`: one per workspace. Its members are every tool an owner or
//   admin made available (`agent.tools.enabled`), each active as its
//   `default_active` says. It stores no members and cannot be edited; change a
//   tool's availability or default instead (`set_tool_state`).
// - `custom`: a clone. It stores its own members, copied from the belt it was
//   cloned from, and `update_toolbelt` edits them: remove or add a server,
//   turn a server or a tool on or off in the belt.
import { z } from "zod";
import { WORKSPACE_SLUG_PATTERN } from "../workspace-slug";

/** The longest toolbelt slug (`tools.toolbelts.slug`, `toolbelts_slug_check`). */
export const TOOLBELT_SLUG_MAX = 40;

export const toolbeltSlugSchema = z
  .string()
  .min(1)
  .max(TOOLBELT_SLUG_MAX)
  .regex(
    WORKSPACE_SLUG_PATTERN,
    "lowercase letters and digits, separated by single hyphens",
  );

/** `tbt_…`. */
export const toolbeltIdSchema = z.string().regex(/^tbt_[0-9a-z]+$/);

/** `tol_…`, an `agent.tools` row. */
export const toolIdSchema = z.string().regex(/^tol_[0-9a-z]+$/);

/**
 * The MCP server a tool came from (`mcs_…`), or null for the workspace's
 * declared and built-in tools, which the belt treats as one group.
 */
export const toolServerIdSchema = z
  .string()
  .regex(/^mcs_[0-9a-z]+$/)
  .nullable();

export const toolbeltKindSchema = z.enum(["all_tools", "custom"]);
export type ToolbeltKind = z.output<typeof toolbeltKindSchema>;

/** A toolbelt as every other record names it. */
export const toolbeltRefSchema = z
  .object({
    id: toolbeltIdSchema,
    name: z.string().min(1),
    slug: z.string().min(1),
    kind: toolbeltKindSchema,
  })
  .strict();
export type ToolbeltRef = z.output<typeof toolbeltRefSchema>;
