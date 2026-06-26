import { Plus, MoreHorizontal } from "lucide-react";
import { Panel } from "@/components/ui/panel";

// ---------------------------------------------------------------------------
// Static mock — no DB dependency (pure presentational; OXA-XXXX to wire)
// ---------------------------------------------------------------------------

interface Grant {
  id: string;
  principalName: string;
  principalType: "user" | "service" | "agent";
  capability: string;
  effect: "allow" | "deny";
  scope: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
}

const MOCK_GRANTS: Grant[] = [
  {
    id: "grt_01",
    principalName: "alice@acme.co",
    principalType: "user",
    capability: "chat.message.send",
    effect: "allow",
    scope: "workspace:ws_prod",
    grantedBy: "admin@acme.co",
    grantedAt: "2025-12-01",
    expiresAt: null,
  },
  {
    id: "grt_02",
    principalName: "ci-deploy-bot",
    principalType: "service",
    capability: "automation.agent.execute",
    effect: "allow",
    scope: "org:acme",
    grantedBy: "admin@acme.co",
    grantedAt: "2025-11-15",
    expiresAt: "2026-11-15",
  },
  {
    id: "grt_03",
    principalName: "research-agent",
    principalType: "agent",
    capability: "knowledge.source.create",
    effect: "allow",
    scope: "workspace:ws_research",
    grantedBy: "bob@acme.co",
    grantedAt: "2026-01-08",
    expiresAt: null,
  },
  {
    id: "grt_04",
    principalName: "intern@acme.co",
    principalType: "user",
    capability: "billing.subscription.update",
    effect: "deny",
    scope: "org:acme",
    grantedBy: "admin@acme.co",
    grantedAt: "2026-02-20",
    expiresAt: null,
  },
  {
    id: "grt_05",
    principalName: "support-agent",
    principalType: "agent",
    capability: "chat.message.send",
    effect: "allow",
    scope: "workspace:ws_support",
    grantedBy: "alice@acme.co",
    grantedAt: "2026-03-10",
    expiresAt: "2026-09-10",
  },
  {
    id: "grt_06",
    principalName: "data-pipeline-svc",
    principalType: "service",
    capability: "knowledge.source.ingest",
    effect: "allow",
    scope: "org:acme",
    grantedBy: "admin@acme.co",
    grantedAt: "2026-04-01",
    expiresAt: null,
  },
];

const PRINCIPAL_TYPE_BADGE: Record<Grant["principalType"], string> = {
  user: "bg-blue-500/10 text-blue-600",
  service: "bg-purple-500/10 text-purple-600",
  agent: "bg-amber-500/10 text-amber-600",
};

const EFFECT_BADGE: Record<Grant["effect"], string> = {
  allow: "bg-success/10 text-success",
  deny: "bg-destructive/10 text-destructive",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessGrantsPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* OXA-XXXX indicator */}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        OXA-XXXX · not yet wired to live data
      </div>

      <Panel
        title="Capability Grants"
        actions={
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground opacity-60 cursor-not-allowed"
            aria-label="Create grant (coming soon)"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Create Grant
          </button>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Direct principal-to-capability grants. Each grant gives or denies a
          specific capability to a principal within a scope.
        </p>

        <div className="overflow-hidden rounded-lg border border-border/60">
          <table className="w-full text-sm" aria-label="Capability grants">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30">
                <th className="py-2.5 pl-4 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Principal
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Capability
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Effect
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Scope
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Granted
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Expires
                </th>
                <th className="py-2.5 pl-3 pr-4 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {MOCK_GRANTS.map((grant) => (
                <tr
                  key={grant.id}
                  className="border-b border-border/40 last:border-b-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="py-3 pl-4 pr-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">
                        {grant.principalName}
                      </span>
                      <span
                        className={`inline-flex w-fit items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${PRINCIPAL_TYPE_BADGE[grant.principalType]}`}
                      >
                        {grant.principalType}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3">
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {grant.capability}
                    </code>
                  </td>
                  <td className="py-3 px-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${EFFECT_BADGE[grant.effect]}`}
                    >
                      {grant.effect}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-xs text-muted-foreground font-mono">
                    {grant.scope}
                  </td>
                  <td className="py-3 px-3 text-xs text-muted-foreground whitespace-nowrap">
                    {grant.grantedAt}
                  </td>
                  <td className="py-3 px-3 text-xs text-muted-foreground whitespace-nowrap">
                    {grant.expiresAt ?? "—"}
                  </td>
                  <td className="py-3 pl-3 pr-4">
                    <button
                      type="button"
                      disabled
                      className="rounded p-1 text-muted-foreground opacity-50 cursor-not-allowed"
                      aria-label="Grant actions"
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
