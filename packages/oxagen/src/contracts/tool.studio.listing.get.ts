import { z } from "zod";
import { registerCapability } from "../registry";
import { studioServerNameSchema } from "./tool.studio.draft.save";

const isoDateSchema = z.string().datetime();

/**
 * One tool a machine listed, with the classification Studio suggests for it
 * (packages/mcp-studio/src/suggest). The suggestion is not a decision: a
 * person confirms or changes it when they import the tool, and Review refuses
 * an imported tool with no classification.
 */
export const studioListedToolSchema = z.object({
  /** The upstream name, as tools/list gave it. An import op names the tool by it. */
  name: z.string(),
  description: z.string().nullable(),
  suggested: z.object({
    risk: z.enum(["low", "medium", "high", "critical"]),
    sideEffect: z.enum(["read", "write", "irreversible"]),
    egress: z.enum(["local", "org_tenant", "third_party"]),
    impacts: z.array(z.string()),
  }),
});
export type StudioListedTool = z.output<typeof studioListedToolSchema>;

/**
 * One Studio draft's tool listing, as Studio shows its progress (ADR-233,
 * #4756). A new server that runs on machines has no tools until a machine
 * starts it. The listing asks one machine in `machineGroups` to start the
 * pinned package or command and answer tools/list. The MCP process that holds
 * the machine's poll writes the answer into the draft as its MCP source.
 * Progress is the status: waiting_for_machine, running, then succeeded or
 * failed. A succeeded listing saved the draft once more, so read the draft
 * again before the next save. It also carries the tools the machine listed,
 * so Studio can import and classify them before Review.
 */
export const studioListingSchema = z.object({
  /** The folder name under tools/servers/. */
  server: z.string(),
  status: z.enum(["waiting_for_machine", "running", "succeeded", "failed"]),
  /** server.toml's source.machines when the listing was asked. */
  machineGroups: z.array(z.string()),
  /** What the machine checks before it starts anything. */
  pin: z.object({
    /** The package, or the command for a local server. */
    name: z.string(),
    version: z.string(),
    /** `sha256:<hex>`: the package archive's, or the executable's. */
    digest: z.string(),
    /** npm or nuget for a registry package, null for a local command. */
    registryType: z.enum(["npm", "pypi", "oci", "nuget"]).nullable(),
  }),
  /** The draft revision the listing was asked on. */
  draftRevision: z.number().int().min(1),
  requestedAt: isoDateSchema,
  /** The person who asked. */
  requestedBy: z.string().nullable(),
  /** When a machine's MCP process claimed it. */
  claimedAt: isoDateSchema.nullable(),
  finishedAt: isoDateSchema.nullable(),
  /** The machine that answered tools/list. */
  machine: z.string().nullable(),
  /** How many tools the machine listed. */
  toolCount: z.number().int().min(0).nullable(),
  /** Why the listing failed. */
  error: z.string().nullable(),
  /**
   * The tools the machine listed, once the listing succeeded and while the
   * draft still holds them as its MCP source. Null before then, and after a
   * later save replaced the draft's source.
   */
  tools: z.array(studioListedToolSchema).nullable(),
});
export type StudioListing = z.output<typeof studioListingSchema>;

export const toolStudioListingGet = registerCapability({
  name: "get_studio_listing",
  domain: "tool",
  description:
    "Read the tool listing of one Studio draft for a server that runs on machines: whether a machine has listed its tools yet, which machine answered, the tools it listed with the classification Studio suggests for each, and why a listing failed. Null when the draft has none.",
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
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
    })
    .strict(),
  output: z.object({ listing: studioListingSchema.nullable() }),
});

export type ToolStudioListingGetInput = z.output<typeof toolStudioListingGet.input>;
export type ToolStudioListingGetOutput = z.output<typeof toolStudioListingGet.output>;
