/**
 * Grants tab — static mock UI.
 *
 * Displays a high-fidelity table of capability grants (principal → capability).
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live IAM data in OXA-XXXX (see parent ticket).
 */

import {
  Shield,
  XCircle,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import {
  Card,
  CardPanel,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Mock data — realistic, hardcoded. Replace with DB query when wired.
// ---------------------------------------------------------------------------

type GrantEffect = "allow" | "deny" | "require_approval";
type ScopeKind = "org" | "workspace" | "global";

interface MockGrant {
  id: string;
  principal: string;
  principalKind: "user" | "service" | "agent";
  capabilityId: string;
  scope: ScopeKind;
  effect: GrantEffect;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
}

const MOCK_GRANTS: MockGrant[] = [
  {
    id: "grn_01j9xk2p3q4r5s6t",
    principal: "Sarah Chen",
    principalKind: "user",
    capabilityId: "agent.run",
    scope: "org",
    effect: "allow",
    grantedBy: "Mac Anderson",
    grantedAt: "May 28, 2026",
    expiresAt: null,
  },
  {
    id: "grn_02j9xk2p3q4r5s7u",
    principal: "data-sync-worker",
    principalKind: "service",
    capabilityId: "knowledge.ingest",
    scope: "workspace",
    effect: "allow",
    grantedBy: "Mac Anderson",
    grantedAt: "May 30, 2026",
    expiresAt: "Jun 30, 2026",
  },
  {
    id: "grn_03j9xk2p3q4r5s8v",
    principal: "James Park",
    principalKind: "user",
    capabilityId: "billing.manage",
    scope: "org",
    effect: "allow",
    grantedBy: "Mac Anderson",
    grantedAt: "Jun 1, 2026",
    expiresAt: null,
  },
  {
    id: "grn_04j9xk2p3q4r5s9w",
    principal: "research-agent-v2",
    principalKind: "agent",
    capabilityId: "web.search",
    scope: "workspace",
    effect: "allow",
    grantedBy: "Sarah Chen",
    grantedAt: "Jun 2, 2026",
    expiresAt: "Jun 16, 2026",
  },
  {
    id: "grn_05j9xk2p3q4r5sax",
    principal: "Priya Nair",
    principalKind: "user",
    capabilityId: "content.generate",
    scope: "org",
    effect: "require_approval",
    grantedBy: "Mac Anderson",
    grantedAt: "Jun 3, 2026",
    expiresAt: null,
  },
  {
    id: "grn_06j9xk2p3q4r5sby",
    principal: "ci-deploy-bot",
    principalKind: "service",
    capabilityId: "infra.deploy",
    scope: "global",
    effect: "deny",
    grantedBy: "Mac Anderson",
    grantedAt: "Jun 4, 2026",
    expiresAt: null,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EFFECT_LABEL: Record<GrantEffect, string> = {
  allow: "Allow",
  deny: "Deny",
  require_approval: "Require approval",
};

const PRINCIPAL_KIND_LABEL: Record<MockGrant["principalKind"], string> = {
  user: "User",
  service: "Service",
  agent: "Agent",
};

function EffectBadge({ effect }: { effect: GrantEffect }) {
  const variant =
    effect === "allow"
      ? ("default" as const)
      : effect === "deny"
        ? ("destructive" as const)
        : ("muted" as const);

  const Icon =
    effect === "allow" ? Shield : effect === "deny" ? XCircle : AlertTriangle;

  return (
    <Badge variant={variant} className="shrink-0 text-xs">
      <Icon className="mr-1 h-3 w-3" aria-hidden="true" />
      {EFFECT_LABEL[effect]}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessGrantsPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <p className="text-[11px] text-muted-foreground/60 font-medium">
        Preview &middot; not yet wired to live data
      </p>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <ShieldCheck
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
            <div>
              <CardTitle>Capability grants</CardTitle>
              <CardDescription>
                Direct principal-to-capability grants outside of roles. These
                supplement role-based access for specific principals.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardPanel>
          {/* Table header */}
          <div className="mb-2 hidden grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_80px_80px_100px_100px] gap-4 px-4 sm:grid">
            {["Principal", "Capability", "Scope", "Effect", "Granted by", "Expires"].map(
              (h) => (
                <span
                  key={h}
                  className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {h}
                </span>
              ),
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            {MOCK_GRANTS.map((g) => (
              <div
                key={g.id}
                className="grid rounded-xl border border-border/50 bg-muted/20 px-4 py-3 text-sm
                  grid-cols-1 gap-y-1
                  sm:grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_80px_80px_100px_100px] sm:gap-4 sm:items-center"
              >
                {/* Principal */}
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="font-medium text-foreground truncate">
                    {g.principal}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {PRINCIPAL_KIND_LABEL[g.principalKind]}
                  </span>
                </div>

                {/* Capability */}
                <span className="font-mono text-xs text-foreground truncate">
                  {g.capabilityId}
                </span>

                {/* Scope */}
                <Badge variant="outline" className="w-fit text-xs capitalize">
                  {g.scope}
                </Badge>

                {/* Effect */}
                <EffectBadge effect={g.effect} />

                {/* Granted by */}
                <span className="text-xs text-muted-foreground truncate">
                  {g.grantedBy}
                  <br />
                  <span className="text-muted-foreground/60">{g.grantedAt}</span>
                </span>

                {/* Expires */}
                <span className="text-xs text-muted-foreground">
                  {g.expiresAt ?? "Never"}
                </span>
              </div>
            ))}
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
