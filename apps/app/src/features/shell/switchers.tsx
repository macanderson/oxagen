"use client";
// The organization and workspace switchers at the top of the sidebar (mockup
// `sidebar()` and its org-switch and ws-switch dialogs). Each tile opens a
// dialog listing what `shell.context` read, the current choice marked; a
// refused or failed read says so in the dialog, and the tile still names the
// organization and workspace the page is in.
import { ChevronsUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { ShellData } from "./shell-data";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

type Choice = { slug: string; name: string; href: SafePath };

const tileClass =
  "mb-[7px] flex w-full items-center gap-[9px] rounded-[10px] border border-border bg-card px-2.5 py-2 text-left text-card-foreground transition-colors hover:border-rule focus-visible:outline-2 focus-visible:outline-ring";

function Tile({ text, mono }: { text: string; mono?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        mono
          ? "grid size-6 flex-none place-items-center rounded-md border border-rule bg-hl font-mono text-[11px] text-foreground"
          : "grid size-6 flex-none place-items-center rounded-md bg-gold text-[11px] font-bold text-on-gold"
      }
    >
      {text}
    </span>
  );
}

function Switcher({
  title,
  testId,
  current,
  choices,
  children,
}: {
  title: string;
  testId: string;
  current: string;
  choices: Read<Choice[]>;
  children: ReactNode;
}) {
  const t = useTranslations("shell.switcher");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        data-touch-target=""
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
        className={tileClass}
      >
        <span className="sr-only">{title}</span>
        {children}
        <ChevronsUpDown
          aria-hidden="true"
          className="size-3.5 flex-none text-muted-foreground"
        />
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        testId={`${testId}-dialog`}
      >
        {choices.ok ? (
          <ul className="flex flex-col gap-1">
            {choices.value.map((choice) => {
              const isCurrent = choice.slug === current;
              return (
                <li key={choice.slug}>
                  <SafeLink
                    to={choice.href}
                    data-touch-target=""
                    aria-current={isCurrent ? "true" : undefined}
                    onClick={() => {
                      setOpen(false);
                    }}
                    className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="min-w-0 flex-1">
                      <b className="block truncate text-sm font-semibold">
                        {choice.name}
                      </b>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {choice.slug}
                      </span>
                    </span>
                    {isCurrent ? (
                      <span className="text-xs text-muted-foreground">
                        {t("current")}
                      </span>
                    ) : null}
                  </SafeLink>
                </li>
              );
            })}
          </ul>
        ) : (
          <p
            role="status"
            data-read={choices.reason}
            className="text-sm text-muted-foreground"
          >
            {choices.reason === "denied" ? t("denied") : t("unavailable")}
          </p>
        )}
      </SheetDialog>
    </>
  );
}

export function OrgSwitcher({ data }: { data: ShellData }) {
  const t = useTranslations("shell.switcher");
  const { org, context } = data;
  const choices: Read<Choice[]> = context.ok
    ? {
        ok: true,
        value: context.value.orgs.map((o) => ({
          ...o,
          href: routes.people(o.slug),
        })),
      }
    : context;
  return (
    <Switcher
      title={t("org")}
      testId="org-switcher"
      current={org.slug}
      choices={choices}
    >
      <Tile text={org.name.slice(0, 1).toLocaleUpperCase()} />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[13px] font-semibold">{org.name}</b>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {org.slug}
        </span>
      </span>
    </Switcher>
  );
}

/** The workspace the sidebar points at; nothing when the organization has none the viewer can open. */
export function WorkspaceSwitcher({
  data,
  ws,
}: {
  data: ShellData;
  ws: string | null;
}) {
  const t = useTranslations("shell.switcher");
  if (ws === null) return null;
  const { org, context } = data;
  const choices: Read<Choice[]> = context.ok
    ? {
        ok: true,
        value: context.value.workspaces.map((w) => ({
          ...w,
          href: routes.fleet(org.slug, w.slug),
        })),
      }
    : context;
  const name = choices.ok
    ? (choices.value.find((w) => w.slug === ws)?.name ?? ws)
    : ws;
  return (
    <Switcher
      title={t("ws")}
      testId="workspace-switcher"
      current={ws}
      choices={choices}
    >
      <Tile text={ws.slice(0, 2)} mono />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[13px] font-semibold">{name}</b>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {ws}
        </span>
      </span>
    </Switcher>
  );
}
