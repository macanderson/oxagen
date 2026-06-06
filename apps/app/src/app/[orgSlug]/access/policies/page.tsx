/**
 * Policies tab — static mock UI.
 *
 * Displays policy rules (allow/deny, resource, condition).
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live IAM data in OXA-XXXX (see parent ticket).
 */

import {
  FileText,
  Shield,
  XCircle,
  AlertTriangle,
  Lock,
  Tag,
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
// Mock data
// ---------------------------------------------------------------------------

type PolicyEffect = "allow" | "deny" | "require_approval";
type ScopeKind = "org" | "workspace" | "global";
type SensitivityTag = "public" | "internal" | "confidential" | "restricted";

interface MockPolicy {
  id: string;
  name: string;
  capabilityId: string;
  effect: PolicyEffect;
  enforced: boolean;
  scope: ScopeKind;
  sensitivityTag: SensitivityTag | null;
  condition: string | null;
  createdAt: string;
}

const MOCK_POLICIES: MockPolicy[] = [
  {
    id: "pol_01j9xpqa",
    name: "Block external data exfiltration",
    capabilityId: "data.export",
    effect: "deny",
    enforced: true,
    scope: "org",
    sensitivityTag: "confidential",
    condition: "principal.kind == 'agent' && !principal.verified",
    createdAt: "May 25, 2026",
  },
  {
    id: "pol_02j9xpqb",
    name: "Allow knowledge ingestion for workspace agents",
    capabilityId: "knowledge.ingest",
    effect: "allow",
    enforced: true,
    scope: "workspace",
    sensitivityTag: "internal",
    condition: "resource.workspace_id == principal.workspace_id",
    createdAt: "May 28, 2026",
  },
  {
    id: "pol_03j9xpqc",
    name: "Require approval for high-cost model runs",
    capabilityId: "agent.run",
    effect: "require_approval",
    enforced: true,
    scope: "org",
    sensitivityTag: null,
    condition: "model.tier == 'premium' && credits.estimated > 50",
    createdAt: "May 30, 2026",
  },
  {
    id: "pol_04j9xpqd",
    name: "Public read-only for docs workspace",
    capabilityId: "workspace.read",
    effect: "allow",
    enforced: false,
    scope: "workspace",
    sensitivityTag: "public",
    condition: null,
    createdAt: "Jun 1, 2026",
  },
  {
    id: "pol_05j9xpqe",
    name: "Deny billing access from non-owner roles",
    capabilityId: "billing.manage",
    effect: "deny",
    enforced: true,
    scope: "org",
    sensitivityTag: "restricted",
    condition: "principal.role not in ['owner', 'billing']",
    createdAt: "Jun 2, 2026",
  },
  {
    id: "pol_06j9xpqf",
    name: "Allow web search for all members",
    capabilityId: "web.search",
    effect: "allow",
    enforced: false,
    scope: "org",
    sensitivityTag: null,
    condition: null,
    createdAt: "Jun 3, 2026",
  },
  {
    id: "pol_07j9xpqg",
    name: "Restrict infra operations to service accounts",
    capabilityId: "infra.deploy",
    effect: "deny",
    enforced: true,
    scope: "global",
    sensitivityTag: "restricted",
    condition: "principal.kind != 'service'",
    createdAt: "Jun 5, 2026",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EFFECT_LABEL: Record<PolicyEffect, string> = {
  allow: "Allow",
  deny: "Deny",
  require_approval: "Require approval",
};

const SENSITIVITY_VARIANT: Record<
  SensitivityTag,
  "default" | "muted" | "warning" | "destructive" | "outline"
> = {
  public: "outline",
  internal: "muted",
  confidential: "warning",
  restricted: "destructive",
};

function EffectBadge({ effect }: { effect: PolicyEffect }) {
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

export default function AccessPoliciesPage() {
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
              <FileText
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
            <div>
              <CardTitle>Conditional policies</CardTitle>
              <CardDescription>
                Enforced capability policies with optional CEL conditions and
                sensitivity tags. Evaluated after role grants.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardPanel>
          <div className="flex flex-col gap-2">
            {MOCK_POLICIES.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3"
              >
                <div className="flex flex-wrap items-start gap-3">
                  {/* Left: name + capability + condition */}
                  <div className="flex flex-1 flex-col gap-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">
                        {p.name}
                      </p>
                      {p.enforced && (
                        <Badge variant="destructive" className="text-[10px]">
                          <Lock
                            className="mr-1 h-2.5 w-2.5"
                            aria-hidden="true"
                          />
                          Enforced
                        </Badge>
                      )}
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                      {p.capabilityId}
                    </p>
                    {p.condition && (
                      <p className="font-mono text-[11px] text-muted-foreground/70 bg-muted/40 rounded-md px-2 py-1 mt-0.5 truncate">
                        if {p.condition}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground/60 mt-0.5">
                      Created {p.createdAt}
                    </p>
                  </div>

                  {/* Right: badges */}
                  <div className="flex shrink-0 flex-wrap items-center gap-2 mt-0.5">
                    <Badge variant="outline" className="text-xs capitalize">
                      {p.scope}
                    </Badge>
                    {p.sensitivityTag && (
                      <Badge
                        variant={SENSITIVITY_VARIANT[p.sensitivityTag]}
                        className="text-xs capitalize"
                      >
                        <Tag
                          className="mr-1 h-2.5 w-2.5"
                          aria-hidden="true"
                        />
                        {p.sensitivityTag}
                      </Badge>
                    )}
                    <EffectBadge effect={p.effect} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}
