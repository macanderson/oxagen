"use client";
// "Import tools from an MCP server" (mockup `tools.md`, the Registry action):
// pull a registered server's pinned `tools/list` into the workspace registry,
// one immutable version per changed manifest.
//
// The dialog picks the server from the workspace's roster (`list_mcp_servers`)
// and, optionally, names the pinned tools to take; leaving the tools blank
// takes every pin. Re-importing an unchanged server changes nothing and says
// so. Registering a server is the section under the registry.
//
// When the roster could not be read the field falls back to a typed `mcs_…`,
// so a failed read costs the picker rather than the import.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { importTools } from "./actions";
import { splitTags, textValue, type ToolsAt } from "./view";

export function ImportControls({
  at,
  servers,
}: {
  at: ToolsAt;
  /** The workspace's registered servers, or null when the roster read failed. */
  servers: readonly { id: string; name: string }[] | null;
}) {
  const t = useTranslations("tools.import");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<{
    published: number;
    unchanged: number;
  } | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const result = await importTools(at.org, at.ws, {
        serverId: textValue(form, "serverId"),
        tools: splitTags(textValue(form, "tools")),
      });
      if (result.ok) {
        setDone({
          published: result.value.published,
          unchanged: result.value.unchanged,
        });
        navigate.replace(routes.tools(at.org, at.ws));
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-testid="tools-import-open"
        className={buttonSecondary}
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
          if (!next) {
            setFailure(null);
            setDone(null);
          }
        }}
        title={t("title")}
        testId="tools-import-dialog"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              htmlFor="serverId"
              className="text-sm font-medium text-foreground"
            >
              {t("serverId")}
            </label>
            {servers === null ? (
              <>
                <input
                  id="serverId"
                  name="serverId"
                  required
                  placeholder={t("serverIdPlaceholder")}
                  className={`${inputBase} ${mono}`}
                />
                <p className="text-xs text-muted-foreground">
                  {t("serverFallbackHint")}
                </p>
              </>
            ) : (
              <>
                <select
                  id="serverId"
                  name="serverId"
                  required
                  defaultValue=""
                  className={inputBase}
                >
                  <option value="" disabled>
                    {t("serverPick")}
                  </option>
                  {servers.map((server) => (
                    <option key={server.id} value={server.id}>
                      {server.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {servers.length === 0 ? t("serverNone") : t("serverPickHint")}
                </p>
              </>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              htmlFor="tools"
              className="text-sm font-medium text-foreground"
            >
              {t("tools")}
            </label>
            <input id="tools" name="tools" className={`${inputBase} ${mono}`} />
            <p className="text-xs text-muted-foreground">{t("toolsHint")}</p>
          </div>
          {done === null ? null : (
            <p
              data-testid="tools-import-done"
              className="rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground"
            >
              {t("done", {
                published: done.published,
                unchanged: done.unchanged,
              })}
            </p>
          )}
          {failure === null ? null : (
            <FormAlert testId="tools-import-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("confirm")}
            pendingLabel={t("pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
