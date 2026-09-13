/**
 * support.ts — single source of truth for customer-support contact details and
 * help links surfaced in the in-app Support menu (and anywhere else support
 * info is shown).
 *
 * Keep every externally-visible support value here so a change (new docs domain,
 * new contact mailbox, updated mailing address) is a one-line edit, never a
 * hunt across components. The docs domain is now the branded oxagen.sh domain
 * (docs.oxagen.sh) following the domain migration.
 */

/** Base URL of the end-user documentation site. */
export const DOCS_URL = "https://docs.oxagen.sh";

/** Customer-success / support mailbox. */
export const SUPPORT_EMAIL = "success@oxagen.ai";

/** Legal entity name shown in the support footer. */
export const COMPANY_NAME = "Oxagen, Inc.";

/**
 * Public contact locale. Region-level on purpose until a registered mailing
 * address is finalized — update this single constant when it is.
 */
export const COMPANY_ADDRESS = "San Francisco, CA";

/** A help link rendered as a row in the Support menu. */
export interface SupportLink {
  label: string;
  description: string;
  href: string;
  /** Opens in a new tab when true (external destinations). */
  external?: boolean;
}

/** Documentation / help destinations, ordered most-useful-first. */
export const SUPPORT_LINKS: readonly SupportLink[] = [
  {
    label: "Documentation",
    description: "Guides, API & SDK reference",
    href: `${DOCS_URL}/docs`,
    external: true,
  },
  {
    label: "Quickstart",
    description: "Get up and running fast",
    href: `${DOCS_URL}/docs/quickstart`,
    external: true,
  },
] as const;
