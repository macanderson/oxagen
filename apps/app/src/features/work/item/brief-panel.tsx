// The brief (work-brief/v1; roadmap mockups/src/work.js `briefPanel()`): what
// a person agreed the work must do, one row per criterion with its key, its
// kind, and the evidence a reviewer expects. Once a send has run, a column
// shows the agent's claim for each criterion, or "no claim". A claim is the
// agent's word: oxagen marks no criterion met, and a person reads each claim
// and accepts the work or returns it.
//
// An approved revision never changes. Editing makes the next revision, and a
// source change after approval reads Out of date until a person approves the
// brief for the new revision.
import { useTranslations } from "next-intl";
import type { WorkItemDetail } from "@/data/contracts/work";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  kvList,
  kvTerm,
  kvValue,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { cell, Table } from "@/ui/table";
import { CopyValue } from "./copy-value";
import { useWhen } from "./phrases";
import { latestBrief, latestSend, shortDigest } from "./view";

const STATE_TONE: Record<"triage_draft" | "draft" | "approved" | "out_of_date", BadgeTone> = {
  triage_draft: "quiet",
  draft: "approval",
  approved: "allowed",
  out_of_date: "approval",
};

export function BriefPanel({ detail }: { detail: WorkItemDetail }) {
  const t = useTranslations("workItem.brief");
  const when = useWhen();
  const { brief, item } = detail;
  const shown = latestBrief(detail);
  const send = latestSend(detail);
  // The claims column appears once a send has run.
  const showClaims = send !== null && send.firstRunAt !== null;
  const person = (name: string | null) => name ?? t("aPerson");

  let line: string;
  if (shown !== null && shown.approved !== null) {
    line = t("approvedLine", {
      revision: String(shown.revision),
      by: person(shown.approved.by),
      at: when(shown.approved.at),
      itemRevision: String(shown.itemRevision),
    });
  } else if (shown !== null) {
    line = t("draftLine", {
      revision: String(shown.revision),
      by: person(shown.author),
      at: when(shown.savedAt),
    });
  } else if (brief.state === "triage_draft" || brief.triageCriteria.length > 0) {
    line = t("triageLine");
  } else {
    switch (item.status) {
      case "triaging":
      case "triage_failed":
        line = t("noneTriaging");
        break;
      case "needs_info":
        line = t("noneQuestion");
        break;
      case "possible_duplicate":
      case "out_of_scope":
        line = t("noneHeld");
        break;
      case "closed":
        line = t("noneClosed");
        break;
      default:
        line = t("noneYet");
    }
  }

  const word =
    brief.state === "none" && brief.triageCriteria.length > 0
      ? "triage_draft"
      : brief.state;
  return (
    <section
      aria-labelledby="work-brief-heading"
      data-testid="work-panel-brief"
      className={panel}
    >
      <div className={panelHeader}>
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <h2 id="work-brief-heading" className={panelTitle}>
            {t("heading")}
          </h2>
          {word === "none" ? null : (
            <Badge tone={STATE_TONE[word]} data-testid="work-brief-state" data-state={word}>
              {t(`states.${word}`)}
            </Badge>
          )}
        </div>
        <p className="min-w-0 text-xs text-muted-foreground">{line}</p>
      </div>
      {shown !== null ? (
        <>
          <Table
            label={t("tableLabel")}
            columns={[
              { label: t("columns.key") },
              { label: t("columns.criterion") },
              { label: t("columns.kind") },
              { label: t("columns.evidence") },
              ...(showClaims ? [{ label: t("columns.claim") }] : []),
            ]}
          >
            {shown.criteria.map((criterion) => {
              const claim = send?.claims.find((c) => c.criterion === criterion.criterion);
              return (
                <tr key={criterion.criterion} data-testid={`work-brief-row-${criterion.criterion}`}>
                  <td className={`${cell} whitespace-nowrap font-mono text-[12px]`}>
                    {criterion.criterion}
                  </td>
                  <td className={`${cell} [overflow-wrap:anywhere]`}>{criterion.text}</td>
                  <td className={cell}>{t(`kinds.${criterion.intent}`)}</td>
                  <td className={`${cell} text-muted-foreground [overflow-wrap:anywhere]`}>
                    {criterion.evidence === "" ? t("noEvidence") : criterion.evidence}
                  </td>
                  {showClaims ? (
                    <td className={cell} data-testid={`work-brief-claim-${criterion.criterion}`}>
                      {claim === undefined ? (
                        <span className="text-muted-foreground">{t("noClaim")}</span>
                      ) : (
                        <span className="flex flex-col items-start gap-1">
                          <Badge tone="quiet">{t("claimed")}</Badge>
                          <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                            {claim.text}
                          </span>
                        </span>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </Table>
          <div className={`${panelBody} flex flex-col gap-3 border-t border-border`}>
            <dl className={kvList}>
              <dt className={kvTerm}>{t("repository")}</dt>
              <dd className={`${kvValue} font-mono`}>{shown.repository}</dd>
              <dt className={kvTerm}>{t("digest")}</dt>
              <dd className={`${kvValue} flex items-center gap-1.5`}>
                <code data-testid="work-brief-digest" className="font-mono text-[0.92em]">
                  {shortDigest(shown.digest)}
                </code>
                <CopyValue value={shown.digest} label={t("digest")} />
              </dd>
              <dt className={kvTerm}>{t("schema")}</dt>
              <dd className={`${kvValue} font-mono`}>{t("schemaName")}</dd>
            </dl>
            <p className="text-xs text-muted-foreground">{t("noVerdict")}</p>
          </div>
        </>
      ) : brief.triageCriteria.length > 0 ? (
        <div className={panelBody}>
          <ol
            data-testid="work-brief-triage-draft"
            className="ml-5 flex list-decimal flex-col gap-1.5 text-[13px] text-foreground"
          >
            {brief.triageCriteria.map((text) => (
              <li key={text} className="[overflow-wrap:anywhere]">
                {text}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
