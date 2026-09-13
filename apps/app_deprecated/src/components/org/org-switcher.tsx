"use client";
import { EntityAvatar } from "@/components/avatar/entity-avatar";
import { useRouter } from "next/navigation";
import {
  ChevronsUpDown,
  Plus,
  Check,
  Settings,
  CreditCard,
} from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
} from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface OrgOption {
  publicId: string;
  slug: string;
  name: string;
  /** Org logo (public blob URL). Falls back to an initial when absent. */
  avatarUrl?: string | null;
  /** Human-readable subscription plan, e.g. "Free" / "Build". */
  planLabel?: string;
}

/** Identity of the active org — enriched (avatar/plan) from the org list. */
export interface CurrentOrg {
  publicId: string;
  slug: string;
  name: string;
}

/** Square org avatar: photo, designed avatar:v1: tile, or initials fallback. */
function OrgAvatar({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl?: string | null;
  className?: string;
}) {
  return (
    <EntityAvatar
      value={avatarUrl}
      name={name}
      shape="square"
      size="md"
      className={cn("shrink-0", className)}
    />
  );
}

export function OrgSwitcher({
  current,
  organizations,
}: {
  current: CurrentOrg;
  organizations: OrgOption[];
}) {
  const router = useRouter();
  // Enrich the active org (avatar + plan) from the list, which the org layout
  // selects with those fields; fall back to the bare identity if not found.
  const active = organizations.find((o) => o.publicId === current.publicId);
  const activeName = active?.name ?? current.name;
  const activePlan = active?.planLabel ?? "Free";

  return (
    <Menu>
      {/* Two-line trigger sized to the header row: avatar left, bold org name
          over a muted plan line, chevron right. `h-auto` lets it grow past the
          compact Button height so both lines fit. Below `md` the header can't
          fit the text column next to the workspace picker (it crushes to one
          letter per line), so the trigger collapses to avatar + chevron with a
          ≥44px tap target; the full name lives in the menu. */}
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            className="h-auto max-w-[16rem] gap-2 px-2 py-1.5 max-md:min-h-11"
          />
        }
      >
        <OrgAvatar name={activeName} avatarUrl={active?.avatarUrl} />
        <span className="hidden min-w-0 text-left leading-tight md:grid">
          <span className="truncate text-sm font-semibold">{activeName}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {activePlan}
          </span>
        </span>
        <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-64">
        <MenuGroupLabel>Organizations</MenuGroupLabel>
        {organizations.map((t) => (
          <MenuItem
            key={t.publicId}
            onClick={() => router.push(`/${t.slug}`)}
            className="gap-2 py-2"
          >
            <OrgAvatar name={t.name} avatarUrl={t.avatarUrl} />
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">{t.name}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {t.planLabel ?? "Free"}
              </span>
            </span>
            {t.publicId === current.publicId ? (
              <Check className="size-4 shrink-0" />
            ) : null}
          </MenuItem>
        ))}
        <MenuSeparator />
        {/* Governance shortcuts for the active org — settings + billing are
            otherwise only reachable once you're already on an org-scope page. */}
        <MenuItem
          onClick={() => router.push(`/${current.slug}/settings/general`)}
          className="gap-2 py-2"
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
          >
            <Settings className="size-4" />
          </span>
          Organization settings
        </MenuItem>
        <MenuItem
          onClick={() => router.push(`/${current.slug}/billing`)}
          className="gap-2 py-2"
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center text-muted-foreground"
          >
            <CreditCard className="size-4" />
          </span>
          Billing &amp; plans
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() => router.push("/new-organization")}
          className="gap-2 py-2"
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground"
          >
            <Plus className="size-4" />
          </span>
          New organization
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
