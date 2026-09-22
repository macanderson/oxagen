// The Spend page's forms (#2962): a spend ceiling, read into the
// set_spend_budget input, the month a statement covers, and the two writes the
// Pricing tab makes against the price book. Issues carry keys under
// `spend.budgetDialog.errors.*` and `spend.priceDialog.errors.*`; the contract
// still parses the input on every invoke, and a field it refuses maps back
// through `budgetFieldErrors` / `priceFieldErrors`.
import { z } from "zod";
import { microsFromDecimal } from "@/data/contracts/money";
import { PriceTokenClass } from "@/data/contracts/spend";

export type BudgetFormValues = {
  scope: "org" | "workspace";
  period: "monthly" | "rolling";
  windowDays: string;
  /** The limit in US dollars, as typed. */
  limit: string;
  enabled: boolean;
};

type BudgetFormErrorKey = "limitInvalid" | "windowDaysInvalid";
export type BudgetFieldErrors = Partial<
  Record<"limit" | "windowDays", BudgetFormErrorKey>
>;

const WINDOW_DAYS = /^[1-9]\d{0,3}$/;

export const BudgetForm = z
  .object({
    scope: z.enum(["org", "workspace"]),
    period: z.enum(["monthly", "rolling"]),
    windowDays: z.string(),
    limit: z.string(),
    enabled: z.boolean(),
  })
  .transform((form, ctx) => {
    const micros = microsFromDecimal(form.limit);
    if (micros === null || micros === "0") {
      ctx.addIssue({
        code: "custom",
        path: ["limit"],
        message: "limitInvalid",
      });
      return z.NEVER;
    }
    const days = form.windowDays.trim();
    if (form.period === "rolling" && !WINDOW_DAYS.test(days)) {
      ctx.addIssue({
        code: "custom",
        path: ["windowDays"],
        message: "windowDaysInvalid",
      });
      return z.NEVER;
    }
    return {
      scope: form.scope,
      enabled: form.enabled,
      period: form.period,
      ...(form.period === "rolling" ? { windowDays: Number(days) } : {}),
      // The store records ceilings in micro-USD (set_spend_budget).
      limit: { micros, currency: "USD" },
    };
  });

/** The field a refusal names, by the head of its path: the form's or the contract's. */
export function budgetFieldErrors(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): BudgetFieldErrors {
  const errors: BudgetFieldErrors = {};
  for (const issue of issues) {
    const head = String(issue.path[0] ?? "");
    if (head === "limit") errors.limit = "limitInvalid";
    if (head === "windowDays") errors.windowDays = "windowDaysInvalid";
  }
  return errors;
}

// ── The wrapped-session policy ───────────────────────────────────────────────

/** What the gateway dialog collects, as typed. */
export type GatewayPolicyFormValues = {
  mode: "observed" | "enforced";
  /** The per-session ceiling in US dollars, as typed; blank clears it. */
  sessionLimit: string;
  /** One model pattern per line; blank means no allowlist at all. */
  modelAllow: string;
  modelDeny: string;
};

type GatewayFormErrorKey =
  | "sessionLimitInvalid"
  | "modelPatternInvalid"
  | "nothingToEnforce";
export type GatewayFieldErrors = Partial<
  Record<
    "sessionLimit" | "modelAllow" | "modelDeny" | "mode",
    GatewayFormErrorKey
  >
>;

/**
 * What the host can actually apply: an exact model id, or one ending in `*`
 * to match by prefix. The contract carries the same rule. Refusing here is
 * what lets the field name the line that is wrong, rather than the dialog
 * reporting a whole-form refusal for one typo.
 */
const MODEL_PATTERN = /^(?:[A-Za-z0-9._:/-]+\*?|\*)$/;

/** A textarea's lines as a model list, blanks dropped. */
function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The gateway dialog's values as `update_tacho_session_policy` takes them.
 *
 * Two rules are enforced here as well as in the handler and the database,
 * because each layer answers a different reader. This one tells the person
 * which field to fix while they are still looking at it.
 *
 *   - A model pattern the host could not apply is refused, rather than saved
 *     as a rule that silently matches nothing.
 *   - `enforced` with no ceiling and no model list is refused. A policy that
 *     says it governs and governs nothing is the defect the gateway audit
 *     found, wearing a switch.
 *
 * An allowlist box left blank means *no allowlist*, so every model is
 * permitted. To permit nothing, deny `*`.
 */
