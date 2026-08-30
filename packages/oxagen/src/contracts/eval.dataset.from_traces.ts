import { z } from "zod";
import { registerCapability } from "../registry";

export const evalDatasetFromTraces = registerCapability({
  name: "create_trace_dataset",
  domain: "eval",
  description:
    "Create an eval dataset from the workspace's real, already-metered run traces — samples recent user messages that produced billed activity and captures them as dataset items. This is the wedge: score what actually ran, not synthetic prompts.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // Reads traces + Postgres messages; captures inputs. No AI tokens spent.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    name: z.string().min(1),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case")
      .optional(),
    description: z.string().optional(),
    /** Only sample runs whose metered capability matches (e.g. "send_message"). */
    capabilityName: z.string().optional(),
    /** Lookback window over the metered traces. */
    sinceHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 90)
      .default(24 * 7),
    /** Cap the number of captured cases (cost + noise control). */
    limit: z.number().int().min(1).max(500).default(50),
  }),
  output: z.object({
    datasetId: z.string(),
    publicId: z.string(),
    slug: z.string(),
    itemCount: z.number().int().nonnegative(),
  }),
});

export type EvalDatasetFromTracesInput = z.output<
  typeof evalDatasetFromTraces.input
>;
export type EvalDatasetFromTracesOutput = z.output<
  typeof evalDatasetFromTraces.output
>;
