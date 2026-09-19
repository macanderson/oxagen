/**
 * Public, unauthenticated ebook lead-gate routes for the oxagen.sh website.
 *
 *   POST /v1/cms/leads        — capture a lead, mint a single-use book code,
 *                               email the reader link.
 *   POST /v1/cms/book/redeem  — validate + consume + rotate a code, return the
 *                               book HTML (the only path to the gated content).
 *   POST /v1/cms/book/resend  — email lookup: re-issue a code to a known lead,
 *                               or tell an unknown caller to fill out the form.
 *
 * No session or API key is required or accepted — the callers are anonymous
 * website visitors. Mirroring /v1/telemetry, the security boundary is (1) strict
 * `.strict()` Zod validation that rejects any field outside the allowlist, and
 * (2) a per-IP rate limit. All state lives in the non-tenant cms.* tables,
 * written through withSystemDb (see lib/cms/access.ts). A honeypot field silently
 * drops bots. This route deliberately has no MCP/CLI parity — it is a marketing
 * surface, not an agent capability (same class as /v1/telemetry).
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  sendEmail,
  isEmailTransportConfigured,
  bookAccessEmailTemplate,
} from "@oxagen/notifications";
import {
  COMPANY_SIZES,
  REFERRAL_SOURCES,
  EDITION_SLUGS,
  DEFAULT_EDITION_SLUG,
  type EditionSlug,
} from "@oxagen/database";
import { rateLimiter } from "../../middleware/rate-limit";
import { trustedClientIpBucketKey } from "../../middleware/distributed-rate-limit";
import {
  captureLead,
  captureLeadAndIssueCode,
  finalizeCodeDelivery,
  findLeadByEmail,
  issueCodeForLead,
  redeemAndRotate,
} from "../../lib/cms/access";
import { logger } from "../../middleware/logger";
import { extractClientIp } from "../../lib/context";
import type { Context } from "hono";
import type { AppEnv } from "../../app";

/** Per-IP CMS ceilings keyed by the trusted edge address (ADR-083). */
const cmsIpLimit = (windowMs: number, max: number) =>
  rateLimiter({ windowMs, max, keyFn: trustedClientIpBucketKey });

export const cmsRoute = new Hono<AppEnv>();

const BOOK_TITLE = "Engineering Deterministic AI Coding Agents";
const EDITION_TITLES: Record<EditionSlug, string> = {
  "field-manual": "Field manual",
  "page-flip-reader": "Page-flip reader",
};

/** User-facing success copy: the exact wording the product asked for. */
const SENT_MESSAGE = "The link to the book has been sent to your email.";
const DEMO_MESSAGE = "Thanks. We got it. We'll be in touch shortly.";
const NOT_FOUND_MESSAGE =
  "We couldn't find that email. Please fill out the form to get the book.";
// Two wordings: /leads has no resend control in front of it (the homepage
// forms only ever submit once), while /book/resend IS the resend action, so
// its own failure message can honestly point back at itself.
const SIGNUP_DELIVERY_FAILED_MESSAGE =
  "We saved your details, but couldn't send the email. Please try again.";
const RESEND_DELIVERY_FAILED_MESSAGE =
  "We couldn't send the email just now. Please try again in a moment.";

const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));

// Strict lead payload: any unknown key is rejected so a bad/compromised client
// cannot smuggle unexpected content into cms.leads.
const leadSchema = z
  .object({
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(320),
    jobTitle: optionalTrimmed(200),
    company: optionalTrimmed(200),
    companySize: z.enum(COMPANY_SIZES).optional(),
    mobilePhone: optionalTrimmed(50),
    country: optionalTrimmed(120),
    state: optionalTrimmed(120),
    city: optionalTrimmed(120),
    address1: optionalTrimmed(240),
    address2: optionalTrimmed(240),
    referralSource: z.enum(REFERRAL_SOURCES).optional(),
    trackingCode: optionalTrimmed(500),
    edition: z.enum(EDITION_SLUGS).optional(),
    // "book" (default) captures the lead AND emails a single-use reader link;
    // "demo" captures the lead only — no code, no book email.
    intent: z.enum(["book", "demo"]).optional(),
    message: optionalTrimmed(2000),
    source: optionalTrimmed(120),
    pagePath: optionalTrimmed(1000),
    marketingConsent: z.boolean().optional(),
    // Honeypot: real users never fill this hidden field. Any value ⇒ bot.
    website: z.string().max(0).optional().or(z.string()),
  })
  .strict();

