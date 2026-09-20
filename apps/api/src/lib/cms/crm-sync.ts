/**
 * Push a captured website lead into the CRM (Attio).
 *
 * Postgres (cms.leads) stays the record: the form handler writes the row,
 * answers the visitor, and only then hands the lead id here. A CRM outage
 * therefore never costs a lead or slows the form. What the CRM has seen is
 * written back to the row (`crm_record_id`, `crm_synced_at`,
 * `crm_sync_error`), so a lead the sync missed is visible in the table and
 * `pnpm --filter @oxagen/api cms:crm-backfill` picks it up.
 *
 * One lead becomes, in Attio:
 *   - a company, asserted by the email domain, unless the domain is a
 *     consumer mailbox (gmail.com and friends), where a company record would
 *     only be noise;
 *   - a person, asserted by email, linked to that company;
 *   - a note on the person carrying everything the form said that Attio has
 *     no attribute for: source, page, message, tracking code, company size,
 *     referral source, location, consent;
 *   - for a lead who asked for the book and consented to marketing contact,
 *     an entry on the "Inbound lead nurture" list with Asset set to each
 *     edition they requested (read from their access codes) and Branch left
 *     blank, which is what the nurture sequence's day-3 job fills in. A
 *     second form appends its asset; it never resets the entry. A lead who
 *     withdraws consent on a later form is taken off the list.
 *
 * Person and company asserts are idempotent, so a retry cannot duplicate
 * them. A note is a new object each time, so a resubmitted form adds a new
 * note, which is what a sales rep wants to see ("they came back").
 */

import {
  schema,
  withSystemDb,
  type EditionSlug,
  type Tx,
} from "@oxagen/database";
import { and, eq, isNull, asc, getTableColumns, sql } from "drizzle-orm";
import { logger } from "../../middleware/logger";
import {
  createAttioClient,
  type AttioClient,
  type AttioPersonInput,
} from "./attio";

const { leads, bookAccessCodes } = schema;

/** The Attio list the nurture sequence reads (People object). */
export const NURTURE_LIST_SLUG = "inbound_lead_nurture";
/** Its id: the record-entries endpoint reports lists by id, not slug. */
export const NURTURE_LIST_ID = "657c389d-5dc4-4518-a81c-caea59cd7923";

/**
 * The list's `asset` options, by edition. These are the option titles as
 * created in Attio; a new gated asset is a new option there and a new row
 * here.
 */
export const ASSET_TITLES: Record<EditionSlug, string> = {
  "field-manual": "Field manual",
  "page-flip-reader": "Page-flip reader",
};

/** Mailbox providers whose domain names a mailbox, not an employer. */
export const CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "fastmail.com",
  "hey.com",
  "zoho.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "126.com",
]);

/** Longest error text the row keeps; the log line carries the full one. */
const MAX_ERROR_LENGTH = 500;

export type LeadRecord = typeof leads.$inferSelect;

export type CrmSyncResult =
  | { status: "synced"; leadId: string; recordId: string }
  | {
      status: "skipped";
      leadId: string;
      reason: "not_configured" | "not_found" | "resubmitted";
    }
  | { status: "failed"; leadId: string; error: string };

export function isCrmSyncConfigured(): boolean {
  return Boolean(process.env.ATTIO_API_KEY);
}

let _client: AttioClient | null = null;

function defaultClient(): AttioClient | null {
  const apiKey = process.env.ATTIO_API_KEY;
  if (!apiKey) return null;
  if (!_client) _client = createAttioClient({ apiKey });
  return _client;
}

/** Test seam: drop the cached client so a changed env takes effect. */
export function __resetCrmClientForTests(): void {
  _client = null;
}

/** The part of the address after `@`, lowercased; null if there is none. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Attio parses `original_phone_number` and rejects the whole person assert
 * when it cannot, so only an unambiguous E.164 number is forwarded. Anything
 * else still reaches the CRM in the note.
 */
export function e164OrNull(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const compact = phone.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
}

