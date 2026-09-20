/**
 * The auto-approval rule vocabulary (MC spec §6.9 part 2, ADR-070).
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
// The same tag vocabulary the tools carry, so the stamp and the fact it is
// compared against cannot drift apart.
import { consequenceTagSchema } from "../contracts/tool.classification";

/**
 * The ceiling on a rule's authored-consequence stamp, and the widest
 * consequence surface one rule may be written over.
 *
 * It is a real bound rather than a generous one, because the thing it bounds
 * has no maximum to size the field for. A tool version carries at most 16
 * declared tags (`publish_tool_declaration`) and 32 classified ones
 * (`toolClassificationSchema`) — 48 — and the vocabulary is open, since
 * `consequenceTagSchema` admits any snake_case string rather than the starter
 * set. So two matched tools can already contribute 96 distinct tags, and a
 * rule whose pattern is `*` follows however many tools the workspace holds.
 *
 * `assertRulesSavable` enforces it where the union is formed, refusing the
 * rule as `conflict` / `too_many_consequences` and naming the count against
 * this limit. Without that the bound still applied — `writeRules` parses the
 * document before storing it — but as `rule_set_would_not_load`, a fact about
 * a generated field the author never wrote and cannot see, on a rule every
 * authoring guard had just passed.
 *
 * The number is also a governance statement and not only a storage one: one
 * rule spanning more than this many distinct consequences asks a single
 * author to be accountable for all of them at once, which is the widening
 * MC spec §6.9 part 2 exists to stop. Narrowing the patterns is the repair.
 */
export const MAX_AUTHORED_CONSEQUENCES = 64;

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

/**
 * How many measures one rule may cap, and how many it may allow-list.
 *
 * The bound exists so the recorded reason list has a known maximum: the
 * evaluator writes one reason per failed condition, and a reason list the
 * output schema refuses would make a stored approval unreadable through the
 * API — an audit record that cannot be read back is close to one that does
 * not exist. `MAX_AUTO_APPROVAL_REASONS` is the arithmetic.
 */
export const MAX_RULE_MEASURES = 16;

/**
 * The most reasons one evaluation can record: the four floors, one per capped
 * measure, one per allow-listed target, the standing window, the business
 * hours and the authored-consequence check — 4 + 16 + 16 + 2 + 1 = 39,
 * rounded up so the two bounds do not have to move together. The rounding is
 * what absorbed ADR-070's `consequences_changed` without this constant
 * moving; the arithmetic is restated rather than left stale.
 */
export const MAX_AUTO_APPROVAL_REASONS = 64;

const boundedMeasureCount = <T extends Record<string, unknown>>(record: T) =>
  Object.keys(record).length <= MAX_RULE_MEASURES;
const tooManyMeasures = `a rule names at most ${MAX_RULE_MEASURES} measures`;

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
    maxMeasures: z
      .record(measureNameSchema, measureValueSchema)
      .refine(boundedMeasureCount, tooManyMeasures)
      .default({}),
    /** measure → the globs its target must match (a counterparty, an environment). */
    allowTargets: z
      .record(measureNameSchema, z.array(z.string().min(1).max(256)).min(1))
      .refine(boundedMeasureCount, tooManyMeasures)
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
  disabledReason: z
    .object({
      code: z.enum([
        "classification_changed",
        "measure_changed",
        "tool_scope_changed",
      ]),
      tool: z.string().min(1).max(256),
      at: z.string().datetime({ offset: true }),
      detail: z.string().min(1).max(512),
    })
    .strict()
    .optional(),
  /** The public id (`usr_…`) of whoever last wrote the rule; null when no person did. */
  createdBy: z.string().max(64).nullable(),
  /** When it was last written, ISO-8601. */
  createdAt: z.string().datetime({ offset: true }),
  /**
   * The effective consequence tags the rule's tools carried when it was last
   * written — the union of the declared column and the classified jsonb over
   * every tool the rule's patterns matched at that moment.
   *
   * It exists because the accountability gate is on the WRITE. An author is
   * refused a rule over a tool that moves money unless they are accountable
   * for money, but the same end is reached by ordering: author the rule while
   * the tool is harmless, then classify the tool `moves_money` afterwards.
   * The gate never fires, because the write already happened. The stamp is
   * what the evaluation compares against, so a tool whose consequences grew
   * under a rule stops that rule releasing calls until someone saves it again
   * — and saving re-runs the gate, which is where accountability belongs.
   *
   * SEMANTICS, stated rather than left to the subset test:
   *
   * - A tag the tool carries that is NOT in this set → the rule does not
   *   qualify (`consequences_changed`). It is the growth that matters.
   * - A tag REMOVED from the tool after authoring leaves the rule qualifying,
   *   because the current set is still within the stamp. Intended: losing a
   *   consequence cannot make a rule more dangerous than it was approved to be.
   * - ABSENT → the rule does not qualify, ever, until it is written again.
   *
   * That last reading is the strict one, and it is free rather than weighed:
   * the three capabilities that write this clause (`set_approval_rules`,
   * `set_approval_rule_enabled`, `delete_approval_rule`) all arrive with
   * ADR-070 and are the only writers of `settings.decisionRules.autoApproval`
   * — `update_workspace_settings` takes named fields and cannot reach it,
   * nothing seeds or backfills it, and there is no table. So no stored rule
   * can lack the stamp, and choosing the safe default costs nothing. Read it
   * as "this could not happen yet", not as a trade someone judged.
   *
   * Optional in the schema on purpose: a rule set that does not parse reads as
   * NO rule set, which would take the gate's own deny and require_approval
   * rules down with the clause. Keeping the field optional means the document
   * always parses and the strictness lands on the auto-approval axis alone.
   */
  authoredConsequences: z
    .array(consequenceTagSchema)
    .max(MAX_AUTHORED_CONSEQUENCES)
    .optional(),
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
    reasons: z.array(z.string().min(1).max(128)).max(MAX_AUTO_APPROVAL_REASONS),
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
