// Source and Triage, side by side under a hairline (roadmap mockups/src/work.js
// `sourcePanel()`, `triagePanel()`; stacked on a phone).
//
// Source is what arrived, and every part of it is data. The title,
// description, labels and requester come from outside the workspace, so they
// render as text and nothing here reads them as markup or as an instruction,
// whoever wrote them. A changed item also shows what revision 1 read.
//
// Triage is a suggestion with its reason and the rule it cites. A person's
// correction adds a line and never erases what triage said.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { WorkItemDetail, WorkStatus } from "@/data/contracts/work";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { kvList, kvTerm, kvValue, linkText, note } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { ProviderMark } from "@/ui/provider-mark";
import { PriorityCell } from "../words";
import { RecordAnswer } from "./inline-actions";
import { useWhen } from "./phrases";
import { CorrectTriageControl } from "./triage-dialogs";
import { itemData } from "./view";

type At = { org: string; ws: string };

export function SourcePanel({ detail }: { detail: WorkItemDetail }) {
  const t = useTranslations("workItem.source");
  const when = useWhen();
  const item = detail.item;
  const revisions = [...item.sourceRevisions].sort((a, b) => a.revision - b.revision);
  const first = revisions[0];
  const last = revisions[revisions.length - 1];
  const changed = first !== undefined && last !== undefined && last.revision > 1;
  return (
    <section
      aria-labelledby="work-source-heading"
      data-testid="work-panel-source"
      className="min-w-0 text-sm"
    >
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 id="work-source-heading" className="text-xs font-semibold text-muted-foreground">
          {t("heading")}
        </h2>
        <span className="text-xs text-muted-foreground">{t("treatedAsData")}</span>
      </div>
      <dl className={kvList}>
        {item.origin === "manual" ? (
          <>
            <dt className={kvTerm}>{t("addedBy")}</dt>
            <dd className={kvValue}>
              {item.requester === null
                ? t("aPersonInOxagen")
                : t("personInOxagen", { name: item.requester })}
            </dd>
          </>
        ) : (
          <>
            <dt className={kvTerm}>{t("repository")}</dt>
            <dd className={`${kvValue} font-mono`}>
              {item.repository ?? t("noRepository")}
            </dd>
          </>
        )}
        <dt className={kvTerm}>{t("revision")}</dt>
        <dd className={kvValue}>
          {changed ? (
            <>
              {t("revisionChanged", {
                revision: String(last.revision),
                at: when(last.at),
              })}
              <span className="block text-xs text-muted-foreground">
                {t("firstArrived", { at: when(first.at) })}
              </span>
            </>
          ) : (
            t("revisionOne", { at: when(first?.at ?? item.arrivedAt) })
          )}
        </dd>
      </dl>
      {item.description === null || item.description.trim() === "" ? (
        <p className="mt-3 text-muted-foreground">{t("noDescription")}</p>
      ) : (
        <p
          data-testid="work-source-description"
          className="mt-3 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
        >
          {item.description}
        </p>
      )}
      {changed ? (
        <div data-testid="work-source-first" className="mt-3 flex flex-col gap-1">
          <p className="text-xs font-semibold text-muted-foreground">{t("firstRead")}</p>
          <p className="whitespace-pre-wrap text-xs text-foreground [overflow-wrap:anywhere]">
            {first.subject}
          </p>
          {first.description === null ? null : (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {first.description}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** The statuses whose triage a person may still correct from the panel. */
const CORRECTABLE: ReadonlySet<WorkStatus> = new Set([
  "brief_to_approve",
  "changed",
  "ready",
  "send_rejected",
]);

type CorrectionValue = string | number | readonly string[] | null;

export function TriagePanel({ detail, at }: { detail: WorkItemDetail; at: At }) {
  const t = useTranslations("workItem.triage");
  const when = useWhen();
  const { item, triage } = detail;
  const person = (name: string | null) => name ?? t("aPerson");
  const value = (v: CorrectionValue): string =>
    v === null
      ? t("noValue")
      : typeof v === "string"
        ? v
        : typeof v === "number"
          ? String(v)
          : v.length === 0
            ? t("noValue")
            : v.join(", ");
  const labels = triage.labels.value ?? [];
  const paths = triage.claims.value ?? [];
  const questions =
    triage.questions.length > 0
      ? triage.questions
      : item.wait.kind === "needs_info" && item.wait.question !== null
        ? [item.wait.question]
        : [];
  const duplicateOf = item.wait.kind === "possible_duplicate" ? item.wait.of : null;

  let body: ReactNode;
  if (item.status === "triaging") {
    body = <p className="text-muted-foreground">{t("reading")}</p>;
  } else if (triage.failure !== null) {
    body = (
      <div
        data-testid="work-triage-failed"
        className="flex flex-col gap-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2.5"
      >
        <p className="text-foreground">
          <span className="font-semibold">{t("failed")}</span> {triage.failure.reason}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("failedNote", { at: when(triage.failure.at) })}
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <dl className={kvList}>
          <dt className={kvTerm}>{t("priority")}</dt>
          <dd className={kvValue}>
            <PriorityCell priority={item.priority} />
          </dd>
          <dt className={kvTerm}>{t("labels")}</dt>
          <dd className={`${kvValue} flex flex-wrap gap-1`}>
            {labels.length === 0 ? (
              <span className="text-muted-foreground">{t("noValue")}</span>
            ) : (
              labels.map((label) => (
                <Badge key={label} tone="quiet" dot={false}>
                  {label}
                </Badge>
              ))
            )}
          </dd>
          {triage.estimateMinutes.value === null ? null : (
            <>
              <dt className={kvTerm}>{t("estimate")}</dt>
              <dd className={kvValue}>
                {t("minutes", { count: triage.estimateMinutes.value })}
              </dd>
            </>
          )}
          {paths.length === 0 ? null : (
            <>
              <dt className={kvTerm}>{t("paths")}</dt>
              <dd className={`${kvValue} flex flex-wrap gap-1.5`}>
                {paths.map((path) => (
                  <code key={path} className="font-mono">
                    {path}
                  </code>
                ))}
              </dd>
            </>
          )}
          {triage.priority.by === "person" ? (
            <>
              <dt className={kvTerm}>{t("setBy")}</dt>
              <dd className={kvValue}>
                {triage.priority.at === null
                  ? person(triage.priority.actor)
                  : t("setByOn", {
                      name: person(triage.priority.actor),
                      at: when(triage.priority.at),
                    })}
              </dd>
            </>
          ) : (
            <>
              <dt className={kvTerm}>{t("suggestedBy")}</dt>
              <dd className={kvValue} data-testid="work-triage-model">
                {triage.model ? (
                  <ProviderMark
                    model={triage.model}
                    size={14}
                    className="mr-1 align-middle"
                  />
                ) : null}
                {triage.decidedAt === null
                  ? t("suggestedByModel", { model: triage.model ?? t("unrecordedModel") })
                  : t("suggestedByModelOn", {
                      model: triage.model ?? t("unrecordedModel"),
                      at: when(triage.decidedAt),
                    })}
              </dd>
            </>
          )}
        </dl>
        {triage.corrections.map((correction) => (
          <p
            key={`${correction.field}-${correction.at}`}
            data-testid="work-triage-correction"
            className={`${note} mt-2`}
          >
            {t("correction", {
              by: person(correction.by),
              field: t(`fields.${correction.field}`),
              before: value(correction.before),
              after: value(correction.after),
              at: when(correction.at),
            })}
          </p>
        ))}
        {triage.override === null ? null : (
          <p className={`${note} mt-2`}>
            {t("override", {
              by: person(triage.override.by),
              outcome: triage.override.outcome,
              at: when(triage.override.at),
              reason: triage.override.reason,
            })}
          </p>
        )}
      </>
    );
  }

  return (
    <section
      aria-labelledby="work-triage-heading"
      data-testid="work-panel-triage"
      className="min-w-0 text-sm max-md:mt-4 max-md:border-t max-md:border-border max-md:pt-4 md:border-l md:border-border md:pl-7"
    >
      <div className="mb-2.5 flex items-center gap-2.5">
        <h2 id="work-triage-heading" className="text-xs font-semibold text-muted-foreground">
          {t("heading")}
        </h2>
        {CORRECTABLE.has(item.status) && triage.failure === null ? (
          <span className="ml-auto">
            <CorrectTriageControl org={at.org} ws={at.ws} detail={itemData(detail)} />
          </span>
        ) : null}
      </div>
      {body}
      {item.status === "needs_info" ? (
        <div
          data-testid="work-triage-question"
          className="mt-3 flex flex-col gap-2 rounded-lg border border-border p-3"
        >
          <p className="text-xs font-semibold text-muted-foreground">{t("question")}</p>
          {questions.map((question) => (
            <p key={question} className="whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
              {question}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">{t("questionNote")}</p>
          <RecordAnswer
            org={at.org}
            ws={at.ws}
            itemId={item.id}
            version={item.version}
            canControl={detail.viewer.canControl}
          />
        </div>
      ) : null}
      {item.status === "possible_duplicate" ? (
        <p data-testid="work-triage-duplicate" className={`${note} mt-3`}>
          {duplicateOf === null
            ? t("duplicateUnknown")
            : t.rich("duplicateOf", {
                number: duplicateOf.number,
                link: (chunks) => (
                  <SafeLink
                    to={routes.workItem(at.org, at.ws, duplicateOf.number)}
                    className={`${linkText} font-mono`}
                  >
                    {chunks}
                  </SafeLink>
                ),
              })}
        </p>
      ) : null}
    </section>
  );
}
