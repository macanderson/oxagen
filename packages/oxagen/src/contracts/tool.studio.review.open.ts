import { z } from "zod";
import { registerCapability } from "../registry";
import {
  toolEgressClassSchema,
  toolRiskGradeSchema,
  toolSideEffectClassSchema,
} from "./tool.classification";
import { studioServerNameSchema } from "./tool.studio.draft.save";

const classificationSchema = z.object({
  risk: toolRiskGradeSchema,
  sideEffect: toolSideEffectClassSchema,
  egress: toolEgressClassSchema,
  impacts: z.array(z.string()),
});

/**
 * Review (lane M11, ADR-224): turn Studio's draft for one server folder into
 * one steering PR on the branch `tools/<server>`. The PR writes server.toml,
 * tools.toml, tools.lock.json, the vendored definition, and tests/calls.jsonl
 * under tools/servers/<server>/. Its body lists every imported, removed, and
 * reclassified tool, the definition token total against the budget, and the
 * tool checks' findings.
 *
 * Review refuses with `conflict` while any tool the draft imports has no
 * risk, side effect, or egress, and while the folder does not compile. A
 * second Review of the same draft adds a commit to the PR it already opened.
 */
export const toolStudioReviewOpen = registerCapability({
  name: "open_studio_review",
  domain: "tool",
  description:
    "Open one steering PR from Studio's draft for a server folder: server.toml, tools.toml, tools.lock.json, the vendored definition, and saved tests on the branch tools/<server>. Refuses while a tool the draft imports has no risk, side effect, or egress.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Opening a steering PR is governance work and spends no model tokens.
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
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
      /** The draft revision Review reads. A newer draft is refused with `conflict`. */
      revision: z.number().int().min(1).optional(),
    })
    .strict(),
  output: z.object({
    number: z.number().int().positive(),
    url: z.string().url(),
    branch: z.string(),
    headSha: z.string(),
    /** Tool keys the PR adds to tools.toml. */
    imported: z.array(z.string()),
    /** Tool keys the PR takes out of tools.toml. */
    removed: z.array(z.string()),
    /** Tools whose risk, side effect, egress, or impacts the PR changes. */
    reclassified: z.array(
      z.object({
        tool: z.string(),
        before: classificationSchema,
        after: classificationSchema,
      }),
    ),
    tokens: z.object({
      /** Every imported tool's definition together. */
      definitions: z.number().int().min(0),
      /** server.toml's definition_budget, or the default. */
      budget: z.number().int().min(1),
    }),
    /** The tool checks' findings on the folder the PR writes. */
    findings: z.array(
      z.object({
        rule: z.string(),
        level: z.enum(["error", "warning", "info"]),
        tool: z.string().nullable(),
        field: z.string().nullable(),
        message: z.string(),
        fix: z.string(),
      }),
    ),
  }),
});

export type ToolStudioReviewOpenInput = z.output<typeof toolStudioReviewOpen.input>;
export type ToolStudioReviewOpenOutput = z.output<typeof toolStudioReviewOpen.output>;