/** Company name for the assert: what the form said, else the domain itself. */
export function companyNameFor(lead: LeadRecord, domain: string): string {
  return lead.company?.trim() || domain;
}

/** The plaintext note Attio shows on the person. */
export function buildLeadNote(lead: LeadRecord): {
  title: string;
  content: string;
} {
  const source = lead.source ?? "website";
  const lines: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) lines.push(`${label}: ${value.trim()}`);
  };
  add("Source", source);
  add("Page", lead.pagePath);
  add("Company", lead.company);
  add("Company size", lead.companySize);
  add("Role", lead.jobTitle);
  add("Phone", lead.mobilePhone);
  add(
    "Address",
    [lead.address1, lead.address2].filter(Boolean).join(", ") || null,
  );
  add(
    "Location",
    [lead.city, lead.state, lead.country].filter(Boolean).join(", ") || null,
  );
  add("Heard about us via", lead.referralSource?.replace(/_/g, " "));
  add("Tracking code", lead.trackingCode);
  lines.push(`Marketing consent: ${lead.marketingConsent ? "yes" : "no"}`);
  add("Submitted", lead.updatedAt.toISOString());
  if (lead.message?.trim()) {
    lines.push("", "What they are building:", lead.message.trim());
  }
  return {
    title: `Website lead: ${source}`,
    content: lines.join("\n"),
  };
}

/** Every edition this lead has been issued a code for, in Attio's titles. */
async function loadRequestedAssets(tx: Tx, leadId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ edition: bookAccessCodes.lastEditionSlug })
    .from(bookAccessCodes)
    .where(eq(bookAccessCodes.leadId, leadId));
  const titles = new Set<string>();
  for (const { edition } of rows) {
    if (edition && edition in ASSET_TITLES) {
      titles.add(ASSET_TITLES[edition as EditionSlug]);
    }
  }
  return [...titles].sort();
}

type LeadSnapshot = LeadRecord & { revision: string };

