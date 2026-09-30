import { z } from "zod";
import { registerCapability } from "../registry";
import { studioServerNameSchema } from "./tool.studio.draft.save";

const isoDateSchema = z.string().datetime();

/**
 * One server's discovery, as Studio shows its progress (lane M10, #4682).
 * mcp.server_discoveries keeps one row per server, and each discovery
 * overwrites it, so `id` stays the same across runs and serves as the
 * discovery id. Progress is the status: queued, running, then succeeded or
 * failed.
 */
export const studioDiscoverySchema = z.object({
  /** The row's id, stable across every discovery of the server. */
  id: z.string().uuid(),
  /** The folder name under tools/servers/. */
  server: z.string(),
  /** `mcs_…`, or null before the server has a registry row. */
  mcpServerId: z.string().nullable(),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  /** What asked for the latest discovery. */
  trigger: z.enum([
    "schedule",
    "list_changed",
    "push",
    "registry_version",
    "manual",
    "lock_merged",
  ]),
  requestedAt: isoDateSchema,
  /** The person who asked, or null when the platform asked. */
  requestedBy: z.string().nullable(),
  startedAt: isoDateSchema.nullable(),
  finishedAt: isoDateSchema.nullable(),
  error: z.string().nullable(),
  /** What a finished discovery did about the lock. */
  outcome: z
    .enum(["unchanged", "pr_opened", "pr_updated", "needs_digest", "skipped"])
    .nullable(),
  toolCount: z.number().int().min(0).nullable(),
  /** The machine that reported, for a local server or a registry package. */
  machine: z.string().nullable(),
  sourceKind: z.string().nullable(),
  sourceRepo: z.string().nullable(),
  sourcePath: z.string().nullable(),
  sourceRef: z.string().nullable(),
  schedule: z.enum(["on-change", "daily", "manual"]).nullable(),
  upstreamDigest: z.string().nullable(),
  latestVersion: z.string().nullable(),
  /** The sync steering PR this discovery opened or updated. */
  pr: z
    .object({
      number: z.number().int().positive(),
      url: z.string(),
      branch: z.string(),
    })
    .nullable(),
  /** Full tool names the gateway hides until the sync steering PR merges. */
  withheld: z.array(z.string()),
  /**
   * True when the discovery has sat queued, or run, for over an hour. A run
   * times out after 10 minutes and retries twice, so a live run never gets
   * this old. The hourly sweep asks for a stalled server again.
   */
  stalled: z.boolean(),
});

export type StudioDiscovery = z.output<typeof studioDiscoverySchema>;

/**
 * Read one server's latest discovery (lane M10, #4682): its status, what
 * asked for it, its outcome, the sync steering PR, and the tools the gateway
 * withholds. Null before the server's first discovery.
 */
export const toolStudioDiscoveryGet = registerCapability({
  name: "get_studio_discovery",
  domain: "tool",
  description:
    "Read one server folder's latest tool discovery: its status, what asked for it, when it ran, its outcome, the sync steering PR, and the tools the gateway withholds until that PR merges. Null before the first discovery.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
    })
    .strict(),
  output: z.object({ discovery: studioDiscoverySchema.nullable() }),
});

export type ToolStudioDiscoveryGetInput = z.output<typeof toolStudioDiscoveryGet.input>;
export type ToolStudioDiscoveryGetOutput = z.output<typeof toolStudioDiscoveryGet.output>;
