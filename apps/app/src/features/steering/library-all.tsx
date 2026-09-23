// The Library's All shelf (roadmap pages/steering.md, "Library, the All
// shelf"): the stat strip, the lead note, and "Everything written down", one
// table over the items the assembler reads, in the assembler's order.
//
// Today the one source read into it is the record registry (list_records,
// status active), so every row is a record. Token cost and the enforcement
// grant have no field on that contract, so the Compiles to and Token cost
// cells and the Compiled size and Carry a grant tiles print "not recorded"
// rather than a figure nobody measured. Instructions, skills, memory and
// ontology notes join the list when the steering registry reads every source
// into one item type; the footer names the issue that tracks it.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RecordForce, RecordPage } from "@/data/contracts/steering";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  linkText,
  panel,
  panelFooter,
  panelHeader,
  panelTitle,
  statNote,
  statStrip,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { STEERING_GAPS } from "./gaps";
import { Pager } from "./section";
import { type SteeringAt, steeringLink } from "./view";

/** `STG_FORCE_ORDER`: must, should, may, info; an unclassified record last. */
const FORCE_ORDER: Record<RecordForce, number> = {
  must: 0,
  should: 1,
  may: 2,
  info: 3,
};

const note =
  "border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground";

type Row = RecordPage["records"][number];

/** Within a kind, by force, then by lineage: the assembler's order (`STG_KIND_ORDER`, `STG_FORCE_ORDER`, id). */
export function assemblerOrder(rows: readonly Row[]): Row[] {
  const rank = (row: Row) => (row.force === null ? 4 : FORCE_ORDER[row.force]);
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.lineage < b.lineage ? -1 : a.lineage > b.lineage ? 1 : 0),
  );
}

function Tile({
  term,
  value,
  note: basis,
  testId,
}: {
  term: string;
  value: ReactNode;
  note: string;
  testId: string;
}) {
  return (
    <div className={statTile} data-testid={testId}>
      <span className={statTerm}>{term}</span>
      <span className={statValue}>{value}</span>
      <span className={statNote}>{basis}</span>
    </div>
  );
}

export function LibraryAll({
  at,
  page,
  offset,
}: {
  at: SteeringAt;
  page: RecordPage;
  offset: number;
}) {
  const t = useTranslations("steering.library");
  const record = useTranslations("ui.record");
  const notRecorded = (
    <span className="text-[15px] font-medium text-muted-foreground">
      {t("notRecorded")}
    </span>
  );
  const rows = assemblerOrder(page.records);
  return (
    <div className="flex flex-col gap-3.5" data-testid="library-all">
      <div className={statStrip}>
        <Tile
          testId="tile-items"
          term={t("items")}
          value={page.total}
          note={t("itemsNote")}
        />
        <Tile
          testId="tile-by-kind"
          term={t("byKind")}
          value={
            <span className="font-mono text-[15px]">
              {t("kindRecord")} {page.total}
            </span>
          }
          note={t("byKindNote")}
        />
        <Tile
          testId="tile-compiled-size"
          term={t("compiledSize")}
          value={notRecorded}
          note={t("compiledSizeNote")}
        />
        <Tile
          testId="tile-grants"
          term={t("grants")}
          value={notRecorded}
          note={t("grantsNote")}
        />
      </div>
      <p className={note} data-testid="library-lead">
        {t("lead")}
      </p>
      <section aria-labelledby="library-all-title" className={panel}>
        <div className={panelHeader}>
          <h3 id="library-all-title" className={panelTitle}>
            {t("title")}
          </h3>
          <span className="ml-auto flex items-center gap-2">
            <Badge tone="quiet" dot={false} data-testid="library-count">
              {page.total}
            </Badge>
            <SafeLink
              to={steeringLink(at, { tab: "assignments" })}
              className={buttonSecondary}
            >
              {t("receives")}
            </SafeLink>
          </span>
        </div>
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.item") },
            { label: t("columns.kind") },
            { label: t("columns.force") },
            { label: t("columns.scope") },
            { label: t("columns.compiles") },
            { label: t("columns.tokens"), numeric: true },
            { label: t("columns.source") },
          ]}
        >
          {rows.map((row) => (
            <tr key={row.id} data-lineage={row.lineage}>
              <td className={`${cell} max-w-[54ch]`}>
                <b className="block font-medium text-foreground">
                  {row.statement ?? row.title}
                </b>
                <SafeLink
                  to={routes.steeringRecord(at.org, at.ws, row.lineage)}
                  className={`${linkText} font-mono text-[12px]`}
                >
                  {row.lineage}
                </SafeLink>
              </td>
              <td className={cell}>
                <Badge tone="quiet" dot={false}>
                  {row.kind === null
                    ? t("kindRecord")
                    : `${t("kindRecord")} · ${record(`kinds.${row.kind}`).toLowerCase()}`}
                </Badge>
              </td>
              <td className={cell}>
                {row.force === null ? (
                  <span className="text-muted-foreground">
                    {t("notRecorded")}
                  </span>
                ) : (
                  <Badge tone="quiet" dot={false} data-force={row.force}>
                    {row.force}
                  </Badge>
                )}
              </td>
              <td className={cell}>{row.sharingScope}</td>
              <td className={cell}>
                <span
                  title={t("compilesTitle")}
                  data-compiles="not-recorded"
                  className="text-muted-foreground"
                >
                  {t("compilesNotRecorded")}
                </span>
              </td>
              <td className={numericCell}>
                <span
                  title={t("tokensTitle")}
                  className="font-sans text-muted-foreground"
                >
                  {t("notRecorded")}
                </span>
              </td>
              <td
                className={`${cell} max-w-[34ch] break-all font-mono text-[11px]`}
              >
                {row.path === null ? (
                  <span className="font-sans text-muted-foreground">
                    {t("sourceNone")}
                  </span>
                ) : (
                  `${row.path}${row.commit === null ? "" : ` @ ${row.commit.slice(0, 7)}`}`
                )}
              </td>
            </tr>
          ))}
        </Table>
        <div className={`${panelFooter} flex-col items-start`}>
          <Pager
            offset={offset}
            shown={page.records.length}
            total={page.total}
            link={(to) => steeringLink(at, { tab: "library", offset: to })}
          />
          <p className={note}>{t("planes")}</p>
          <p className={note} data-testid="library-gap">
            {t("gap", { issue: String(STEERING_GAPS.registry) })}
          </p>
        </div>
      </section>
    </div>
  );
}
