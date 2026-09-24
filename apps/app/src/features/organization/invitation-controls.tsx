"use client";
// An invitation's row: Resend runs at once, and Revoke opens the design's
// `invrevoke` dialog (the email as its subtitle, what revoking ends, and Cancel
// then Revoke in the footer), because revoking cannot be taken back. A refusal
// is named where the write was asked for and changes nothing; a write that
// answered leaves its receipt and reloads the table.
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { buttonDanger, buttonSecondary } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import {
  type ActionFailure,
  UNANSWERED,
  useActionFailure,
} from "./action-failure";
import { resendInvitation, revokeInvitation } from "./actions";
import { note } from "./parts";
import { recordReceipt } from "./receipt";

export function InvitationControls({
  org,
  invitationId,
  email,
  allowed,
}: {
  org: string;
  invitationId: string;
  /** The address the invitation went to: the revoke dialog's subtitle and body. */
  email: string;
  allowed: boolean;
}) {
  const t = useTranslations("organization.invitations");
  const tActions = useTranslations("organization.actions");
  const tReceipt = useTranslations("organization.receipts");
  const describeFailure = useActionFailure();
  const navigate = useNavigate();
  const busyRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{
    verb: "resend" | "revoke";
    failure: ActionFailure;
  } | null>(null);
  const [outcome, setOutcome] = useState<
    "resent" | "revoked" | "deliveryFailed" | null
  >(null);
  const formId = `revoke-invitation-${invitationId}-form`;

  async function act(verb: "resend" | "revoke") {
    if (!allowed || busyRef.current || outcome === "revoked") return;
    busyRef.current = true;
    setPending(true);
    setFailure(null);
    setOutcome(null);
    try {
      const result = await (verb === "resend"
        ? resendInvitation
        : revokeInvitation)(org, invitationId);
      if (result.ok) {
        recordReceipt(
          verb === "resend"
            ? tReceipt("invitationResent")
            : tReceipt("invitationRevoked"),
        );
        setOutcome(
          verb === "resend"
            ? "delivery" in result.value && result.value.delivery === "failed"
              ? "deliveryFailed"
              : "resent"
            : "revoked",
        );
        setConfirming(false);
        navigate.refresh();
      } else setFailure({ verb, failure: result });
    } catch {
      setFailure({ verb, failure: UNANSWERED });
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }

  const ended = !allowed || pending || outcome === "revoked";
  return (
    <div className="flex flex-col gap-2" data-testid="invitation-controls">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonSecondary}
          disabled={ended}
          onClick={() => void act("resend")}
        >
          {t("resend")}
        </button>
        <button
          type="button"
          className={buttonDanger}
          disabled={ended}
          onClick={() => {
            setFailure(null);
            setConfirming(true);
          }}
        >
          {t("revoke")}
        </button>
      </div>
      <SheetDialog
        open={confirming}
        onOpenChange={(next) => {
          setConfirming(next);
          if (!next && failure?.verb === "revoke") setFailure(null);
        }}
        title={t("confirmTitle")}
        subtitle={email}
        headerClose
        closeLabel={tActions("cancel")}
        footer={
          <SubmitButton
            form={formId}
            pending={pending}
            label={t("confirmRevoke")}
            pendingLabel={t("working")}
            fullWidth={false}
            danger
          />
        }
        testId={`revoke-invitation-${invitationId}`}
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act("revoke");
          }}
        >
          <p className="text-sm">
            {t.rich("confirmBody", {
              email,
              b: (chunks) => <b>{chunks}</b>,
            })}
          </p>
          <p className={note}>{t("confirmNote")}</p>
          {failure?.verb === "revoke" ? (
            <FormAlert>{describeFailure(failure.failure)}</FormAlert>
          ) : null}
        </form>
      </SheetDialog>
      {failure?.verb === "resend" ? (
        <FormAlert>{describeFailure(failure.failure)}</FormAlert>
      ) : null}
      <p role="status">{pending ? t("working") : outcome ? t(outcome) : ""}</p>
    </div>
  );
}
