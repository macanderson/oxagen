"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Plus, Check } from "lucide-react";
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

/** Square org avatar: the logo image, or the name's initial in a muted tile. */
function OrgAvatar({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl?: string | null;
  className?: string;
}) {
  if (avatarUrl) {
    return (
      <Image
        src={avatarUrl}
        alt=""
        aria-hidden="true"
        width={32}
        height={32}
        className={cn("size-8 shrink-0 rounded-md object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md bg-foreground/[0.08] text-xs font-semibold uppercase text-foreground",
        className,
      )}
    >
      {name.charAt(0)}
    </span>
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
          compact Button height so both lines fit. */}
      <MenuTrigger render={<Button variant="ghost" className="h-auto max-w-[16rem] gap-2 px-2 py-1.5" />}>
        <OrgAvatar name={activeName} avatarUrl={active?.avatarUrl} />
        <span className="grid min-w-0 text-left leading-tight">
          <span className="truncate text-sm font-semibold">{activeName}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{activePlan}</span>
        </span>
        <ChevronsUpDown className="ml-1 size-3.5 shrink-0 opacity-50" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-64">
        <MenuGroupLabel>Organizations</MenuGroupLabel>
        {organizations.map((t) => (
          <MenuItem key={t.publicId} onClick={() => router.push(`/${t.slug}`)} className="gap-2 py-2">
            <OrgAvatar name={t.name} avatarUrl={t.avatarUrl} />
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">{t.name}</span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {t.planLabel ?? "Free"}
              </span>
            </span>
            {t.publicId === current.publicId ? <Check className="size-4 shrink-0" /> : null}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => router.push("/new-organization")} className="gap-2 py-2">
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