const redeemSchema = z
  .object({
    edition: z.string().min(1).max(64),
    code: z.string().trim().min(1).max(64),
  })
  .strict();

const resendSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    edition: z.enum(EDITION_SLUGS).optional(),
  })
  .strict();

// Same trusted-IP derivation the rate limiters use (ADR-083), so an audit row
// and the bucket it was counted against never disagree about who the caller
// was. `x-forwarded-for` alone is caller-writable and, under the production
// edge rewrite, identifies Caddy rather than the visitor.
function clientCtx(c: Context<AppEnv>) {
  return {
    ip: extractClientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  };
}

/**
 * Send the reader link and report whether delivery actually happened.
 *
 * Never throws — a transport failure must not turn an already-minted code
 * into a 500 — but it also must not lie: the caller gets back whether the
 * email went out, so a route can finalize the code rotation correctly
 * (`finalizeCodeDelivery`) and tell the visitor to retry instead of
 * claiming "sent" over a delivery that silently failed.
 */
async function emailReaderLink(
  to: string,
  edition: EditionSlug,
  readUrl: string,
): Promise<boolean> {
  if (!isEmailTransportConfigured()) {
    // In dev the SMTP transport is usually unconfigured — surface the link in
    // logs so the flow is testable without a mail server. Not a delivery
    // failure to report to the visitor: this is the expected local state.
    logger.warn(
      { to, readUrl },
      "[cms] email transport not configured — reader link not emailed (dev)",
    );
    return true;
  }
  try {
    const tpl = bookAccessEmailTemplate({
      readUrl,
      bookTitle: BOOK_TITLE,
      editionTitle: EDITION_TITLES[edition],
      email: to,
    });
    const result = await sendEmail({
      to,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
    });
    // sendEmail can resolve without throwing while the target address sits in
    // `rejected` (bad mailbox, provider-side block, etc.), which is still a
    // failed delivery, not a thrown error, so check `accepted` explicitly
    // rather than trusting a non-throwing resolve.
    const delivered = result.accepted.some(
      (addr) => addr.toLowerCase() === to.toLowerCase(),
    );
    if (!delivered) {
      logger.error(
        { to, accepted: result.accepted, rejected: result.rejected },
        "[cms] email transport rejected the recipient, delivery failed",
      );
    }
    return delivered;
  } catch (err) {
    logger.error(
      { err, to },
      "[cms] failed to send ebook access email — lead captured, delivery failed",
    );
    return false;
  }
}

