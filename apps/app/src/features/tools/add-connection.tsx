"use client";
// Add a connection (#2957, lane: connections): store one connector's
// credential for this workspace and name it.
//
// Three things this dialog is careful about.
//
//   1. **The credential goes one way.** It is read off the form, handed to
//      the action and dropped. The form is not re-rendered with it, the
//      success panel names the connection and never the secret, and no
//      failure message carries a field value.
//   2. **The answer is `pending_setup`, and it says so.** `create_connection`
//      stores the credential and marks the row pending setup; nothing has
//      drawn on it and no sync has run. Calling that "connected" would be the
//      page claiming a state the record does not hold.
//   3. **The role is checked on the server.** `create_connection` asserts an
//      org Owner or Admin, or a workspace Owner, before it touches a row, so
//      the control is offered to every reader of the tab and a caller without
//      the role is told which role it wants, where they acted.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { addConnection } from "./actions";
import {
  CONNECTION_SCHEME_NAMES,
  CONNECTION_SCHEMES,
  type ConnectionScheme,
  connectionSchemeOf,
  DEFAULT_CONNECTION_SCHEME,
  textValue,
  type ToolsAt,
} from "./view";

const TESTID = "connection-add";

export function AddConnection({
  at,
  connectors,
  primary = false,
}: {
  at: ToolsAt;
  /** Gold only where it is the screen's one primary action. */
  primary?: boolean;
  /**
   * The connector slugs already in use in this workspace, offered as
   * suggestions. No capability lists the connectors this deployment has, so
   * the field stays free text and the handler is what refuses an unknown one.
   */
  connectors: readonly string[];
}) {
  const t = useTranslations("tools.connections.add");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [scheme, setScheme] = useState<ConnectionScheme>(
    DEFAULT_CONNECTION_SCHEME,
  );
  const [done, setDone] = useState<{ id: string; name: string } | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const chosen = connectionSchemeOf(textValue(form, "scheme"));
    // Read the scheme's fields into a record that leaves this function with
    // the action and is never held in state.
    const secrets: Record<string, string> = {};
    for (const field of CONNECTION_SCHEMES[chosen]) {
      secrets[field] = textValue(form, field);
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await addConnection(at.org, at.ws, {
        connectorId: textValue(form, "connectorId"),
        displayName: textValue(form, "displayName"),
        scheme: chosen,
        secrets,
        deliveryMethod: textValue(form, "deliveryMethod"),
      });
      if (result.ok) {
        // The form is replaced by the outcome, so the typed credential leaves
        // the DOM with it rather than sitting in an input behind a panel.
        setDone({ id: result.value.id, name: result.value.displayName });
        navigate.replace(routes.tools(at.org, at.ws, { tab: "providers" }));
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
        data-testid={`${TESTID}-open`}
        className={primary ? buttonPrimary : buttonSecondary}
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
        testId={`${TESTID}-dialog`}
      >
        {done === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t("body")}</p>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="connectorId"
                className="text-sm font-medium text-foreground"
              >
                {t("connector")}
              </label>
              <input
                id="connectorId"
                name="connectorId"
                required
                list={connectors.length === 0 ? undefined : `${TESTID}-slugs`}
                placeholder={t("connectorPlaceholder")}
                className={`${inputBase} ${mono}`}
              />
              {connectors.length === 0 ? null : (
                <datalist
                  id={`${TESTID}-slugs`}
                  aria-label={t("connectorInUse")}
                >
                  {connectors.map((slug) => (
                    <option key={slug} value={slug} />
                  ))}
                </datalist>
              )}
              <p className="text-xs text-muted-foreground">
                {t("connectorHint")}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="displayName"
                className="text-sm font-medium text-foreground"
              >
                {t("displayName")}
              </label>
              <input
                id="displayName"
                name="displayName"
                required
                maxLength={255}
                className={inputBase}
              />
              <p className="text-xs text-muted-foreground">
                {t("displayNameHint")}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="scheme"
                className="text-sm font-medium text-foreground"
              >
                {t("scheme")}
              </label>
              <select
                id="scheme"
                name="scheme"
                value={scheme}
                onChange={(event) => {
                  setScheme(connectionSchemeOf(event.currentTarget.value));
                }}
                className={inputBase}
              >
                {CONNECTION_SCHEME_NAMES.map((option) => (
                  <option key={option} value={option}>
                    {t(`schemes.${option}`)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{t("schemeHint")}</p>
            </div>
            {CONNECTION_SCHEMES[scheme].map((field) => (
              <div key={field} className="flex min-w-0 flex-col gap-1.5">
                <label
                  htmlFor={field}
                  className="text-sm font-medium text-foreground"
                >
                  {t(`fields.${field}`)}
                </label>
                <input
                  id={field}
                  name={field}
                  type="password"
                  required
                  autoComplete="off"
                  className={`${inputBase} ${mono}`}
                />
              </div>
            ))}
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="deliveryMethod"
                className="text-sm font-medium text-foreground"
              >
                {t("delivery")}
              </label>
              <input
                id="deliveryMethod"
                name="deliveryMethod"
                className={`${inputBase} ${mono}`}
              />
              <p className="text-xs text-muted-foreground">
                {t("deliveryHint")}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">{t("secretNote")}</p>
            {failure === null ? null : (
              <FormAlert testId={`${TESTID}-failure`}>{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          </form>
        ) : (
          <p
            data-testid={`${TESTID}-done`}
            className="rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground"
          >
            {t("done", { name: done.name, id: done.id })}
          </p>
        )}
      </SheetDialog>
    </>
  );
}
