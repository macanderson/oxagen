"use client";
// The one write on an agent's cost center (ADR-142): charge it to a label on
// the organization's list, or clear the label so it inherits the workspace's.
//
// `set_cost_center` takes a label the list holds, so the dialog offers the
// list rather than a text box: a typo would come back as a refusal the seam
// cannot classify. The list is read when the dialog opens, through
// `readCostCenters`, the way the role picker reads its catalogue. The dialog
// says plainly that runs already rolled up keep their label, because a person
// changing a label in March expects to know whether February moves.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import type { ActionResult } from "@/server/kernel";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import {
  type CostCenterChoice,
  readCostCenters,
  setAgentCostCenter,
} from "./actions";

/** Where the write happens and where the page reloads to afterwards. */
export type CostCenterTarget = {
  org: string;
  ws: string;
  /** The agent's slug: what `set_cost_center` names the agent by, and its page. */
  agentSlug: string;
  /** The agent's name, for the dialog's title. */
  agentName: string;
  /** The label the agent holds now, or null when it inherits the workspace's. */
  costCenter: string | null;
};

type Failure = Exclude<ActionResult<unknown>, { ok: true }>;

/** The list read, in the three states the dialog draws. */
type Offer =
  | { state: "loading" }
  | { state: "loaded"; centers: CostCenterChoice[] }
  | { state: "failed"; failure: Failure };

const TEST_ID = "agent-cost-center";

export function ChargeAgent({
  org,
  ws,
  agentSlug,
  agentName,
  costCenter,
}: CostCenterTarget) {
  const t = useTranslations("agents.detail.costCenter");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [offer, setOffer] = useState<Offer>({ state: "loading" });

  // The list is read once the dialog opens and kept for as long as the page
  // lives. The ref, not the state, stops a second read, so the effect sets no
  // state synchronously and cannot cascade a render.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!open || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const result = await readCostCenters(org, ws);
        setOffer(
          result.ok
            ? { state: "loaded", centers: result.value }
            : { state: "failed", failure: result },
        );
      } catch {
        setOffer({ state: "failed", failure: UNANSWERED });
      }
    })();
  }, [open, org, ws]);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const chosen = form.get("costCenter");
    const label = typeof chosen === "string" ? chosen : "";
    setPending(true);
    setFailure(null);
    try {
      const result = await setAgentCostCenter(org, ws, agentSlug, label);
      if (result.ok) {
        setOpen(false);
        navigate.replace(routes.agent(org, ws, agentSlug));
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const centers = offer.state === "loaded" ? offer.centers : null;
  const empty = centers !== null && centers.length === 0;
  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title", { name: agentName })}
        testId={TEST_ID}
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          {offer.state === "loading" ? (
            <p data-state="loading" className="text-sm text-muted-foreground">
              {t("loading")}
            </p>
          ) : null}
          {offer.state === "failed" ? (
            <FormAlert testId={`${TEST_ID}-list-failure`}>
              {failureText(offer.failure)}
            </FormAlert>
          ) : null}
          {empty ? (
            <p data-state="empty" className="text-sm text-foreground">
              {t("empty")}
            </p>
          ) : null}
          {centers !== null && !empty ? (
            <div className="flex flex-col gap-1 text-sm text-foreground">
              <label htmlFor={`${TEST_ID}-label`}>{t("field")}</label>
              <select
                id={`${TEST_ID}-label`}
                name="costCenter"
                defaultValue={costCenter ?? ""}
                className={inputBase}
              >
                <option value="">{t("none")}</option>
                {centers.map((center) => (
                  <option key={center.id} value={center.label}>
                    {center.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {failure === null ? null : (
            <FormAlert testId={`${TEST_ID}-failure`}>{failure}</FormAlert>
          )}
          {centers !== null && !empty ? (
            <SubmitButton
              pending={pending}
              label={t("confirm")}
              pendingLabel={t("pending")}
            />
          ) : null}
        </form>
      </SheetDialog>
    </>
  );
}
