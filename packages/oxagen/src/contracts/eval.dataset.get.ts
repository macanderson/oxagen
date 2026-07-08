import { z } from "zod";
import { registerCapability } from "../registry";

export const evalDatasetGet = registerCapability({
  name: "get_dataset",
  domain: "eval",
  description:
    "Fetch one eval dataset by public id along with a page of its items (input, expected output, metadata). Paginated via limit + cursor to avoid loading an unbounded item set.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    datasetPublicId: z.string().min(1),
    limit: z.number().int().min(1).max(200).default(50),
    /** Opaque cursor — the public id of the last item on the previous page. */
    cursor: z.string().optional(),
  }),
  output: z.object({
    dataset: z.object({
      datasetId: z.string(),
      name: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      source: z.enum(["manual", "traces"]),
      itemCount: z.number().int().nonnegative(),
      createdAt: z.string(),
    }),
    items: z.array(
      z.object({
        itemId: z.string(),
        input: z.string(),
        expectedOutput: z.string().nullable(),
        metadata: z.record(z.string(), z.unknown()),
      }),
    ),
    /** Public id to pass as `cursor` for the next page, or null when exhausted. */
    nextCursor: z.string().nullable(),
  }),
});

export type EvalDatasetGetInput = z.output<typeof evalDatasetGet.input>;
export type EvalDatasetGetOutput = z.output<typeof evalDatasetGet.output>;
