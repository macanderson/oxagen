/**
 * The mandate vocabulary (MC spec §6.9, ADR-059): consequence tags, the
 * measure declaration a tool version carries, the limits, targets and
 * approval rule a mandate carries, the consequence-role map, and the row
 * shape every mandate read returns. Contracts, handlers and the rules gate
 * import from here so the wire shape has one definition.
 *
 * Values are integer strings (INV-09): micros for a currency measure, whole
 * units for a count. `MEASURE_VALUE` is the regex the contracts and the
 * ledger agree on.
 */
import { z } from "zod";

/** The starter set the customer extends (§6.9 part 1). */
const CONSEQUENCE_TAG_STARTER_SET = [
  "moves_money",
  "destroys_data",
  "alters_production",
  "communicates_externally",
  "changes_access",
  "changes_entitlement",
] as const;

export const consequenceTagSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,63}$/,
    "a consequence tag is snake_case, 2 to 64 characters",
  );

/** The org-scoped IAM role names provisioned for every org (iam-provision.ts ORG_ROLES). */
const ORG_ROLE_NAMES = ["Owner", "Admin", "Compliance", "Billing"] as const;
const orgRoleNameSchema = z.enum(ORG_ROLE_NAMES);
export type OrgRoleName = z.infer<typeof orgRoleNameSchema>;

/**
 * Consequence tag → the org roles that may grant, change or revoke a
 * mandate for it (ADR-059 decision 1). A tag the customer defines and has
 * not mapped takes `DEFAULT_CONSEQUENCE_ROLES.other`.
 */
export const DEFAULT_CONSEQUENCE_ROLES: Readonly<
  Record<
    (typeof CONSEQUENCE_TAG_STARTER_SET)[number] | "other",
    readonly OrgRoleName[]
  >
> = {
  moves_money: ["Owner", "Billing"],
  changes_entitlement: ["Owner", "Billing"],
  destroys_data: ["Owner", "Admin"],
  alters_production: ["Owner", "Admin"],
  communicates_externally: ["Owner", "Admin"],
  changes_access: ["Owner", "Admin", "Compliance"],
  other: ["Owner", "Admin"],
};

/** The stored overrides: tag → non-empty role list. */
export const consequenceRolesSchema = z.record(
  consequenceTagSchema,
  z.array(orgRoleNameSchema).min(1),
);
export type ConsequenceRoles = z.infer<typeof consequenceRolesSchema>;

/** The roles that may act on `tag`, overrides first, then the defaults. */
export function rolesForConsequence(
  tag: string,
  overrides: ConsequenceRoles,
): readonly OrgRoleName[] {
  const override = overrides[tag];
  if (override && override.length > 0) return override;
  const known = (
    DEFAULT_CONSEQUENCE_ROLES as Record<string, readonly OrgRoleName[]>
  )[tag];
  return known ?? DEFAULT_CONSEQUENCE_ROLES.other;
}

/** The effective map for every starter tag plus the overrides' own tags. */
export function effectiveConsequenceRoles(
  overrides: ConsequenceRoles,
): Record<string, OrgRoleName[]> {
  const tags = new Set<string>([
    ...CONSEQUENCE_TAG_STARTER_SET,
    ...Object.keys(overrides),
  ]);
  const out: Record<string, OrgRoleName[]> = {};
  for (const tag of tags) out[tag] = [...rolesForConsequence(tag, overrides)];
  return out;
}

// ── Measures ──────────────────────────────────────────────────────────────

/** A non-negative integer in a string: micros for a currency, whole units otherwise. */
export const MEASURE_VALUE = /^(0|[1-9][0-9]{0,29})$/;
export const measureValueSchema = z
  .string()
  .regex(
    MEASURE_VALUE,
    "an integer string: micros for a currency, whole units otherwise",
  );

const measureNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, "a measure name is snake_case");

/** The one built-in measure: every call counts 1, no path is declared. */
export const CALLS_MEASURE = "calls";

/**
 * How a tool version exposes one measure (§6.9 part 1, ADR-059 decision 6):
 * a dot path into the call's input, its type, its unit, and for an amount
 * the number of decimal places the tool uses (default 2, so `12.50` in a
 * currency with cents becomes 12500000 micros).
 */
export const measureDeclarationSchema = z
  .object({
    path: z.string().min(1).max(256),
    type: z.enum(["amount", "count", "text"]),
    unit: z.string().min(1).max(32),
    scale: z.number().int().min(0).max(6).optional(),
  })
  .strict();
export type MeasureDeclaration = z.infer<typeof measureDeclarationSchema>;

export const measureDeclarationsSchema = z.record(
  measureNameSchema,
  measureDeclarationSchema,
);
export type MeasureDeclarations = z.infer<typeof measureDeclarationsSchema>;

