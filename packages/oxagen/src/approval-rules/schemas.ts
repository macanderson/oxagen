/**
 * The auto-approval rule vocabulary (MC spec §6.9 part 2, ADR-068).
 *
 * An auto-approval rule names the conditions under which a call the policy
 * sent to a person may skip them. The contracts, the handlers and the
 * evaluator in `@oxagen/rules` all import from here, so the wire shape, the
 * stored shape and the judged shape are one definition.
 *
 * The spec's conditions are here one for one: a measure under a threshold
 * (`maxMeasures`), a counterparty or environment on an allow list
 * (`allowTargets`), a standing approval of the same call digest inside a
 * window the rule names (`standingWindowMs`), and business hours
 * (`businessHours`). Two of the six are not rule fields:
 *
 * - **no taint** is a floor in the evaluator, not a condition an author can
 *   name or lift.
 * - **inside a mandate's remaining authority** is not a condition because the
 *   mandate check reserves authority before the approval hop is reached, so
 *   every call an auto-approval rule can see is already inside its mandate.
 *
 * Values are integer strings (INV-09): micros for a currency measure, whole
 * units for a count.
 */
import { z } from "zod";

/** The discriminator a rule set carrying an auto-approval clause is written with. */
export const RULE_SET_SCHEMA_V2 = "oxagen.decision-rules.v2";

/** A rule id: the citation a receipt carries as `policy:<id>`. */
export const approvalRuleIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "rule ids are lowercase slugs");

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** True when this host's ICU knows the zone, so `Intl` will not throw on it at decision time. */
export function isKnownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The hours a rule admits, local to its own zone. Days are ISO weekdays
 * (1 Monday … 7 Sunday) and the window is `[start, end)`, so a rule written
 * for an office keeps its hours across that zone's daylight-saving changes.
 */
export const businessHoursSchema = z
  .object({
    // Checked at publish time: an unknown zone would otherwise make every
    // evaluation of the rule throw at decision time.
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isKnownTimeZone, "an IANA time-zone name, e.g. Europe/London"),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: z.string().regex(HHMM, "HH:MM, 24-hour"),
    end: z.string().regex(HHMM, "HH:MM, 24-hour"),
  })
  .strict()
  .refine((h) => h.start < h.end, "end is after start");

export type AutoApprovalBusinessHours = z.infer<typeof businessHoursSchema>;

const measureNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "a measure name is snake_case");

const measureValueSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]{0,29})$/,
    "an integer string: micros for a currency, whole units otherwise",
  );

/** The fields an author writes. `createdBy` and `createdAt` are the handler's. */
export const approvalRuleBodySchema = z
  .object({
    id: approvalRuleIdSchema,
    /** One line a reviewer reads on the Tools page. */
    name: z.string().min(1).max(200),
    /** Globs over a declared tool's `slug@version`, or over the bare slug. */
    tools: z.array(z.string().min(1).max(256)).min(1).max(64),
    /** Off leaves the rule in the set and out of every evaluation. */
    enabled: z.boolean().default(true),
    /** measure → the inclusive ceiling its value may not exceed. */
    maxMeasures: z.record(measureNameSchema, measureValueSchema).default({}),
    /** measure → the globs its target must match (a counterparty, an environment). */
    allowTargets: z
      .record(measureNameSchema, z.array(z.string().min(1).max(256)).min(1))
      .default({}),
    /**
     * The window in which a person's approval of the same call digest
     * re-applies; null asks for none. One minute to 30 days: shorter cannot
     * be authored meaningfully, and a standing approval that outlives a month
     * is a grant rather than a re-application of one person's decision.
     */
    standingWindowMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60 * 1000)
      .nullable()
      .default(null),
    /** The hours the rule admits; null admits every hour. */
    businessHours: businessHoursSchema.nullable().default(null),
  })
  .strict();

/** One rule as it is stored and as every read returns it. */
export const approvalRuleSchema = approvalRuleBodySchema.extend({
  /** The public id (`usr_…`) of whoever last wrote the rule; null when no person did. */
  createdBy: z.string().max(64).nullable(),
  /** When it was last written, ISO-8601. */
  createdAt: z.string().datetime({ offset: true }),
});

export type AutoApprovalRuleBody = z.infer<typeof approvalRuleBodySchema>;
export type AutoApprovalRule = z.infer<typeof approvalRuleSchema>;

/** The evaluation recorded beside an approval, as every read returns it. */
export const autoEligibilitySchema = z
  .object({
    /** The rule that was evaluated. */
    ruleId: approvalRuleIdSchema,
    /** True when every condition held and no floor applied. */
    ok: z.boolean(),
    /**
     * Every reason it did not qualify, empty when `ok`. A code, or a code and
     * the measure it is about (`measure_above_ceiling:amount`); the app maps a
     * code to its copy.
     */
    reasons: z.array(z.string().min(1).max(128)).max(32),
    /** True when at least one reason is a floor no rule can lift. */
    floor: z.boolean(),
  })
  .strict();

export type AutoEligibility = z.infer<typeof autoEligibilitySchema>;

/**
 * Who resolved an approval: a person by public id, or the rule that let
 * Oxagen skip them. The `policy:` form is what makes a receipt say plainly
 * that no person looked (§6.9 part 2).
 */
export const resolvedBySchema = z
  .string()
  .regex(
    /^(user:usr_[0-9a-z]+|policy:[a-z0-9][a-z0-9._-]*)$/i,
    "resolvedBy is user:<usr_…> or policy:<rule id>",
  );

/** The stored form of an auto-approval's approver. */
export function policyApprover(ruleId: string): string {
  return `policy:${ruleId}`;
}