async function loadLead(tx: Tx, leadId: string): Promise<LeadSnapshot | null> {
  const [row] = await tx
    .select({
      ...getTableColumns(leads),
      // Preserve Postgres microseconds that a JavaScript Date would lose.
      revision: sql<string>`${leads.updatedAt}::text`,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return row ?? null;
}

async function recordOutcome(
  tx: Tx,
  lead: LeadSnapshot,
  outcome: { recordId: string } | { error: string },
): Promise<boolean> {
  const rows = await tx
    .update(leads)
    .set(
      "recordId" in outcome
        ? {
            crmRecordId: outcome.recordId,
            crmSyncedAt: new Date(),
            crmSyncError: null,
          }
        : { crmSyncError: outcome.error.slice(0, MAX_ERROR_LENGTH) },
    )
    .where(
      and(
        eq(leads.id, lead.id),
        sql`${leads.updatedAt} = ${lead.revision}::timestamptz`,
      ),
    )
    .returning({ id: leads.id });
  return rows.length > 0;
}

/**
 * Sync one lead. Never throws: the outcome is returned and written to the
 * row, and a failure is logged with the full error.
 */
export async function syncLeadToCrm(
  leadId: string,
  client: AttioClient | null = defaultClient(),
): Promise<CrmSyncResult> {
  if (!client) return { status: "skipped", leadId, reason: "not_configured" };
  try {
    // Serialize CRM writers across processes without locking the submission
    // row while Attio responds. A newer sync cannot be overwritten by an
    // older sync after it has already marked the lead as delivered.
    return await withSystemDb(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`cms-crm:${leadId}`}, 0))`,
      );
      return syncLeadSnapshot(tx, leadId, client);
    });
  } catch (err) {
    logger.error({ err, leadId }, "[cms] crm sync transaction failed");
    return { status: "failed", leadId, error: errorText(err) };
  }
}

async function syncLeadSnapshot(
  tx: Tx,
  leadId: string,
  client: AttioClient,
): Promise<CrmSyncResult> {
  let lead: LeadSnapshot | null;
  let assets: string[];
  try {
    lead = await loadLead(tx, leadId);
    assets = lead ? await loadRequestedAssets(tx, leadId) : [];
  } catch (err) {
    logger.error({ err, leadId }, "[cms] crm sync could not load the lead");
    return { status: "failed", leadId, error: errorText(err) };
  }
  if (!lead) return { status: "skipped", leadId, reason: "not_found" };

  try {
    const domain = emailDomain(lead.email);
    let companyRecordId: string | null = null;
    if (domain && !CONSUMER_EMAIL_DOMAINS.has(domain)) {
      const company = await client.assertCompany({
        domain,
        name: companyNameFor(lead, domain),
      });
      companyRecordId = company.recordId;
    }

    const person: AttioPersonInput = {
      email: lead.email,
      firstName: lead.firstName,
      lastName: lead.lastName,
      jobTitle: lead.jobTitle,
      phone: e164OrNull(lead.mobilePhone),
      companyRecordId,
    };
    const { recordId } = await client.assertPerson(person);

    const note = buildLeadNote(lead);
    await client.createNote({
      parentObject: "people",
      parentRecordId: recordId,
      ...note,
    });

    // A demo request is a conversation, not a nurture; only book leads join
    // the list, and only with consent. Assert first (keeps an existing
    // entry intact), then append. A lead who has opted out is taken off the
    // list, so a consent withdrawn on a later form is honoured too.
    if (!lead.marketingConsent) {
      await client.removeListEntry({
        listId: NURTURE_LIST_ID,
        listSlug: NURTURE_LIST_SLUG,
        parentObject: "people",
        parentRecordId: recordId,
      });
    } else if (assets.length > 0) {
      const { entryId } = await client.assertListEntry({
        list: NURTURE_LIST_SLUG,
        parentObject: "people",
        parentRecordId: recordId,
      });
      await client.appendListEntryValues({
        list: NURTURE_LIST_SLUG,
        entryId,
        values: { asset: assets },
      });
    }

    if (!(await recordOutcome(tx, lead, { recordId }))) {
      return { status: "skipped", leadId, reason: "resubmitted" };
    }
    logger.info({ leadId, recordId }, "[cms] lead synced to crm");
    return { status: "synced", leadId, recordId };
  } catch (err) {
    const error = errorText(err);
    logger.error({ err, leadId }, "[cms] crm sync failed");
    try {
      await recordOutcome(tx, lead, { error });
    } catch (writeErr) {
      logger.error(
        { err: writeErr, leadId },
        "[cms] crm sync could not record its failure",
      );
    }
    return { status: "failed", leadId, error };
  }
}

/**
 * Fire-and-forget entry point for the request path: the visitor has already
 * been answered, so nothing here may throw into the route. `syncLeadToCrm`
 * already contains its errors; the catch is for the promise machinery itself.
 */
export function queueCrmSync(leadId: string): void {
  if (!isCrmSyncConfigured()) return;
  void syncLeadToCrm(leadId).catch((err: unknown) => {
    logger.error({ err, leadId }, "[cms] crm sync rejected unexpectedly");
  });
}

/**
 * Re-sync every lead the CRM has not confirmed, oldest first. Used by the
 * backfill script; returns the per-lead outcomes so the script can report.
 */
export async function syncPendingLeads(
  opts: { limit?: number; client?: AttioClient | null } = {},
): Promise<CrmSyncResult[]> {
  const limit = opts.limit ?? 500;
  const pending = await withSystemDb(async (tx) =>
    tx
      .select({ id: leads.id })
      .from(leads)
      .where(isNull(leads.crmSyncedAt))
      .orderBy(asc(leads.createdAt))
      .limit(limit),
  );
  const results: CrmSyncResult[] = [];
  for (const row of pending) {
    results.push(await syncLeadToCrm(row.id, opts.client ?? defaultClient()));
  }
  return results;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
