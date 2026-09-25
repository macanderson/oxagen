"use client";
// The writes one assistant turn parked, as cards in the thread (#4162). Each
// card is one approval row, with Approve and Deny while it waits, and what
// became of the call once it is decided.
//
// **The decision is the person's.** Approve and Deny call Fleet's own action
// (`resolveApprovalAction`, through `@/features/fleet/client`), which resolves
// the signed-in viewer and writes `resolve_approval` through the kernel seam.
// Nothing here carries the turn's run or acts as the turn, so a run can never
// approve its own write through this card. A denial needs a reason, and the
// action refuses one without it, exactly as it does on Fleet.
//
// **The state is the row's.** Every card shows what its approval row records,
// read through `readParkedApprovals` narrowed to the turn's run: waiting,
// approved with the call's execution, denied, or expired. A person deciding on
// Fleet, a second viewer, and the expiry all change the row, so the card
// re-reads it: once when it mounts, after every decision, and every few
// seconds while any card still waits or a delivered call has not finished. The
// re-reads stop after a bound, and "Check again" reads it on demand after that.
//
// **Approved means it runs.** The handler delivers the approved call in the
// same request (ADR-118) and answers the row's execution, so the card says the
// call ran, and links the run it was recorded as, as soon as the decision
// returns. A call left queued for the periodic worker is watched until it
// settles.
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveApprovalAction } from "@/features/fleet/client";
import type { ActionResult } from "@/server/kernel";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  linkText,
  mono,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { SafeLink, useNavigate } from "@/ui/navigation";
import type { ParkedCard } from "./assistant-actions";
import {
  type ParkedApprovalRow,
  type ParkedExecution,
  readParkedApprovals,
} from "./assistant-approval-actions";

/**
 * How often a card that is not settled reads its row again. The reads are
 * console reads that meter nothing.
 *
 * @internal Exported for its unit test.
 */
export const PARKED_POLL_MS = 10_000;
/**
 * How many timed re-reads a turn's cards make before they stop: six minutes,
 * which covers the five-minute approval window and the periodic worker's next
 * pass after it. "Check again" reads on demand after that.
 *
 * @internal Exported for its unit test.
 */
export const PARKED_POLL_MAX = 36;

/** An execution the handler or the worker has not finished. */
const UNSETTLED = new Set(["queued", "running", "waiting"]);

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

/** A write that threw before it answered, as the seam would have named it. */
const UNANSWERED: Failure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

/** What one card shows, derived from its row and the card the turn returned. */
type CardView =
  | { kind: "checking" }
  | { kind: "waiting"; expiresAt: string }
  | { kind: "expired" }
  | {
      kind: "approved";
      execution: ParkedExecution | null;
      resolvedBy: string | null;
    }
  | { kind: "denied"; resolvedBy: string | null };

function viewOf(
  card: ParkedCard,
  row: ParkedApprovalRow | undefined,
  read: boolean,
  readAt: number,
): CardView {
  if (row === undefined) {
    // Not read yet: the card waits on the first read. Read and absent from
    // both lists: the record holds it neither as pending nor as resolved,
    // which is an approval the expiry sweep has not reached yet once its
    // deadline has passed.
    if (!read) return { kind: "checking" };
    return Date.parse(card.expiresAt) <= readAt
      ? { kind: "expired" }
      : { kind: "waiting", expiresAt: card.expiresAt };
  }
  switch (row.state) {
    case "waiting":
      return Date.parse(row.expiresAt) <= readAt
        ? { kind: "expired" }
        : { kind: "waiting", expiresAt: row.expiresAt };
    case "approved":
      return {
        kind: "approved",
        execution: row.execution,
        resolvedBy: row.resolvedBy,
      };
    case "denied":
      return { kind: "denied", resolvedBy: row.resolvedBy };
    case "expired":
      return { kind: "expired" };
  }
}

/** Whether a card still has something to learn from its row. */
function unsettled(view: CardView): boolean {
  if (view.kind === "checking" || view.kind === "waiting") return true;
  return (
    view.kind === "approved" &&
    view.execution !== null &&
    UNSETTLED.has(view.execution.status)
  );
}

/**
 * The row a card shows. A decision this card made is kept beside the reads,
 * because a read that started before the decision can land after it and still
 * say the row waits; the decision's answer is itself read back from the row
 * (the handler answers the row's execution), so it never outranks a read that
 * already shows the row resolved.
 */
function rowFor(
  id: string,
  rows: ReadonlyMap<string, ParkedApprovalRow> | null,
  decided: ReadonlyMap<string, ParkedApprovalRow>,
): ParkedApprovalRow | undefined {
  const read = rows?.get(id);
  const mine = decided.get(id);
  if (mine === undefined) return read;
  if (read === undefined || read.state === "waiting") return mine;
  return read;
}