/**
 * Whether a measure's figures are money or a count (ADR-108). A stored limit
 * and the authority read from it carry this fact directly: it is worked out
 * once, from the tool's declared `type` (`amount` → `money`, `count` →
 * `count`), at the moment a mandate's limits are written, by
 * `assertToolsDeclareMeasures` (`packages/handlers/src/_mandate.ts`). No
 * reader downstream of that write infers it from `currencyOrUnit`: a
 * three-letter unit such as `GAU` is not a currency, and a tool may
 * legitimately declare a **count** denominated in a currency code (`{ type:
 * "count", unit: "USD" }`), which a guess from the unit string alone gets
 * wrong every time.
 */
export const measureKindSchema = z.enum(["money", "count"]);
export type MeasureKind = z.infer<typeof measureKindSchema>;

// ── The mandate shape (§6.9 part 3) ───────────────────────────────────────

const MANDATE_PERIODS = ["daily", "weekly", "monthly"] as const;
const mandatePeriodSchema = z.enum(MANDATE_PERIODS);
export type MandatePeriod = z.infer<typeof mandatePeriodSchema>;

const mandateLimitSchema = z
  .object({
    perCall: measureValueSchema.optional(),
    perPeriod: measureValueSchema.optional(),
    period: mandatePeriodSchema,
    /** A currency code for an amount, a unit name for a count. */
    currencyOrUnit: z.string().min(1).max(32),
    /**
     * Money or a count (ADR-108), stamped by the handler from the declaration
     * it already validated, never client-supplied and never re-derived from
     * `currencyOrUnit` downstream. Optional only because a limit written
     * before ADR-108 has no such field in its stored jsonb; every write since
     * carries it. A reader that finds it absent takes the documented legacy
     * fallback (`legacyMeasureKindGuess`, `packages/rules`), not a fresh
     * guess of its own.
     */
    kind: measureKindSchema.optional(),
  })
  .strict()
  .refine(
    (l) => l.perCall !== undefined || l.perPeriod !== undefined,
    "a limit names perCall, perPeriod or both",
  );

export const mandateLimitsSchema = z
  .record(measureNameSchema, mandateLimitSchema)
  .refine(
    (limits) => Object.keys(limits).length > 0,
    "a mandate names at least one limit",
  );
export type MandateLimits = z.infer<typeof mandateLimitsSchema>;

/**
 * One measure's bound as a **change** rather than a record: every field is
 * optional and an absent field means "leave what is stored". A bound is
 * replaced field by field, so clearing a per-call cap while keeping the
 * per-period one is not expressible here and is not meant to be — deleting a
 * bound is what `mandateLimitsSchema` replacement is for (ADR-102).
 */
const mandateLimitChangeSchema = z
  .object({
    perCall: measureValueSchema.optional(),
    perPeriod: measureValueSchema.optional(),
    period: mandatePeriodSchema.optional(),
    currencyOrUnit: z.string().min(1).max(32).optional(),
  })
  .strict()
  .refine(
    (c) =>
      c.perCall !== undefined ||
      c.perPeriod !== undefined ||
      c.period !== undefined ||
      c.currencyOrUnit !== undefined,
    "a limit change names at least one field",
  );

/**
 * measure → the fields to change on that measure's bound, leaving every other
 * measure and every unnamed field as stored (ADR-102). `update_mandate_limits`
 * merges this under the row lock it already takes, which is the only place the
 * merge is safe: a caller that read the record, merged, and sent the whole
 * record back could restore a bound another operator lowered in between.
 */
export const mandateLimitChangesSchema = z
  .record(measureNameSchema, mandateLimitChangeSchema)
  .refine(
    (changes) => Object.keys(changes).length > 0,
    "a limit change names at least one measure",
  );
export type MandateLimitChanges = z.infer<typeof mandateLimitChangesSchema>;

const mandateTargetSchema = z
  .object({
    allow: z.array(z.string().min(1).max(256)).default([]),
    deny: z.array(z.string().min(1).max(256)).default([]),
  })
  .strict();
export const mandateTargetsSchema = z.record(
  measureNameSchema,
  mandateTargetSchema,
);
export type MandateTargets = z.infer<typeof mandateTargetsSchema>;

/** Glob over `slug@version` (or `slug`) of a declared tool. */
const toolPatternSchema = z.string().min(1).max(256);

/** One approver entry: an org role, or one user by public id. */
export const mandateApproverSchema = z
  .string()
  .regex(
    new RegExp(
      `^(role:(${ORG_ROLE_NAMES.join("|")})|user:usr_[0-9a-z]+)$`,
      "i",
    ),
    "an approver is role:<Owner|Admin|Compliance|Billing> or user:<usr_…>",
  );