export const GatewayPolicyForm = z
  .object({
    mode: z.enum(["observed", "enforced"]),
    sessionLimit: z.string(),
    modelAllow: z.string(),
    modelDeny: z.string(),
  })
  .transform((form, ctx) => {
    const typed = form.sessionLimit.trim();
    let sessionLimitUsd: number | null = null;
    if (typed.length > 0) {
      const parsed = Number(typed);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["sessionLimit"],
          message: "sessionLimitInvalid",
        });
        return z.NEVER;
      }
      sessionLimitUsd = parsed;
    }
    const allow = lines(form.modelAllow);
    const deny = lines(form.modelDeny);
    for (const [field, list] of [
      ["modelAllow", allow],
      ["modelDeny", deny],
    ] as const) {
      if (list.some((pattern) => !MODEL_PATTERN.test(pattern))) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "modelPatternInvalid",
        });
        return z.NEVER;
      }
    }
    // Blank is no allowlist, which is not the same as one that permits
    // nothing. The two reach the contract as null and [].
    const modelAllow = allow.length > 0 ? allow : null;
    if (
      form.mode === "enforced" &&
      sessionLimitUsd === null &&
      modelAllow === null &&
      deny.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["mode"],
        message: "nothingToEnforce",
      });
      return z.NEVER;
    }
    return {
      mode: form.mode,
      sessionLimitUsd,
      modelAllow,
      modelDeny: deny,
    };
  });

/** The field a refusal names, by the head of its path: the form's or the contract's. */
export function gatewayFieldErrors(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): GatewayFieldErrors {
  const errors: GatewayFieldErrors = {};
  for (const issue of issues) {
    const head = String(issue.path[0] ?? "");
    if (head === "sessionLimit" || head === "sessionLimitUsd")
      errors.sessionLimit = "sessionLimitInvalid";
    if (head === "modelAllow") errors.modelAllow = "modelPatternInvalid";
    if (head === "modelDeny") errors.modelDeny = "modelPatternInvalid";
    if (head === "mode") errors.mode = "nothingToEnforce";
  }
  return errors;
}

/** A calendar month as export_statement takes it. */
export function isStatementMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** A finding's public id as the finding contracts take it (`fnd_…`). */
export function isFindingId(value: string): boolean {
  return /^fnd_[0-9a-z]+$/.test(value);
}

// ── The price book's two writes ──────────────────────────────────────────────
//
// Each class uses the same form parser. The action combines validated classes
// into one atomic card before calling set_price_entry.

/** The values one `set_price_entry` call is built from, as typed. */
export type PriceEntryFormValues = {
  provider: string;
  model: string;
  /**
   * Optional, and the dialog no longer collects it. Nothing on the pricing
   * path resolves by region — a frame does not record the region it was served
   * from and `resolvePriceEntry` never reads `PriceEntry.region` — so a
   * regional row would be a candidate everywhere rather than in its region,
   * and `set_price_entry` refuses one. Kept in the shape, unset, so the field
   * returns here when resolution can honour it.
   */
  region?: string;
  /** Comma- or newline-separated; empty leaves the stored alias list alone. */
  modelAliases: string;
  /**
   * A UTC day (YYYY-MM-DD, read as its midnight) or an RFC 3339 instant;
   * empty is the write instant. The dialog sends an instant it took once for
   * the whole card, so every class of one submission starts together.
   */
  effectiveFrom: string;
  tokenClass: string;
  /** USD per one million units, as a person reads it off a contract. */
  usdPerMillion: string;
};

/** The values one `remove_price_entry` call is built from. */
export type RemovePriceEntryFormValues = {
  cancellationToken?: string;
  provider: string;
  model: string;
  region: string;
  tokenClass: string;
  /**
   * States the class may go UNPRICED, not list-priced, once this rate ends.
   * The dialog leaves this unset on the first submit; the handler refuses
   * with `price_entry_close_would_unprice` if a fallback is missing, and the
   * dialog resubmits with this set only after the person confirms.
   */
  confirmUnpriced?: boolean;
};

type PriceFormErrorKey =
  | "providerInvalid"
  | "modelInvalid"
  | "regionInvalid"
  | "aliasesInvalid"
  | "effectiveFromInvalid"
  | "tokenClassInvalid"
  | "rateInvalid";

/** The fields a refusal can name, whether the form refused it or the contract did. */
export type PriceFieldErrors = Partial<
  Record<
    | "provider"
    | "model"
    | "region"
    | "modelAliases"
    | "effectiveFrom"
    | "tokenClass"
    | "usdPerMillion",
    PriceFormErrorKey
  >
>;

/** A UTC calendar day, as `<input type="date">` writes it. */
const UTC_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/**
 * An RFC 3339 instant in UTC, as `Date#toISOString` writes it — the shape the
 * contract's `z.string().datetime()` takes. A day is widened to this; an
 * instant passes through unchanged.
 */
const UTC_INSTANT =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * USD per one million units as typed: digits, at most six decimal places (the
 * store records micro-USD, so a seventh would be dropped in silence) and no
 * grouping separator, sign or exponent. The ceiling matches the contract's own
 * typo guard.
 */
const USD_PER_MILLION = /^\d{1,7}(?:\.\d{1,6})?$/;
const USD_PER_MILLION_MAX = 1_000_000;

const PROVIDER_MAX = 128;
const MODEL_MAX = 256;
const REGION_MAX = 64;
const ALIASES_MAX = 32;

