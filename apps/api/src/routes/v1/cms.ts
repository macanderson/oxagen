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
import {
  captureLead,
  captureLeadAndIssueCode,
  findLeadByEmail,
  issueCodeForLead,
  redeemAndRotate,
} from "../../lib/cms/access";
import { logger } from "../../middleware/logger";
import type { AppEnv } from "../../app";

export const cmsRoute = new Hono<AppEnv>();

const BOOK_TITLE = "Engineering Deterministic AI Coding Agents";
const EDITION_TITLES: Record<EditionSlug, string> = {
  "field-manual": "Field manual",
  "page-flip-reader": "Page-flip reader",
};

/** User-facing success copy — the exact wording the product asked for. */
const SENT_MESSAGE = "The link to the book has been sent to your email.";
const DEMO_MESSAGE = "Thanks — we got it. We'll be in touch shortly.";
const NOT_FOUND_MESSAGE =
  "We couldn’t find that email. Please fill out the form to get the book.";

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

function clientCtx(c: { req: { header: (n: string) => string | undefined } }) {
  const forwarded = c.req.header("x-forwarded-for");
  const ip = forwarded
    ? forwarded.split(",")[0]!.trim()
    : (c.req.header("x-real-ip") ?? null);
  return { ip, userAgent: c.req.header("user-agent") ?? null };
}

/** Best-effort: send the reader link, log (never throw) on transport failure. */
async function emailReaderLink(
  to: string,
  edition: EditionSlug,
  readUrl: string,
): Promise<void> {
  if (!isEmailTransportConfigured()) {
    // In dev the SMTP transport is usually unconfigured — surface the link in
    // logs so the flow is testable without a mail server.
    logger.warn(
      { to, readUrl },
      "[cms] email transport not configured — reader link not emailed (dev)",
    );
    return;
  }
  try {
    const tpl = bookAccessEmailTemplate({
      readUrl,
      bookTitle: BOOK_TITLE,
      editionTitle: EDITION_TITLES[edition],
      email: to,
    });
    await sendEmail({
      to,
      subject: tpl.subject,
      text: tpl.text,
      html: tpl.html,
    });
  } catch (err) {
    logger.error(
      { err, to },
      "[cms] failed to send ebook access email — lead captured, delivery failed",
    );
  }
}

// ── POST /v1/cms/leads ────────────────────────────────────────────────────────
// Generous but bounded: a handful of submissions per minute per IP.
cmsRoute.use("/leads", rateLimiter({ windowMs: 60_000, max: 10 }));
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
      const edition: EditionSlug = data.edition ?? DEFAULT_EDITION_SLUG;
      const { readUrl } = await captureLeadAndIssueCode(
        leadInput,
        edition,
        "signup",
        clientCtx(c),
      );
      await emailReaderLink(data.email, edition, readUrl);
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
cmsRoute.use("/book/redeem", rateLimiter({ windowMs: 60_000, max: 60 }));
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
cmsRoute.use("/book/resend", rateLimiter({ windowMs: 60_000, max: 5 }));
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
    const readUrl = await issueCodeForLead(lead.id, edition, clientCtx(c));
    await emailReaderLink(lead.email, edition, readUrl);
    return c.json({ ok: true, sent: true, message: SENT_MESSAGE }, 200);
  } catch (err) {
    logger.error({ err }, "[cms] resend failed");
    return c.json(
      { error: "internal_error", message: "Failed to send the link" },
      500,
    );
  }
});
