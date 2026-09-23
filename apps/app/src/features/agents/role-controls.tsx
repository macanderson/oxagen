"use client";
// The two writes on an agent's roles (#2956): assign one from the
// organization's catalogue, and revoke one from the row that records it.
//
// Both contracts name a role by NAME, not by id, so Assign has to offer the
// catalogue rather than a text box: a typo would otherwise come back as a
// refusal the seam cannot classify. The catalogue is read when the dialog
// opens, through `readAssignableRoles`, and the picker offers only the roles
// an agent may hold. A role the organization's tier does not yet enforce is
// still assignable, and the dialog says the assignment governs nothing until
// the tier enforces it rather than leaving the reader to assume it does.
//
// Assign follows the design's `assignrole` dialog: the agent key under the
// title, the role picker with the note that only agent-kind roles are listed
// and a link to manage them, a Why field whose words ride the capability's
// input into the audit event, and the note that a role cannot lift an agent
// above its operator's grants (the delegation ceiling the handler enforces).
//
// Revoke names the role in its confirming sentence, because the button sits on
// a row and a row is easy to mistake for its neighbour.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonSecondary,
  inputBase,
  linkText,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import {
  assignAgentRole,
  readAssignableRoles,
  type RoleOffer,
  revokeAgentRole,
} from "./actions";

/** Where the writes happen and where the page reloads to afterwards. */
export type RoleTarget = {
  org: string;
  ws: string;
  /** The agent's public id, as both contracts take it. */
  agentId: string;
  /** The agent's slug, which names its page. */
  agentSlug: string;
};

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

/**
 * The catalogue read, in the three states the dialog draws. `loading` is the
 * state it opens in: the read starts when the dialog opens and nothing is
 * offered until it answers.
 */
type Catalogue =
  | { state: "loading" }
  | { state: "loaded"; offer: RoleOffer }
  | { state: "failed"; failure: Failure };

const ASSIGN = "assign-role";

export function AssignRole({
  org,
  ws,
  agentId,
  agentSlug,
  agentKey,
  operatorName,
  label,
  after,
}: RoleTarget & {
  /** The agent key the dialog is about, under its title; the slug when the key is not recorded. */
  agentKey?: string;
  /** The person the agent acts for, whose grants cap the agent's; null when none is recorded. */
  operatorName?: string | null;
  /** The trigger's words where the page names it differently: the list's row action reads "Roles". */
  label?: string;
  /** Where to reload once the role is assigned; the agent's Permissions tab by default. */
  after?: SafePath;
}) {
  const t = useTranslations("agents.detail.roles.assign");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<Catalogue>({ state: "loading" });

  // The catalogue is read once the dialog opens, and kept for as long as the
  // page lives: a person who assigns two roles reads it once. The ref, not the
  // state, is what stops a second read, so the effect sets no state
  // synchronously and cannot cascade a render.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const result = await readAssignableRoles(org, ws);
        setCatalogue(
          result.ok
            ? { state: "loaded", offer: result.value }
            : { state: "failed", failure: result },
        );
      } catch {
        setCatalogue({ state: "failed", failure: UNANSWERED });
      }
    })();
  }, [open, org, ws]);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const chosen = form.get("roleName");
    const roleName = typeof chosen === "string" ? chosen : "";
    const why = form.get("reason");
    const reason = typeof why === "string" ? why : "";
    setPending(true);
    setFailure(null);
    try {
      const result = await assignAgentRole(org, ws, agentId, roleName, reason);
      if (result.ok) {
        setOpen(false);
        navigate.replace(
          after ?? routes.agent(org, ws, agentSlug, { tab: "permissions" }),
        );
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const offered = catalogue.state === "loaded" ? catalogue.offer : null;
  const empty = offered !== null && offered.roles.length === 0;
  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label ?? t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title")}
        subtitle={agentKey ?? agentSlug}
        closeLabel={t("cancel")}
        testId={ASSIGN}
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          {catalogue.state === "loading" ? (
            <p data-state="loading" className="text-sm text-muted-foreground">
              {t("loading")}
            </p>
          ) : null}
          {catalogue.state === "failed" ? (
            <FormAlert testId={`${ASSIGN}-catalogue-failure`}>
              {failureText(catalogue.failure)}
            </FormAlert>
          ) : null}
          {empty ? (
            <p data-state="empty" className="text-sm text-foreground">
              {t("empty")}
            </p>
          ) : null}
          {offered !== null && !empty ? (
            <div className="flex flex-col gap-1 text-sm text-foreground">
              <label htmlFor={`${ASSIGN}-roleName`}>{t("field")}</label>
              <select
                id={`${ASSIGN}-roleName`}
                name="roleName"
                required
                className={inputBase}
              >
                {offered.roles.map((role) => (
                  <option key={role.name} value={role.name}>
                    {role.builtIn
                      ? t("builtIn", { name: role.name })
                      : role.name}
                  </option>
                ))}
              </select>
              <p
                data-testid={`${ASSIGN}-hint`}
                className="text-xs text-muted-foreground"
              >
                {t.rich("hint", {
                  link: (chunks) => (
                    <SafeLink to={routes.roles(org)} className={linkText}>
                      {chunks}
                    </SafeLink>
                  ),
                })}
              </p>
              {offered.enforced ? null : (
                <p
                  data-state="not-enforced"
                  className="text-xs text-muted-foreground"
                >
                  {t("notEnforced", { tier: offered.tier })}
                </p>
              )}
              {offered.more ? (
                <p
                  data-state="partial"
                  className="text-xs text-muted-foreground"
                >
                  {t("partial")}
                </p>
              ) : null}
            </div>
          ) : null}
          {offered !== null && !empty ? (
            <>
              <div className="flex flex-col gap-1 text-sm text-foreground">
                <label htmlFor={`${ASSIGN}-reason`}>{t("why")}</label>
                <input
                  id={`${ASSIGN}-reason`}
                  name="reason"
                  maxLength={500}
                  autoComplete="off"
                  placeholder={t("whyPlaceholder")}
                  className={inputBase}
                />
              </div>
              <p
                data-testid={`${ASSIGN}-note`}
                className="border-l-2 border-gold pl-3 text-xs text-muted-foreground"
              >
                {operatorName
                  ? t.rich("note", {
                      operator: operatorName,
                      mono: (chunks) => <span className={mono}>{chunks}</span>,
                    })
                  : t.rich("noteNoOperator", {
                      mono: (chunks) => <span className={mono}>{chunks}</span>,
                    })}
              </p>
            </>
          ) : null}
          {failure === null ? null : (
            <FormAlert testId={`${ASSIGN}-failure`}>{failure}</FormAlert>
          )}
          {offered !== null && !empty ? (
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          ) : null}
        </form>
      </SheetDialog>
    </>
  );
}

export function RevokeRole({
  org,
  ws,
  agentId,
  agentSlug,
  roleName,
}: RoleTarget & { roleName: string }) {
  const t = useTranslations("agents.detail.roles.revoke");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const testId = `revoke-role-${roleName}`;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await revokeAgentRole(org, ws, agentId, roleName);
      if (result.ok) {
        setOpen(false);
        navigate.replace(
          routes.agent(org, ws, agentSlug, { tab: "permissions" }),
        );
      } else {
        setFailure(failureText(result));
      }
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
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open", { role: roleName })}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title", { role: roleName })}
        testId={testId}
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t("body", { role: roleName })}
          </p>
          {failure === null ? null : (
            <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
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
