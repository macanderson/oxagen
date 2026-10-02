/**
 * revise_work_triage: a person corrects a triage suggestion, or clears a
 * correction (P1-03, #5103; agent-work-phase-1.html, Work lifecycle: Triage).
 *
 * - A field (priority, estimate, labels, predicted paths, acceptance
 *   criteria) set to a value is a correction. It stays in force through every
 *   later triage run until a person clears it by setting the field to null.
 *   Each changed field is one work.triage_corrections row.
 * - `outcome` overrides what triage decided (triaged, needs_info, duplicate,
 *   out_of_scope) with a triage_overridden fact. Null clears the override.
 *   A duplicate names the item it repeats.
 *
 * The call names the item version it read, and a stale version is refused.
 * The handler also refuses a call that changes nothing, a duplicate outcome
 * that names no item, and a duplicate named without that outcome
 * (reviseRequestProblem below).
 * A correction grants no authority and writes nothing back to the source.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  triageOutcomeSchema,
  triageStandingSchema,
  triageViewSchema,
  workItemIdSchema,
  workItemStateSchema,
  workPrioritySchema,
} from "./work.intake.shared";

const listOf = (max: number) => z.array(z.string().trim().min(1).max(1000)).max(max);

export const workTriageRevise = registerCapability({
  name: "revise_work_triage",
  domain: "work",
  description:
    "Correct a work item's triage suggestion (priority, estimate, labels, predicted paths, acceptance criteria) or its outcome. A null value clears a correction so triage decides again.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      item_id: workItemIdSchema,
      /** The item version the person read. */
      expected_version: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(2000).describe("Why the person changed the suggestion."),
      priority: workPrioritySchema.nullable().optional(),
      estimate_minutes: z.number().int().min(0).max(43_200).nullable().optional(),
      labels: listOf(50).nullable().optional(),
      claims: listOf(50).nullable().optional().describe("Predicted path globs."),
      criteria: listOf(50).min(1).nullable().optional().describe("Acceptance criteria."),
      outcome: triageOutcomeSchema.nullable().optional(),
      duplicate_of: workItemIdSchema.optional().describe("The item this one repeats, when the outcome is duplicate."),
    })
    .strict(),
  output: z
    .object({
      item_id: workItemIdSchema,
      version: z.number().int().nonnegative(),
      state: workItemStateSchema,
      /** The fields this call changed or cleared. */
      changed: z.array(z.enum(["priority", "estimate_minutes", "labels", "claims", "criteria", "outcome"])),
      triage: triageViewSchema,
      standing: triageStandingSchema,
    })
    .strict(),
});

/** The fields one call can change. */
export const REVISE_TRIAGE_FIELDS = ["priority", "estimate_minutes", "labels", "claims", "criteria", "outcome"] as const;

/** Why a request cannot be applied as asked, or null when it can. */
export function reviseRequestProblem(input: z.output<typeof workTriageRevise.input>): string | null {
  if (!REVISE_TRIAGE_FIELDS.some((field) => input[field] !== undefined)) {
    return "Change at least one field, or the outcome.";
  }
  if (input.outcome === "duplicate" && input.duplicate_of === undefined) return "Name the item this one repeats in duplicate_of.";
  if (input.duplicate_of !== undefined && input.outcome !== "duplicate") return "Name a duplicate only with the outcome duplicate.";
  if (input.duplicate_of !== undefined && input.duplicate_of === input.item_id) return "An item cannot repeat itself.";
  return null;
}

export type WorkTriageReviseInput = z.output<typeof workTriageRevise.input>;
export type WorkTriageReviseOutput = z.output<typeof workTriageRevise.output>;
