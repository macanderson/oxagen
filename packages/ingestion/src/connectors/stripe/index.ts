import { z } from "zod";
import {
  registerConnector,
  type AuthCredential,
  type ConnectorDefinition,
  type NormalizedRecord,
  type RawRecord,
  type RecordTypeSample,
} from "../types";

/**
 * This is a customer's OWN Stripe account ingested as business entities —
 * customers, charges, refunds, subscriptions, invoices and disputes become
 * nodes in their workspace graph so an agent can reason and act over them.
 *
 * It is unrelated to `packages/billing`, which is how Oxagen bills its own
 * customers through Oxagen's Stripe account. Nothing here may import or reach
 * into `@oxagen/billing`, and none of the `STRIPE_*` env vars that package
 * reads apply: this connector's key arrives per-connection through the
 * AuthCredential seam, never from the environment.
 */

const connectionConfigSchema = z.object({
  syncDepthDays: z.number().int().positive().default(90),
  pageSize: z.number().int().min(1).max(100).default(100),
  stripeAccount: z.string().optional(),
});

type Config = typeof connectionConfigSchema;

const STRIPE_API_BASE = "https://api.stripe.com/v1";

// Record type → Stripe list resource. Every one of these supports the same
// `created[gt]` + `starting_after` list protocol, so one poll body serves all.
const RESOURCE_PATH: Record<string, string> = {
  customer: "customers",
  charge: "charges",
  refund: "refunds",
  subscription: "subscriptions",
  invoice: "invoices",
  dispute: "disputes",
};

/**
 * Stripe secret (`sk_`) and restricted (`rk_`) keys are sent as bearer tokens.
 * Only the prefix is checked here: the key's suffix format is Stripe's to
 * change, and the user-facing format check — the one that catches a publishable
 * `pk_` key pasted into the field — lives in schema.yaml where it can report a
 * validation error at connect time instead of failing a poll.
 *
 * A restricted key with read scopes on the six resources below is the
 * recommended credential; the connector never writes.
 */
function stripeApiKey(auth: AuthCredential): string | null {
  if (auth.scheme !== "api_key") return null;
  return /^(sk|rk)_/.test(auth.apiKey) ? auth.apiKey : null;
}

/** Stripe stamps every object's `created` as Unix epoch seconds. */
function epochToIso(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds))
    return undefined;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Durable cursors are ISO-8601; Stripe's `created[gt]` filter wants epoch seconds. */
