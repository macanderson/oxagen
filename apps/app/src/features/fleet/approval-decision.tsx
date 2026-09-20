"use client";
// The decision on a parked tool call, and the eligibility line the card and the
// dialog both draw.
//
// **Two buttons, no default.** Approve and Deny sit side by side and neither is
// preselected, because a decision surface that pre-picks one has made the
// safer answer the slower one. Approve carries the primary style as the action
// a reader is most often here to take; gold marks the action, never a severity,
// so a denial is not the loudest control on the card.
//
// **Neither button is hidden from a reader whose roles cannot make the write.**
// The handler holds the gate (see actions.ts, INV-29), and an operator told
// which office answers this call has learned something, where one shown nothing
// has only been left to guess.
//
// **The eligibility line is what was recorded, never what the rules say now**
// (ADR-070). A rule edited since the call was parked is a different rule than
// the one that judged it, so the line names the rule id and says the evaluation
// is the recorded one.
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { AutoEligibility } from "@/data/contracts/approvals";
import type { ActionResult } from "@/server/kernel";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  linkText,
} from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { readApprovalEligibility, resolveApprovalAction } from "./actions";

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

/** A write that threw before it answered, as the seam would have named it. */
const UNANSWERED: Failure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

/**
 * The reason codes the evaluator records that name a measure
 * (`measure_above_ceiling:amount`), and the ones that stand alone. They are
 * `REASON` in `packages/rules/src/auto-approval.ts`, which the app may not
 * import, mirrored here so a code the evaluator adds shows as its own code
 * rather than as a sentence written for a different condition.
 */
const MEASURED_REASONS = [
  "measure_above_ceiling",
  "measure_unreadable",
  "target_not_allowed",
  "target_unreadable",
] as const;
const PLAIN_REASONS = [
  "tool_not_declared",
  "tainted_input",
  "critical_hazard",
  "irreversible_consequence",
  "no_standing_approval",
  "outside_business_hours",
  "consequences_changed",
] as const;

type MeasuredReason = (typeof MEASURED_REASONS)[number];
type PlainReason = (typeof PLAIN_REASONS)[number];

const isMeasured = (code: string): code is MeasuredReason =>
  MEASURED_REASONS.some((entry) => entry === code);
const isPlain = (code: string): code is PlainReason =>
  PLAIN_REASONS.some((entry) => entry === code);

function Reason({ code }: { code: string }) {
  const t = useTranslations("fleet.approvals.eligibility");
  const [base, measure = ""] = code.split(":");
  if (base !== undefined && isMeasured(base) && measure !== "")
    return <li>{t(`reasons.${base}`, { measure })}</li>;
  if (base !== undefined && isPlain(base))
    return <li>{t(`reasons.${base}`)}</li>;
  // A code this build has no copy for is printed as the evaluator recorded it.
  // Inventing a sentence for an unknown condition would be the one thing an
  // eligibility line must not do.
  return <li>{t("unknownReason", { code })}</li>;
}

/**
 * What the auto-approval clause said about this call: the rule that was read,
 * whether it qualified, and every reason it did not.
 *
 * `ok: true` on a call that is still parked is not a contradiction. A mandate's
 * own approval rule outranks any workspace rule (MC spec §6.9 part 3), so the
 * rule would have released the call and the mandate asked for a person anyway.
 * The copy says that rather than leaving a reader to reconcile the two.
 */
export function Eligibility({
  eligibility,
}: {
  eligibility: AutoEligibility | null;
}) {
  const t = useTranslations("fleet.approvals.eligibility");
  if (eligibility === null)
    return (
      <p data-testid="eligibility" className="text-xs text-muted-foreground">
        {t("none")}
      </p>
    );
  return (
    <div data-testid="eligibility" className="flex flex-col gap-1 text-xs">
      <p>
        {eligibility.ok
          ? t("ok", { rule: eligibility.ruleRef })
          : t("blocked", { rule: eligibility.ruleRef })}
      </p>
      {eligibility.reasons.length === 0 ? null : (
        <ul className="list-inside list-disc text-muted-foreground">
          {eligibility.reasons.map((code) => (
            <Reason key={code} code={code} />
          ))}
        </ul>
      )}
      {eligibility.floor ? (
        <p data-testid="eligibility-floor" className="text-muted-foreground">
          {t("floor")}
        </p>
      ) : null}
      <p className="text-muted-foreground">{t("recorded")}</p>
    </div>
  );
}

function useFailureText(): (failure: Failure) => string {
  const t = useTranslations("fleet.approvals.decide.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "no_principal":
            return t("noPrincipal");
          case "org_role_required":
            return t("orgRoleRequired");
          case "no_role_covers_all_tags":
            return t("noRoleCoversAllTags");
          case "not_an_approver":
            return t("notAnApprover");
          case "agent_cannot_resolve_own_mandate":
            return t("agentCannotResolveOwnMandate");
          case "approval_expired":
            return t("approvalExpired");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        return failure.code === "note_required"
          ? t("noteRequired")
          : t("invalid");
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
        return t("exhausted", { code: failure.code });
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  };
}