// ── POST /v1/cms/leads ────────────────────────────────────────────────────────
// Generous but bounded: a handful of submissions per minute per IP.
cmsRoute.use("/leads", cmsIpLimit(60_000, 10));
cmsRoute.post("/leads", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { error: "invalid_request", message: "Invalid JSON body" },
      400,
    );
  }
  const parsed = leadSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: "invalid_request",
        message: parsed.error.issues[0]?.message ?? "Invalid input",
      },
      400,
    );
  }
  const data = parsed.data;
  const intent = data.intent ?? "book";
  const successMessage = intent === "demo" ? DEMO_MESSAGE : SENT_MESSAGE;

  // Honeypot tripped → pretend success, drop silently (don't tip off bots).
  if (data.website && data.website.length > 0) {
    return c.json({ ok: true, message: successMessage }, 200);
  }

  const leadInput = {
    email: data.email,
    firstName: data.firstName,
    lastName: data.lastName,
    jobTitle: data.jobTitle,
    company: data.company,
    companySize: data.companySize,
    mobilePhone: data.mobilePhone,
    country: data.country,
    state: data.state,
    city: data.city,
    address1: data.address1,
    address2: data.address2,
    referralSource: data.referralSource,
    trackingCode: data.trackingCode,
    source: data.source ?? (intent === "demo" ? "demo" : "ebook-gate"),
    pagePath: data.pagePath,
    message: data.message,
    marketingConsent: data.marketingConsent,
  };

  try {
    if (intent === "demo") {
      // Demo requests capture the lead only — no book code, no book email.
      await captureLead(leadInput);
    } else {
      // The homepage "Get the manual" form sends source: "field-manual" but
      // no explicit edition; fall back to the edition its own source names
      // rather than the generic default, or every field-manual signup is
      // emailed the page-flip reader instead.
      const edition: EditionSlug =
        data.edition ??
        (data.source === "field-manual"
          ? "field-manual"
          : DEFAULT_EDITION_SLUG);
      const { readUrl, leadId, codeId } = await captureLeadAndIssueCode(
        leadInput,
        edition,
        "signup",
        clientCtx(c),
      );
      const delivered = await emailReaderLink(data.email, edition, readUrl);
      await finalizeCodeDelivery(leadId, codeId, delivered);
      if (!delivered) {
        // The lead is already persisted and (if this was not the visitor's
        // first code) their prior link is still live — only the email
        // failed, so this stays 200 with an honest retry message.
        return c.json(
          {
            ok: true,
            delivered: false,
            message: SIGNUP_DELIVERY_FAILED_MESSAGE,
          },
          200,
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "[cms] lead capture failed");
    return c.json(
      { error: "internal_error", message: "Failed to record your details" },
      500,
    );
  }
  return c.json({ ok: true, message: successMessage }, 200);
});

// ── POST /v1/cms/book/redeem ──────────────────────────────────────────────────
// Higher ceiling: legitimate readers open/refresh, and each rotates a code.
cmsRoute.use("/book/redeem", cmsIpLimit(60_000, 60));
cmsRoute.post("/book/redeem", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { error: "invalid_request", message: "Invalid JSON body" },
      400,
    );
  }
  const parsed = redeemSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", message: "Invalid input" }, 400);
  }
  try {
    const result = await redeemAndRotate(
      parsed.data.edition,
      parsed.data.code,
      clientCtx(c),
    );
    return c.json(result, 200);
  } catch (err) {
    logger.error({ err }, "[cms] redeem failed");
    return c.json(
      { error: "internal_error", message: "Failed to open the book" },
      500,
    );
  }
});

// ── POST /v1/cms/book/resend ──────────────────────────────────────────────────
// Stricter: this triggers an email, so bound it tightly per IP.
cmsRoute.use("/book/resend", cmsIpLimit(60_000, 5));
cmsRoute.post("/book/resend", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      { error: "invalid_request", message: "Invalid JSON body" },
      400,
    );
  }
  const parsed = resendSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", message: "Invalid input" }, 400);
  }
  const edition: EditionSlug = parsed.data.edition ?? DEFAULT_EDITION_SLUG;
  try {
    const lead = await findLeadByEmail(parsed.data.email);
    if (!lead) {
      // Product decision (explicit ask): tell the caller to fill out the form
      // rather than silently pretend. This does disclose email existence — an
      // accepted trade-off for a public marketing funnel.
      return c.json({ ok: true, sent: false, message: NOT_FOUND_MESSAGE }, 200);
    }
    const { readUrl, codeId } = await issueCodeForLead(
      lead.id,
      edition,
      clientCtx(c),
    );
    const delivered = await emailReaderLink(lead.email, edition, readUrl);
    await finalizeCodeDelivery(lead.id, codeId, delivered);
    // On failure the prior code (if the lead had one) was left active by
    // finalizeCodeDelivery above, so this is never worse than the resend
    // never having happened.
    return c.json(
      {
        ok: true,
        sent: delivered,
        message: delivered ? SENT_MESSAGE : RESEND_DELIVERY_FAILED_MESSAGE,
      },
      200,
    );
  } catch (err) {
    logger.error({ err }, "[cms] resend failed");
    return c.json(
      { error: "internal_error", message: "Failed to send the link" },
      500,
    );
  }
});
