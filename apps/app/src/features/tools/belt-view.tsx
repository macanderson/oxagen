"use client";
// One toolbelt, open below the list (ADR-198): every tool in the workspace
// grouped by the server it came from, as `get_toolbelt` answers it.
//
// - A custom belt is edited here through `update_toolbelt`: remove or add a
//   server, turn every tool of a server on or off, and turn one tool on or
//   off. A tool an admin made unavailable shows as such and cannot be turned
//   on. A belt no live agent carries can be deleted.
// - The All tools belt is derived from the workspace's tool settings and is
//   never edited directly. An org Owner or Admin sets each tool's availability
//   and default here through `set_tool_state`, per tool or per server; anyone
//   else reads it.
//
// A belt narrows what an agent is shown and grants nothing, so every control
// here changes what agents see, never what they may do.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { ToolbeltDetail, ToolbeltGroup } from "@/data/contracts/toolbelts";
import { routes } from "@/shared/safe-path";
import { unanswered } from "@/ui/action-failure";
import {
  buttonSecondary,
  linkText,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  deleteToolbelt,
  setToolState,
  type ToolbeltChangeDraft,
  updateToolbelt,
} from "./actions";
import { useActionFailure } from "./action-failure";
import { type ToolsAt, toolsLink } from "./view";

/** `.btn.danger`: the ink and the border carry the red; the word carries the meaning. */
const buttonDanger = `${buttonSecondary} border-error/50! text-error-ink! hover:bg-error/10!`;

type Write = () => Promise<
  Awaited<ReturnType<typeof updateToolbelt | typeof setToolState>>
>;

/** A server group's key for `data-server`: its `mcs_…` id, or `declared` for the null group. */
function serverKey(group: ToolbeltGroup): string {
  return group.serverId ?? "declared";
}

function ServerActions({
  at,
  group,
  derived,
  pending,
  run,
  change,
}: {
  at: ToolsAt;
  group: ToolbeltGroup;
  derived: boolean;
  pending: boolean;
  run: (write: Write) => void;
  change: (changes: readonly ToolbeltChangeDraft[]) => Write;
}) {
  const t = useTranslations("tools.toolbelts.belt.server");
  // The server's every tool at once, on the All tools belt.
  const setServerState =
    (state: { available: boolean }): Write =>
    () =>
      setToolState(at.org, at.ws, { serverId: group.serverId, ...state });
  // The group is a region named for its server, so each button's own words
  // are its name and the region says which server it acts on.
  const button = (
    key: string,
    label: string,
    write: Write,
    className = buttonSecondary,
  ) => (
    <button
      key={key}
      type="button"
      data-testid={`belt-server-${key}`}
      data-touch-target=""
      aria-disabled={pending || undefined}
      className={className}
      onClick={() => {
        if (!pending) run(write);
      }}
    >
      {label}
    </button>
  );
  if (derived)
    return (
      <div className="flex flex-wrap gap-2">
        {button(
          "available",
          t("makeAvailable"),
          setServerState({ available: true }),
        )}
        {button(
          "unavailable",
          t("takeOut"),
          setServerState({ available: false }),
        )}
      </div>
    );
  if (!group.included)
    return (
      <div className="flex flex-wrap gap-2">
        {button(
          "add",
          t("add"),
          change([
            { op: "add_server", serverId: group.serverId, active: true },
          ]),
        )}
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2">
      {button(
        "on",
        t("turnOn"),
        change([
          { op: "set_server_active", serverId: group.serverId, active: true },
        ]),
      )}
      {button(
        "off",
        t("turnOff"),
        change([
          { op: "set_server_active", serverId: group.serverId, active: false },
        ]),
      )}
      {button(
        "remove",
        t("remove"),
        change([{ op: "remove_server", serverId: group.serverId }]),
        buttonDanger,
      )}
    </div>
  );
}

