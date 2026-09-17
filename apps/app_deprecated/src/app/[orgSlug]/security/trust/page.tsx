/**
 * Security → Trust: data residency, encryption, sub-processors, and retention.
 *
 * Mostly static-but-accurate: values come from env signals and hard policy.
 * No Enterprise gate — trust information is available to all org members.
 * Links to the docs security section for third-party verification.
 */

import { ExternalLink, CheckCircle2 } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import {
  SUB_PROCESSORS,
  TRUST_SIGNALS,
  type SubProcessor,
} from "./trust-content";

// ---------------------------------------------------------------------------
// Sub-processor card
// ---------------------------------------------------------------------------

function SubProcessorRow({ sp }: { sp: SubProcessor }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex flex-1 flex-col gap-0.5 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{sp.name}</span>
          <Badge variant="muted" className="text-[10px]">
            {sp.category}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground leading-snug">
          {sp.purpose}
        </p>
        <p className="text-xs text-muted-foreground/70 leading-snug">
          {sp.dataRegion} · {sp.certifications.join(", ")}
        </p>
      </div>
      {sp.privacyUrl && (
        <a
          href={sp.privacyUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Privacy
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SecurityTrustPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [session, tenant] = await Promise.all([
    getSessionOrRedirect(),
    resolveOrg(orgSlug),
  ]);
  await assertOrgMember(tenant.id, session.user.id);

  const rlsEnforced = process.env["TENANT_RLS_ENFORCEMENT_ENABLED"] === "true";

  return (
    <div className="flex flex-col gap-6">
      {/* Header card — summary */}
      <Panel
        title="Trust and security"
        actions={
          <Button
            variant="outline"
            size="sm"
            render={
              <a
                href="https://docs.oxagen.sh/security"
                target="_blank"
                rel="noreferrer noopener"
              />
            }
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            Security docs
          </Button>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Data residency, encryption, tenant isolation, sub-processors, and
          retention policies for this platform.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TRUST_SIGNALS.map((signal) => (
            <div
              key={signal.id}
              className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-3"
            >
              <CheckCircle2
                className="mt-0.5 h-4 w-4 shrink-0 text-success"
                aria-hidden="true"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">
                  {signal.title}
                </span>
                <span className="text-xs text-muted-foreground leading-snug">
                  {signal.description}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {/* Data region */}
      <Panel title="Data region">
        <p className="mb-4 text-sm text-muted-foreground">
          All data is stored and processed in the United States.
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">
                Primary region
              </span>
              <Badge variant="muted" className="text-xs">
                US-central (iad1)
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Postgres (AlloyDB), ClickHouse, Neo4j, and blob storage are all
              provisioned in US-central. Vercel edge functions route to the{" "}
              <code className="font-mono text-[10px] bg-muted px-1 rounded">
                iad1
              </code>{" "}
              region. No data crosses to other regions by default.
            </p>
          </div>

          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">
                Tenant isolation
              </span>
              <Badge
                variant={rlsEnforced ? "success" : "warning"}
                className="text-xs"
              >
                {rlsEnforced ? "RLS enforced" : "Enforcement pending"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Each org&apos;s data is isolated via Postgres row-level security
              (RLS). The application database role (
              <code className="font-mono text-[10px] bg-muted px-1 rounded">
                oxagen_app
              </code>
              ) is{" "}
              <code className="font-mono text-[10px] bg-muted px-1 rounded">
                NOSUPERUSER
              </code>{" "}
              and{" "}
              <code className="font-mono text-[10px] bg-muted px-1 rounded">
                NOBYPASSRLS
              </code>
              , so RLS policies cannot be bypassed by the application layer.
            </p>
          </div>
        </div>
      </Panel>

      {/* Encryption */}
      <Panel title="Encryption">
        <p className="mb-4 text-sm text-muted-foreground">
          All data is encrypted at rest and in transit.
        </p>
        <div className="flex flex-col gap-2">
          {[
            {
              label: "At rest",
              value: "AES-256 (managed by Vercel, Google Cloud)",
              detail:
                "Postgres, ClickHouse, and blob storage volumes are encrypted at rest using AES-256 with cloud-provider managed keys. OAuth access tokens are additionally encrypted at the application layer with a rotating Vercel-native master key (KEK).",
            },
            {
              label: "In transit",
              value: "TLS 1.2+ enforced everywhere",
              detail:
                "All endpoints are served exclusively over HTTPS. TLS 1.2 is the minimum; TLS 1.3 is preferred. HTTP→HTTPS redirect is enforced at the Vercel edge.",
            },
            {
              label: "OAuth tokens",
              value: "Application-layer AES-256-GCM",
              detail:
                "OAuth access tokens and refresh tokens are encrypted with a rotating application-layer key (AUTH_TOKEN_ENCRYPTION_KEY) before being stored in the database. The key is held in Vercel's encrypted environment variable store, never in source code.",
            },
          ].map((row, _i) => (
            <div
              key={row.label}
              className="flex flex-col gap-1 rounded-xl border border-border/60 bg-muted/30 px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {row.label}
                </span>
                <Badge variant="muted" className="text-xs">
                  {row.value}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-snug">
                {row.detail}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      {/* Retention */}
      <Panel title="Data retention">
        <p className="mb-4 text-sm text-muted-foreground">
          How long different categories of data are kept.
        </p>
        <div className="flex flex-col gap-2">
          {[
            {
              category: "Audit log (security_events)",
              retention: "7 years",
              basis:
                "SOC 2 CC7.2 — append-only, monthly partitions rolled over by cron; partitions older than 7 years are dropped.",
            },
            {
              category: "ClickHouse telemetry (audit_events)",
              retention: "7 years",
              basis:
                "TTL policy mirrors the Postgres audit log. Execution events and token analytics are retained for the same period.",
            },
            {
              category: "Sessions",
              retention: "30 days (sliding)",
              basis:
                "Better Auth session tokens expire 30 days after last use. Expired sessions are not accessible from the application.",
            },
            {
              category: "Workspace files",
              retention: "Until deleted by user",
              basis:
                "User-uploaded files and generated assets are stored in Vercel Blob until the owning user or org deletes them, or the org is deleted.",
            },
            {
              category: "Account data (PII)",
              retention: "Until account deletion",
              basis:
                "User profiles, organization data, and settings are retained until the account owner requests deletion (GDPR Art. 17 / CCPA). Audit rows referencing the user are retained but the user_id reference becomes an orphan.",
            },
          ].map((row) => (
            <div
              key={row.category}
              className="flex flex-col gap-1 rounded-xl border border-border/60 bg-muted/30 px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground font-mono text-xs">
                  {row.category}
                </span>
                <Badge variant="outline" className="text-xs">
                  {row.retention}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-snug">
                {row.basis}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      {/* Sub-processors */}
      <Panel title="Sub-processors">
        <p className="mb-4 text-sm text-muted-foreground">
          Third-party vendors that may process your data. All sub-processors are
          bound by data processing agreements (DPAs).
        </p>
        <div className="flex flex-col gap-2">
          {SUB_PROCESSORS.map((sp) => (
            <SubProcessorRow key={sp.name} sp={sp} />
          ))}
        </div>
      </Panel>

      {/* Database architecture */}
      <Panel title="Data store architecture">
        <p className="mb-4 text-sm text-muted-foreground">
          Purpose-bound storage — each store holds exactly one kind of data.
        </p>
        <div className="flex flex-col gap-2">
          {[
            {
              store: "Postgres (AlloyDB)",
              region: "us-central1",
              purpose:
                "Transactional application state: users, orgs, billing, configs, sessions, security policy, and the security_events audit log.",
            },
            {
              store: "ClickHouse Cloud",
              region: "us-east-2",
              purpose:
                "Append-only analytics: execution events, token usage, traces, and telemetry. 7-year TTL.",
            },
            {
              store: "Neo4j Aura",
              region: "us-east-1",
              purpose:
                "Knowledge graph: ontology, entity relationships, workflow lineage, agent memory, and semantic retrieval.",
            },
            {
              store: "Vercel Blob",
              region: "iad1 (US-east)",
              purpose:
                "Binary assets: user/org avatars, generated images, PDFs, workspace uploads. References stored in Postgres.",
            },
          ].map((row) => (
            <div
              key={row.store}
              className="flex flex-col gap-1 rounded-xl border border-border/60 bg-muted/30 px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">
                  {row.store}
                </span>
                <Badge variant="muted" className="text-xs">
                  {row.region}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground leading-snug">
                {row.purpose}
              </p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
