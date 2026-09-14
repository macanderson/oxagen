"use client";
// Organization and workspace switchers at the top of the sidebar, per the
// mockup's org-switch and ws-switch dialogs.
import { Dialog } from "@base-ui/react/dialog";
import { Check, ChevronsUpDown, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { NavCounts, ShellContext } from "@/data/contracts/shell";
import { filterByName } from "./switcher-filter";
import { workspaceHref } from "./nav";

const triggerClass =
  "mb-2 flex w-full items-center gap-2.5 rounded-lg border border-sidebar-border bg-app-panel-bg px-2.5 py-2 text-left text-app-panel-fg transition-colors hover:border-input focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const popupClass =
  "fixed left-1/2 top-[12vh] z-50 flex max-h-[76dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col gap-3 overflow-y-auto rounded-lg border border-dialog-border bg-dialog-bg p-5 text-dialog-fg shadow-lg";

const optionClass =
  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring";

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

function SwitcherDialog({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  const t = useTranslations("shell.switcher");
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay-scrim" />
        <Dialog.Popup className={popupClass}>
          <div className="flex items-center gap-2">
            <Dialog.Title className="text-base font-semibold">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label={t("close")}
              className="ml-auto rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function OrgSwitcher({ context }: { context: ShellContext }) {
  const t = useTranslations("shell.switcher.org");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { org } = context;
  const orgs = filterByName(context.orgs, query);
  return (
    <>
      <button
        type="button"
        className={triggerClass}
        aria-label={t("trigger", { name: org.name })}
        onClick={() => {
          setOpen(true);
        }}
      >
        <Tile text={org.name.slice(0, 1).toLocaleUpperCase()} />
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[13px] font-semibold">{org.name}</b>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {org.plan === null
              ? t("detailNoPlan", { slug: org.slug })
              : t("detail", { slug: org.slug, plan: org.plan })}
          </span>
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="size-3.5 flex-none text-muted-foreground"
        />
      </button>
      <SwitcherDialog open={open} onOpenChange={setOpen} title={t("title")}>
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          aria-label={t("search")}
          placeholder={t("search")}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
        />
        <ul className="flex flex-col gap-1">
          {orgs.map((o) => {
            const current = o.slug === org.slug;
            return (
              <li key={o.slug}>
                <Link
                  href={`/${encodeURIComponent(o.slug)}`}
                  className={optionClass}
                  aria-current={current ? "page" : undefined}
                  onClick={() => {
                    setOpen(false);
                  }}
                >
                  <Tile text={o.name.slice(0, 1).toLocaleUpperCase()} />
                  <span className="min-w-0 flex-1">
                    <b className="block truncate text-sm">{o.name}</b>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {o.plan === null
                        ? t("detailNoPlan", { slug: o.slug })
                        : t("detail", { slug: o.slug, plan: o.plan })}
                    </span>
                  </span>
                  {current ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check aria-hidden="true" className="size-3.5" />
                      {t("current")}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
        {orgs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("note")}
        </p>
      </SwitcherDialog>
    </>
  );
}

export function WorkspaceSwitcher({
  context,
  current,
  counts,
}: {
  context: ShellContext;
  current: string | null;
  counts: Record<string, NavCounts> | null;
}) {
  const t = useTranslations("shell.switcher.ws");
  const [open, setOpen] = useState(false);
  const { org, workspaces } = context;
  const ws = workspaces.find((w) => w.slug === current) ?? null;
  const detail = (w: (typeof workspaces)[number]) =>
    w.mainRepo === null
      ? t("noRepo")
      : t("detail", { repo: w.mainRepo, branch: w.productionBranch ?? "" });
  return (
    <>
      {ws === null ? null : (
        <button
          type="button"
          className={triggerClass}
          aria-label={t("trigger", { name: ws.name })}
          onClick={() => {
            setOpen(true);
          }}
        >
          <Tile text={ws.slug.slice(0, 2)} mono />
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13px] font-semibold">
              {ws.name}
            </b>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {detail(ws)}
            </span>
          </span>
          <ChevronsUpDown
            aria-hidden="true"
            className="size-3.5 flex-none text-muted-foreground"
          />
        </button>
      )}
      <SwitcherDialog open={open} onOpenChange={setOpen} title={t("title")}>
        {workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {workspaces.map((w) => {
              const isCurrent = w.slug === current;
              const agents = counts?.[w.slug]?.agents ?? w.agentCount;
              return (
                <li key={w.slug}>
                  <Link
                    href={workspaceHref(org.slug, w.slug, "fleet")}
                    className={optionClass}
                    aria-current={isCurrent ? "page" : undefined}
                    onClick={() => {
                      setOpen(false);
                    }}
                  >
                    <Tile text={w.slug.slice(0, 2)} mono />
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-sm">{w.name}</b>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {detail(w)}
                        {agents === null
                          ? null
                          : ` · ${t("agents", { count: agents })}`}
                      </span>
                    </span>
                    {isCurrent ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Check aria-hidden="true" className="size-3.5" />
                        {t("current")}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("manage")}</p>
      </SwitcherDialog>
    </>
  );
}
