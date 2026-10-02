"use client";
// Ending a send (roadmap mockups/src/work.js `wrk-stop`). A send no runtime
// claimed belongs to oxagen, so Cancel the send withdraws it at once
// (cancel_work_order). A claimed run stops only when its runtime confirms, so
// Stop the run asks the runtime (stop_work_order) and the page reads Stopping
// until it does. A stopping send that never linked a run can be withdrawn.
// Each takes the person's reason, and nothing in the history is removed.
import { useTranslations } from "next-intl";
import type { WorkSend } from "@/data/contracts/work";
import { cancelSend, stopSend } from "../actions";
import { useActionFailure } from "./action-failure";
import { ReasonField } from "./fields";
import type { ItemData } from "./view";
import {
  type DialogControl,
  formText,
  type SubmitOutcome,
  WorkDialog,
} from "./work-dialog";

export type StopVariant = "cancel" | "stop" | "withdraw";

export function StopDialog({
  org,
  ws,
  detail,
  send,
  variant,
  ...control
}: DialogControl & {
  org: string;
  ws: string;
  detail: ItemData;
  send: WorkSend;
  variant: StopVariant;
}) {
  const t = useTranslations("workItem.stop");
  const failureText = useActionFailure();
  const agent = send.agent.name ?? t("theAgent");
  const runtime = send.runtime.name ?? t("theRuntime");
  const number = String(send.send);

  async function submit(form: FormData): Promise<SubmitOutcome> {
    const input = {
      itemId: detail.item.id,
      version: detail.item.version,
      orderId: send.id,
      reason: formText(form, "reason"),
    };
    const result =
      variant === "stop"
        ? await stopSend(org, ws, input)
        : await cancelSend(org, ws, input);
    return result.ok ? { ok: true } : { ok: false, message: failureText(result), refused: true };
  }

  const title =
    variant === "cancel"
      ? t("cancelTitle")
      : variant === "stop"
        ? t("stopTitle")
        : t("withdrawTitle");
  return (
    <WorkDialog
      name="stop"
      {...control}
      title={title}
      subtitle={detail.item.number}
      submitLabel={title}
      pendingLabel={t("pending")}
      danger
      submit={submit}
    >
      <p className="text-sm text-foreground">
        {variant === "cancel"
          ? t("cancelBody", { send: number, runtime })
          : variant === "stop"
            ? t("stopBody", { agent, runtime })
            : t("withdrawBody", { send: number })}
      </p>
      <p className="text-sm text-muted-foreground">{t("after")}</p>
      <ReasonField id="work-stop-reason" label={t("reason")} hint={t("reasonHint")} />
    </WorkDialog>
  );
}