export function AssistantParkedApprovals({
  org,
  ws,
  runId,
  cards,
}: {
  org: string;
  ws: string;
  /** `arun_…`: the run the turn was recorded as, which every parked row names. */
  runId: string;
  cards: readonly ParkedCard[];
}) {
  const t = useTranslations("shell.assistant.parkedCard");
  const navigate = useNavigate();
  const [rows, setRows] = useState<ReadonlyMap<
    string,
    ParkedApprovalRow
  > | null>(null);
  const [readAt, setReadAt] = useState(0);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  const [decided, setDecided] = useState<
    ReadonlyMap<string, ParkedApprovalRow>
  >(() => new Map());
  const [polls, setPolls] = useState(0);
  // A read that returns after a later one started is dropped, so an older row
  // never paints over a newer one.
  const generationRef = useRef(0);

  const read = useCallback(async () => {
    const generation = ++generationRef.current;
    try {
      const result = await readParkedApprovals(org, ws, runId);
      if (generation !== generationRef.current) return;
      setReadAt(Date.now());
      if (result.ok) {
        setRows(new Map(result.value.rows.map((row) => [row.id, row])));
        setReadFailure(null);
      } else {
        setReadFailure(
          result.reason === "pending_approval"
            ? "pending_approval"
            : result.code,
        );
      }
    } catch {
      if (generation !== generationRef.current) return;
      setReadAt(Date.now());
      setReadFailure("action_failed");
    }
  }, [org, ws, runId]);

  // The first read lands on the next task rather than in the effect body,
  // where a state change would cascade a second render.
  useEffect(() => {
    const first = setTimeout(() => {
      void read();
    }, 0);
    return () => {
      clearTimeout(first);
    };
  }, [read]);

  const views = cards.map((card) =>
    viewOf(
      card,
      rowFor(card.approvalId, rows, decided),
      // A failed first read still lets the person decide from the card the
      // turn returned: the handler refuses a decision the row no longer takes.
      rows !== null || readFailure !== null,
      readAt,
    ),
  );
  const watching = views.some(unsettled) && polls < PARKED_POLL_MAX;

  // One timed re-read after each read while something is unsettled. Keyed on
  // `readAt`, so the next one is scheduled only once the last one answered.
  useEffect(() => {
    if (!watching || readAt === 0) return;
    const next = setTimeout(() => {
      setPolls((count) => count + 1);
      void read();
    }, PARKED_POLL_MS);
    return () => {
      clearTimeout(next);
    };
  }, [watching, readAt, read]);

  function onDecided(card: ParkedCard, decision: ParkedApprovalRow | null) {
    if (decision !== null)
      setDecided((prior) => new Map(prior).set(card.approvalId, decision));
    // A decision starts a new watch: a delivered call may still be queued.
    setPolls(0);
    // Fleet's panel, the drawer and the waiting counts were rendered on the
    // server before this decision, so they are re-read the way Fleet's own
    // dialog re-reads them.
    navigate.refresh();
    void read();
  }

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {readFailure === null ? null : (
        <p
          data-testid="assistant-parked-unread"
          className="text-[12px] text-muted-foreground"
        >
          {t("unread", { code: readFailure })}
        </p>
      )}
      <ul className="flex flex-col gap-1.5" aria-label={t("list")}>
        {cards.map((card, index) => (
          <ParkedApproval
            key={card.approvalId}
            card={card}
            view={views[index] ?? { kind: "checking" }}
            org={org}
            ws={ws}
            onDecided={onDecided}
          />
        ))}
      </ul>
      {!watching && views.some(unsettled) ? (
        <button
          type="button"
          data-testid="assistant-parked-check"
          className={`self-start text-[12px] ${linkText}`}
          onClick={() => {
            setPolls(0);
            void read();
          }}
        >
          {t("checkAgain")}
        </button>
      ) : null}
    </div>
  );
}

