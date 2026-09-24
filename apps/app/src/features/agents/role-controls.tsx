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
// title, the role picker (each role with what it is for, a role the agent
// already holds marked and disabled) with the note that only agent-kind roles
// are listed and a link to manage them, the Repository row (not backed,
// #3865), a Why field whose words ride the capability's input into the audit
// event, and the note that a role cannot lift an agent above its operator's
// grants (the delegation ceiling the handler enforces). Assign sits in the
// footer beside Cancel. A completed assignment leaves a receipt in the dialog
// naming the role, the agent and the reason, and the page reloads when the
// person closes it.
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
import { SheetDialog, SheetFooterAction } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import {
  assignAgentRole,
  readAgentRoleNames,
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

/** The roles the agent holds now, read beside the catalogue; null until read or when the read failed. */
type Held = readonly string[] | null;

/** What the dialog shows once the write answered ok: the design's receipt. */
type Receipt = {
  role: string;
  alreadyAssigned: boolean;
  reason: string;
  enforced: boolean;
};

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
  const [held, setHeld] = useState<Held>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const key = agentKey ?? agentSlug;
  const formId = `${ASSIGN}-${agentSlug}-form`;

  // The catalogue and the roles held are read when the dialog opens. The
  // catalogue is kept for as long as the page lives: a person who assigns two
  // roles reads it once. The held roles are read at every opening, because an
  // assignment changes them. The ref, not the state, is what stops a second
  // catalogue read, so the effect sets no state synchronously.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const result = await readAgentRoleNames(org, ws, agentId);
        setHeld(result.ok ? result.value : null);
      } catch {
        setHeld(null);
      }
    })();
    if (startedRef.current) return;
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
  }, [open, org, ws, agentId]);

  const offered = catalogue.state === "loaded" ? catalogue.offer : null;
  const empty = offered !== null && offered.roles.length === 0;
  const ready = offered !== null && !empty && receipt === null;
  const isHeld = (name: string) => held?.includes(name) ?? false;
  const first = offered?.roles.find((role) => !isHeld(role.name));

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const chosen = form.get("roleName");
    const roleName = typeof chosen === "string" ? chosen : "";
    const why = form.get("reason");
    const reason = typeof why === "string" ? why.trim() : "";
    setPending(true);
    setFailure(null);
    try {
      const result = await assignAgentRole(org, ws, agentId, roleName, reason);
      if (result.ok) {
        setReceipt({
          role: result.value.roleName,
          alreadyAssigned: result.value.alreadyAssigned,
          reason,
          enforced: offered?.enforced ?? true,
        });
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  function openChange(next: boolean) {
    setOpen(next);
    if (next) return;
    setFailure(null);
    // The list reloads once the person has read the receipt, so the row they
    // acted on is still there while they read it.
    if (receipt !== null && !receipt.alreadyAssigned)
      navigate.replace(
        after ?? routes.agent(org, ws, agentSlug, { tab: "permissions" }),
      );
    setReceipt(null);
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
        {label ?? t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={t("title")}
        subtitle={key}
        closeLabel={receipt === null ? t("cancel") : t("close")}
        testId={ASSIGN}
      >
        {receipt !== null ? (
          <p
            role="status"
            data-testid={`${ASSIGN}-receipt`}
            className="text-sm text-foreground"
          >
            {receipt.alreadyAssigned
              ? t("already", { key, role: receipt.role })
              : t(receipt.enforced ? "done" : "doneNotEnforced", {
                  key,
                  role: receipt.role,
                  why:
                    receipt.reason === ""
                      ? ""
                      : t("doneWhy", { reason: receipt.reason }),
                })}
          </p>
        ) : (
          <form
            id={formId}
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
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
                  // Remounted once the held roles answer, so the default
                  // lands on the first role the agent does not hold yet.
                  key={held === null ? "unread" : "read"}
                  id={`${ASSIGN}-roleName`}
                  name="roleName"
                  required
                  defaultValue={first?.name}
                  className={inputBase}
                >
                  {offered.roles.map((role) => {
                    const holds = isHeld(role.name);
                    const name = holds
                      ? t("held", { name: role.name })
                      : role.name;
                    return (
                      <option
                        key={role.name}
                        value={role.name}
                        disabled={holds}
                      >
                        {role.description === null ||
                        role.description.trim() === ""
                          ? name
                          : t("option", {
                              name,
                              description: role.description,
                            })}
                      </option>
                    );
                  })}
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
                {/* The design's Repository field binds a repository-scoped
                    role to one repo. No role can declare that scope and
                    assign_agent_role takes no repository (#3865), so the row
                    says so instead of offering a choice nothing would store. */}
                <div
                  data-not-backed=""
                  data-gap="#3865"
                  data-testid={`${ASSIGN}-repository`}
                  className="flex flex-col gap-1 text-sm text-foreground"
                >
                  <span>{t("repository")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("repositoryGap")}
                  </span>
                </div>
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
                        mono: (chunks) => (
                          <span className={mono}>{chunks}</span>
                        ),
                      })
                    : t.rich("noteNoOperator", {
                        mono: (chunks) => (
                          <span className={mono}>{chunks}</span>
                        ),
                      })}
                </p>
              </>
            ) : null}
            {failure === null ? null : (
              <FormAlert testId={`${ASSIGN}-failure`}>{failure}</FormAlert>
            )}
            {ready ? (
              <SheetFooterAction>
                <SubmitButton
                  pending={pending}
                  fullWidth={false}
                  form={formId}
                  testId={`${ASSIGN}-confirm`}
                  label={t("confirm")}
                  pendingLabel={t("pending")}
                />
              </SheetFooterAction>
            ) : null}
          </form>
        )}
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
