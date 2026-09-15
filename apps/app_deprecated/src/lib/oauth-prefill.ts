/**
 * Pure helpers that turn a signed-in user's profile (name / email / avatar,
 * populated by Better Auth from the Google or GitHub OAuth profile) into
 * sensible defaults for the new-organization form. No I/O, no React — node-
 * testable. Used by the new-organization page (server) to seed the form.
 */

/** Provider whose profile seeded the prefill, for UI attribution. */
export type SignupProvider = "google" | "github";

/**
 * Consumer mailbox providers. A user signing up with one of these has a
 * personal address, so its domain must NOT seed a business name or website.
 */
const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "duck.com",
  "qq.com",
  "163.com",
  "126.com",
]);

/** Lower-cased domain part of an email, or null when it isn't a valid address. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length > 0 && domain.includes(".") ? domain : null;
}

/** True for consumer mailbox domains (and for null/empty — treat as personal). */
export function isConsumerEmailDomain(
  domain: string | null | undefined,
): boolean {
  if (!domain) return true;
  return CONSUMER_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/**
 * Derive a human company name from a domain by title-casing its registrable
 * label: `"acme-corp.io"` → `"Acme Corp"`, `"mail.acme.com"` → `"Acme"`.
 * Uses the second-to-last label so common subdomains don't leak in. Returns
 * `""` when no sensible name can be derived.
 */
export function companyNameFromDomain(
  domain: string | null | undefined,
): string {
  if (!domain) return "";
  const labels = domain
    .toLowerCase()
    .replace(/^www\./, "")
    .split(".");
  if (labels.length < 2) return "";
  const brand = labels[labels.length - 2] ?? "";
  return brand
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Prefill values handed from the server page into the new-org form. */
export interface OrgSignupPrefill {
  /** Display name from the profile (may be ""). */
  name: string;
  /** Email from the profile (may be ""). */
  email: string;
  /** External avatar URL (Google/GitHub CDN) for the logo preview; "" if none. */
  avatarUrl: string;
  /** Social provider the data came from, or null for email/password signup. */
  provider: SignupProvider | null;
  /** Suggested org name from a non-consumer email domain ("" otherwise). */
  suggestedBusinessName: string;
  /** Suggested website (`https://<domain>`) from a non-consumer domain ("" otherwise). */
  suggestedWebsite: string;
}

/**
 * Build the form prefill from a user's profile. Business suggestions (name +
 * website) are only produced for non-consumer email domains; personal/consumer
 * accounts get name + email + avatar only.
 */
export function buildOrgSignupPrefill(input: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  provider?: SignupProvider | null;
}): OrgSignupPrefill {
  const email = (input.email ?? "").trim();
  const domain = emailDomain(email);
  const isBusinessDomain = domain !== null && !isConsumerEmailDomain(domain);
  return {
    name: (input.name ?? "").trim(),
    email,
    avatarUrl: (input.image ?? "").trim(),
    provider: input.provider ?? null,
    suggestedBusinessName: isBusinessDomain
      ? companyNameFromDomain(domain)
      : "",
    suggestedWebsite: isBusinessDomain ? `https://${domain}` : "",
  };
}
