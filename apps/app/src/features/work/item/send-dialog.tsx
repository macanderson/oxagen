"use client";
// Send to an agent (roadmap mockups/src/work.js DIALOGS.send): the approved
// brief goes to one agent on one runtime as a work order. The dialog offers
// the agents that can take it now (list_work_targets), folds the others under
// one line with each one's reason, and says what the agent gets: the brief
// revision and its digest, the operator, and where its budget holds.
//
// The work order's key is fixed before the first try (`nextSend.key`, read
// with the item), and Send passes it unchanged. Pressing Send again after a
// lost answer names the same key, so the runtime gets the same work order and
// starts no second run. The work item grants the agent no authority: the
// server reads the target, the operator and the mandate itself (ADR-251).
import { useTranslations } from "next-intl";
import { useState } from "react";
import type {
  BriefRevision,
  WorkTarget,
  WorkTargetList,
} from "@/data/contracts/work";
import { fieldLabel, kvList, kvTerm, kvValue } from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { sendWork } from "../actions";
import { useActionFailure } from "./action-failure";
import { useWhen } from "./phrases";
import { budgetHeld, type ItemData, latestSend, shortDigest } from "./view";
import { type DialogControl, type SubmitOutcome, WorkDialog } from "./work-dialog";

export function SendDialog({
  org,
  ws,
  detail,
  approved,
  sendKey,
  targets,
  ...control
}: DialogControl & {
  org: string;
  ws: string;
  detail: ItemData;
  /** The brief approved for the item's current revision: the one this send carries. */
  approved: BriefRevision;
  /** `<item>:r<brief revision>:s<send>`, as the item read it. */
  sendKey: string;
  targets: WorkTargetList;
}) {
  const t = useTranslations("workItem.send");
  const failureText = useActionFailure();
  const when = useWhen();
  const sendable = targets.agents.filter((agent) => agent.canTake);
  const others = targets.agents.filter((agent) => !agent.canTake);
  // The agent the last send went to, when it can take this one too.
  const previous = latestSend(detail)?.agent.id ?? null;
  const [agentId, setAgentId] = useState<string | null>(
    () => sendable.find((a) => a.id === previous)?.id ?? sendable[0]?.id ?? null,
  );
  const chosen = sendable.find((a) => a.id === agentId) ?? null;

  function why(target: WorkTarget): string {
    switch (target.reason) {
      case "no_runtime":
        return t("why.no_runtime");
      case "no_host":
        return t("why.no_host");
      case "host_outdated":
        return t("why.host_outdated", { host: target.host?.name ?? t("itsHost") });
      case "not_operator":
        return t("why.not_operator");
      case "busy":
        return target.busyWith === null
          ? t("why.busyElsewhere")
          : t("why.busy", { number: target.busyWith.number });
      case null:
        return t("why.unknown");
    }
  }

  function poll(target: WorkTarget): string | null {
    if (!target.quiet || target.host === null) return null;
    return target.host.lastPollAt === null
      ? t("neverPolled", { host: target.host.name })
      : t("lastPoll", { host: target.host.name, at: when(target.host.lastPollAt) });
  }

  async function submit(): Promise<SubmitOutcome> {
    if (chosen === null) return { ok: false, message: t("chooseAgent") };
    const result = await sendWork(org, ws, {
      itemId: detail.item.id,
      version: detail.item.version,
      itemRevision: detail.item.revision,
      briefRevision: approved.revision,
      briefDigest: approved.digest,
      agentId: chosen.id,
      key: sendKey,
    });
    return result.ok ? { ok: true } : { ok: false, message: failureText(result), refused: true };
  }

  const runtime = chosen?.runtime ?? null;
  return (
    <WorkDialog
      name="send"
      {...control}
      title={t("title")}
      subtitle={detail.item.number}
      wide
      submitLabel={t("submit")}
      pendingLabel={t("pending")}
      blocked={sendable.length === 0}
      footerNote={
        chosen === null
          ? undefined
          : t("footer", {
              agent: chosen.name,
              runtime: runtime?.name ?? t("itsRuntime"),
            })
      }
      submit={submit}
    >
      <p className="text-base text-muted-foreground">{t("body")}</p>
      {sendable.length === 0 ? (
        <p data-testid="work-send-none" className="text-base text-foreground">
          {t("none")}
        </p>
      ) : (
        <fieldset className="flex flex-col gap-2">
          <legend className={fieldLabel}>{t("agent")}</legend>
          {sendable.map((target) => {
            const line = poll(target);
            return (
              <label
                key={target.id}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 has-checked:border-gold has-checked:bg-hl"
              >
                <input
                  type="radio"
                  name="agent"
                  value={target.id}
                  checked={target.id === agentId}
                  onChange={() => {
                    setAgentId(target.id);
                  }}
                  data-testid={`work-send-agent-${target.id}`}
                  className="mt-1 size-4 flex-none accent-gold"
                />
                <span className="flex min-w-0 flex-col items-start gap-0.5 text-sm">
                  <span className="font-medium text-foreground">{target.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {t("where", {
                      harness: target.harness,
                      runtime: target.runtime?.name ?? t("itsRuntime"),
                    })}
                  </span>
                  {target.runtime === null ? null : (
                    <EnforcementTierBadge tier={target.runtime.tier} />
                  )}
                  {line === null ? null : (
                    <span className="text-sm text-muted-foreground">{line}</span>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {others.length === 0 ? null : (
        <details
          data-testid="work-send-unavailable"
          className="text-sm text-muted-foreground"
        >
          <summary className="cursor-pointer">
            {t("unavailable", { count: others.length })}
          </summary>
          <ul className="mt-1.5 ml-4 flex list-disc flex-col gap-1">
            {others.map((target) => (
              <li key={target.id} data-testid={`work-send-out-${target.id}`}>
                <span className="font-medium text-foreground">{target.name}</span>{" "}
                {why(target)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <section aria-labelledby="work-send-details" className="flex flex-col gap-2">
        <h3 id="work-send-details" className={fieldLabel}>
          {t("detailsHeading")}
        </h3>
        <dl className={kvList}>
          <dt className={kvTerm}>{t("brief")}</dt>
          <dd className={kvValue}>
            {t("briefRevision", { revision: String(approved.revision) })}{" "}
            <code className="font-mono">{shortDigest(approved.digest)}</code>
          </dd>
          <dt className={kvTerm}>{t("operator")}</dt>
          <dd className={kvValue}>{t("operatorYou")}</dd>
          {runtime === null ? null : (
            <>
              <dt className={kvTerm}>{t("budget")}</dt>
              <dd className={kvValue}>
                {budgetHeld(runtime.tier) ? t("budgetHeld") : t("budgetRecorded")}
              </dd>
            </>
          )}
          <dt className={kvTerm}>{t("key")}</dt>
          <dd className={kvValue}>
            <code className="font-mono break-all">{sendKey}</code>
            <span className="block text-sm text-muted-foreground">{t("keyNote")}</span>
          </dd>
        </dl>
      </section>
    </WorkDialog>
  );
}
