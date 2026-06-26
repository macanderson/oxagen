import { ShieldCheck, Plus, MoreHorizontal, Users, Lock } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Static mock — no DB dependency (pure presentational; OXA-XXXX to wire)
// ---------------------------------------------------------------------------

interface Role {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  memberCount: number;
  capabilities: string[];
  createdAt: string;
}

const MOCK_ROLES: Role[] = [
  {
    id: "role_01",
    name: "Owner",
    description:
      "Full organization control. Cannot be removed from the last owner.",
    isSystem: true,
    memberCount: 1,
    capabilities: ["*"],
    createdAt: "2025-06-01",
  },
  {
    id: "role_02",
    name: "Admin",
    description:
      "Manage members, billing, and all workspace settings. Cannot modify owners.",
    isSystem: true,
    memberCount: 3,
    capabilities: [
      "members.*",
      "billing.*",
      "settings.*",
      "workspace.*",
      "knowledge.*",
      "automation.*",
      "chat.*",
    ],
    createdAt: "2025-06-01",
  },
  {
    id: "role_03",
    name: "Member",
    description:
      "Standard workspace access. Can use chat, knowledge, and automation features.",
    isSystem: true,
    memberCount: 12,
    capabilities: [
      "chat.message.send",
      "chat.message.list",
      "knowledge.source.list",
      "knowledge.source.get",
      "automation.agent.list",
      "automation.agent.execute",
    ],
    createdAt: "2025-06-01",
  },
  {
    id: "role_04",
    name: "Viewer",
    description:
      "Read-only access to workspace content. Cannot create or modify resources.",
    isSystem: true,
    memberCount: 5,
    capabilities: [
      "chat.message.list",
      "knowledge.source.list",
      "knowledge.source.get",
      "automation.agent.list",
    ],
    createdAt: "2025-06-01",
  },
  {
    id: "role_05",
    name: "Agent",
    description:
      "Machine identity role for automation agents with scoped capability access.",
    isSystem: true,
    memberCount: 4,
    capabilities: [
      "chat.message.send",
      "knowledge.source.list",
      "knowledge.source.get",
      "knowledge.source.ingest",
    ],
    createdAt: "2025-06-01",
  },
  {
    id: "role_06",
    name: "Deployer",
    description:
      "CI/CD service accounts that can trigger automation runs and manage deployments.",
    isSystem: false,
    memberCount: 2,
    capabilities: [
      "automation.agent.execute",
      "automation.playbook.execute",
      "knowledge.source.ingest",
    ],
    createdAt: "2026-02-10",
  },
  {
    id: "role_07",
    name: "Contractor",
    description:
      "Time-bound external collaborator with limited workspace access.",
    isSystem: false,
    memberCount: 3,
    capabilities: [
      "chat.message.send",
      "chat.message.list",
      "knowledge.source.list",
    ],
    createdAt: "2026-04-15",
  },
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessRolesPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        Preview · role CRUD not yet available
      </div>

      <Panel
        title="Roles"
        actions={
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground opacity-60 cursor-not-allowed"
            aria-label="Create role (coming soon)"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Create Role
          </button>
        }
      >
        <p className="mb-4 text-sm text-muted-foreground">
          Roles group capabilities into reusable permission sets. System roles
          are seeded at org creation; custom roles can be added for specialized
          access patterns.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {MOCK_ROLES.map((role) => (
            <div
              key={role.id}
              className="group flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/10 px-4 py-3.5 transition-colors hover:bg-muted/20"
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
                    <ShieldCheck
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-foreground">
                      {role.name}
                    </span>
                    {role.isSystem && (
                      <Badge variant="outline" className="text-[10px] gap-0.5">
                        <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                        System
                      </Badge>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  disabled
                  className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-50 cursor-not-allowed transition-opacity"
                  aria-label="Role actions"
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              {/* Description */}
              <p className="text-xs text-muted-foreground leading-snug">
                {role.description}
              </p>

              {/* Capabilities preview */}
              <div className="flex flex-wrap gap-1">
                {role.capabilities.slice(0, 4).map((cap) => (
                  <code
                    key={cap}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground"
                  >
                    {cap}
                  </code>
                ))}
                {role.capabilities.length > 4 && (
                  <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    +{role.capabilities.length - 4} more
                  </span>
                )}
              </div>

              {/* Footer meta */}
              <div className="flex items-center gap-3 pt-1 border-t border-border/30 mt-auto">
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Users className="h-3 w-3" aria-hidden="true" />
                  {role.memberCount}{" "}
                  {role.memberCount === 1 ? "principal" : "principals"}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Created {role.createdAt}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
