/**
 * trust-content.ts — static-but-accurate trust page data.
 *
 * Extracted to a pure module so unit tests can assert the content without
 * rendering a React page. The data here is factual — it reflects the actual
 * infra stack; do not add aspirational or placeholder entries.
 */

// ---------------------------------------------------------------------------
// Sub-processors
// ---------------------------------------------------------------------------

export interface SubProcessor {
  name: string;
  category: string;
  purpose: string;
  dataRegion: string;
  certifications: string[];
  privacyUrl?: string;
}

export const SUB_PROCESSORS: SubProcessor[] = [
  {
    name: "Stripe",
    category: "Payments",
    purpose:
      "Payment processing, subscription management, and billing. Oxagen transmits only the minimum data required for payment (name, email, billing address). Card numbers are never seen by Oxagen servers — Stripe handles all PCI-DSS cardholder data.",
    dataRegion: "US (with EU data residency options for cards)",
    certifications: ["PCI DSS Level 1", "SOC 2 Type II", "ISO 27001"],
    privacyUrl: "https://stripe.com/privacy",
  },
  {
    name: "Inngest",
    category: "Background jobs",
    purpose:
      "Durable background job execution for async AI tasks, Inngest cron jobs (audit partition rollover, billing metering), and event-driven workflows. Job payloads may contain org-scoped metadata but never raw user content.",
    dataRegion: "US",
    certifications: ["SOC 2 Type II"],
    privacyUrl: "https://www.inngest.com/privacy",
  },
  {
    name: "Vercel",
    category: "Infrastructure",
    purpose:
      "Edge function hosting, CDN, environment variable encryption, blob storage (Vercel Blob), and deployment pipeline. All app compute, API routes, and static assets are served from Vercel infrastructure.",
    dataRegion: "US (iad1 / us-east-1 primary)",
    certifications: ["SOC 2 Type II", "ISO 27001", "GDPR DPA available"],
    privacyUrl: "https://vercel.com/legal/privacy-policy",
  },
  {
    name: "Google Cloud",
    category: "Infrastructure",
    purpose:
      "AlloyDB (managed Postgres) for the primary transactional database. Neo4j Aura for the knowledge graph. Both are provisioned in US regions.",
    dataRegion: "us-central1 / us-east1",
    certifications: ["SOC 2 Type II", "ISO 27001", "HIPAA BAA available"],
    privacyUrl: "https://cloud.google.com/terms/cloud-privacy-notice",
  },
  {
    name: "ClickHouse Cloud",
    category: "Analytics",
    purpose:
      "Append-only analytics store for execution telemetry, token usage, audit events, and runtime traces. Contains aggregate operational data, not raw user content.",
    dataRegion: "us-east-2 (AWS-backed)",
    certifications: ["SOC 2 Type II"],
    privacyUrl: "https://clickhouse.com/legal/privacy-policy",
  },
  {
    name: "Resend",
    category: "Transactional email",
    purpose:
      "Sending transactional emails (password reset, invitations, low-balance alerts). Oxagen passes the recipient address and a templated body — no persistent PII is stored.",
    dataRegion: "US",
    certifications: ["GDPR DPA available"],
    privacyUrl: "https://resend.com/legal/privacy-policy",
  },
];

// ---------------------------------------------------------------------------
// Trust signals (summary badges at the top of the page)
// ---------------------------------------------------------------------------

export interface TrustSignal {
  id: string;
  title: string;
  description: string;
}

export const TRUST_SIGNALS: TrustSignal[] = [
  {
    id: "encryption_at_rest",
    title: "Encrypted at rest",
    description:
      "All databases and blob storage are encrypted at rest using AES-256. OAuth tokens receive an additional application-layer encryption pass.",
  },
  {
    id: "tls_in_transit",
    title: "TLS 1.2+ in transit",
    description:
      "All traffic uses HTTPS with TLS 1.2 minimum. Plain HTTP requests are redirected at the edge.",
  },
  {
    id: "rls_isolation",
    title: "RLS tenant isolation",
    description:
      "Postgres row-level security (RLS) isolates every org's data. The application role is NOSUPERUSER and NOBYPASSRLS.",
  },
  {
    id: "audit_log",
    title: "Append-only audit log",
    description:
      "Every auth event, API key action, and org mutation is recorded in an append-only security_events table. 7-year retention.",
  },
  {
    id: "us_region",
    title: "US data residency",
    description:
      "All data is stored in United States regions. No cross-border data transfer outside the US by default.",
  },
  {
    id: "soc2",
    title: "SOC 2 Type II in progress",
    description:
      "Controls are mapped to SOC 2 CC6–CC9 Trust Service Criteria. Audit evidence is captured continuously via the audit log pipeline.",
  },
];
