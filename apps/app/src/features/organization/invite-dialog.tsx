"use client";
// Organization › People › Invite: the one write that adds a person to the
// organization who is not in it yet (#2964). An Owner or an Admin sends it and
// every other role reads the refusal in place of the button, which is what
// `send_workspace_invite` would answer anyway (INV-29).
//
// The dialog asks for an email, the role the invitation offers, and an optional
// note. It asks for no workspace: the capability is named for one and declared
// `scoped`, but its handler writes an organization row with an organization
// role and records no workspace, so the copy says the invitation admits the
// person to the organization and grants nothing else. The scope the kernel
// enters is the org-only sentinel an `OrgCtx` carries, which is invocation
// scope and never a grant (`actions.ts`, `sendInvitation`).
//
// A second invitation for an email that is already pending is not a failure:
// the handler re-reads the pending row and answers with it, so the dialog says
// the person was already invited. Which of the two happened is read from the
// id: the roster the server last sent is `pendingIds`, and an answer whose id
// is already on it is the row that already existed. The reading is taken at
// submit time, before the reload changes the roster underneath it. It is only
// as fresh as the page: an invitation sent from another session since this
// render reads as newly sent here, which names the wrong one of two outcomes
// that both changed nothing.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  type ActionFailure,
  UNANSWERED,
  useActionFailure,
} from "./action-failure";
import { sendInvitation } from "./actions";
import { recordReceipt } from "./receipt";
import { INVITABLE_ROLES, type InvitableRole } from "./invitation-roles";

/**
 * The sentence a refused invitation shows. The two refusals this write has of
 * its own are the ones a person can act on: an address the contract's schema
 * does not accept, and a role outside the three an invitation offers. Every
 * other refusal is the Organization lane's, worded once in `action-failure.ts`.
 */
function useInviteFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("organization.invite.failure");
  const shared = useActionFailure();
  return (failure) => {
    if (failure.reason !== "invalid") return shared(failure);
    if (failure.code === "role_not_invitable") return t("roleNotInvitable");
    return failure.field === "email" ? t("emailInvalid") : shared(failure);
  };
}

/** What the write answered, as the panel that replaces the form reads it. */
type Outcome = { email: string; role: InvitableRole; already: boolean };

/**
 * The answer, in place of the form: the invitation was sent, or the person
 * already had one waiting. Both left the roster correct, so neither is an
 * alert; the pending table behind the dialog has already been re-read.
 */
function OutcomeText({ outcome }: { outcome: Outcome }) {
  const t = useTranslations("organization.invite");
  const roleName = useTranslations("organization.roles");
  const block = outcome.already ? "already" : "sent";
  return (
    <div
      className="flex flex-col gap-2"
      data-testid={outcome.already ? "invitation-already" : "invitation-sent"}
    >
      <p className="text-sm font-medium text-foreground">
        {t(`${block}.title`)}
      </p>
      <p className="text-sm text-muted-foreground">
        {t(`${block}.body`, {
          email: outcome.email,
          role: roleName(outcome.role),
        })}
      </p>
    </div>
  );
}

export function InviteDialog({
  org,
  pendingIds,
  allowed,
  after,
}: {
  org: string;
  /** The pending invitations the server last sent, by id; an answer on it already existed. */
  pendingIds: readonly string[];
  /** Owner and Admin invite; the handler checks it again. */
  allowed: boolean;
  /** The page, re-read once an invitation answered, so the pending table redraws. */
  after: SafePath;
}) {
  const t = useTranslations("organization.invite");
  const tReceipt = useTranslations("organization.receipts");
  const roleName = useTranslations("organization.roles");
  const failureText = useInviteFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("member");
  const [message, setMessage] = useState("");

  if (!allowed) {
    return (
      <p data-testid="invite-denied" className="text-sm text-muted-foreground">
        {t("denied")}
      </p>
    );
  }

  function openChange(next: boolean) {
    // A write in flight holds the dialog: the answer decides which of two
    // sentences the person reads, and nothing else reports it.
    if (pending && !next) return;
    setOpen(next);
    setFailure(null);
    if (next) {
      setOutcome(null);
      setEmail("");
      setRole("member");
      setMessage("");
    }
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await sendInvitation(org, { email, role, message });
      if (!result.ok) {
        setFailure(failureText(result));
        return;
      }
      recordReceipt(tReceipt("invited", { email: email.trim() }));
      setOutcome({
        email: email.trim(),
        role,
        already: pendingIds.includes(result.value.id),
      });
      // The pending table is server-rendered, so the roster is re-read rather
      // than patched here. The dialog stays open over it with the answer.
      navigate.replace(after);
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
          openChange(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={
          outcome === null
            ? t("title")
            : t(`${outcome.already ? "already" : "sent"}.title`)
        }
        closeLabel={outcome === null ? undefined : t("close")}
        testId="send-invitation"
      >
        {outcome === null ? (
          <form
            onSubmit={(e) => void submit(e)}
            className="flex flex-col gap-3"
          >
            <p className="text-sm text-muted-foreground">{t("body")}</p>
            <Field
              id="invite-email"
              name="email"
              type="email"
              label={t("email")}
              hint={t("emailHint")}
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={mono}
              value={email}
              onChange={(event) => {
                setEmail(event.currentTarget.value);
              }}
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="invite-role"
                className="text-sm font-medium text-foreground"
              >
                {t("role")}
              </label>
              <select
                id="invite-role"
                name="role"
                value={role}
                aria-describedby="invite-role-hint"
                className={inputBase}
                onChange={(event) => {
                  // The picker offers exactly what the contract admits, so the
                  // value is looked up in that set rather than asserted into it.
                  const { value } = event.currentTarget;
                  setRole(INVITABLE_ROLES.find((r) => r === value) ?? "member");
                }}
              >
                {INVITABLE_ROLES.map((option) => (
                  <option key={option} value={option}>
                    {roleName(option)}
                  </option>
                ))}
              </select>
              <p
                id="invite-role-hint"
                className="text-xs text-muted-foreground"
              >
                {t("roleHint")}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label
                htmlFor="invite-message"
                className="text-sm font-medium text-foreground"
              >
                {t("message")}
              </label>
              <textarea
                id="invite-message"
                name="message"
                rows={3}
                value={message}
                aria-describedby="invite-message-hint"
                className={inputBase}
                onChange={(event) => {
                  setMessage(event.currentTarget.value);
                }}
              />
              <p
                id="invite-message-hint"
                className="text-xs text-muted-foreground"
              >
                {t("messageHint")}
              </p>
            </div>
            {failure === null ? null : (
              <FormAlert testId="send-invitation-failure">{failure}</FormAlert>
            )}
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          </form>
        ) : (
          <OutcomeText outcome={outcome} />
        )}
      </SheetDialog>
    </>
  );
}