function isoToEpoch(cursor: string): number | null {
  const t = new Date(cursor).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object"
    ? (raw as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Dashboard deep link for an object whose dashboard route is unambiguous. */
function dashboardUrl(
  section: string,
  id: string | undefined,
): string | undefined {
  return id ? `https://dashboard.stripe.com/${section}/${id}` : undefined;
}

const stripe: ConnectorDefinition<Config> = {
  connectorId: "stripe",
  displayName: "Stripe",
  description:
    "Sync customers, charges, refunds, subscriptions, invoices, and disputes from Stripe.",
  icon: "stripe",
  supportedAuthSchemes: ["api_key"],
  deliveryMethod: "rest_polling",
  defaultPollIntervalSeconds: 900,
  connectionConfigSchema,

  async previewRecordTypes(_auth, _config): Promise<RecordTypeSample[]> {
    throw new Error("stripe.previewRecordTypes: not yet implemented");
  },

  /**
   * Money is reported as `amountMinor` — the currency's smallest unit, exactly
   * as Stripe returns it (2000 = $20.00 USD, but 2000 = ¥2000 JPY). The name
   * carries the unit because a decision rule that reads this field to approve
   * a refund would be wrong by a factor of 100 if it read a bare `amount` and
   * assumed dollars. Convert against `currency` at the point of use.
   */
  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord {
    const r = asRecord(raw);
    const id = asString(r["id"]) ?? "";

    switch (sourceRecordType) {
      case "customer": {
        const address = asRecord(r["address"]);
        return {
          externalId: id,
          externalUrl: dashboardUrl("customers", id || undefined),
          displayName: asString(r["name"]) ?? asString(r["email"]) ?? id,
          properties: {
            name: asString(r["name"]),
            email: asString(r["email"]),
            phone: asString(r["phone"]),
            description: asString(r["description"]),
            currency: asString(r["currency"]),
            balanceMinor: r["balance"],
            delinquent: r["delinquent"],
            city: asString(address["city"]),
            country: asString(address["country"]),
            livemode: r["livemode"],
            metadata: r["metadata"],
            createdAt: epochToIso(r["created"]),
          },
        };
      }

      case "charge": {
        return {
          externalId: id,
          externalUrl: dashboardUrl("payments", id || undefined),
          displayName: asString(r["description"]) ?? `Charge ${id}`,
          properties: {
            description: asString(r["description"]),
            amountMinor: r["amount"],
            amountCapturedMinor: r["amount_captured"],
            amountRefundedMinor: r["amount_refunded"],
            currency: asString(r["currency"]),
            status: asString(r["status"]),
            paid: r["paid"],
            captured: r["captured"],
            refunded: r["refunded"],
            disputed: r["disputed"],
            customerId: asString(r["customer"]),
            paymentIntentId: asString(r["payment_intent"]),
            receiptEmail: asString(r["receipt_email"]),
            failureCode: asString(r["failure_code"]),
            failureMessage: asString(r["failure_message"]),
            createdAt: epochToIso(r["created"]),
          },
        };
      }

      case "refund": {
        // A refund has no dashboard page of its own — it is shown on the
        // payment it reverses, so that is what externalUrl points at.
        const chargeId = asString(r["charge"]);
        return {
          externalId: id,
          externalUrl: dashboardUrl("payments", chargeId),
          displayName: `Refund ${id}`,
          properties: {
            amountMinor: r["amount"],
            currency: asString(r["currency"]),
            status: asString(r["status"]),
            reason: asString(r["reason"]),
            chargeId,
            paymentIntentId: asString(r["payment_intent"]),
            receiptNumber: asString(r["receipt_number"]),
            failureReason: asString(r["failure_reason"]),
            createdAt: epochToIso(r["created"]),
          },
        };
      }

      case "subscription": {
        const items = asRecord(r["items"]);
        const lines = asArray(items["data"]).map((i) => asRecord(i));
        return {
          externalId: id,
          externalUrl: dashboardUrl("subscriptions", id || undefined),
          displayName: `Subscription ${id}`,
          properties: {
            status: asString(r["status"]),
            customerId: asString(r["customer"]),
            currency: asString(r["currency"]),
            collectionMethod: asString(r["collection_method"]),
            priceIds: lines
              .map((l) => asString(asRecord(l["price"])["id"]))
              .filter(Boolean),
            quantity: lines[0]?.["quantity"],
            cancelAtPeriodEnd: r["cancel_at_period_end"],
            startDate: epochToIso(r["start_date"]),
            currentPeriodStart: epochToIso(r["current_period_start"]),
            currentPeriodEnd: epochToIso(r["current_period_end"]),
            trialStart: epochToIso(r["trial_start"]),
            trialEnd: epochToIso(r["trial_end"]),
            canceledAt: epochToIso(r["canceled_at"]),
            createdAt: epochToIso(r["created"]),
          },
        };
      }

      case "invoice": {
        return {
          externalId: id,
          // The hosted invoice page is the customer-facing view and is the more
          // useful link when Stripe provides one.
          externalUrl:
            asString(r["hosted_invoice_url"]) ??
            dashboardUrl("invoices", id || undefined),
          displayName: asString(r["number"]) ?? `Invoice ${id}`,
          properties: {
            number: asString(r["number"]),
            status: asString(r["status"]),
            currency: asString(r["currency"]),
            totalMinor: r["total"],
            subtotalMinor: r["subtotal"],
            amountDueMinor: r["amount_due"],
            amountPaidMinor: r["amount_paid"],
            amountRemainingMinor: r["amount_remaining"],
            paid: r["paid"],
            customerId: asString(r["customer"]),
            customerEmail: asString(r["customer_email"]),
            subscriptionId: asString(r["subscription"]),
            invoicePdf: asString(r["invoice_pdf"]),
            dueDate: epochToIso(r["due_date"]),
            periodStart: epochToIso(r["period_start"]),
            periodEnd: epochToIso(r["period_end"]),
            createdAt: epochToIso(r["created"]),
          },
        };
      }

      case "dispute": {
        const evidence = asRecord(r["evidence_details"]);
        return {
          externalId: id,
          externalUrl: dashboardUrl("disputes", id || undefined),
          displayName: `Dispute ${id}`,
          properties: {
            amountMinor: r["amount"],
            currency: asString(r["currency"]),
            status: asString(r["status"]),
            reason: asString(r["reason"]),
            chargeId: asString(r["charge"]),
            paymentIntentId: asString(r["payment_intent"]),
            isChargeRefundable: r["is_charge_refundable"],
            evidenceDueBy: epochToIso(evidence["due_by"]),
            createdAt: epochToIso(r["created"]),
          },
        };
      }

      default:
        throw new Error(
          `stripe.normalizeRecord: unknown sourceRecordType "${sourceRecordType}"`,
        );
    }
  },

  /**
   * Incremental list poll. Filters on `created[gt]` (epoch seconds derived from
   * the durable ISO cursor) and walks Stripe's `starting_after` pagination.
   *
   * Every page of the window is drained rather than capping the page count.
   * Stripe returns lists newest-first and the sync loop persists MAX(cursorOf)
   * across the whole batch, so stopping early would advance the cursor past
   * older records that were never yielded and lose them permanently. The
   * `created[gt]` filter is what bounds the work instead: the first poll reaches
   * back only `syncDepthDays`, and every later poll sees one interval of change.
   * The loop still exits if a page comes back empty or its last id repeats, so
   * a misbehaving `has_more` cannot spin it forever.
   */
  async *poll(auth, config, recordType, cursor): AsyncIterable<RawRecord> {
    const apiKey = stripeApiKey(auth);
    if (!apiKey) return;

    const path = RESOURCE_PATH[recordType];
    if (!path) return; // not a pollable record type

    const since =
      cursor !== null
        ? isoToEpoch(cursor)
        : Math.floor(Date.now() / 1000) - config.syncDepthDays * 86_400;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    // Connected-account reads are scoped by this header rather than a distinct key.
    if (config.stripeAccount) headers["Stripe-Account"] = config.stripeAccount;

    const now = new Date().toISOString();
    let startingAfter: string | undefined;

    for (;;) {
      const params = new URLSearchParams({ limit: String(config.pageSize) });
      if (since !== null) params.set("created[gt]", String(since));
      if (startingAfter) params.set("starting_after", startingAfter);

      const resp = await fetch(
        `${STRIPE_API_BASE}/${path}?${params.toString()}`,
        { headers },
      );
      if (!resp.ok) {
        // 429 (rate limited) and 401 (bad key) both surface here as a thrown
        // poll failure, which is what degrades the connection's health.
        throw new Error(
          `stripe.poll: list API ${resp.status} for ${recordType}`,
        );
      }
      const json = (await resp.json()) as {
        data?: Array<Record<string, unknown>>;
        has_more?: boolean;
      };
      const data = json.data ?? [];

      for (const item of data) {
        const itemId = asString(item["id"]);
        if (!itemId) continue;
        yield {
          sourceRecordType: recordType,
          externalId: itemId,
          raw: item,
          receivedAt: now,
        };
      }

      const lastId = asString(data[data.length - 1]?.["id"]);
      if (json.has_more !== true || !lastId || lastId === startingAfter) return;
      startingAfter = lastId;
    }
  },

  // Cursor watermark: Stripe's `created`, converted from epoch seconds to
  // ISO-8601 so it sorts as a string like every other connector's cursor.
  cursorOf(_recordType, raw): string | null {
    return epochToIso(asRecord(raw)["created"]) ?? null;
  },
};

registerConnector(stripe);

export { stripe };
