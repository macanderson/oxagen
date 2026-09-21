// Records (#2961; spec §10.2): the records in force in this workspace, one
// page at a time, filtered by kind. A record is in force because a Context PR
// merged its file into .oxagen/rules/ on the production branch.
import { useTranslations } from "next-intl";
import {
  RECORD_KINDS,
  type RecordKind,
  type RecordPage,
} from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { routes } from "@/shared/safe-path";
import { SafeLink } from "@/ui/navigation";
import { CloneButton } from "@/ui/clone-button";
import { RecordCard } from "@/ui/record-card";
import { ReadFailure } from "./read-failure";
import { Fact, Facts, Pager, Section, useDate } from "./section";
import { type SteeringAt, steeringLink } from "./view";

const chip =
  "inline-flex min-h-9 items-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground";

function KindFilter({ at, kind }: { at: SteeringAt; kind: RecordKind | null }) {
  const t = useTranslations("steering.records");
  const record = useTranslations("ui.record");
  return (
    <nav aria-label={t("filter")} className="flex flex-wrap gap-2">
      <SafeLink
        to={steeringLink(at, { tab: "records" })}
        data-kind="all"
        aria-current={kind === null ? "page" : undefined}
        className={chip}
      >
        {t("all")}
      </SafeLink>
      {RECORD_KINDS.map((k) => (
        <SafeLink
          key={k}
          to={steeringLink(at, { tab: "records", kind: k })}
          data-kind={k}
          aria-current={kind === k ? "page" : undefined}
          className={chip}
        >
          {record(`kinds.${k}`)}
        </SafeLink>
      ))}
    </nav>
  );
}

export function Records({
  at,
  kind,
  offset,
  read,
}: {
  at: SteeringAt;
  kind: RecordKind | null;
  offset: number;
  read: Read<RecordPage>;
}) {
  const t = useTranslations("steering.records");
  const date = useDate();
  const title = t("title");
  if (!read.ok) {
    return (
      <Section id="steering-records" title={title}>
        <ReadFailure read={read} section={title} />
      </Section>
    );
  }
  const { records, total } = read.value;
  if (total === 0 && kind === null && offset === 0) {
    return (
      <Section id="steering-records" title={t("emptyTitle")}>
        <p data-state="empty" className="max-w-prose text-sm text-foreground">
          {t("empty")}
        </p>
      </Section>
    );
  }
  return (
    <Section id="steering-records" title={title} lead={t("lead")}>
      <KindFilter at={at} kind={kind} />
      {records.length === 0 ? (
        <p data-state="empty" className="text-sm text-muted-foreground">
          {t("emptyKind")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {records.map((record) => (
            <li key={record.id}>
              <RecordCard
                kind={record.kind}
                force={record.force}
                constraintEffect={record.constraintEffect}
                sharingScope={record.sharingScope}
                lineage={record.lineage}
                statement={record.statement ?? record.title}
              >
                <CloneButton kind="record" sourceRef={record.lineage} />
                <Facts>
                  {record.version === null ? null : (
                    <Fact name="version" term={t("facts.version")}>
                      {String(record.version)}
                    </Fact>
                  )}
                  {record.commit === null ? null : (
                    <Fact name="commit" term={t("facts.commit")}>
                      <span className={mono}>{record.commit}</span>
                    </Fact>
                  )}
                  {record.path === null ? null : (
                    <Fact name="path" term={t("facts.path")}>
                      <span className={mono}>{record.path}</span>
                    </Fact>
                  )}
                  {record.publishedAt === null ? null : (
                    <Fact name="published" term={t("facts.published")}>
                      {date(record.publishedAt)}
                    </Fact>
                  )}
                </Facts>
                {/* The way into the record's own page (#3395). The lineage is
                    the address, because a record read out of a file the
                    registry has no row for carries no public id. */}
                <SafeLink
                  to={routes.steeringRecord(at.org, at.ws, record.lineage)}
                  className={`${buttonSecondary} self-start`}
                >
                  {t("open")}
                </SafeLink>
              </RecordCard>
            </li>
          ))}
        </ul>
      )}
      <Pager
        offset={offset}
        shown={records.length}
        total={total}
        link={(to) => steeringLink(at, { tab: "records", kind, offset: to })}
      />
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("authority")}
      </p>
    </Section>
  );
}
