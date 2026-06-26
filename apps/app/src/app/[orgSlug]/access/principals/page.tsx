import { Plus, MoreHorizontal, ShieldCheck, Bot, Server } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Static mock — no DB dependency (pure presentational; OXA-XXXX to wire)
// ---------------------------------------------------------------------------

interface Principal {
  id: string;
  name: string;
  email: string | null;
  type: "user" | "service" | "agent";
  status: "active" | "suspended" | "pending";
  mfaEnabled: boolean;
  roles: string[];
  lastActiveAt: string | null;
  createdAt: string;
}

const MOCK_PRINCIPALS: Principal[] = [
  {
    id: "prin_01",
    name: "Alice Johnson",
    email: "alice@acme.co",
    type: "user",
    status: "active",
    mfaEnabled: true,
    roles: ["Owner"],
    lastActiveAt: "2026-06-24",
    createdAt: "2025-06-01",
  },
  {
    id: "prin_02",
    name: "Bob Chen",
    email: "bob@acme.co",
    type: "user",
    status: "active",
    mfaEnabled: true,
    roles: ["Admin"],
    lastActiveAt: "2026-06-23",
    createdAt: "2025-07-15",
  },
  {
    id: "prin_03",
    name: "ci-deploy-bot",
    email: null,
    type: "service",
    status: "active",
    mfaEnabled: false,
    roles: ["Deployer"],
    lastActiveAt: "2026-06-25",
    createdAt: "2025-11-01",
  },
  {
    id: "prin_04",
    name: "research-agent",
    email: null,
    type: "agent",
    status: "active",
    mfaEnabled: false,
    roles: ["Agent"],
    lastActiveAt: "2026-06-24",
    createdAt: "2026-01-08",
  },
  {
    id: "prin_05",
    name: "Carol Martinez",
    email: "carol@acme.co",
    type: "user",
    status: "pending",
    mfaEnabled: false,
    roles: ["Member"],
    lastActiveAt: null,
    createdAt: "2026-06-20",
  },
  {
    id: "prin_06",
    name: "data-pipeline-svc",
    email: null,
    type: "service",
    status: "active",
    mfaEnabled: false,
    roles: ["Ingester"],
    lastActiveAt: "2026-06-25",
    createdAt: "2026-04-01",
  },
  {
    id: "prin_07",
    name: "Dan Williams",
    email: "dan@acme.co",
    type: "user",
    status: "suspended",
    mfaEnabled: true,
    roles: ["Member"],
    lastActiveAt: "2026-05-10",
    createdAt: "2025-09-20",
  },
  {
    id: "prin_08",
    name: "support-agent",
    email: null,
    type: "agent",
    status: "active",
    mfaEnabled: false,
    roles: ["Agent", "Viewer"],
    lastActiveAt: "2026-06-24",
    createdAt: "2026-03-10",
  },
];

const TYPE_ICON: Record<
  Principal["type"],
  React.ComponentType<{ className?: string }>
> = {
  user: ShieldCheck,
  service: Server,
  agent: Bot,
};

const TYPE_BADGE: Record<Principal["type"], string> = {
  user: "bg-blue-500/10 text-blue-600",
  service: "bg-purple-500/10 text-purple-600",
  agent: "bg-amber-500/10 text-amber-600",
};

const STATUS_BADGE: Record<Principal["status"], string> = {
  active: "bg-success/10 text-success",
  suspended: "bg-destructive/10 text-destructive",
  pending: "bg-warning/10 text-warning",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessPrincipalsPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* OXA-XXXX indicator */}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        OXA-XXXX · not yet wired to live data
      </div>

      <Panel
        title="Principals"
        actions={
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground opacity-60 cursor-not-allowed"
            aria-label="Add principal (coming soon)"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add Principal
          </button>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          All identities that can be granted capabilities — users, service
          accounts, and agents — unified in a single registry.
        </p>

        <div className="overflow-hidden rounded-lg border border-border/60">
          <table className="w-full text-sm" aria-label="Principals">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30">
                <th className="py-2.5 pl-4 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Identity
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Type
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Status
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  MFA
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Roles
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Last Active
                </th>
                <th className="py-2.5 pl-3 pr-4 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {MOCK_PRINCIPALS.map((principal) => {
                const TypeIcon = TYPE_ICON[principal.type];
                return (
                  <tr
                    key={principal.id}
                    className="border-b border-border/40 last:border-b-0 hover:bg-muted/20 transition-colors"
                  >
                    <td className="py-3 pl-4 pr-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                          <TypeIcon
                            className="h-3.5 w-3.5 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </span>
                        <div className="flex flex-col gap-0 min-w-0">
                          <span className="text-sm font-medium text-foreground truncate">
                            {principal.name}
                          </span>
                          {principal.email && (
                            <span className="text-xs text-muted-foreground truncate">
                              {principal.email}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${TYPE_BADGE[principal.type]}`}
                      >
                        {principal.type}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[principal.status]}`}
                      >
                        {principal.status}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-xs text-muted-foreground">
                      {principal.mfaEnabled ? (
                        <Badge
                          variant="outline"
                          className="text-[10px] text-success border-success/30"
                        >
                          Enabled
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex flex-wrap gap-1">
                        {principal.roles.map((role) => (
                          <Badge
                            key={role}
                            variant="outline"
                            className="text-[10px]"
                          >
                            {role}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-xs text-muted-foreground whitespace-nowrap">
                      {principal.lastActiveAt ?? "Never"}
                    </td>
                    <td className="py-3 pl-3 pr-4">
                      <button
                        type="button"
                        disabled
                        className="rounded p-1 text-muted-foreground opacity-50 cursor-not-allowed"
                        aria-label="Principal actions"
                      >
                        <MoreHorizontal
                          className="h-4 w-4"
                          aria-hidden="true"
                        />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
