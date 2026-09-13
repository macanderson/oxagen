"use client";
// The ⌘K command menu (mockup `cmdMenu()`): a combobox over every page, recent
// runs, actions and graph questions. Arrow keys move, Enter opens, Esc closes.
import { Dialog } from "@base-ui/react/dialog";
import { Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useMemo, useRef, useState } from "react";
import {
  buildCommands,
  type Command,
  filterCommands,
  groupCommands,
  moveHighlight,
} from "./commands";
import { parseShellPath } from "./nav";
import { activeWorkspace, type ShellData } from "./shell-data";
import { useShellState } from "./shell-state";

export function CommandMenu({ data }: { data: ShellData }) {
  const { commandOpen, setCommandOpen } = useShellState();
  return (
    <Dialog.Root open={commandOpen} onOpenChange={setCommandOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay-scrim" />
        {commandOpen ? (
          <CommandPalette
            data={data}
            onClose={() => {
              setCommandOpen(false);
            }}
          />
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CommandPalette({
  data,
  onClose,
}: {
  data: ShellData;
  onClose: () => void;
}) {
  const t = useTranslations("shell");
  const router = useRouter();
  const pathname = usePathname();
  const ws = activeWorkspace(data, parseShellPath(pathname).ws);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const optionId = (c: Command) =>
    `${listId}-${c.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  const commands = useMemo(
    () =>
      buildCommands(
        { org: data.org, ws, runs: data.runs },
        {
          nav: (key) => t(`nav.${key}`),
          action: (id) => t(`commands.actions.${id}`),
          question: (id) => t(`commands.questions.${id}`),
        },
      ),
    [data.org, data.runs, ws, t],
  );
  const filtered = filterCommands(commands, query);
  const groups = groupCommands(filtered);
  const ordered = groups.flatMap((g) => g.items);
  const active = ordered[highlight] ?? null;

  const open = (c: Command) => {
    onClose();
    router.push(c.href);
  };

  return (
    <Dialog.Popup
      data-testid="command-menu"
      initialFocus={inputRef}
      className="fixed left-1/2 top-[10vh] z-50 flex max-h-[76dvh] w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-dialog-border bg-dialog-bg text-dialog-fg shadow-2xl"
    >
      <Dialog.Title className="sr-only">{t("commands.title")}</Dialog.Title>
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <Search aria-hidden="true" className="size-4 text-muted-foreground" />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={groups.length > 0}
          aria-controls={groups.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active === null ? undefined : optionId(active)}
          aria-label={t("commands.input")}
          placeholder={t("commands.input")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
      {groups.length === 0 ? (
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
          {groups.map((g) => (
            <div
              key={g.group}
              role="group"
              aria-labelledby={`${listId}-g-${g.group}`}
              className="mb-1"
            >
              <p
                id={`${listId}-g-${g.group}`}
                role="presentation"
                className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
              >
                {t(`commands.groups.${g.group}`)}
              </p>
              {g.items.map((c) => {
                const selected = active?.id === c.id;
                return (
                  <div
                    key={c.id}
                    id={optionId(c)}
                    role="option"
                    aria-selected={selected}
                    data-command={c.id}
                    tabIndex={-1}
                    onMouseMove={() => {
                      const i = ordered.indexOf(c);
                      if (i !== highlight) setHighlight(i);
                    }}
                    onClick={() => {
                      open(c);
                    }}
                    className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm ${
                      selected ? "bg-accent text-accent-foreground" : ""
                    }`}
                  >
                    <span
                      className={`min-w-0 flex-1 truncate ${c.group === "runs" ? "font-mono text-[13px]" : ""}`}
                    >
                      {c.label}
                    </span>
                    {c.detail === null ? null : (
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {c.detail}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        <span>
          <kbd className="font-mono">↑↓</kbd> {t("commands.footer.move")}
        </span>
        <span>
          <kbd className="font-mono">↩</kbd> {t("commands.footer.open")}
        </span>
        <span>
          <kbd className="font-mono">esc</kbd> {t("commands.footer.close")}
        </span>
        <span className="ml-auto hidden font-mono sm:inline">
          {t("commands.footer.contract")}
        </span>
      </div>
    </Dialog.Popup>
  );
}
