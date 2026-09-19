// cms.ts — public marketing/content surface for oxagen.sh.
//
// Three responsibilities, one Postgres schema:
//   1. cms.leads          — website lead capture (the ebook gate + demo forms).
//   2. cms.book_editions  — the gated ebook content (self-contained HTML), served
//                           ONLY through a valid one-time access code.
//   3. cms.book_access_codes — single-use, rotating view codes that gate the book.
//
// These are NOT tenant-scoped. A lead is a prospect, not an org member, and the
// book is public marketing content behind a lead wall — so there is no org_id /
// workspace_id and no tenant_isolation policy. Instead every table gets a
// bypass-only RLS policy (USING app.rls_bypass = 'on'): the sole access path is
// the audited withSystemDb bypass, so leads can never leak through a tenant
// query. All writes/reads go through the public /v1/cms/* API routes.
//
// Purely transactional state (leads, codes) → Postgres is the correct store per
// CLAUDE.md's four-store model. The book HTML lives here rather than as a static
// file so that "no valid code = no book" is actually enforceable: the bytes are
// never at a public URL, they are returned by the redeem route after a code is
// validated and consumed.

import {
  boolean,
  check,
  index,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { cmsSchema } from "./_schemas";
import { citext, idMixin, auditMixin } from "./_mixins";

// ── Shared value sets (single source of truth for API + web validation) ───────

/**
 * Company-size buckets — standard B2B SaaS employee-count ranges (used across
 * marketing/CRM tooling: HubSpot, Salesforce, Clearbit-style segmentation).
 */
export const COMPANY_SIZES = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001-10000",
  "10001+",
] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

/**
 * Referral / attribution source — how the lead first heard about us. Standard
 * "How did you hear about us?" taxonomy, normalized to snake_case enum values.
 */
export const REFERRAL_SOURCES = [
  "search_engine",
  "social_media",
  "referral",
  "email",
  "blog_or_content",
  "event_or_conference",
  "advertisement",
  "word_of_mouth",
  "other",
] as const;
export type ReferralSource = (typeof REFERRAL_SOURCES)[number];

/** Where a code was issued from — drives lineage + analytics. */
export const CODE_ISSUE_REASONS = ["signup", "resend", "rotation"] as const;
export type CodeIssueReason = (typeof CODE_ISSUE_REASONS)[number];

/** Access-code lifecycle. `active` codes are the only redeemable state. */
export const CODE_STATUSES = ["active", "consumed", "revoked"] as const;
export type CodeStatus = (typeof CODE_STATUSES)[number];

/**
 * The book the whole funnel gates. One book, delivered in two presentations
 * (editions). Kept as a constant so codes and editions agree on the grouping.
 */
export const BOOK_SLUG = "deterministic-ai-coding-agents" as const;

/**
 * The two shipped editions of the book. Slug is the stable identifier used in
 * the reader URL (`/read?e=<slug>`), the seed, and the redeem route.
 */
export const EDITION_SLUGS = ["field-manual", "page-flip-reader"] as const;
export type EditionSlug = (typeof EDITION_SLUGS)[number];
/** Default edition the signup/resend emails link to (the premium reader). */
export const DEFAULT_EDITION_SLUG: EditionSlug = "page-flip-reader";

// ── Enums ─────────────────────────────────────────────────────────────────────

export const companySizeEnum = cmsSchema.enum("company_size", COMPANY_SIZES);
export const referralSourceEnum = cmsSchema.enum(
  "referral_source",
  REFERRAL_SOURCES,
);

// ── cms.leads ─────────────────────────────────────────────────────────────────

/**
 * A captured website lead. `email` is the natural key (case-insensitive): the
 * lead form upserts on it, and the "resend my code" flow looks up by it. All
 * profile fields beyond first/last/email are optional so the gate can stay low
 * friction while still collecting rich firmographics when offered.
 */
