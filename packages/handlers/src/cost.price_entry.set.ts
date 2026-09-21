// `set_price_entry` (ADR-060 §1): write this organization's negotiated rate
// for one model and token class into `cost.price_entries`.
//
// This is a privileged commercial mutation — it changes what every run in the
// organization is billed at — so it is NOT audit-exempt. `billing.plan_changed`
// is the taxonomy's "this organization's commercial terms moved" event, the
// same one `set_org_billing_terms` emits; no price-book-specific type exists
// and inventing one here is exactly what the audit-coverage guard forbids.
//
// The role gate runs in the handler rather than resting on the contract's
// `defaultRoles`, because the kernel's IAM check allows every capability for a
// non-enterprise organization (INV-29, apps/app/ARCHITECTURE.md §3.2). An
// API-key call acts as the key's creator, bounded by that user's current org
// role.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  costPriceEntrySet,
  type CostPriceEntrySetOutput,
} from "@oxagen/oxagen/contracts/cost.price_entry.set";
import {
  setNegotiatedPriceEntry,
  setNegotiatedPriceCard,
  usdPerMillionToMicros,
  type NegotiatedPriceWrite,
  type SetNegotiatedPriceEntryArgs,
} from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { HandlerError } from "@oxagen/oxagen";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { assertDataPlaneUsable, resolveDataPlane } from "@oxagen/tenancy";
import { logger } from "./logger";
import { toPriceEntryDto } from "./lib/price-entry-dto";

export type PriceEntrySetDeps = {
  setNegotiatedPriceCard?: typeof setNegotiatedPriceCard;
  setNegotiatedPriceEntry: (
    args: SetNegotiatedPriceEntryArgs,
  ) => Promise<NegotiatedPriceWrite>;
};