/** The alias list as the contract takes it: the names typed, separated by commas or newlines. */
function aliasesOf(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

function issue(
  ctx: z.RefinementCtx,
  path: string,
  message: PriceFormErrorKey,
): typeof z.NEVER {
  ctx.addIssue({ code: "custom", path: [path], message });
  return z.NEVER;
}

/**
 * One statement against the price book, read into the `set_price_entry` input.
 * `modelAliases` is sent only where the person typed one: an empty array would
 * REPLACE the stored list with nothing, which is a change nobody asked for.
 */
export const PriceEntryForm = z
  .object({
    provider: z.string(),
    model: z.string(),
    region: z.string().optional(),
    modelAliases: z.string(),
    effectiveFrom: z.string(),
    tokenClass: z.string(),
    usdPerMillion: z.string(),
  })
  .transform((form, ctx) => {
    const provider = form.provider.trim();
    if (provider.length === 0 || provider.length > PROVIDER_MAX)
      return issue(ctx, "provider", "providerInvalid");
    const model = form.model.trim();
    if (model.length === 0 || model.length > MODEL_MAX)
      return issue(ctx, "model", "modelInvalid");
    const region = (form.region ?? "").trim();
    if (region.length > REGION_MAX)
      return issue(ctx, "region", "regionInvalid");
    const aliases = aliasesOf(form.modelAliases);
    if (
      aliases.length > ALIASES_MAX ||
      aliases.some((alias) => alias.length > MODEL_MAX)
    )
      return issue(ctx, "modelAliases", "aliasesInvalid");
    const when = form.effectiveFrom.trim();
    const isDay = UTC_DAY.test(when);
    if (when.length > 0 && !isDay && !UTC_INSTANT.test(when))
      return issue(ctx, "effectiveFrom", "effectiveFromInvalid");
    // A calendar check the shape alone cannot make: `Date` rolls a 30 February
    // over into March rather than refusing it, so the day that comes back is
    // compared with the day typed.
    if (when.length > 0) {
      const parsed = new Date(when);
      if (
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== when.slice(0, 10)
      )
        return issue(ctx, "effectiveFrom", "effectiveFromInvalid");
    }
    const tokenClass = PriceTokenClass.safeParse(form.tokenClass);
    if (!tokenClass.success)
      return issue(ctx, "tokenClass", "tokenClassInvalid");
    const rate = form.usdPerMillion.trim();
    if (!USD_PER_MILLION.test(rate) || Number(rate) > USD_PER_MILLION_MAX)
      return issue(ctx, "usdPerMillion", "rateInvalid");
    return {
      provider,
      model,
      tokenClass: tokenClass.data,
      region: region.length === 0 ? null : region,
      ...(aliases.length === 0 ? {} : { modelAliases: aliases }),
      usdPerMillion: Number(rate),
      // A day the person named is read as its UTC midnight; an instant the
      // dialog took for the whole card passes through; the contract takes the
      // write instant when nothing is named.
      ...(when.length === 0
        ? {}
        : { effectiveFrom: isDay ? `${when}T00:00:00.000Z` : when }),
    };
  });

/** Ending one negotiated row: the key alone, since the instant is the call's. */
export const RemovePriceEntryForm = z
  .object({
    cancellationToken: z.string().max(4096).optional(),
    provider: z.string(),
    model: z.string(),
    region: z.string(),
    tokenClass: z.string(),
    confirmUnpriced: z.boolean().optional(),
  })
  .transform((form, ctx) => {
    const provider = form.provider.trim();
    if (provider.length === 0 || provider.length > PROVIDER_MAX)
      return issue(ctx, "provider", "providerInvalid");
    const model = form.model.trim();
    if (model.length === 0 || model.length > MODEL_MAX)
      return issue(ctx, "model", "modelInvalid");
    const region = form.region.trim();
    if (region.length > REGION_MAX)
      return issue(ctx, "region", "regionInvalid");
    const tokenClass = PriceTokenClass.safeParse(form.tokenClass);
    if (!tokenClass.success)
      return issue(ctx, "tokenClass", "tokenClassInvalid");
    return {
      ...(form.cancellationToken === undefined
        ? {}
        : { cancellationToken: form.cancellationToken }),
      provider,
      model,
      tokenClass: tokenClass.data,
      region: region.length === 0 ? null : region,
      ...(form.confirmUnpriced === true ? { confirmUnpriced: true } : {}),
    };
  });

/** The field a refusal names, by the head of its path: the form's or the contract's. */
export function priceFieldErrors(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): PriceFieldErrors {
  const errors: PriceFieldErrors = {};
  for (const raw of issues) {
    switch (String(raw.path[0] ?? "")) {
      case "provider":
        errors.provider = "providerInvalid";
        break;
      case "model":
        errors.model = "modelInvalid";
        break;
      case "region":
        errors.region = "regionInvalid";
        break;
      case "modelAliases":
        errors.modelAliases = "aliasesInvalid";
        break;
      case "effectiveFrom":
        errors.effectiveFrom = "effectiveFromInvalid";
        break;
      case "tokenClass":
        errors.tokenClass = "tokenClassInvalid";
        break;
      case "usdPerMillion":
        errors.usdPerMillion = "rateInvalid";
        break;
      default:
        break;
    }
  }
  return errors;
}