function ParkedApproval({
  card,
  view,
  org,
  ws,
  onDecided,
}: {
  card: ParkedCard;
  view: CardView;
  org: string;
  ws: string;
  onDecided: (card: ParkedCard, decision: ParkedApprovalRow | null) => void;
}) {
  const t = useTranslations("shell.assistant.parkedCard");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approved" | "denied" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Set when the record refused this card's decision because the row was no
  // longer pending: someone else answered it first, or it expired.
  const [answeredFirst, setAnsweredFirst] = useState(false);
  const noteId = `assistant-parked-note-${card.approvalId}`;

  async function decide(decision: "approved" | "denied") {
    if (pending !== null) return;
    setPending(decision);
    setFailure(null);
    try {
      const result = await resolveApprovalAction(org, ws, {
        approvalId: card.approvalId,
        decision,
        note,
      });
      if (result.ok) {
        onDecided(card, {
          id: card.approvalId,
          state: result.value.resolution,
          resolvedBy: null,
          resolvedAt: new Date().toISOString(),
          execution: result.value.execution,
        });
      } else if (
        result.reason === "conflict" &&
        result.code === "approval_expired"
      ) {
        setAnsweredFirst(true);
        onDecided(card, null);
      } else {
        setFailure(result);
      }
    } catch {
      setFailure(UNANSWERED);
    } finally {
      setPending(null);
    }
  }

  const deciding = view.kind === "waiting" || view.kind === "checking";

  return (
    <li
      data-testid="assistant-parked-card"
      data-approval={card.approvalId}
      className="flex flex-col gap-1.5 rounded-md border border-border px-2.5 py-2 text-[12px]"
    >
      <p className="text-app-raised-fg">
        <span className={mono}>{card.capability}</span>
      </p>
      <Outcome view={view} org={org} ws={ws} />
      {answeredFirst && !deciding ? (
        <p
          data-testid="assistant-parked-first"
          className="text-muted-foreground"
        >
          {t("answeredFirst")}
        </p>
      ) : null}
      {deciding ? (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={noteId} className="text-muted-foreground">
              {t("note")}
            </label>
            <textarea
              id={noteId}
              rows={1}
              maxLength={2000}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              className={inputBase}
            />
            <p className="text-muted-foreground">{t("noteHint")}</p>
          </div>
          {failure === null ? null : (
            <FailureLine failure={failure} org={org} />
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="assistant-parked-approve"
              aria-disabled={
                pending !== null || view.kind === "checking" || undefined
              }
              className={buttonPrimary}
              onClick={() => {
                if (view.kind !== "checking") void decide("approved");
              }}
            >
              {pending === "approved" ? t("approving") : t("approve")}
            </button>
            <button
              type="button"
              data-testid="assistant-parked-deny"
              aria-disabled={
                pending !== null || view.kind === "checking" || undefined
              }
              className={buttonSecondary}
              onClick={() => {
                if (view.kind !== "checking") void decide("denied");
              }}
            >
              {pending === "denied" ? t("denying") : t("deny")}
            </button>
          </div>
        </>
      ) : null}
    </li>
  );
}

/** The card's state as one line, announced when it changes. */
function Outcome({
  view,
  org,
  ws,
}: {
  view: CardView;
  org: string;
  ws: string;
}) {
  const t = useTranslations("shell.assistant.parkedCard");
  const format = useFormatter();
  const line = (() => {
    switch (view.kind) {
      case "checking":
        return t("checking");
      case "waiting":
        return t("waiting", {
          time: format.dateTime(new Date(view.expiresAt), {
            hour: "numeric",
            minute: "2-digit",
          }),
        });
      case "expired":
        return t("expired");
      case "denied":
        return t("denied");
      case "approved":
        return <ApprovedLine execution={view.execution} />;
    }
  })();
  const rule =
    (view.kind === "approved" || view.kind === "denied") &&
    view.resolvedBy?.startsWith("policy:")
      ? view.resolvedBy.slice("policy:".length)
      : null;
  const runId =
    view.kind === "approved" ? (view.execution?.runId ?? null) : null;
  return (
    <div
      role="status"
      data-testid="assistant-parked-outcome"
      data-state={view.kind}
      className="flex flex-col gap-0.5 text-muted-foreground"
    >
      <p>{line}</p>
      {rule === null ? null : <p>{t("byRule", { rule })}</p>}
      {runId === null ? null : (
        <p className="font-mono text-[11px]">
          {t("recordedAs")}{" "}
          <SafeLink
            to={routes.run(org, ws, runId)}
            data-testid="assistant-parked-run"
            className={linkText}
          >
            {runId}
          </SafeLink>
        </p>
      )}
    </div>
  );
}

/**
 * What became of an approved call, one sentence per execution status the row
 * can hold. Spelled out rather than interpolated so the catalog check reads
 * every key (INV-12).
 */
function ApprovedLine({ execution }: { execution: ParkedExecution | null }) {
  const t = useTranslations("shell.assistant.parkedCard.approved");
  if (execution === null) return <>{t("plain")}</>;
  switch (execution.status) {
    case "succeeded":
      return <>{t("ran")}</>;
    case "dispatched":
      return <>{t("dispatched")}</>;
    case "queued":
    case "waiting":
      return <>{t("queued")}</>;
    case "running":
      return <>{t("running")}</>;
    case "indeterminate":
      return <>{t("indeterminate")}</>;
    case "expired":
      return <>{t("tooLate")}</>;
    case "failed":
      return <>{t("failed", { reason: execution.reason ?? "unknown" })}</>;
    default:
      return <>{t("other", { status: execution.status })}</>;
  }
}

/** Why a decision did not land, with the way out where there is one (INV-14). */
function FailureLine({ failure, org }: { failure: Failure; org: string }) {
  const t = useTranslations("shell.assistant.parkedCard.failure");
  const text = (() => {
    switch (failure.reason) {
      case "invalid":
        return failure.code === "note_required"
          ? t("noteRequired")
          : t("invalid", { code: failure.code });
      case "denied":
      case "not_found":
      case "conflict":
        return t("refused", { code: failure.code });
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
        return t("exhausted", { code: failure.code });
      case "unavailable":
        return t("unavailable", { code: failure.code });
    }
  })();
  return (
    <p
      role="alert"
      data-testid="assistant-parked-failure"
      className="text-error-ink"
    >
      {text}
      {failure.reason === "exhausted" ? (
        <>
          {" "}
          <SafeLink to={routes.billing(org)} className={linkText}>
            {t("billingLink")}
          </SafeLink>
        </>
      ) : null}
    </p>
  );
}