export const mandateApprovalSchema = z
  .object({
    /** measure → the value above which a person must look. */
    humanAbove: z.record(measureNameSchema, measureValueSchema).default({}),
    /** Tags a call carries for which a person always looks. */
    alwaysHumanFor: z.array(consequenceTagSchema).default([]),
    /**
     * Who may answer a parked call, beside the consequence roles:
     * `role:<org role>` or `user:<usr_…>`. Empty leaves it to the
     * consequence roles; resolve_approval enforces a non-empty list.
     */
    approvers: z.array(mandateApproverSchema).default([]),
  })
  .strict();
export type MandateApproval = z.infer<typeof mandateApprovalSchema>;

const MANDATE_STATUSES = ["draft", "active", "expired", "revoked"] as const;
export const mandateStatusSchema = z.enum(MANDATE_STATUSES);
export type MandateStatus = z.infer<typeof mandateStatusSchema>;

const MANDATE_PUBLIC_ID = /^mnd_[0-9a-z]+$/i;
export const mandateIdSchema = z
  .string()
  .regex(MANDATE_PUBLIC_ID, "mandateId is the public id (mnd_…)");

const AGENT_PUBLIC_ID = /^agt_[0-9a-z]+$/i;
/** The agent's public id (agt_…); the handler resolves its delegated principal. */
export const agentIdSchema = z
  .string()
  .regex(AGENT_PUBLIC_ID, "agentId is the agent's public id (agt_…)");

/**
 * The fields a grant and a request share. Exported as a field map because the
 * contract input wraps them in `.refine()` (a ZodEffects, no `.shape`), and
 * the xmcp tools build their argument schemas from the map.
 */
export const mandateBodyFields = {
  agentId: agentIdSchema,
  consequenceTags: z.array(consequenceTagSchema).min(1).max(16),
  limits: mandateLimitsSchema,
  targets: mandateTargetsSchema.default({}),
  tools: z.array(toolPatternSchema).min(1).max(64),
  approval: mandateApprovalSchema.default({
    humanAbove: {},
    alwaysHumanFor: [],
    approvers: [],
  }),
  purpose: z.string().min(1).max(2000),
  validFrom: z.string().datetime({ offset: true }),
  validTo: z.string().datetime({ offset: true }),
};

const validityOrdered = (m: { validFrom: string; validTo: string }) =>
  Date.parse(m.validTo) > Date.parse(m.validFrom);

export const mandateBodySchema = z
  .object(mandateBodyFields)
  .strict()
  .refine(validityOrdered, "validTo is after validFrom");

/** The grant's fields: the body plus the draft it activates, if any. */
export const mandateGrantFields = {
  ...mandateBodyFields,
  requestId: mandateIdSchema.optional(),
};
export const mandateGrantInputSchema = z
  .object(mandateGrantFields)
  .strict()
  .refine(validityOrdered, "validTo is after validFrom");

/** Remaining authority by measure: perPeriod less what the period drew, from the ledger. */
const mandateAuthoritySchema = z
  .object({
    measure: measureNameSchema,
    currencyOrUnit: z.string(),
    /** Money or a count (ADR-108); always present, `readAuthority` resolves the legacy fallback before this leaves the handler. */
    kind: measureKindSchema,
    period: mandatePeriodSchema,
    periodKey: z.string(),
    perCall: measureValueSchema.nullable(),
    perPeriod: measureValueSchema.nullable(),
    /** Settled this period: the sum of settle rows. */
    settled: measureValueSchema,
    /** Held by reservations not yet settled or released. */
    reserved: measureValueSchema,
    /** perPeriod less reserved and settled this period, floored at zero; null without a perPeriod. */
    remaining: measureValueSchema.nullable(),
  })
  .strict();
export type MandateAuthority = z.infer<typeof mandateAuthoritySchema>;

export const mandateLedgerRowSchema = z
  .object({
    id: z.string(),
    toolCallId: z.string(),
    kind: z.enum(["reserve", "settle", "release"]),
    measure: measureNameSchema,
    value: measureValueSchema,
    unitOrCurrency: z.string(),
    externalEffectId: z.string().nullable(),
    periodKey: z.string(),
    balanceAfter: measureValueSchema,
    at: z.string(),
  })
  .strict();

/** One mandate as every read returns it. Only public ids leave the handler. */
export const mandateSchema = z
  .object({
    id: mandateIdSchema,
    agentId: agentIdSchema,
    agentSlug: z.string(),
    requestedBy: z.string().nullable(),
    grantedBy: z.string().nullable(),
    roleAtGrant: z.string().nullable(),
    consequenceTags: z.array(consequenceTagSchema),
    limits: mandateLimitsSchema,
    targets: mandateTargetsSchema,
    tools: z.array(toolPatternSchema),
    approval: mandateApprovalSchema,
    purpose: z.string(),
    validFrom: z.string(),
    validTo: z.string(),
    status: mandateStatusSchema,
    revokedBy: z.string().nullable(),
    revokedReason: z.string().nullable(),
    revokedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    authority: z.array(mandateAuthoritySchema),
  })
  .strict();
export type MandateOut = z.infer<typeof mandateSchema>;
