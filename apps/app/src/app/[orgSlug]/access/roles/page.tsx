/**
 * Roles tab — static mock UI.
 *
 * Displays role cards for the 5 built-in roles (Owner/Admin/Billing/Member/Viewer)
 * with permission summaries.
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live IAM data in OXA-XXXX (see parent ticket).
 */

import {
  Crown,
  ShieldCheck,
  CreditCard,
  Users,
  Eye,
  Lock,
  Check,
  Minus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

type PermissionState = "full" | "limited" | "none";

interface RolePermission {
  label: string;
  state: PermissionState;
}

interface MockRole {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: LucideIcon;
  iconColor: string;
  isSystem: boolean;
  memberCount: number;
  permissions: RolePermission[];
}

const MOCK_ROLES: MockRole[] = [
  {
    id: "role_owner",
    slug: "owner",
    name: "Owner",
    description:
      "Full control over the organization. Can manage billing, members, security, and all settings.",
    icon: Crown,
    iconColor: "text-foreground",
    isSystem: true,
    memberCount: 1,
    permissions: [
      { label: "Manage members", state: "full" },
      { label: "Manage billing", state: "full" },
      { label: "Configure security", state: "full" },
      { label: "Manage integrations", state: "full" },
      { label: "Run agents", state: "full" },
      { label: "Delete organization", state: "full" },
    ],
  },
  {
    id: "role_admin",
    slug: "admin",
    name: "Admin",
    description:
      "Can invite members, manage workspaces, and configure most org settings. Cannot access billing.",
    icon: ShieldCheck,
    iconColor: "text-foreground",
    isSystem: true,
    memberCount: 2,
    permissions: [
      { label: "Manage members", state: "full" },
      { label: "Manage billing", state: "none" },
      { label: "Configure security", state: "limited" },
      { label: "Manage integrations", state: "full" },
      { label: "Run agents", state: "full" },
      { label: "Delete organization", state: "none" },
    ],
  },
  {
    id: "role_billing",
    slug: "billing",
    name: "Billing",
    description:
      "Read and write access to billing, subscriptions, and usage. Cannot manage members or security.",
    icon: CreditCard,
    iconColor: "text-foreground",
    isSystem: true,
    memberCount: 1,
    permissions: [
      { label: "Manage members", state: "none" },
      { label: "Manage billing", state: "full" },
      { label: "Configure security", state: "none" },
      { label: "Manage integrations", state: "none" },
      { label: "Run agents", state: "limited" },
      { label: "Delete organization", state: "none" },
    ],
  },
  {
    id: "role_member",
    slug: "member",
    name: "Member",
    description:
      "Standard access. Can use agents and contribute to workspaces they belong to.",
    icon: Users,
    iconColor: "text-foreground",
    isSystem: true,
    memberCount: 4,
    permissions: [
      { label: "Manage members", state: "none" },
      { label: "Manage billing", state: "none" },
      { label: "Configure security", state: "none" },
      { label: "Manage integrations", state: "none" },
      { label: "Run agents", state: "full" },
      { label: "Delete organization", state: "none" },
    ],
  },
  {
    id: "role_viewer",
    slug: "viewer",
    name: "Viewer",
    description:
      "Read-only access to workspaces and knowledge. Cannot run agents or modify any settings.",
    icon: Eye,
    iconColor: "text-muted-foreground",
    isSystem: true,
    memberCount: 2,
    permissions: [
      { label: "Manage members", state: "none" },
      { label: "Manage billing", state: "none" },
      { label: "Configure security", state: "none" },
      { label: "Manage integrations", state: "none" },
      { label: "Run agents", state: "none" },
      { label: "Delete organization", state: "none" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function PermissionRow({ label, state }: RolePermission) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      {state === "full" ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-label="Full access" />
      ) : state === "limited" ? (
        <Minus className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Limited access" />
      ) : (
        <Minus className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" aria-label="No access" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessRolesPage() {
  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <p className="text-[11px] text-muted-foreground/60 font-medium">
        Preview &middot; not yet wired to live data
      </p>

      <Panel title="Role builder">
        <p className="mb-4 text-sm text-muted-foreground">
          System and custom roles for this organization. System roles are
          seeded on org creation and cannot be deleted.
        </p>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MOCK_ROLES.map((role) => {
            const RoleIcon = role.icon;
            return (
              <div
                key={role.id}
                className="flex flex-col rounded-xl border border-border/60 bg-card p-4 gap-3"
              >
                {/* Role header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/40 bg-muted/60">
                      <RoleIcon
                        className={`h-4 w-4 ${role.iconColor}`}
                        aria-hidden="true"
                      />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-foreground leading-tight">
                        {role.name}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {role.memberCount}{" "}
                        {role.memberCount === 1 ? "member" : "members"}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {role.isSystem && (
                      <Badge variant="muted" className="text-[10px]">
                        <Lock className="mr-1 h-2.5 w-2.5" aria-hidden="true" />
                        System
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Description */}
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {role.description}
                </p>

                {/* Permissions */}
                <div className="border-t border-border/40 pt-3 flex flex-col divide-y divide-border/30">
                  {role.permissions.map((p) => (
                    <PermissionRow key={p.label} {...p} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
