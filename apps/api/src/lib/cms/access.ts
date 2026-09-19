/**
 * Core logic for the public ebook lead gate (POST /v1/cms/*).
 *
 * Enforcement lives here, not in the routes: leads are upserted, single-use
 * access codes are minted/rotated, and codes are redeemed under a row lock so
 * "the same link can't be used twice" holds even under concurrent opens.
 *
 * Every DB touch goes through withSystemDb — cms.* tables are non-tenant and
 * carry bypass-only RLS, so this audited system bypass is the sole access path.
 */

import {
  schema,
  withSystemDb,
  type Tx,
  BOOK_SLUG,
  EDITION_SLUGS,
  type EditionSlug,
  type CompanySize,
  type ReferralSource,
  type CodeIssueReason,
} from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import { isProductionRuntime } from "@oxagen/config/env";

const { leads, bookEditions, bookAccessCodes } = schema;

// Crockford base32 (no I/L/O/U — unambiguous), 26 chars ≈ 130 bits of entropy.
// URL-safe and case-insensitive (the column is citext), so a link survives a
// mail client lowercasing it.
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
export function generateAccessCode(length = 26): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b % 32];
  return out;
}

/** True when `slug` is a known edition. Narrows to EditionSlug. */
export function isEditionSlug(slug: string): slug is EditionSlug {
  return (EDITION_SLUGS as readonly string[]).includes(slug);
}

/** Marketing website origin used to build the emailed reader link. */
export function resolveMarketingUrl(): string {
  const configured = process.env.MARKETING_URL?.replace(/\/$/, "");
  if (configured) return configured;
  return isProductionRuntime() ? "https://oxagen.sh" : "http://localhost:8080";
}

/** The single-use reader URL emailed to a lead. */
export function readerUrl(edition: EditionSlug, code: string): string {
  return `${resolveMarketingUrl()}/read?e=${encodeURIComponent(edition)}&c=${encodeURIComponent(code)}`;
}

export interface LeadInput {
  email: string;
  firstName: string;
  lastName: string;
  jobTitle?: string | null;
  company?: string | null;
  companySize?: CompanySize | null;
  mobilePhone?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
  address1?: string | null;
  address2?: string | null;
  referralSource?: ReferralSource | null;
  trackingCode?: string | null;
  source?: string | null;
  pagePath?: string | null;
  message?: string | null;
  marketingConsent?: boolean;
}

export interface LeadRow {
  id: string;
  email: string;
}

/**
 * Upsert a lead by email (the natural key). Re-submitting updates the profile
 * with any newly-supplied non-null fields rather than creating a duplicate.
 * Runs inside the caller's tx so lead upsert + code mint share one transaction.
 */
