"use client";
// The ⌘K command menu (mockup `cmdMenu()`, audit-prompt check 6): a combobox
// over every page and action in the mockup's groups, and, inside a workspace,
// what `search_tools` answers for the query (runs, agents, approvals and the
// tools on the belt). The search is a governed read through the kernel, and
// the footer says so. Arrow keys move, Enter opens, ⌘1 to ⌘5 open the five
// pages that carry them, Esc closes. On a phone it rises from the bottom edge
// as a sheet (src/ui/phone.css).
//
// Two strings differ from the mock's `shell.json` on purpose, and the audit
// (audit-prompt check 6) reads them against this note. The placeholder is
// "Search runs, agents, tools, records, or run an action": the mock joins the
// last clause with an em dash, which the house prose rules forbid
// (clear-prose rule 1), so a comma takes its place. The footer says a search
// is "recorded in the audit record" where the mock says "recorded as a
// frame": `search_tools` here is a kernel read the audit log records, and no
// run is open to hold a frame until the assistant records its turns as runs
// (#2968), so "frame" would claim a record that does not exist.
import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { searchCommands } from "./command-actions";
import {
  type Command,
  type CommandGroup,
  buildCommands,
  filterCommands,
  fromSearchRows,
  moveHighlight,
  orderCommands,
  shortcutCommand,
} from "./commands";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { useSidebarSections } from "./sidebar";
import { openAssistantDraft } from "@/shared/assistant-draft";
import { openApprovals } from "@/shared/approvals-drawer";
import { openCreate } from "@/shared/create";
import { useNavigate } from "@/ui/navigation";
import { SheetHandle } from "@/ui/sheet-dialog";

/** How long typing rests before the query goes to `search_tools`. */
const SEARCH_DEBOUNCE_MS = 150;

