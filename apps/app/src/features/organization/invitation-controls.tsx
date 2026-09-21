"use client";
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { resendInvitation, revokeInvitation } from "./actions";
import {
  type ActionFailure,
  UNANSWERED,
  useActionFailure,
} from "./action-failure";

export function InvitationControls({
  org,
  invitationId,
  allowed,
}: {
  org: string;
  invitationId: string;
  allowed: boolean;
}) {
  const t = useTranslations("organization.invitations");
  const describeFailure = useActionFailure();
  const navigate = useNavigate();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [outcome, setOutcome] = useState<"resent" | "revoked" | null>(null);
  async function act(verb: "resend" | "revoke") {
    if (!allowed || busy.current || outcome === "revoked") return;
    busy.current = true;
    setPending(true);
    setFailure(null);
    setOutcome(null);
    try {
      const result = await (verb === "resend"
        ? resendInvitation
        : revokeInvitation)(org, invitationId);
      if (result.ok) {
        setOutcome(verb === "resend" ? "resent" : "revoked");
        navigate.refresh();
      } else setFailure(result);
    } catch {
      setFailure(UNANSWERED);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="flex flex-col gap-2" data-testid="invitation-controls">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonSecondary}
          disabled={!allowed || pending || outcome === "revoked"}
          onClick={() => void act("resend")}
        >
          {t("resend")}
        </button>
        <button
          type="button"
          className={buttonSecondary}
          disabled={!allowed || pending || outcome === "revoked"}
          onClick={() => void act("revoke")}
        >
          {t("revoke")}
        </button>
      </div>
      {failure ? <FormAlert>{describeFailure(failure)}</FormAlert> : null}
      <p role="status">{pending ? t("working") : outcome ? t(outcome) : ""}</p>
    </div>
  );
}