function ToolRow({
  tool,
  derived,
  canEdit,
  pending,
  run,
  change,
  at,
}: {
  tool: ToolbeltGroup["tools"][number];
  derived: boolean;
  canEdit: boolean;
  pending: boolean;
  run: (write: Write) => void;
  change: (changes: readonly ToolbeltChangeDraft[]) => Write;
  at: ToolsAt;
}) {
  const t = useTranslations("tools.toolbelts.belt");
  const name = (
    <span className="flex min-w-0 flex-col">
      <span className="font-medium">{tool.name}</span>
      {tool.slug === tool.name ? null : (
        <span className={`${mono} text-xs text-muted-foreground`}>
          {tool.slug}
        </span>
      )}
    </span>
  );
  const unavailable = tool.available ? null : (
    <span
      data-state="unavailable"
      className="text-xs font-medium text-muted-foreground"
    >
      {t("unavailable")}
    </span>
  );
  if (derived && canEdit)
    return (
      <li
        data-testid="belt-tool"
        data-tool={tool.id}
        className="flex flex-wrap items-center justify-between gap-3 py-2"
      >
        {name}
        <span className="flex flex-wrap items-center gap-4 text-[13px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid={`belt-tool-available-${tool.id}`}
              aria-label={t("availableLabel", { tool: tool.name })}
              checked={tool.available}
              disabled={pending}
              onChange={(event) => {
                const available = event.currentTarget.checked;
                run(() =>
                  setToolState(at.org, at.ws, {
                    toolIds: [tool.id],
                    available,
                  }),
                );
              }}
            />
            {t("available")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid={`belt-tool-default-${tool.id}`}
              aria-label={t("defaultOnLabel", { tool: tool.name })}
              checked={tool.defaultActive}
              disabled={pending}
              onChange={(event) => {
                const defaultActive = event.currentTarget.checked;
                run(() =>
                  setToolState(at.org, at.ws, {
                    toolIds: [tool.id],
                    defaultActive,
                  }),
                );
              }}
            />
            {t("defaultOn")}
          </label>
        </span>
      </li>
    );
  if (!derived && canEdit)
    return (
      <li
        data-testid="belt-tool"
        data-tool={tool.id}
        className="flex flex-wrap items-center justify-between gap-3 py-2"
      >
        {name}
        <span className="flex items-center gap-3 text-[13px]">
          {unavailable}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid={`belt-tool-active-${tool.id}`}
              aria-label={t("toolOn", { tool: tool.name })}
              checked={tool.active}
              disabled={pending || !tool.available}
              onChange={(event) => {
                run(
                  change([
                    {
                      op: "set_tool_active",
                      toolId: tool.id,
                      active: event.currentTarget.checked,
                    },
                  ]),
                );
              }}
            />
            {t("on")}
          </label>
        </span>
      </li>
    );
  return (
    <li
      data-testid="belt-tool"
      data-tool={tool.id}
      className="flex flex-wrap items-center justify-between gap-3 py-2"
    >
      {name}
      <span className="flex items-center gap-3 text-[13px]">
        {unavailable}
        <span data-state={tool.active ? "on" : "off"}>
          {tool.active ? t("on") : t("off")}
        </span>
      </span>
    </li>
  );
}

function DeleteToolbelt({
  at,
  belt,
  carriers,
}: {
  at: ToolsAt;
  belt: { id: string; name: string };
  /** Live agents carrying the belt; a belt with any cannot be deleted. */
  carriers: number;
}) {
  const t = useTranslations("tools.toolbelts.belt.delete");
  const failureOf = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function confirm() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await deleteToolbelt(at.org, at.ws, belt.id);
      if (result.ok) {
        setOpen(false);
        navigate.push(toolsLink(at, { tab: "toolbelts" }));
      } else {
        setFailure(failureOf(result));
      }
    } catch {
      setFailure(failureOf(unanswered("action_failed")));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="belt-delete"
        data-touch-target=""
        aria-haspopup="dialog"
        className={buttonDanger}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title", { name: belt.name })}
        closeLabel={t("keep")}
        testId="belt-delete-dialog"
      >
        {carriers > 0 ? (
          <p data-testid="belt-delete-in-use" className="text-sm">
            {t("inUse", { count: carriers })}
          </p>
        ) : (
          <form
            className="flex flex-col gap-3 text-sm"
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <p className="text-muted-foreground">{t("body")}</p>
            {failure === null ? null : (
              <FormAlert testId="belt-delete-failure">{failure}</FormAlert>
            )}
            <button
              type="submit"
              data-testid="belt-delete-confirm"
              data-touch-target=""
              aria-disabled={pending || undefined}
              className={`${buttonDanger} w-full`}
            >
              {pending ? t("pending") : t("confirm")}
            </button>
          </form>
        )}
      </SheetDialog>
    </>
  );
}

