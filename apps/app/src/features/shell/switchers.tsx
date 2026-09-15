"use client";
// The organization and workspace tiles at the top of the sidebar. Between
// WL-08 and WL-11 they show the current organization from the layout's viewer
// and the current workspace from the URL, with no list to switch to: the lists
// return with `shell.context` (WL-11) and the switcher dialogs with WL-32.
import { useTranslations } from "next-intl";
import type { ShellData } from "./shell-data";

const tileClass =
  "mb-2 flex w-full items-center gap-2.5 rounded-lg border border-sidebar-border bg-app-panel-bg px-2.5 py-2 text-left text-app-panel-fg";

function Tile({ text, mono }: { text: string; mono?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        mono
          ? "grid size-6 flex-none place-items-center rounded-md border border-input bg-muted font-mono text-[11px] text-foreground"
          : "grid size-6 flex-none place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground"
      }
    >
      {text}
    </span>
  );
}

export function OrgSwitcher({ org }: { org: ShellData["org"] }) {
  const t = useTranslations("shell.switcher");
  return (
    <div
      role="group"
      aria-label={t("org")}
      data-testid="org-switcher"
      className={tileClass}
    >
      <Tile text={org.name.slice(0, 1).toLocaleUpperCase()} />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[13px] font-semibold">{org.name}</b>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {org.slug}
        </span>
      </span>
    </div>
  );
}

/** The workspace in the URL; nothing on an organization page. */
export function WorkspaceSwitcher({ current }: { current: string | null }) {
  const t = useTranslations("shell.switcher");
  if (current === null) return null;
  return (
    <div
      role="group"
      aria-label={t("ws")}
      data-testid="workspace-switcher"
      className={tileClass}
    >
      <Tile text={current.slice(0, 2)} mono />
      <span className="min-w-0 flex-1">
        <b className="block truncate font-mono text-[13px] font-semibold">
          {current}
        </b>
      </span>
    </div>
  );
}
