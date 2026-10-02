// Delivery (roadmap mockups/src/work.js `deliveryPanel()`): who the newest
// send went to and on what terms, then every send, newest first.
//
// The terms are read from the send, never from the item: the target, the
// operator, the agent's mandate at send, and where its budget holds. The work
// item adds no authority to any of them. At the gateway and contained tiers
// the gateway holds the agent's budget before each model call. At the harness
// and observe tiers oxagen records spend after the run, and nothing stops the
// run at a limit, so the panel says which one applies.
import { useTranslations } from "next-intl";
import type { WorkItemDetail, WorkSend } from "@/data/contracts/work";
import { routes } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  kvList,
  kvTerm,
  kvValue,
  linkText,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { CopyValue } from "./copy-value";
import { useWhen } from "./phrases";
import { budgetHeld, type DeliveryWord, deliveryWord, latestSend, sendLive } from "./view";

const DELIVERY_TONE: Record<DeliveryWord, BadgeTone> = {
  waiting_for_claim: "quiet",
  no_answer: "failed",
  claimed: "allowed",
  running: "allowed",
  stopping: "approval",
  run_ended: "quiet",
  stopped: "quiet",
  returned: "quiet",
  withdrawn: "quiet",
  rejected: "failed",
};

type At = { org: string; ws: string };

function SendRow({ send, at }: { send: WorkSend; at: At }) {
  const t = useTranslations("workItem.delivery");
  const when = useWhen();
  const word = deliveryWord(send);
  const person = (name: string | null) => name ?? t("aPerson");
  const notes: string[] = [];
  if (send.rejected !== null) notes.push(t("rejectedNote", { reason: send.rejected.reason }));
  if (send.withdrawn !== null) {
    notes.push(
      t("withdrawnNote", {
        by: person(send.withdrawn.by),
        at: when(send.withdrawn.at),
        reason: send.withdrawn.reason,
      }),
    );
  }
  if (send.claimedAt !== null) notes.push(t("claimedNote", { at: when(send.claimedAt) }));
  if (send.firstRunAt !== null) notes.push(t("firstRunNote", { at: when(send.firstRunAt) }));
  if (send.stopRequested !== null) {
    notes.push(
      t("stopNote", {
        by: person(send.stopRequested.by),
        at: when(send.stopRequested.at),
        reason: send.stopRequested.reason,
      }),
    );
  }
  if (send.returned !== null) notes.push(t("returnedNote", { reason: send.returned.reason }));
  return (
    <tr data-testid={`work-send-${String(send.send)}`} data-delivery={word}>
      <td className={numericCell}>{send.send}</td>
      <td className={cell}>
        <span className="font-medium text-foreground">{send.agent.name ?? t("unnamedAgent")}</span>
        <span className="block text-xs text-muted-foreground">
          {t("sentLine", {
            at: when(send.requestedAt),
            by: person(send.operator),
            revision: String(send.briefRevision),
          })}
        </span>
      </td>
      <td className={cell}>
        <Badge tone={DELIVERY_TONE[word]} data-delivery={word}>
          {t(`words.${word}`)}
        </Badge>
        {notes.length === 0 ? null : (
          <span className="mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {notes.join(" ")}
          </span>
        )}
      </td>
      <td className={cell}>
        {send.runs.length === 0 ? (
          <span className="text-muted-foreground">{t("noRun")}</span>
        ) : (
          <span className="flex flex-col gap-0.5">
            {send.runs.map((run, index) => (
              <SafeLink key={run.id} to={routes.run(at.org, at.ws, run.id)} className={linkText}>
                {send.runs.length === 1
                  ? t("openRun")
                  : t("openRunNumber", { number: String(index + 1) })}
              </SafeLink>
            ))}
          </span>
        )}
      </td>
    </tr>
  );
}

export function DeliveryPanel({ detail, at }: { detail: WorkItemDetail; at: At }) {
  const t = useTranslations("workItem.delivery");
  const send = latestSend(detail);
  return (
    <section
      aria-labelledby="work-delivery-heading"
      data-testid="work-panel-delivery"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-delivery-heading" className={panelTitle}>
          {t("heading")}
        </h2>
        {send === null ? null : (
          <span className="text-xs text-muted-foreground">
            {t("count", { count: detail.sends.length })}
          </span>
        )}
      </div>
      {send === null ? (
        <p data-testid="work-delivery-none" className={`${panelBody} text-[13px] text-muted-foreground`}>
          {t("notSent")}
        </p>
      ) : (
        <>
          <dl className={`${kvList} ${panelBody}`}>
            <dt className={kvTerm}>{t("target")}</dt>
            <dd className={`${kvValue} flex flex-wrap items-center gap-2`}>
              <span>
                {t("targetValue", {
                  agent: send.agent.name ?? t("unnamedAgent"),
                  runtime: send.runtime.name ?? t("unnamedRuntime"),
                })}
              </span>
              <EnforcementTierBadge tier={send.runtime.tier} />
            </dd>
            <dt className={kvTerm}>{t("operator")}</dt>
            <dd className={kvValue}>{send.operator ?? t("notRecorded")}</dd>
            <dt className={kvTerm}>{t("mandate")}</dt>
            <dd className={kvValue}>
              {send.mandateId === null ? (
                <span className="text-muted-foreground">{t("noMandate")}</span>
              ) : (
                <SafeLink
                  to={routes.mandate(at.org, at.ws, send.mandateId)}
                  className={`${linkText} font-mono`}
                >
                  {send.mandateId}
                </SafeLink>
              )}
              <span className="block text-xs text-muted-foreground">{t("noAuthority")}</span>
            </dd>
            <dt className={kvTerm}>{t("budget")}</dt>
            <dd className={kvValue} data-testid="work-delivery-budget">
              {budgetHeld(send.runtime.tier) ? t("budgetHeld") : t("budgetRecorded")}
            </dd>
            <dt className={kvTerm}>{sendLive(send) ? t("workOrder") : t("lastSend")}</dt>
            <dd className={`${kvValue} flex flex-col items-start gap-0.5`}>
              <span className="flex items-center gap-1.5">
                <code data-testid="work-delivery-key" className="font-mono text-[0.92em] break-all">
                  {send.key}
                </code>
                <CopyValue value={send.key} label={t("keyLabel")} />
              </span>
              {sendLive(send) ? (
                <span className="text-xs text-muted-foreground">{t("keyNote")}</span>
              ) : null}
            </dd>
          </dl>
          <Table
            label={t("tableLabel")}
            columns={[
              { label: t("columns.send"), numeric: true },
              { label: t("columns.agent") },
              { label: t("columns.status") },
              { label: t("columns.run") },
            ]}
          >
            {detail.sends.map((row) => (
              <SendRow key={row.id} send={row} at={at} />
            ))}
          </Table>
        </>
      )}
    </section>
  );
}
