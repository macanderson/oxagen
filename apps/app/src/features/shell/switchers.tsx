"use client";
// The organization and workspace switchers at the top of the sidebar (mockup
// `sidebar()` and its org-switch and ws-switch dialogs). Each tile opens a
// dialog listing what `shell.context` read, the current choice marked; a
// refused or failed read says so in the dialog, and the tile still names the
// organization and workspace the page is in.
//
// The organization dialog has the mock's search field and its note about what
// an organization owns; the workspace dialog ends on Create a workspace, which
// goes to the Workspaces section of the Organization page where the governed
// `create_workspace` form lives. The mock's meta (plan, agent counts, main
// repository and branch) is not returned by `list_orgs` or `list_workspaces`,
// so each dialog says so once. Each tile prints only what the read returned:
// `acme` where the mock has `a-intel · Team`, `acme/core-platform` where it
// has `a-intel/platform · main` (#3861).
//
// Each tile and each dialog row draws the avatar set on the Organization page.
// An organization or workspace with none keeps the mock's letter tile: the
// first letter on gold for an organization, two mono letters for a workspace.
// A refused or failed read has no avatar to draw, so the tile falls back too.
import { ChevronsUpDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import type { ShellData } from "./shell-data";
import type { Read } from "@/data/read";
import { routes, type SafePath } from "@/shared/safe-path";
import { Avatar } from "@/ui/avatar";
import { buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

type Choice = {
  slug: string;
  name: string;
  avatarUrl: string | null;
  href: SafePath;
};

/** The issue that owns the switchers' missing meta, carried as a data attribute only. */
const META_GAP = "#3861";

/** Every whitespace-separated term appears in the name or the slug, ignoring case. */
function matchesChoice(choice: Choice, query: string): boolean {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${choice.name} ${choice.slug}`.toLocaleLowerCase();
  return terms.every((term) => hay.includes(term));
}

const tileClass =
  "mb-[7px] flex w-full items-center gap-[9px] rounded-[10px] border border-border bg-card px-2.5 py-2 text-left text-card-foreground transition-colors hover:border-rule focus-visible:outline-2 focus-visible:outline-ring";

/** An organization's or a workspace's avatar, or its letter tile when none is set. */
function ChoiceAvatar({
  kind,
  choice,
  testId,
}: {
  kind: "org" | "ws";
  choice: { slug: string; name: string; avatarUrl: string | null };
  testId?: string;
}) {
  return kind === "org" ? (
    <Avatar
      value={choice.avatarUrl}
      initials={choice.name.slice(0, 1).toLocaleUpperCase()}
      size={24}
      shape="agent"
      fallbackTone="gold"
      testId={testId}
    />
  ) : (
    <Avatar
      value={choice.avatarUrl}
      initials={choice.slug.slice(0, 2)}
      size={24}
      shape="agent"
      fallbackFont="mono"
      testId={testId}
    />
  );
}

/** The dialog a switcher opens: what `shell.context` read, the current choice marked. */
export function SwitcherDialog({
  title,
  testId,
  kind,
  current,
  choices,
  open,
  onOpenChange,
  createHref,
}: {
  title: string;
  testId: string;
  /** Which list: the organization dialog searches and carries the note; the workspace one ends on Create a workspace. */
  kind: "org" | "ws";
  current: string;
  choices: Read<Choice[]>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where Create a workspace goes; the workspace dialog only. */
  createHref?: SafePath;
}) {
  const t = useTranslations("shell.switcher");
  const [query, setQuery] = useState("");
  const searchId = useId();
  const shown = choices.ok
    ? choices.value.filter((c) => matchesChoice(c, query))
    : [];
  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
      title={title}
      testId={`${testId}-dialog`}
    >
      {choices.ok ? (
        <>
          {kind === "org" ? (
            <>
              <label htmlFor={searchId} className="sr-only">
                {t("searchOrgs")}
              </label>
              <input
                id={searchId}
                type="search"
                data-testid={`${testId}-search`}
                placeholder={t("searchOrgs")}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                className="mb-2.5 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
            </>
          ) : null}
          {shown.length === 0 ? (
            <p
              role="status"
              className="px-1 py-2 text-sm text-muted-foreground"
            >
              {t("noMatch", { query })}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {shown.map((choice) => {
                const isCurrent = choice.slug === current;
                return (
                  <li key={choice.slug}>
                    <SafeLink
                      to={choice.href}
                      data-touch-target=""
                      aria-current={isCurrent ? "true" : undefined}
                      onClick={() => {
                        onOpenChange(false);
                      }}
                      className={`flex items-center gap-3 rounded-md px-3 py-2 hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring ${
                        isCurrent ? "bg-hl" : ""
                      }`}
                    >
                      <ChoiceAvatar kind={kind} choice={choice} />
                      <span className="min-w-0 flex-1">
                        <b className="block truncate text-sm font-semibold">
                          {choice.name}
                        </b>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {choice.slug}
                        </span>
                      </span>
                      {isCurrent ? (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {t("current")}
                        </span>
                      ) : null}
                    </SafeLink>
                  </li>
                );
              })}
            </ul>
          )}
          <p
            data-testid="switcher-meta-not-backed"
            data-gap={META_GAP}
            className="mt-2 text-xs text-muted-foreground"
          >
            {kind === "org" ? t("orgMetaNotBacked") : t("wsMetaNotBacked")}
          </p>
          {kind === "org" ? (
            <p className="mt-3 border-l-2 border-gold px-3 py-1 text-[12.5px] leading-relaxed text-muted-foreground">
              {t("orgNote", { count: choices.value.length })}
            </p>
          ) : createHref === undefined ? null : (
            <div className="mt-3 border-t border-border pt-3">
              <SafeLink
                to={createHref}
                data-testid="create-workspace-link"
                onClick={() => {
                  onOpenChange(false);
                }}
                className={buttonSecondary}
              >
                {t("createWorkspace")}
              </SafeLink>
            </div>
          )}
        </>
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
  );
}

function Switcher({
  title,
  testId,
  kind,
  current,
  choices,
  createHref,
  children,
}: {
  title: string;
  testId: string;
  kind: "org" | "ws";
  current: string;
  choices: Read<Choice[]>;
  createHref?: SafePath;
  children: ReactNode;
}) {
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
      <SwitcherDialog
        title={title}
        testId={testId}
        kind={kind}
        current={current}
        choices={choices}
        open={open}
        onOpenChange={setOpen}
        {...(createHref === undefined ? {} : { createHref })}
      />
    </>
  );
}

/** The organizations the viewer belongs to, each linking to its Organization page. */
export function orgChoices(data: ShellData): Read<Choice[]> {
  const { context } = data;
  return context.ok
    ? {
        ok: true,
        value: context.value.orgs.map((o) => ({
          ...o,
          href: routes.people(o.slug),
        })),
      }
    : context;
}

/** The organization's workspaces the viewer belongs to, each linking to its Fleet. */
export function workspaceChoices(data: ShellData): Read<Choice[]> {
  const { org, context } = data;
  return context.ok
    ? {
        ok: true,
        value: context.value.workspaces.map((w) => ({
          ...w,
          href: routes.fleet(org.slug, w.slug),
        })),
      }
    : context;
}

export function OrgSwitcher({ data }: { data: ShellData }) {
  const t = useTranslations("shell.switcher");
  const { org } = data;
  const choices = orgChoices(data);
  // The page's organization is always one of the viewer's, so its avatar is
  // the listed one; a read that did not list leaves the letter tile.
  const avatarUrl = choices.ok
    ? (choices.value.find((o) => o.slug === org.slug)?.avatarUrl ?? null)
    : null;
  return (
    <Switcher
      title={t("org")}
      testId="org-switcher"
      kind="org"
      current={org.slug}
      choices={choices}
    >
      <ChoiceAvatar
        kind="org"
        choice={{ slug: org.slug, name: org.name, avatarUrl }}
        testId="org-switcher-avatar"
      />
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
  const choices = workspaceChoices(data);
  const listed = choices.ok
    ? choices.value.find((w) => w.slug === ws)
    : undefined;
  const name = listed?.name ?? ws;
  return (
    <Switcher
      title={t("ws")}
      testId="workspace-switcher"
      kind="ws"
      current={ws}
      createHref={routes.organization(data.org.slug, "workspaces")}
      choices={choices}
    >
      <ChoiceAvatar
        kind="ws"
        choice={{ slug: ws, name, avatarUrl: listed?.avatarUrl ?? null }}
        testId="workspace-switcher-avatar"
      />
      <span className="min-w-0 flex-1">
        <b className="block truncate text-[13px] font-semibold">{name}</b>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {data.org.slug}/{ws}
        </span>
      </span>
    </Switcher>
  );
}
