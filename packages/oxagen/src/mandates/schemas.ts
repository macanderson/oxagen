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
export const CONSEQUENCE_TAG_STARTER_SET = [
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
export const ORG_ROLE_NAMES = [
  "Owner",
  "Admin",
  "Compliance",
  "Billing",
] as const;
export const orgRoleNameSchema = z.enum(ORG_ROLE_NAMES);
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

export const measureNameSchema = z
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

// ── The mandate shape (§6.9 part 3) ───────────────────────────────────────

export const MANDATE_PERIODS = ["daily", "weekly", "monthly"] as const;
export const mandatePeriodSchema = z.enum(MANDATE_PERIODS);
export type MandatePeriod = z.infer<typeof mandatePeriodSchema>;

export const mandateLimitSchema = z
  .object({
    perCall: measureValueSchema.optional(),
    perPeriod: measureValueSchema.optional(),
    period: mandatePeriodSchema,
    /** A currency code for an amount, a unit name for a count. */
    currencyOrUnit: z.string().min(1).max(32),
  })
  .strict()
  .refine(
    (l) => l.perCall !== undefined || l.perPeriod !== undefined,
    "a limit names perCall, perPeriod or both",
  );
export type MandateLimit = z.infer<typeof mandateLimitSchema>;

export const mandateLimitsSchema = z
  .record(measureNameSchema, mandateLimitSchema)
  .refine(
    (limits) => Object.keys(limits).length > 0,
    "a mandate names at least one limit",
  );
export type MandateLimits = z.infer<typeof mandateLimitsSchema>;

export const mandateTargetSchema = z
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
export const toolPatternSchema = z.string().min(1).max(256);

export const mandateApprovalSchema = z
  .object({
    /** measure → the value above which a person must look. */
    humanAbove: z.record(measureNameSchema, measureValueSchema).default({}),
    /** Tags a call carries for which a person always looks. */
    alwaysHumanFor: z.array(consequenceTagSchema).default([]),
    /** Who may answer: `role:<name>` or `user:<usr_…>`; recorded, read by the app. */
    approvers: z.array(z.string().min(1).max(128)).default([]),
  })
  .strict();
export type MandateApproval = z.infer<typeof mandateApprovalSchema>;

export const MANDATE_STATUSES = [
  "draft",
  "active",
  "expired",
  "revoked",
] as const;
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
export type MandateBody = z.infer<typeof mandateBodySchema>;

/** The grant's fields: the body plus the draft it activates, if any. */
export const mandateGrantFields = {
  ...mandateBodyFields,
  requestId: mandateIdSchema.optional(),
};
export const mandateGrantInputSchema = z
  .object(mandateGrantFields)
  .strict()
  .refine(validityOrdered, "validTo is after validFrom");

/** Remaining authority by measure, from the ledger's last balance_after (INV-10). */
export const mandateAuthoritySchema = z
  .object({
    measure: measureNameSchema,
    currencyOrUnit: z.string(),
    period: mandatePeriodSchema,
    periodKey: z.string(),
    perCall: measureValueSchema.nullable(),
    perPeriod: measureValueSchema.nullable(),
    /** Settled this period: the sum of settle rows. */
    settled: measureValueSchema,
    /** Held by reservations not yet settled or released. */
    reserved: measureValueSchema,
    /** The last balance_after this period, or perPeriod when no row exists; null without a perPeriod. */
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
export type MandateLedgerRowOut = z.infer<typeof mandateLedgerRowSchema>;

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
