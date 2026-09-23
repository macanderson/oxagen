/**
 * The vocabulary the cost-center contracts share (ADR-142). Not a capability:
 * this file registers nothing.
 *
 * A cost center is a label finance charges spend back to. The organization
 * keeps a list of valid labels; an agent and a workspace may each name one,
 * and the agent's wins when both do.
 */
import { z } from "zod";

/**
 * One to 64 characters: a letter or digit, then letters, digits, `.`, `_` or
 * `-`. The same pattern as `COST_CENTER_LABEL_PATTERN` in
 * `@oxagen/database/schema`, which is the CHECK on every column holding one.
 */
export const costCenterLabelSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    "a label of 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
  );

export const costCenterSchema = z
  .object({
    /** `ccn_…` */
    id: z.string(),
    label: costCenterLabelSchema,
    description: z.string().nullable(),
    /** Agents in the organization that name this label. */
    agents: z.number().int().nonnegative(),
    /** Workspaces in the organization that name this label. */
    workspaces: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .strict();
export type CostCenter = z.output<typeof costCenterSchema>;
