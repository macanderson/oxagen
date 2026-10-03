"use client";
// The two review decisions (roadmap mockups/src/work.js `wrk-return`,
// `wrk-accept`).
//
// Return sends the work back with the person's reason, by default to the same
// agent as a new send. When that new send is refused, the return still
// stands, the item waits in Ready, and the dialog says why before it closes.
//
// Accept records a person's acceptance of one head commit, with every
// criterion of the brief ticked by that person. oxagen marks no criterion met:
// the agent's claim sits beside each box as the agent's word, and the person
// decides. Accept stays disabled until every box is ticked, and the dialog
// reads "Accept is blocked." with the reason while the send's gate is closed.
// The server reads the required checks again at the press, so a gate that
// closed since the page read it is refused there too.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { WorkSend } from "@/data/contracts/work";
import { fieldHint, fieldLabel } from "@/ui/control-styles";
import { acceptWork, returnWork } from "../actions";
import { shortSha } from "../words";
import { useActionFailure } from "./action-failure";
import { ReasonField } from "./fields";
import { useBlockText } from "./phrases";
import { acceptBlock, briefOfSend, type ItemData } from "./view";
import {
  type DialogControl,
  formText,
  type SubmitOutcome,
  WorkDialog,
} from "./work-dialog";

type Props = DialogControl & {
  org: string;
  ws: string;
  detail: ItemData;
  send: WorkSend;
};

export function ReturnDialog({ org, ws, detail, send, ...control }: Props) {
  const t = useTranslations("workItem.return");
  const failureText = useActionFailure();
  const agent = send.agent.name ?? t("theAgent");
  const next = String(detail.nextSend?.send ?? send.send + 1);
  const pr = send.pullRequest;

  async function submit(form: FormData): Promise<SubmitOutcome> {
    const result = await returnWork(org, ws, {
      itemId: detail.item.id,
      version: detail.item.version,
      orderId: send.id,
      reason: formText(form, "reason"),
      resend: form.get("resend") === "on",
    });
    if (!result.ok) return { ok: false, message: failureText(result), refused: true };
    return result.value.resendRefused === null
      ? { ok: true }
      : {
          ok: true,
          notice: t("resendRefused", { reason: result.value.resendRefused }),
        };
  }

  return (
    <WorkDialog
      name="return"
      {...control}
      title={t("title", { agent })}
      subtitle={detail.item.number}
      submitLabel={t("submit")}
      pendingLabel={t("pending")}
      submit={submit}
    >
      <p className="text-sm text-muted-foreground">{t("body", { send: next })}</p>
      <ReasonField id="work-return-reason" label={t("reason")} hint={t("reasonHint")} />
      {pr === null ? (
        <p className="text-xs text-muted-foreground">{t("noPullRequest")}</p>
      ) : pr.merged !== null ? (
        <p className="text-xs text-muted-foreground">{t("merged")}</p>
      ) : pr.closedAt !== null ? (
        <p className="text-xs text-muted-foreground">{t("closed")}</p>
      ) : null}
      <div className="flex flex-col">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            name="resend"
            defaultChecked
            aria-describedby="work-return-resend-hint"
            data-testid="work-return-resend"
            className="size-4 accent-gold"
          />
          {t("resend", { agent })}
        </label>
        <p id="work-return-resend-hint" className={fieldHint}>
          {t("resendHint")}
        </p>
      </div>
    </WorkDialog>
  );
}

export function AcceptDialog({ org, ws, detail, send, ...control }: Props) {
  const t = useTranslations("workItem.accept");
  const blockText = useBlockText();
  const failureText = useActionFailure();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const block = acceptBlock(send);
  const head = send.pullRequest?.head ?? null;
  const criteria = briefOfSend(detail, send)?.criteria ?? [];
  const everyTicked =
    criteria.length > 0 && criteria.every((c) => ticked.has(c.criterion));
  const merged = (send.pullRequest?.merged ?? null) !== null;

  function tick(criterion: string, on: boolean) {
    setTicked((before) => {
      const after = new Set(before);
      if (on) after.add(criterion);
      else after.delete(criterion);
      return after;
    });
  }

  async function submit(): Promise<SubmitOutcome> {
    if (head === null) {
      return {
        ok: false,
        message: blockText({ kind: "gate", block: "no_head", detail: null }),
      };
    }
    const result = await acceptWork(org, ws, {
      itemId: detail.item.id,
      version: detail.item.version,
      orderId: send.id,
      headSha: head,
      briefDigest: send.briefDigest,
      criteria: criteria.map((c) => c.criterion),
    });
    return result.ok ? { ok: true } : { ok: false, message: failureText(result), refused: true };
  }

  return (
    <WorkDialog
      name="accept"
      {...control}
      onOpenChange={(next) => {
        // Every opening starts with no box ticked: a tick is a check the
        // person made this time, not one left from before.
        if (!next) setTicked(new Set());
        control.onOpenChange(next);
      }}
      title={t("title", { number: detail.item.number })}
      wide
      submitLabel={t("submit")}
      pendingLabel={t("pending")}
      blocked={block !== null || head === null}
      submitDisabled={!everyTicked}
      submit={submit}
    >
      {block !== null || head === null ? (
        <p
          data-testid="work-accept-blocked"
          className="rounded-lg border border-error/40 bg-error/10 px-3 py-2.5 text-sm text-foreground"
        >
          <span className="font-semibold">{t("blocked")}</span>{" "}
          {blockText(block ?? { kind: "gate", block: "no_head", detail: null })}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("tickEach", { head: shortSha(head) })}
            {send.checksWord === "none_required" ? ` ${t("ticksOnly")}` : null}
          </p>
          <fieldset className="flex flex-col gap-2.5">
            <legend className={fieldLabel}>{t("criteria")}</legend>
            {criteria.map((criterion) => {
              const claim = send.claims.find((c) => c.criterion === criterion.criterion);
              const id = `work-accept-${criterion.criterion}`;
              return (
                <label
                  key={criterion.criterion}
                  htmlFor={id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2"
                >
                  <input
                    id={id}
                    type="checkbox"
                    data-testid={id}
                    checked={ticked.has(criterion.criterion)}
                    onChange={(event) => {
                      tick(criterion.criterion, event.currentTarget.checked);
                    }}
                    className="mt-1 size-4 flex-none accent-gold"
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">
                      <span className="mr-1.5 font-mono text-[0.92em] text-dim">
                        {criterion.criterion}
                      </span>
                      {criterion.text}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {claim === undefined
                        ? t("noClaim")
                        : claim.current || claim.head === null
                          ? t("claim", { claim: claim.text })
                          : t("claimEarlier", {
                              claim: claim.text,
                              head: shortSha(claim.head),
                            })}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <p className="text-xs text-muted-foreground">
            {t("mergesNothing")} {merged ? t("doneOnAccept") : t("doneOnMerge")}{" "}
            {t("newCommit")}
          </p>
        </>
      )}
    </WorkDialog>
  );
}
