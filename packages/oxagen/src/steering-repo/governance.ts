// governance.ts: `governance/v1`, steering/governance.toml (steering-repo-spec,
// Memory settings and Token efficiency). The mode, the always-on budget, the
// ledger's rotation, memory settings, and reviewer groups by path.
import { z } from "zod";
import {
  governanceModeSchema,
  type GovernanceMode,
} from "../contracts/context.steering.shared";
import { organizationSlugSchema } from "./common";
import { withRules } from "./json-schema";
import type { LedgerRotation } from "./paths";
import { DEFAULT_ALWAYS_ON_TOKENS } from "./tokens";

export const ledgerRotationSchema = z.enum(["day", "week", "month", "year"]);

/** Whether an unreviewed memory steers the agent that wrote it, at force `info`. */
export const recallUnreviewedSchema = z.enum(["same-agent", "off"]);
export type RecallUnreviewed = z.output<typeof recallUnreviewedSchema>;

export const governanceSchema = withRules(
  z
    .object({
      schema: z.literal("governance/v1"),
      mode: governanceModeSchema,
      steering: z
        .object({
          always_on_tokens: z
            .union([z.number().int().positive(), z.literal("off")])
            .optional()
            .describe(
              "The always-on budget per code repository, or off. Unset inherits Oxagen's default, which only warns.",
            ),
        })
        .strict()
        .optional(),
      ledger: z
        .object({
          rotate: ledgerRotationSchema.optional(),
          max_lines: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("A new file starts here even mid-period."),
        })
        .strict()
        .optional(),
      memory: z
        .object({
          recall_unreviewed: recallUnreviewedSchema.optional(),
          batch_size: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Memories per memory PR."),
          retire_after_days: z.number().int().positive().optional(),
          auto_merge: z
            .boolean()
            .optional()
            .describe("Allowed in solo mode only."),
        })
        .strict()
        .optional(),
      reviewers: z
        .array(
          z
            .object({
              paths: z.array(z.string().min(1)).min(1),
              group: organizationSlugSchema,
            })
            .strict(),
        )
        .optional()
        .describe("Route the folders a pull request changes to a reviewer group."),
    })
    .strict(),
  [
    {
      kind: "equals",
      when: { field: "mode", isNot: "solo" },
      path: ["memory", "auto_merge"],
      value: false,
    },
  ],
);
export type GovernanceFile = z.output<typeof governanceSchema>;

/** Every governance setting, with Oxagen's default wherever the file sets none. */
export interface GovernanceSettings {
  mode: GovernanceMode;
  /** The budget in tokens, or null when the file turns the check off. */
  always_on_tokens: number | null;
  /** True when the file sets the budget, false when it inherits Oxagen's default. */
  always_on_tokens_set: boolean;
  rotate: LedgerRotation;
  max_lines: number;
  recall_unreviewed: RecallUnreviewed;
  batch_size: number;
  retire_after_days: number;
  auto_merge: boolean;
}

export const GOVERNANCE_DEFAULTS = {
  rotate: "month",
  max_lines: 10000,
  recall_unreviewed: "same-agent",
  batch_size: 20,
  retire_after_days: 180,
  auto_merge: false,
} as const satisfies Partial<GovernanceSettings>;

/**
 * The settings a governance file puts in force. `regulated` mode turns
 * `recall_unreviewed` off whatever the file says.
 */
export function resolveGovernance(file: GovernanceFile): GovernanceSettings {
  const budget = file.steering?.always_on_tokens;
  const memory: NonNullable<GovernanceFile["memory"]> = file.memory ?? {};
  return {
    mode: file.mode,
    always_on_tokens:
      budget === "off" ? null : (budget ?? DEFAULT_ALWAYS_ON_TOKENS),
    always_on_tokens_set: budget !== undefined,
    rotate: file.ledger?.rotate ?? GOVERNANCE_DEFAULTS.rotate,
    max_lines: file.ledger?.max_lines ?? GOVERNANCE_DEFAULTS.max_lines,
    recall_unreviewed:
      file.mode === "regulated"
        ? "off"
        : (memory.recall_unreviewed ?? GOVERNANCE_DEFAULTS.recall_unreviewed),
    batch_size: memory.batch_size ?? GOVERNANCE_DEFAULTS.batch_size,
    retire_after_days:
      memory.retire_after_days ?? GOVERNANCE_DEFAULTS.retire_after_days,
    auto_merge: memory.auto_merge ?? GOVERNANCE_DEFAULTS.auto_merge,
  };
}
