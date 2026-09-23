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
import {
  APPROVAL_NOTE_MAX,
  type ApprovalSettlement,
  type AutoEligibility,
} from "@/data/contracts/approvals";
import type { ActionResult } from "@/server/kernel";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  linkText,
  mono,
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
 * The copy names that mandate only on a row that records one (#3521). On a
 * row that records none it says the call is waiting and the record names no
 * mandate, because a line about trust shows the recorded value and nothing
 * stronger (spec §14).
 */
export function Eligibility({
  eligibility,
  mandateId,
}: {
  eligibility: AutoEligibility | null;
  /** The mandate the parked call drew on (`mnd_…`), or null when the row records none. */
  mandateId: string | null;
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
        {!eligibility.ok
          ? t("blocked", { rule: eligibility.ruleRef })
          : mandateId === null
            ? t("okNoMandate", { rule: eligibility.ruleRef })
            : t("okMandate", { rule: eligibility.ruleRef, mandate: mandateId })}
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
        switch (failure.code) {
          case "note_required":
            return t("noteRequired");
          case "note_too_long":
            return t("noteTooLong", { max: APPROVAL_NOTE_MAX });
          default:
            return t("invalid");
        }
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
 * Who or what already closed this call, read when the dialog opened (#3521).
 *
 * A person is named by display name, with the public id beside it in a
 * copyable span rather than as the label (CLAUDE.md, Runtime checks that
 * matter). A rule is named by its id, which is its own name. A call that
 * nothing resolved (a mandate revoke, or the request's own expiry) says it
 * expired, rather than naming a resolver the record does not hold.
 */
function Settled({ settlement }: { settlement: ApprovalSettlement }) {
  const t = useTranslations("fleet.approvals.decide.settled");
  const id = (publicId: string) => () => (
    <span data-testid="approval-settled-id" className={`${mono} select-all`}>
      {publicId}
    </span>
  );
  return (
    <FormAlert testId="approval-settled">
      {settlement.by === "person"
        ? settlement.name === null
          ? t.rich("personUnnamed", {
              resolution: settlement.resolution,
              id: id(settlement.id),
            })
          : t.rich("person", {
              name: settlement.name,
              resolution: settlement.resolution,
              id: id(settlement.id),
            })
        : settlement.by === "rule"
          ? t("rule", {
              rule: settlement.rule,
              resolution: settlement.resolution,
            })
          : t("none", { resolution: settlement.resolution })}
    </FormAlert>
  );
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
  onResolved,
  approvalId,
  tool,
  eligibility,
  mandateId,
  org,
  ws,
  on,
}: {
  onResolved?: () => void;
  approvalId: string;
  /** The mandate the parked call drew on, which the eligibility line names. */
  mandateId: string | null;
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
    settlement: ApprovalSettlement | null;
    eligibility: AutoEligibility | null;
  } | null>(null);
  /** The code a refused re-read answered; the recorded line stays either way. */
  const [unread, setUnread] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const readGenerationRef = useRef(0);
  const noteId = `approval-note-${approvalId}`;

  function reset() {
    readGenerationRef.current += 1;
    setReading(false);
    setNote("");
    setFailure(null);
    setFresh(null);
    setUnread(null);
  }

  async function load() {
    const generation = ++readGenerationRef.current;
    setReading(true);
    try {
      const result = await readApprovalEligibility(org, ws, approvalId, on);
      if (generation !== readGenerationRef.current) return;
      if (result.ok) setFresh(result.value);
      else
        setUnread(
          result.reason === "pending_approval"
            ? "pending_approval"
            : result.code,
        );
    } catch {
      if (generation === readGenerationRef.current) setUnread("action_failed");
    } finally {
      if (generation === readGenerationRef.current) setReading(false);
    }
  }

  async function submit(decision: "approved" | "denied") {
    if (pending !== null || reading || (fresh?.settlement ?? null) !== null)
      return;
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
        onResolved?.();
      } else {
        setFailure(result);
      }
    } catch {
      setFailure(UNANSWERED);
    } finally {
      setPending(null);
    }
  }

  /** Null while the call is still pending, or before the read answered. */
  const settlement = fresh?.settlement ?? null;
  const settled = settlement !== null;
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
          <Eligibility eligibility={shown} mandateId={mandateId} />
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
          {settlement === null ? null : <Settled settlement={settlement} />}
          <div className="flex flex-col gap-1 text-sm text-foreground">
            <label htmlFor={noteId}>{t("note")}</label>
            <textarea
              id={noteId}
              name="note"
              rows={2}
              maxLength={APPROVAL_NOTE_MAX}
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
              aria-disabled={busy || settled || undefined}
              className={buttonPrimary}
              onClick={() => {
                if (!settled) void submit("approved");
              }}
            >
              {pending === "approved" ? t("approving") : t("approve")}
            </button>
            <button
              type="button"
              data-testid="deny"
              aria-disabled={busy || settled || undefined}
              className={buttonSecondary}
              onClick={() => {
                if (!settled) void submit("denied");
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
