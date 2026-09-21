// Other records of this kind (#3395; mockups/pages/record.md): up to three,
// as the same card the Steering list draws, each with a way in. A reader who
// has just understood what a constraint does wants the other constraints, and
// the kind is the only axis on which that question has an answer today.
//
// A record with no kind has no "others of this kind" to show, and the page
// says the kind is missing rather than listing every record in the workspace
// as if they were siblings.
import { useTranslations } from "next-intl";
import type { RecordKind, RecordPage } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { RecordCard } from "@/ui/record-card";
import { ReadFailure } from "./read-failure";
import { Section } from "./section";
import { recordLink, type RecordAt } from "./view";

/** The mockup's count: three is a sample, and a fourth is a list page. */
const RELATED_SHOWN = 3;

export function Related({
  at,
  kind,
  read,
}: {
  at: RecordAt;
  /** This record's kind; null when no Context PR classified it. */
  kind: RecordKind | null;
  read: Read<RecordPage> | null;
}) {
  const t = useTranslations("record.related");
  const term = useTranslations("ui.record");
  const title = t("title");
  if (kind === null || read === null) {
    return (
      <Section id="record-related" title={title}>
        <p data-state="not-recorded" className="text-sm text-muted-foreground">
          {t("unclassified")}
        </p>
      </Section>
    );
  }
  if (!read.ok) {
    return (
      <Section id="record-related" title={title}>
        <ReadFailure read={read} section={title} />
      </Section>
    );
  }
  const others = read.value.records
    .filter((record) => record.lineage !== at.lineage)
    .slice(0, RELATED_SHOWN);
  if (others.length === 0) {
    return (
      <Section id="record-related" title={title}>
        <p data-state="empty" className="max-w-prose text-sm text-foreground">
          {t("only", { kind: term(`kinds.${kind}`) })}
        </p>
      </Section>
    );
  }
  return (
    <Section id="record-related" title={title}>
      <ul className="flex flex-col gap-3">
        {others.map((record) => (
          <li key={record.id}>
            <RecordCard
              kind={record.kind}
              force={record.force}
              constraintEffect={record.constraintEffect}
              sharingScope={record.sharingScope}
              lineage={record.lineage}
              statement={record.statement ?? record.title}
            >
              <SafeLink
                to={recordLink({ ...at, lineage: record.lineage })}
                className={`${buttonSecondary} self-start`}
              >
                {t("open")}
              </SafeLink>
            </RecordCard>
          </li>
        ))}
      </ul>
    </Section>
  );
}
