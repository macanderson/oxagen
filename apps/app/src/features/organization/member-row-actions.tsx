"use client";
// The two writes a member's row carries: change their organization role and
// remove them from it, each behind a confirming dialog. An Owner or an Admin
// writes; for every other role the row renders the refusal in place of the
// buttons, which is what the handler would answer anyway (INV-29). A refusal is
// named in the dialog and changes nothing; a completed write reloads the roster.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import { GrantableOrgRole, type MemberList } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { changeMemberRole, removeOrgMember } from "./actions";
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

/**
 * One dialog around one write: the row's button opens it, the fields the caller
 * passes are its body, and an answer of ok closes it and reloads the roster.
 */
function WriteDialog({
  open: openLabel,
  title,
  confirm,
  pending: pendingLabel,
  testId,
  write,
  receipt,
  after,
  children,
}: {
  open: string;
  title: string;
  confirm: string;
  pending: string;
  testId: string;
  write: () => Promise<ActionResult<unknown>>;
  /** The line the write leaves once it answered ok. */
  receipt: string;
  /** The roster, reloaded once the write answered ok. */
  after: SafePath;
  children: ReactNode;
}) {
  const failureText = useFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

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
        className={buttonSecondary}
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
        testId={testId}
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          {children}
          {failure === null ? null : (
            <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={confirm}
            pendingLabel={pendingLabel}
          />
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
}: {
  org: string;
  member: Member;
  after: SafePath;
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
      title={t("actions.role.title", { name: member.name ?? member.email })}
      confirm={t("actions.role.confirm")}
      pending={t("actions.role.pending")}
      testId="change-member-role"
      write={() => changeMemberRole(org, member.id, role)}
      receipt={t("receipts.roleChanged", {
        name: member.name ?? member.email,
        role: roleLabel,
      })}
      after={after}
    >
      <p className="text-sm text-muted-foreground">{t("actions.role.body")}</p>
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
      title={t("actions.remove.title", { name: member.name ?? member.email })}
      confirm={t("actions.remove.confirm")}
      pending={t("actions.remove.pending")}
      testId="remove-member"
      write={() => removeOrgMember(org, member.id)}
      receipt={t("receipts.memberRemoved", {
        name: member.name ?? member.email,
      })}
      after={after}
    >
      <p className="text-sm text-muted-foreground">
        {t("actions.remove.body", { role: t(`roles.${member.role}`) })}
      </p>
    </WriteDialog>
  );
}

export function MemberRowActions({
  org,
  member,
  allowed,
  after,
}: {
  org: string;
  member: Member;
  /** Owner and Admin write membership; the handler checks it again. */
  allowed: boolean;
  after: SafePath;
}) {
  const t = useTranslations("organization");
  if (!allowed) {
    return (
      <p
        data-testid="member-actions-denied"
        className="text-sm text-muted-foreground"
      >
        {t("actions.denied")}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <ChangeRole org={org} member={member} after={after} />
      <RemoveMember org={org} member={member} after={after} />
    </div>
  );
}