/**
 * Approve or deny, with the reason the record keeps.
 *
 * On a decision the kernel accepted, the dialog closes and the page re-reads
 * its server components (`navigate.refresh()`). The card leaves the pending
 * panel, and on the Run page it appears in the resolved list below, without a
 * reload and without this component holding a second copy of the queue.
 */
export function ApprovalDecision({
  approvalId,
  tool,
  eligibility,
  org,
  ws,
  on,
}: {
  approvalId: string;
  /** The capability the parked call asked for, which titles the dialog. */
  tool: string;
  /** The evaluation the page read, shown until the dialog reads it again. */
  eligibility: AutoEligibility | null;
  org: string;
  ws: string;
  /** Which page is drawing the card, so a refused re-read names that page's permission. */
  on: "fleet" | "run";
}) {
  const t = useTranslations("fleet.approvals.decide");
  const failureText = useFailureText();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approved" | "denied" | null>(null);
  /**
   * The refusal itself, not a rendered sentence. INV-14 has an exhausted
   * refusal carry the way out of it, and this is the invariant's one rev1
   * producer: a decision is the one billed action of the surface (ADR-115), so
   * the dialog holds the failure and draws the billing link beside the code.
   */
  const [failure, setFailure] = useState<Failure | null>(null);
  /** What the dialog read when it opened: null while it is reading. */
  const [fresh, setFresh] = useState<{
    resolvedBy: string | null;
    eligibility: AutoEligibility | null;
  } | null>(null);
  /** The code a refused re-read answered; the recorded line stays either way. */
  const [unread, setUnread] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const readGeneration = useRef(0);
  const noteId = `approval-note-${approvalId}`;

  function reset() {
    readGeneration.current += 1;
    setReading(false);
    setNote("");
    setFailure(null);
    setFresh(null);
    setUnread(null);
  }

  async function load() {
    const generation = ++readGeneration.current;
    setReading(true);
    try {
      const result = await readApprovalEligibility(org, ws, approvalId, on);
      if (generation !== readGeneration.current) return;
      if (result.ok) setFresh(result.value);
      else
        setUnread(
          result.reason === "pending_approval"
            ? "pending_approval"
            : result.code,
        );
    } catch {
      if (generation === readGeneration.current) setUnread("action_failed");
    } finally {
      if (generation === readGeneration.current) setReading(false);
    }
  }

  async function submit(decision: "approved" | "denied") {
    if (pending !== null || reading) return;
    setPending(decision);
    setFailure(null);
    try {
      const result = await resolveApprovalAction(org, ws, {
        approvalId,
        decision,
        note,
      });
      if (result.ok) {
        setOpen(false);
        reset();
        navigate.refresh();
      } else {
        setFailure(result);
      }
    } catch {
      setFailure(UNANSWERED);
    } finally {
      setPending(null);
    }
  }

  const settledBy = fresh?.resolvedBy ?? null;
  const shown = fresh === null ? eligibility : fresh.eligibility;
  const busy = pending !== null || reading;

  return (
    <>
      <button
        type="button"
        data-testid="decide"
        className={`${buttonPrimary} self-start`}
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
        title={t("title", { tool })}
        testId="approval-decision"
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <Eligibility eligibility={shown} />
          {fresh === null && unread === null ? (
            <p
              data-testid="eligibility-checking"
              className="text-xs text-muted-foreground"
            >
              {t("checking")}
            </p>
          ) : null}
          {unread === null ? null : (
            <p
              data-testid="eligibility-unread"
              className="text-xs text-muted-foreground"
            >
              {t("eligibilityUnread", { code: unread })}
            </p>
          )}
          {settledBy === null ? null : (
            <FormAlert testId="approval-settled">
              {t("settled", { by: settledBy })}
            </FormAlert>
          )}
          <div className="flex flex-col gap-1 text-sm text-foreground">
            <label htmlFor={noteId}>{t("note")}</label>
            <textarea
              id={noteId}
              name="note"
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              className={inputBase}
            />
            <p className="text-xs text-muted-foreground">{t("noteHint")}</p>
          </div>
          {failure === null ? null : (
            <FormAlert testId="approval-decision-failure">
              {failureText(failure)}
              {failure.reason === "exhausted" ? (
                <>
                  {" "}
                  <SafeLink
                    to={routes.billing(org)}
                    data-testid="approval-decision-billing"
                    className={linkText}
                  >
                    {t("failure.billingLink")}
                  </SafeLink>
                </>
              ) : null}
            </FormAlert>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="approve"
              aria-disabled={busy || settledBy !== null || undefined}
              className={buttonPrimary}
              onClick={() => {
                if (settledBy === null) void submit("approved");
              }}
            >
              {pending === "approved" ? t("approving") : t("approve")}
            </button>
            <button
              type="button"
              data-testid="deny"
              aria-disabled={busy || settledBy !== null || undefined}
              className={buttonSecondary}
              onClick={() => {
                if (settledBy === null) void submit("denied");
              }}
            >
              {pending === "denied" ? t("denying") : t("deny")}
            </button>
          </div>
        </div>
      </SheetDialog>
    </>
  );
}