export function CommandMenu({ data }: { data: ShellData }) {
  const { commandOpen, setCommandOpen } = useShellState();
  return (
    <Dialog.Root open={commandOpen} onOpenChange={setCommandOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay-scrim" />
        {/* Always rendered inside the portal: Base UI unmounts the portal once the
            popup has closed, which resets the query. Unmounting the popup itself
            on close leaves the backdrop stuck in its ending style, over the page. */}
        <CommandPalette
          data={data}
          onClose={() => {
            setCommandOpen(false);
          }}
        />
      </Dialog.Portal>
    </Dialog.Root>
  );
}

type Remote =
  | { state: "idle" }
  | { state: "ok"; query: string; commands: Command[] }
  | { state: "failed" };

/**
 * What `search_tools` answered for the query, a moment after typing rests.
 * An answer for an older query is dropped, so a slow read never overwrites a
 * newer one.
 */
function useSearch(org: string, ws: string | null, query: string): Remote {
  const [remote, setRemote] = useState<Remote>({ state: "idle" });
  useEffect(() => {
    if (ws === null) return;
    let live = true;
    const timer = setTimeout(() => {
      searchCommands(org, ws, query)
        .then((result) => {
          if (!live) return;
          setRemote(
            result.ok
              ? {
                  state: "ok",
                  query,
                  commands: fromSearchRows(result.value.rows, { org, ws }),
                }
              : { state: "failed" },
          );
        })
        .catch(() => {
          if (live) setRemote({ state: "failed" });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [org, ws, query]);
  return ws === null ? { state: "idle" } : remote;
}

function CommandPalette({
  data,
  onClose,
}: {
  data: ShellData;
  onClose: () => void;
}) {
  const t = useTranslations("shell");
  const navigate = useNavigate();
  const { setAssistantOpen } = useShellState();
  const { ws } = useSidebarSections(data);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const optionId = (c: Command) =>
    `${listId}-${c.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const org = data.org.slug;
  // The groups that carry a note beside the label (mockup `grp(label, note)`),
  // each key spelled out so the catalog check can follow it.
  const notes: Partial<Record<CommandGroup, string>> = {
    assistant: t("commands.groups.assistant.note"),
    create: t("commands.groups.create.note"),
    actions: t("commands.groups.actions.note"),
  };

  const commands = useMemo(
    () =>
      buildCommands(
        { org, ws },
        {
          nav: (key) => t(`nav.${key}`),
          create: (kind) => t(`commands.create.${kind ?? "any"}`),
          text: (key) => t(`commands.${key}`),
        },
      ),
    [org, ws, t],
  );
  const remote = useSearch(org, ws, query);
  const ordered = orderCommands([
    ...filterCommands(commands, query),
    ...(remote.state === "ok" && remote.query === query ? remote.commands : []),
  ]);
  const active = ordered[highlight] ?? null;

  const open = (c: Command) => {
    if ("gap" in c) return;
    onClose();
    if ("href" in c) navigate.push(c.href);
    else if ("create" in c) openCreate(c.create);
    else if ("approvals" in c) openApprovals();
    else if (c.assistant !== null && ws !== null)
      openAssistantDraft({ org, ws, content: c.assistant });
    else setAssistantOpen(true);
  };

  return (
    <Dialog.Popup
      data-testid="command-menu"
      data-sheet=""
      initialFocus={inputRef}
      className="fixed left-1/2 top-[10vh] z-50 flex max-h-[76dvh] w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-dialog-border bg-dialog-bg text-dialog-fg shadow-2xl"
    >
      <SheetHandle />
      <Dialog.Title className="sr-only">{t("commands.title")}</Dialog.Title>
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Search aria-hidden="true" className="size-4 text-muted-foreground" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={ordered.length > 0}
          aria-controls={ordered.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active === null ? undefined : optionId(active)}
          aria-label={t("commands.title")}
          placeholder={t("commands.input")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            const digit = Number(e.key);
            if (
              (e.metaKey || e.ctrlKey) &&
              !e.altKey &&
              !e.shiftKey &&
              digit >= 1 &&
              digit <= 5
            ) {
              const target = shortcutCommand(commands, digit);
              if (target !== null) {
                e.preventDefault();
                open(target);
              }
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((i) =>
                moveHighlight(
                  i,
                  e.key === "ArrowDown" ? 1 : -1,
                  ordered.length,
                ),
              );
            } else if (e.key === "Enter" && active !== null) {
              e.preventDefault();
              open(active);
            }
          }}
          className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      {ordered.length === 0 ? (
        <p
          role="status"
          className="px-3 py-6 text-center text-sm text-muted-foreground"
        >
          {t("commands.empty", { query })}
        </p>
      ) : (
        <div
          id={listId}
          role="listbox"
          aria-label={t("commands.title")}
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {groupsOf(ordered).map(({ group, items }) => (
            <div
              key={group}
              role="group"
              aria-labelledby={`${listId}-g-${group}`}
              data-group={group}
            >
              <div
                id={`${listId}-g-${group}`}
                className="flex items-baseline gap-2 px-3 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.13em] text-muted-foreground"
              >
                <span>{t(`commands.groups.${group}.label`)}</span>
                {notes[group] === undefined ? null : (
                  <span className="font-normal normal-case tracking-normal">
                    {notes[group]}
                  </span>
                )}
              </div>
              {items.map((c) => {
                const i = ordered.indexOf(c);
                const selected = active?.id === c.id;
                const disabled = "gap" in c;
                return (
                  <div
                    key={c.id}
                    id={optionId(c)}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={disabled ? true : undefined}
                    data-command={c.id}
                    data-gap={disabled ? c.gap : undefined}
                    tabIndex={-1}
                    onMouseMove={() => {
                      if (i !== highlight) setHighlight(i);
                    }}
                    onClick={() => {
                      open(c);
                    }}
                    className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${
                      disabled
                        ? "cursor-default text-muted-foreground"
                        : "cursor-pointer"
                    } ${selected ? "bg-accent text-accent-foreground" : ""}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{c.label}</span>
                      {c.detail === undefined ? null : (
                        <span className="block truncate text-xs text-muted-foreground">
                          {c.detail}
                        </span>
                      )}
                    </span>
                    {"shortcut" in c && c.shortcut !== undefined ? (
                      <kbd className="flex-none font-mono text-[11px] text-muted-foreground">
                        {t("commands.shortcut", { n: c.shortcut })}
                      </kbd>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {remote.state === "failed" ? (
        <p
          role="status"
          data-testid="command-search-failed"
          className="border-t border-border px-4 py-2 text-xs text-muted-foreground"
        >
          {t("commands.search.failed")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span>
          <kbd className="font-mono">↑↓</kbd> {t("commands.footer.move")}
        </span>
        <span>
          <kbd className="font-mono">↩</kbd> {t("commands.footer.open")}
        </span>
        <span>
          <kbd className="font-mono">{t("commands.footer.escape")}</kbd>{" "}
          {t("commands.footer.close")}
        </span>
        <span data-testid="command-footer-note" className="ml-auto">
          {ws === null
            ? t("commands.footer.orgOnly")
            : t.rich("commands.footer.governed", {
                code: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
        </span>
      </div>
    </Dialog.Popup>
  );
}

/** The ordered entries cut into their groups, each group once, in order. */
function groupsOf(
  ordered: readonly Command[],
): { group: CommandGroup; items: Command[] }[] {
  const out: { group: CommandGroup; items: Command[] }[] = [];
  for (const c of ordered) {
    const last = out.at(-1);
    if (last?.group === c.group) last.items.push(c);
    else out.push({ group: c.group, items: [c] });
  }
  return out;
}
