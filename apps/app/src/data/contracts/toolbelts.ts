// The toolbelt view models (ADR-198, #4369): the workspace's belts from
// `list_toolbelts` and one belt from `get_toolbelt`.
//
// A toolbelt is the set of tools an agent is shown. It narrows what the agent
// can reach and never widens a grant. Every workspace holds one All tools belt
// (`all_tools`): every tool an owner or admin made available, each active as
// its workspace default says. A `custom` belt is a clone with its own members.
import { z } from "zod";
import { PublicId } from "./common";

const Instant = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();

const ToolbeltKind = z.enum(["all_tools", "custom"]);

const BeltRef = z.object({
  id: PublicId,
  name: z.string().min(1),
  slug: z.string().min(1),
  kind: ToolbeltKind,
});

const ToolbeltSummary = BeltRef.extend({
  description: z.string().nullable(),
  clonedFrom: BeltRef.nullable(),
  /** Available tools the belt holds, active or not. */
  tools: Count,
  /** The ones among them the belt shows an agent. */
  activeTools: Count,
  servers: Count,
  /** Live agents carrying the belt now. */
  agents: Count,
  updatedAt: Instant,
});

export const ToolbeltList = z.object({
  /** The All tools belt first, then the clones. */
  belts: z.array(ToolbeltSummary),
  /**
   * Tools an owner or admin made available in the workspace. Zero means the
   * workspace has imported no tool an agent could be shown yet.
   */
  availableTools: Count,
});
export type ToolbeltList = z.infer<typeof ToolbeltList>;

const ToolbeltTool = z.object({
  /** `tol_…`. */
  id: PublicId,
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  available: z.boolean(),
  defaultActive: z.boolean(),
  active: z.boolean(),
  member: z.boolean(),
});

export const ToolbeltGroup = z.object({
  /** `mcs_…`, or null for the workspace's declared and built-in tools. */
  serverId: PublicId.nullable(),
  serverName: z.string().min(1),
  included: z.boolean(),
  tools: z.array(ToolbeltTool),
});
export type ToolbeltGroup = z.infer<typeof ToolbeltGroup>;

export const ToolbeltDetail = z.object({
  belt: BeltRef.extend({
    description: z.string().nullable(),
    clonedFrom: BeltRef.nullable(),
    updatedAt: Instant,
  }),
  groups: z.array(ToolbeltGroup),
  agents: z.array(
    z.object({
      id: PublicId,
      name: z.string().min(1),
      slug: z.string().min(1),
    }),
  ),
});
export type ToolbeltDetail = z.infer<typeof ToolbeltDetail>;
