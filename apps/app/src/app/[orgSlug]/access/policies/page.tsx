import { Plus, MoreHorizontal } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Static mock — no DB dependency (pure presentational; OXA-XXXX to wire)
// ---------------------------------------------------------------------------

interface Policy {
  id: string;
  name: string;
  description: string;
  effect: "allow" | "deny";
  capabilities: string[];
  condition: string | null;
  priority: number;
  attachedTo: string[];
  createdAt: string;
  updatedAt: string;
}

const MOCK_POLICIES: Policy[] = [
  {
    id: "pol_01",
    name: "workspace-chat-allow",
    description:
      "Allow all members to send chat messages within their workspace.",
    effect: "allow",
    capabilities: ["chat.message.send", "chat.message.list"],
    condition: "resource.workspaceId == principal.workspaceId",
    priority: 100,
    attachedTo: ["role:Member"],
    createdAt: "2025-10-01",
    updatedAt: "2025-10-01",
  },
  {
    id: "pol_02",
    name: "deny-billing-non-admin",
    description: "Deny billing mutations for non-admin roles.",
    effect: "deny",
    capabilities: [
      "billing.subscription.update",
      "billing.subscription.cancel",
    ],
    condition: '!principal.roles.exists(r, r in ["Owner", "Admin"])',
    priority: 200,
    attachedTo: ["role:Member", "role:Viewer"],
    createdAt: "2025-11-12",
    updatedAt: "2026-01-05",
  },
  {
    id: "pol_03",
    name: "agent-knowledge-read",
    description: "Allow agents to read knowledge sources but not mutate them.",
    effect: "allow",
    capabilities: ["knowledge.source.list", "knowledge.source.get"],
    condition: 'principal.type == "agent"',
    priority: 150,
    attachedTo: ["role:Agent"],
    createdAt: "2026-01-20",
    updatedAt: "2026-01-20",
  },
  {
    id: "pol_04",
    name: "time-bound-access",
    description: "Allow access only during business hours (Mon-Fri 9-17 UTC).",
    effect: "allow",
    capabilities: ["*"],
    condition:
      "request.time.getDayOfWeek() in [1,2,3,4,5] && request.time.getHours() >= 9 && request.time.getHours() < 17",
    priority: 50,
    attachedTo: ["role:Contractor"],
    createdAt: "2026-02-14",
    updatedAt: "2026-03-01",
  },
  {
    id: "pol_05",
    name: "deny-destructive-ops",
    description: "Deny all delete operations for viewers.",
    effect: "deny",
    capabilities: ["*.delete", "*.remove", "*.destroy"],
    condition: null,
    priority: 300,
    attachedTo: ["role:Viewer"],
    createdAt: "2026-03-22",
    updatedAt: "2026-03-22",
  },
];

const EFFECT_BADGE: Record<Policy["effect"], string> = {
  allow: "bg-success/10 text-success",
  deny: "bg-destructive/10 text-destructive",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessPoliciesPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* OXA-XXXX indicator */}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        OXA-XXXX · not yet wired to live data
      </div>

      <Panel
        title="Access Policies"
        actions={
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground opacity-60 cursor-not-allowed"
            aria-label="Create policy (coming soon)"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Create Policy
          </button>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Conditional allow/deny rules evaluated by the IAM kernel. Policies
          attach to roles and use CEL expressions for fine-grained conditions.
        </p>

        <div className="flex flex-col gap-4">
          {MOCK_POLICIES.map((policy) => (
            <div
              key={policy.id}
              className="rounded-xl border border-border/60 bg-muted/10 px-4 py-3.5 transition-colors hover:bg-muted/20"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1.5 min-w-0">
                  {/* Header row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">
                      {policy.name}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${EFFECT_BADGE[policy.effect]}`}
                    >
                      {policy.effect}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      priority: {policy.priority}
                    </span>
                  </div>

                  {/* Description */}
                  <p className="text-xs text-muted-foreground leading-snug">
                    {policy.description}
                  </p>

                  {/* Capabilities */}
                  <div className="flex flex-wrap gap-1 mt-1">
                    {policy.capabilities.map((cap) => (
                      <code
                        key={cap}
                        className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                      >
                        {cap}
                      </code>
                    ))}
                  </div>

                  {/* Condition */}
                  {policy.condition && (
                    <div className="mt-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                        Condition (CEL)
                      </span>
                      <pre className="mt-0.5 rounded bg-muted/60 px-2 py-1 font-mono text-[11px] text-foreground overflow-x-auto">
                        {policy.condition}
                      </pre>
                    </div>
                  )}

                  {/* Attached roles */}
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                      Attached to:
                    </span>
                    {policy.attachedTo.map((target) => (
                      <Badge
                        key={target}
                        variant="outline"
                        className="text-[10px]"
                      >
                        {target}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Actions */}
                <button
                  type="button"
                  disabled
                  className="rounded p-1 text-muted-foreground opacity-50 cursor-not-allowed shrink-0"
                  aria-label="Policy actions"
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
