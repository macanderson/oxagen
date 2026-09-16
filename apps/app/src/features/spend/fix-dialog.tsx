"use client";
// Fix (mockup `fix`, #2963): the two decisions a person takes on an open
// finding. The four kinds the job detects have their fix in the agent's own
// code, harness or tool configuration, which Oxagen does not hold, so the
// dialog shows the fix the finding names and records the change
// (record_finding_fix) or closes the finding (dismiss_finding). Both are org
// Owner or Admin in the handler, so a refusal renders as its sentence and
// changes nothing; a decision taken leaves the finding off the list, which the
// server renders again.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import { routes } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { dismissFindingAction, recordFindingFixAction } from "./actions";
import type { SpendAt } from "./view";

type Failure = Exclude<ActionResult<null>, { ok: true }>;

/** The sentence a refused decision shows; a code with no sentence of its own is printed as recorded. */
function useFailureText(): (failure: Failure) => string {
  const t = useTranslations("spend.findings.fix.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
            return t("orgRoleRequired");
          case "no_principal":
            return t("noPrincipal");
          case "finding_not_open":
            return t("notOpen");
          case "finding_not_found":
            return t("notFound");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        return t("invalid");
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

const UNANSWERED: Failure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

export function FixDialog({
  at,
  findingId,
  fix,
}: {
  at: SpendAt;
  findingId: string;
  /** The change the finding names, as the findings job wrote it. */
  fix: string;
}) {
  const t = useTranslations("spend");
  const failureText = useFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<"record" | "dismiss" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function decide(
    decision: "record" | "dismiss",
    write: () => Promise<ActionResult<null>>,
  ) {
    if (pending !== null) return;
    setFailure(null);
    setPending(decision);
    try {
      const result = await write();
      if (result.ok) {
        setOpen(false);
        navigate.replace(routes.spend(at.org, at.ws, { tab: "findings" }));
        return;
      }
      setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(null);
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
        {t("findings.fix.open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("findings.fix.title")}
        testId="spend-fix-dialog"
      >
        <form
          onSubmit={(event: SyntheticEvent<HTMLFormElement>) => {
            event.preventDefault();
            void decide("record", () => recordFindingFixAction(at, findingId));
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-sm text-foreground">{fix}</p>
          <p className="text-sm text-muted-foreground">
            {t("findings.fix.body")}
          </p>
          {failure === null ? null : (
            <FormAlert testId="spend-fix-failure">{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending === "record"}
            label={t("findings.fix.record")}
            pendingLabel={t("findings.fix.recording")}
          />
          <button
            type="button"
            className={buttonSecondary}
            aria-disabled={pending !== null || undefined}
            onClick={() => {
              void decide("dismiss", () => dismissFindingAction(at, findingId));
            }}
          >
            {pending === "dismiss"
              ? t("findings.fix.dismissing")
              : t("findings.fix.dismiss")}
          </button>
          <p className="text-xs text-muted-foreground">
            {t("findings.fix.dismissNote")}
          </p>
        </form>
      </SheetDialog>
    </>
  );
}