export function BeltView({
  at,
  detail,
  canEdit,
}: {
  at: ToolsAt;
  detail: ToolbeltDetail;
  /** An org Owner or Admin: who the four toolbelt writes admit. */
  canEdit: boolean;
}) {
  const t = useTranslations("tools.toolbelts");
  const failureOf = useActionFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { belt, groups, agents } = detail;
  const derived = belt.kind === "all_tools";

  function run(write: Write) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    void (async () => {
      try {
        const result = await write();
        if (result.ok) navigate.refresh();
        else setFailure(failureOf(result));
      } catch {
        setFailure(failureOf(unanswered("action_failed")));
      } finally {
        setPending(false);
      }
    })();
  }

  const change =
    (changes: readonly ToolbeltChangeDraft[]): Write =>
    () =>
      updateToolbelt(at.org, at.ws, belt.id, changes);

  return (
    <section
      aria-labelledby="tools-belt-open"
      aria-busy={pending || undefined}
      data-testid="tools-belt"
      data-belt={belt.id}
      className={panel}
    >
      <div className={panelHeader}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id="tools-belt-open" className={panelTitle}>
            {belt.name}
          </h2>
          <p className="text-xs text-muted-foreground">
            <span className={mono}>{belt.slug}</span>
            {belt.clonedFrom === null ? null : (
              <span> {t("clonedFrom", { name: belt.clonedFrom.name })}</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!derived && canEdit ? (
            <DeleteToolbelt at={at} belt={belt} carriers={agents.length} />
          ) : null}
          <SafeLink
            to={toolsLink(at, { tab: "toolbelts" })}
            data-testid="belt-close"
            className={`${linkText} text-[13px]`}
          >
            {t("belt.close")}
          </SafeLink>
        </div>
      </div>
      <div className={`${panelBody} flex flex-col gap-4`}>
        {derived ? (
          <p className="max-w-prose border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
            {t("belt.allToolsNote")}
            {canEdit ? ` ${t("belt.adminNote")}` : null}
          </p>
        ) : null}
        {failure === null ? null : (
          <FormAlert testId="belt-failure">{failure}</FormAlert>
        )}
        {groups.length === 0 ? (
          <p
            data-testid="belt-empty"
            className="text-[13px] text-muted-foreground"
          >
            {t("belt.empty")}{" "}
            <SafeLink
              to={toolsLink(at, { tab: "providers" })}
              className={linkText}
            >
              {t("belt.importLink")}
            </SafeLink>
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group) => (
              <section
                key={serverKey(group)}
                aria-label={group.serverName}
                data-testid="belt-server"
                data-server={serverKey(group)}
                data-included={group.included ? "true" : "false"}
                className="rounded-lg border border-border px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[13px] font-semibold text-foreground">
                    {group.serverName}
                  </h3>
                  {canEdit ? (
                    <ServerActions
                      at={at}
                      group={group}
                      derived={derived}
                      pending={pending}
                      run={run}
                      change={change}
                    />
                  ) : null}
                </div>
                {group.included ? (
                  <ul className="divide-y divide-border">
                    {group.tools.map((tool) => (
                      <ToolRow
                        key={tool.id}
                        tool={tool}
                        derived={derived}
                        canEdit={canEdit}
                        pending={pending}
                        run={run}
                        change={change}
                        at={at}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="pt-1 text-xs text-muted-foreground">
                    {t("belt.notIncluded")}
                  </p>
                )}
              </section>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold text-foreground">
            {t("belt.carriedBy")}
          </h3>
          {agents.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {t("belt.noAgents")}
            </p>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              {agents.map((agent) => (
                <li key={agent.id} data-testid="belt-agent">
                  <SafeLink
                    to={routes.agent(at.org, at.ws, agent.slug)}
                    className={linkText}
                  >
                    {agent.name}
                  </SafeLink>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