async function upsertLeadTx(tx: Tx, input: LeadInput): Promise<LeadRow> {
  // Only overwrite columns the caller actually provided (COALESCE keeps prior
  // values when a later submission omits a field).
  const [row] = await tx
    .insert(leads)
    .values({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      jobTitle: input.jobTitle ?? null,
      company: input.company ?? null,
      companySize: input.companySize ?? null,
      mobilePhone: input.mobilePhone ?? null,
      country: input.country ?? null,
      state: input.state ?? null,
      city: input.city ?? null,
      address1: input.address1 ?? null,
      address2: input.address2 ?? null,
      referralSource: input.referralSource ?? null,
      trackingCode: input.trackingCode ?? null,
      source: input.source ?? null,
      pagePath: input.pagePath ?? null,
      message: input.message ?? null,
      marketingConsent: input.marketingConsent ?? true,
    })
    .onConflictDoUpdate({
      target: leads.email,
      set: {
        firstName: input.firstName,
        lastName: input.lastName,
        jobTitle: sql`COALESCE(${input.jobTitle ?? null}, ${leads.jobTitle})`,
        company: sql`COALESCE(${input.company ?? null}, ${leads.company})`,
        companySize: sql`COALESCE(${input.companySize ?? null}::cms.company_size, ${leads.companySize})`,
        mobilePhone: sql`COALESCE(${input.mobilePhone ?? null}, ${leads.mobilePhone})`,
        country: sql`COALESCE(${input.country ?? null}, ${leads.country})`,
        state: sql`COALESCE(${input.state ?? null}, ${leads.state})`,
        city: sql`COALESCE(${input.city ?? null}, ${leads.city})`,
        address1: sql`COALESCE(${input.address1 ?? null}, ${leads.address1})`,
        address2: sql`COALESCE(${input.address2 ?? null}, ${leads.address2})`,
        referralSource: sql`COALESCE(${input.referralSource ?? null}::cms.referral_source, ${leads.referralSource})`,
        trackingCode: sql`COALESCE(${input.trackingCode ?? null}, ${leads.trackingCode})`,
        source: sql`COALESCE(${input.source ?? null}, ${leads.source})`,
        pagePath: sql`COALESCE(${input.pagePath ?? null}, ${leads.pagePath})`,
        message: sql`COALESCE(${input.message ?? null}, ${leads.message})`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: leads.id, email: leads.email });
  // An INSERT … ON CONFLICT DO UPDATE … RETURNING always yields exactly one
  // row; the guard is only here to satisfy the type narrowing.
  if (!row) throw new Error("lead upsert returned no row");
  return row;
}

interface MintOpts {
  reason: CodeIssueReason;
  parentCodeId?: string | null;
  editionSlug?: EditionSlug | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Mint a fresh active code for a lead, revoking any other active code first so
 * the lead holds exactly one live link. Runs inside the caller's tx.
 */
async function mintCodeTx(
  tx: Tx,
  leadId: string,
  opts: MintOpts,
): Promise<string> {
  await tx
    .update(bookAccessCodes)
    .set({ status: "revoked", updatedAt: sql`now()` })
    .where(
      and(
        eq(bookAccessCodes.leadId, leadId),
        eq(bookAccessCodes.status, "active"),
      ),
    );
  const code = generateAccessCode();
  await tx.insert(bookAccessCodes).values({
    code,
    leadId,
    bookSlug: BOOK_SLUG,
    status: "active",
    issueReason: opts.reason,
    parentCodeId: opts.parentCodeId ?? null,
    lastEditionSlug: opts.editionSlug ?? null,
    ip: opts.ip ?? null,
    userAgent: opts.userAgent ?? null,
  });
  return code;
}

/**
 * Capture a lead and mint their first/refreshed access code, returning the
 * single-use reader URL to email. Lead upsert + code mint are one transaction.
 */
export async function captureLeadAndIssueCode(
  input: LeadInput,
  edition: EditionSlug,
  reason: "signup" | "resend",
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ readUrl: string; leadId: string }> {
  return withSystemDb(async (tx) => {
    const lead = await upsertLeadTx(tx, input);
    const code = await mintCodeTx(tx, lead.id, {
      reason,
      editionSlug: edition,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { readUrl: readerUrl(edition, code), leadId: lead.id };
  });
}

/**
 * Capture/refresh a lead WITHOUT minting a book code — used by submissions
 * that aren't requesting the book (e.g. the homepage "Get a demo" form).
 */
export async function captureLead(input: LeadInput): Promise<LeadRow> {
  return withSystemDb((tx) => upsertLeadTx(tx, input));
}

/** Look up an existing lead by email (for the resend flow). */
export async function findLeadByEmail(email: string): Promise<LeadRow | null> {
  return withSystemDb(async (tx) => {
    const [row] = await tx
      .select({ id: leads.id, email: leads.email })
      .from(leads)
      .where(eq(leads.email, email))
      .limit(1);
    return row ?? null;
  });
}

/** Issue a fresh code for a known lead (resend). Returns the reader URL. */
export async function issueCodeForLead(
  leadId: string,
  edition: EditionSlug,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  return withSystemDb(async (tx) => {
    const code = await mintCodeTx(tx, leadId, {
      reason: "resend",
      editionSlug: edition,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return readerUrl(edition, code);
  });
}

export type RedeemResult =
  | {
      ok: true;
      html: string;
      newCode: string;
      editions: { slug: string; title: string; format: string }[];
      leadEmail: string;
    }
  | {
      ok: false;
      reason: "invalid" | "consumed" | "expired" | "unknown_edition";
    };

/**
 * Validate → consume → rotate a code, returning the book HTML for `edition`.
 *
 * The code row is locked FOR UPDATE so a concurrent second open of the same
 * link sees it already consumed — that row lock is what enforces single-use.
 */
export async function redeemAndRotate(
  editionSlug: string,
  code: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<RedeemResult> {
  if (!isEditionSlug(editionSlug))
    return { ok: false, reason: "unknown_edition" };

  return withSystemDb(async (tx): Promise<RedeemResult> => {
    const [edition] = await tx
      .select({
        html: bookEditions.html,
        title: bookEditions.title,
      })
      .from(bookEditions)
      .where(
        and(
          eq(bookEditions.slug, editionSlug),
          eq(bookEditions.published, true),
        ),
      )
      .limit(1);
    if (!edition) return { ok: false, reason: "unknown_edition" };

    // Lock the code row so concurrent redemptions of the same code serialize.
    const [codeRow] = await tx
      .select({
        id: bookAccessCodes.id,
        leadId: bookAccessCodes.leadId,
        status: bookAccessCodes.status,
        expiresAt: bookAccessCodes.expiresAt,
      })
      .from(bookAccessCodes)
      .where(eq(bookAccessCodes.code, code))
      .for("update")
      .limit(1);

    if (!codeRow) return { ok: false, reason: "invalid" };
    if (codeRow.status !== "active") {
      return {
        ok: false,
        reason: codeRow.status === "consumed" ? "consumed" : "invalid",
      };
    }
    if (codeRow.expiresAt && codeRow.expiresAt.getTime() < Date.now()) {
      return { ok: false, reason: "expired" };
    }

    // Consume the presented code, then mint the rotated successor.
    await tx
      .update(bookAccessCodes)
      .set({
        status: "consumed",
        consumedAt: sql`now()`,
        lastEditionSlug: editionSlug,
        ip: ctx.ip ?? sql`${bookAccessCodes.ip}`,
        userAgent: ctx.userAgent ?? sql`${bookAccessCodes.userAgent}`,
        updatedAt: sql`now()`,
      })
      .where(eq(bookAccessCodes.id, codeRow.id));

    const newCode = await mintCodeTx(tx, codeRow.leadId, {
      reason: "rotation",
      parentCodeId: codeRow.id,
      editionSlug: editionSlug as EditionSlug,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    const [lead] = await tx
      .select({ email: leads.email })
      .from(leads)
      .where(eq(leads.id, codeRow.leadId))
      .limit(1);

    const editionList = await tx
      .select({
        slug: bookEditions.slug,
        title: bookEditions.title,
        format: bookEditions.format,
      })
      .from(bookEditions)
      .where(eq(bookEditions.published, true));

    return {
      ok: true,
      html: edition.html,
      newCode,
      editions: editionList,
      leadEmail: lead?.email ?? "",
    };
  });
}
