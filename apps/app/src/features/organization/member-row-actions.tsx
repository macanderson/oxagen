"use client";
// A member's row: Open (the member dialog, whose footer carries Change role as
// the design draws it), and the two writes, change their organization role
// and remove them from it, each behind a confirming dialog. An Owner or an
// Admin writes; for every other role the row renders the refusal in place of
// the buttons, which is what the handler would answer anyway (INV-29). A
// refusal is named in the dialog and changes nothing; a completed write
// reloads the roster.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import { GrantableOrgRole, type MemberList } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import type { SafePath } from "@/shared/safe-path";
import {
  buttonDanger,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { changeMemberRole, removeOrgMember } from "./actions";
import { note } from "./parts";
import { recordReceipt } from "./receipt";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

/** A write that threw before it answered, as the seam would name it. */
const UNANSWERED: Failure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

/**
 * The sentence a refused membership write shows. The kernel classified the
 * refusal and put the handler's `HandlerError` reason in `code` (§3.2), so each
 * reason the two handlers throw has its own sentence and any other code is
 * printed as recorded.
 */
function useFailureText(): (failure: Failure) => string {
  const t = useTranslations("organization.actions.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "last_owner":
            return t("lastOwner");
          case "target_not_member":
            return t("targetNotMember");
          case "role_not_found":
            return t("roleNotFound");
          case "insufficient_role":
            return t("insufficientRole");
          case "no_principal":
          case "unauthenticated":
            return t("noPrincipal");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        return failure.code === "role_not_grantable"
          ? t("roleNotGrantable")
          : t("invalid");
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  };
}

type Member = MemberList["members"][number];

/** A dialog's open state, held by the caller when another dialog opens it too. */
type OpenState = { open: boolean; setOpen: (open: boolean) => void };

/**
 * One dialog around one write: the row's button opens it, the fields the caller
 * passes are its body, and an answer of ok closes it and reloads the roster.
 * The footer reads Cancel then the confirm, as the design draws it.
 */
function WriteDialog({
  open: openLabel,
  title,
  subtitle,
  confirm,
  pending: pendingLabel,
  testId,
  write,
  receipt,
  after,
  state,
  danger = false,
  children,
}: {
  open: string;
  title: string;
  /** The line under the title: who the write acts on. */
  subtitle: string;
  confirm: string;
  pending: string;
  testId: string;
  write: () => Promise<ActionResult<unknown>>;
  /** The line the write leaves once it answered ok. */
  receipt: string;
  /** The roster, reloaded once the write answered ok. */
  after: SafePath;
  /** The open state, when the member dialog can open this one too. */
  state?: OpenState;
  /** A write that ends something: the row's button and the confirm are `btn danger`. */
  danger?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("organization.actions");
  const failureText = useFailureText();
  const navigate = useNavigate();
  const [ownOpen, setOwnOpen] = useState(false);
  const open = state?.open ?? ownOpen;
  const setOpen = state?.setOpen ?? setOwnOpen;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const formId = `${testId}-form`;

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setFailure(null);
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await write();
      if (result.ok) {
        recordReceipt(receipt);
        setOpen(false);
        navigate.replace(after);
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
        className={danger ? buttonDanger : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {openLabel}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={openChange}
        title={title}
        subtitle={subtitle}
        headerClose
        closeLabel={t("cancel")}
        footer={
          <SubmitButton
            form={formId}
            pending={pending}
            label={confirm}
            pendingLabel={pendingLabel}
            fullWidth={false}
            danger={danger}
          />
        }
        testId={testId}
      >
        <form
          id={formId}
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          {children}
          {failure === null ? null : (
            <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
          )}
        </form>
      </SheetDialog>
    </>
  );
}

/** The role the picker opens on: the one they hold, when it is one this org grants. */
function currentRole(member: Member): GrantableOrgRole {
  const held = GrantableOrgRole.safeParse(member.role);
  return held.success ? held.data : "admin";
}

function ChangeRole({
  org,
  member,
  after,
  state,
}: {
  org: string;
  member: Member;
  after: SafePath;
  state: OpenState;
}) {
  const t = useTranslations("organization");
  const roleName = useTranslations("organization.roles");
  const [role, setRole] = useState<string>(() => currentRole(member));
  const selectId = `member-role-${member.id}`;
  const granted = GrantableOrgRole.options.find((option) => option === role);
  const roleLabel = granted === undefined ? role : roleName(granted);
  return (
    <WriteDialog
      open={t("actions.role.open")}
      title={t("actions.role.title")}
      subtitle={member.email}
      confirm={t("actions.role.confirm")}
      pending={t("actions.role.pending")}
      testId="change-member-role"
      state={state}
      write={() => changeMemberRole(org, member.id, role)}
      receipt={t("receipts.roleChanged", {
        name: member.name ?? member.email,
        role: roleLabel,
      })}
      after={after}
    >
      <label htmlFor={`${selectId}-person`} className="text-sm font-medium">
        {t("actions.role.person")}
      </label>
      <input
        id={`${selectId}-person`}
        value={member.name ?? member.email}
        disabled
        readOnly
        className={inputBase}
      />
      <label htmlFor={selectId} className="text-sm font-medium">
        {t("actions.role.label")}
      </label>
      <select
        id={selectId}
        value={role}
        className={inputBase}
        onChange={(event) => {
          setRole(event.currentTarget.value);
        }}
      >
        {GrantableOrgRole.options.map((option) => (
          <option key={option} value={option}>
            {roleName(option)}
          </option>
        ))}
      </select>
      <p className={note}>{t("actions.role.note")}</p>
    </WriteDialog>
  );
}

function RemoveMember({
  org,
  member,
  after,
}: {
  org: string;
  member: Member;
  after: SafePath;
}) {
  const t = useTranslations("organization");
  return (
    <WriteDialog
      open={t("actions.remove.open")}
      title={t("actions.remove.title")}
      subtitle={member.name ?? member.email}
      confirm={t("actions.remove.confirm")}
      pending={t("actions.remove.pending")}
      testId="remove-member"
      danger
      write={() => removeOrgMember(org, member.id)}
      receipt={t("receipts.memberRemoved", {
        name: member.name ?? member.email,
      })}
      after={after}
    >
      <p className="text-sm">
        {t.rich("actions.remove.body", {
          name: member.name ?? member.email,
          role: t(`roles.${member.role}`),
          mono: (chunks) => <span className={mono}>{chunks}</span>,
        })}
      </p>
      <p className={note}>{t("actions.remove.note")}</p>
    </WriteDialog>
  );
}

/**
 * The member dialog (mockup `member`): the person's facts, which the caller
 * renders, with Close and Change role in the footer. Change role closes it and
 * opens the row's own Change role dialog, so there is one role write per row.
 */
function MemberDialog({
  member,
  openLabel,
  changeRole,
  onChangeRole,
  children,
}: {
  member: Member;
  openLabel: string;
  /** The footer's Change role, or null for a viewer who may not write it. */
  changeRole: string | null;
  onChangeRole: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {openLabel}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={member.name ?? member.email}
        subtitle={member.email}
        headerClose
        footer={
          changeRole === null ? undefined : (
            <button
              type="button"
              data-touch-target=""
              className={buttonSecondary}
              onClick={() => {
                setOpen(false);
                onChangeRole();
              }}
            >
              {changeRole}
            </button>
          )
        }
        testId={`member-${member.id}`}
      >
        {children}
      </SheetDialog>
    </>
  );
}

export function MemberRowActions({
  org,
  member,
  allowed,
  after,
  details,
}: {
  org: string;
  member: Member;
  /** Owner and Admin write membership; the handler checks it again. */
  allowed: boolean;
  after: SafePath;
  /** The member dialog's body; when given, the row leads with Open. */
  details?: ReactNode;
}) {
  const t = useTranslations("organization");
  const [roleOpen, setRoleOpen] = useState(false);
  const open =
    details === undefined ? null : (
      <MemberDialog
        member={member}
        openLabel={t("people.open")}
        changeRole={allowed ? t("actions.role.open") : null}
        onChangeRole={() => {
          setRoleOpen(true);
        }}
      >
        {details}
      </MemberDialog>
    );
  if (!allowed) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {open}
        <p
          data-testid="member-actions-denied"
          className="text-sm text-muted-foreground"
        >
          {t("actions.denied")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {open}
      <ChangeRole
        org={org}
        member={member}
        after={after}
        state={{ open: roleOpen, setOpen: setRoleOpen }}
      />
      <RemoveMember org={org} member={member} after={after} />
    </div>
  );
}