export function createPriceEntrySetHandler(
  deps: PriceEntrySetDeps,
): CapabilityHandler<typeof costPriceEntrySet> {
  return async (input, ctx): Promise<CostPriceEntrySetOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin", "Billing"] },
    );

    // ── The write and the read must land on the same Postgres ─────────────
    //
    // `setNegotiatedPriceEntry` is a tenant write and runs on `withTenantDb`,
    // which resolves the organisation's plane. `loadPriceBook` — the read the
    // rollup prices every frame through — runs on `withSystemDb`, which is
    // shared-plane by construction. For an organisation bound to a dedicated
    // plane those are two different databases: the negotiated rate would be
    // accepted, stored, listed back to the customer, and then never applied to
    // a single run, which is worse than refusing it, because the customer has
    // no way to see that it did nothing.
    //
    // Making the price book plane-aware is a change to the store seam and to
    // the hourly list-price sync (which seeds the shared plane only), not this
    // handler's to make. So it refuses, the way `get_evidence_retention`
    // refuses the same ADR-042 gap. Every organisation is shared today
    // (ADR-042 §1), so nothing in service reaches this.
    const plane = await resolveDataPlane(ctx.orgId, "postgres");
    if (plane.mode !== "shared") {
      logger.error(
        { orgId: ctx.orgId, planeMode: plane.mode },
        "cost.price_entry.set: refused — the price book is read from the shared plane only",
      );
      // A plain Error, not a HandlerError: nothing the caller did is wrong and
      // nothing about their tenant forbids the write. The platform has a gap,
      // which is a 5xx at every surface.
      throw new Error(
        "set_price_entry cannot write a negotiated rate for an organisation on a dedicated " +
          "Postgres plane: cost.price_entries is written through withTenantDb but read by " +
          "loadPriceBook through withSystemDb, so the rate would be stored where the cost " +
          "rollup never looks and every run would stay list-priced.",
      );
    }
    // Throws DataPlaneUnavailableError for any binding that is not active.
    assertDataPlaneUsable(plane);

    // ── A regional rate would win outside its region ──────────────────────
    //
    // `price_entries` keys on region and `readEntriesForOrg` can filter by it,
    // but nothing on the pricing path carries one: a frame does not record the
    // region it was served from, and `resolvePriceEntry` never reads
    // `PriceEntry.region`, so a row written for `eu-west-1` is simply a
    // candidate everywhere, competing with the region-agnostic row on
    // effective date alone. Accepting the field would let a customer configure
    // commercial terms that silently apply to the wrong traffic — and a wrong
    // price that looks configured is harder to find than one that was refused.
    //
    // The column stays, because the store is right to key on it. What is
    // refused is offering the customer a lever that does not yet connect to
    // anything.
    if (input.region != null) {
      throw new HandlerError({
        code: "conflict",
        reason: "price_entry_region_unsupported",
        message:
          "a region-specific negotiated rate cannot be recorded yet: cost frames do not carry the region they were served from, so the rate would apply to every region rather than to this one. Omit `region` to set the rate for all traffic.",
      });
    }

    // An omitted `effectiveFrom` is the write instant, and the store reads
    // that under its advisory locks rather than taking one sampled here: the
    // lock wait is unbounded, and a clock read before it is stale by the time
    // the shipped-window check runs. The instant the store used comes back
    // on the written entry.
    const effectiveFrom =
      input.effectiveFrom === undefined
        ? undefined
        : new Date(input.effectiveFrom);

    // The customer states the contracted price the way the contract reads it
    // — USD per one million units — and the store records integer micro-USD.
    const args: SetNegotiatedPriceEntryArgs = {
      orgId: ctx.orgId,
      provider: input.provider,
      model: input.model,
      tokenClass: input.tokenClass,
      region: null,
      // Passed through as `undefined` when the caller omitted it, NEVER
      // coerced to `[]`. Both the app and the CLI omit this field when the
      // operator types no aliases, so coercing it made every correction to an
      // existing rate silently erase the stored alias list — after which every
      // frame arriving under one of those names stopped matching and fell back
      // to list pricing or to unpriced. `[]` means "this model has no aliases";
      // omission means "do not touch them", and the store honours the
      // difference.
      modelAliases: input.modelAliases,
      microsPerMillion: usdPerMillionToMicros(input.usdPerMillion),
      effectiveFrom,
    };
    const rates = [
      { tokenClass: input.tokenClass, microsPerMillion: args.microsPerMillion },
      ...(input.additionalRates ?? []).map((rate) => ({
        tokenClass: rate.tokenClass,
        microsPerMillion: usdPerMillionToMicros(rate.usdPerMillion),
      })),
    ];
    if (new Set(rates.map((rate) => rate.tokenClass)).size !== rates.length) {
      throw new HandlerError({
        code: "conflict",
        reason: "duplicate_price_class",
      });
    }
    const writes = input.additionalRates
      ? await (deps.setNegotiatedPriceCard ?? setNegotiatedPriceCard)({
          ...args,
          rates,
        })
      : [await deps.setNegotiatedPriceEntry(args)];
    const [written, ...additional] = writes;
    if (!written) throw new Error("Price card returned no entries");

    // ── Audit (SOC 2 CC6.3) ───────────────────────────────────────────────
    // Fire-and-forget, like every other kernel-path emit: an audit row that
    // cannot be written must not fail a write that already committed. The
    // structured log carries the previous price so an auditor can reconstruct
    // the change; the security_events row is the tamper-evident marker.
    emitSecurityEvent({
      eventType: "billing.plan_changed",
      actorUserId: actingUserId,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: costPriceEntrySet.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    logger.info(
      {
        orgId: ctx.orgId,
        actorUserId: actingUserId,
        provider: input.provider,
        model: input.model,
        tokenClass: input.tokenClass,
        region: null,
        previousMicrosPerMillion:
          written.closed === null
            ? null
            : written.closed.microsPerMillion.toString(),
        microsPerMillion: written.entry.microsPerMillion.toString(),
        additionalRates: additional.map((write) => ({
          tokenClass: write.entry.tokenClass,
          microsPerMillion: write.entry.microsPerMillion.toString(),
          previousMicrosPerMillion:
            write.closed?.microsPerMillion.toString() ?? null,
        })),
        effectiveFrom: written.entry.effectiveFrom.toISOString(),
        surface: ctx.surface,
      },
      "cost.price_entry.set: negotiated price written",
    );

    return {
      ...(input.additionalRates
        ? {
            additionalEntries: additional.map((write) => ({
              entry: toPriceEntryDto(write.entry),
              closed:
                write.closed === null ? null : toPriceEntryDto(write.closed),
            })),
          }
        : {}),
      entry: toPriceEntryDto(written.entry),
      closed: written.closed === null ? null : toPriceEntryDto(written.closed),
    };
  };
}

export const priceEntrySetHandler = createPriceEntrySetHandler({
  setNegotiatedPriceEntry,
});