export const leads = cmsSchema.table(
  "leads",
  {
    ...idMixin("lead"),
    ...auditMixin(),
    // Identity ----------------------------------------------------------------
    email: citext("email").notNull().unique(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    jobTitle: text("job_title"),
    company: text("company"),
    companySize: companySizeEnum("company_size"),
    mobilePhone: text("mobile_phone"),
    // Location ----------------------------------------------------------------
    country: text("country"),
    state: text("state"),
    city: text("city"),
    address1: text("address_1"),
    address2: text("address_2"),
    // Attribution -------------------------------------------------------------
    referralSource: referralSourceEnum("referral_source"),
    /**
     * Free-form marketing tracking / campaign code carried from the landing URL
     * (UTM bundle, ad click id, or a partner code). Kept opaque so any marketing
     * tool's identifier round-trips without a schema change. Indexed for
     * campaign rollups.
     */
    trackingCode: text("tracking_code"),
    /** Which form/section captured the lead (e.g. "ebook-gate", "demo"). */
    source: text("source"),
    /** Landing page path + hash at submit time, for attribution. */
    pagePath: text("page_path"),
    /**
     * Free-form note from the lead (the demo form's "What are you building?").
     * Book-gate submissions leave it null.
     */
    message: text("message"),
    /** Explicit marketing-contact consent (defaults true; the form states it). */
    marketingConsent: boolean("marketing_consent").notNull().default(true),
  },
  (t) => ({
    // cms_leads_email_idx was dropped (2026-07-11 audit §4.2): duplicate of
    // the email.unique() constraint declared above (citext, both unique).
    trackingIdx: index("cms_leads_tracking_code_idx").on(t.trackingCode),
    createdIdx: index("cms_leads_created_at_idx").on(t.createdAt),
  }),
);

// ── cms.book_editions ─────────────────────────────────────────────────────────

/**
 * A servable edition of the gated book. `html` is the full, self-contained
 * document (asset URLs already absolutized to the marketing origin at seed
 * time). Never exposed at a public URL — the redeem route returns it only after
 * a code is validated and consumed. Seeded by scripts/seed-book-editions.ts.
 */
export const bookEditions = cmsSchema.table(
  "book_editions",
  {
    ...idMixin("bed"),
    ...auditMixin(),
    slug: citext("slug").notNull().unique(),
    /** Groups editions of the same book (BOOK_SLUG). */
    bookSlug: text("book_slug").notNull(),
    format: text("format").notNull(),
    title: text("title").notNull(),
    html: text("html").notNull(),
    published: boolean("published").notNull().default(true),
  },
  (t) => ({
    bookIdx: index("cms_book_editions_book_idx").on(t.bookSlug),
    formatCheck: check(
      "cms_book_editions_format_chk",
      sql`${t.format} IN ('linear','page-flip')`,
    ),
  }),
);

// ── cms.book_access_codes ─────────────────────────────────────────────────────

/**
 * A single-use, rotating access code that gates the book. Each lead holds
 * exactly one `active` code at a time: redeeming it flips it to `consumed` and
 * mints a fresh `active` code (issue_reason='rotation', parent_code_id set) that
 * the served page carries forward. A shared or re-opened old URL is therefore
 * already consumed → the reader shows the gate. `code` is the opaque URL token.
 */
export const bookAccessCodes = cmsSchema.table(
  "book_access_codes",
  {
    ...idMixin("bac"),
    ...auditMixin(),
    code: citext("code").notNull().unique(),
    leadId: uuid("lead_id").notNull(),
    bookSlug: text("book_slug").notNull(),
    status: text("status").notNull().default("active"),
    issueReason: text("issue_reason").notNull(),
    /** The code this one rotated from (null for the first code of a lead). */
    parentCodeId: uuid("parent_code_id"),
    /** Which edition was last opened with this lead's code chain. */
    lastEditionSlug: text("last_edition_slug"),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    /** Optional expiry; null = no time limit (single-use is the real bound). */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    /** Audit context of the redemption/issue. */
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => ({
    leadIdx: index("cms_book_access_codes_lead_idx").on(t.leadId),
    statusIdx: index("cms_book_access_codes_status_idx").on(t.status),
    statusCheck: check(
      "cms_book_access_codes_status_chk",
      sql`${t.status} IN ('active','consumed','revoked')`,
    ),
    reasonCheck: check(
      "cms_book_access_codes_reason_chk",
      sql`${t.issueReason} IN ('signup','resend','rotation')`,
    ),
  }),
);
