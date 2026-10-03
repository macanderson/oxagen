"use client";
// The cost line under an answer in the assistant flyout (#4167). It reads the
// cost of the run the turn was recorded as (`use-reply-cost.ts`) and prints
// it the way the Run page and Spend print a cost: money through <Money>, "not
// recorded" for a figure the rollup did not record, and never a zero it was
// not given. A cost that is not metered yet reads "pending". A cost the
// rollup recorded as zero reads as zero.
//
// Exact precision, as Spend prints a per-run figure: one answer usually costs
// a fraction of a cent, and rounded to cents it would print as $0.00, which
// is a zero the record does not hold.
//
// Beside the cost it names the models the rollup priced, as the record names
// them. The white-labelled tier a turn asked for (fast, balanced, precise) is
// resolved in the turn and not recorded on the run, and `get_run` names no
// model for a ledger run, so the priced models are what the record can show.
// The funding source is not recorded on the run either, so the line does not
// name one.
//
// The basis is printed only when it is weaker than `gateway_observed`. Every
// completion of the in-app agent passes through Oxagen's model chokepoint, so
// that is its ordinary basis, and any other one is printed so the figure
// never reads stronger than the record holds.
//
// The transcript is a polite live region (assistant-flyout.tsx). This line
// changes after the answer has been read out, from "pending" to a figure, so
// it opts out of the announcement with `aria-live="off"`. The figure is still
// in the transcript for anyone who reads it.
import { useTranslations } from "next-intl";
import { Money } from "@/ui/money";
import { type ReplyCostView, useReplyCost } from "./use-reply-cost";

function CostReading({ view }: { view: ReplyCostView }) {
  const t = useTranslations("shell.assistant.cost");
  switch (view.kind) {
    case "reading":
    case "pending":
      return <>{t("pending")}</>;
    case "unread":
      return <>{t("unread")}</>;
    case "recorded": {
      const { cost } = view;
      return (
        <>
          {cost === null ? (
            t("notRecorded")
          ) : (
            <Money value={cost} precision="exact" />
          )}
          {cost === null || cost.basis === "gateway_observed" ? null : (
            <> · {cost.basis ?? t("basisNotRecorded")}</>
          )}
          {view.estimate ? <> · {t("estimate")}</> : null}
          {view.incomplete ? <> · {t("incomplete")}</> : null}
          {view.models.length === 0 ? null : <> · {view.models.join(", ")}</>}
        </>
      );
    }
  }
}

/**
 * What the answer recorded as `runId` cost. `scope` is the thread's key,
 * `org/ws` (assistant-flyout.tsx): the run belongs to the workspace the turn
 * was asked in, which is the thread's, not the page the person stands on.
 */
export function AssistantReplyCost({
  scope,
  runId,
}: {
  scope: string;
  runId: string;
}) {
  const t = useTranslations("shell.assistant.cost");
  // Slugs carry no slash, so the key splits back into the two it was made of.
  const [org = "", ws = ""] = scope.split("/");
  const view = useReplyCost(org, ws, runId);
  return (
    <p
      data-testid="assistant-reply-cost"
      data-state={view.kind}
      aria-live="off"
      className="mt-0.5 font-mono text-[11px] text-muted-foreground"
    >
      {t("label")} <CostReading view={view} />
    </p>
  );
}
