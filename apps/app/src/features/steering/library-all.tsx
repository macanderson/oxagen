// The Library's All shelf (roadmap pages/steering.md, "Library, the All
// shelf"): the stat strip, the lead note, and "Everything written down", one
// table over the items the assembler reads, in the assembler's order.
//
// Today the one source read into it is the record registry (list_records,
// status active), read whole (./library-read.ts) so the assembler's order
// holds across the list and the list tools (@/ui/faceted-list-table: search, the
// Scope, Compiles to and Force filters, sortable headers, a Rows select and a
// numbered pager) work over every row. Every row is a record. Token cost and the enforcement
// grant have no field on that contract, so the Compiles to and Token cost
// cells and the Compiled size and Carry a grant tiles print "not recorded"
// rather than a figure nobody measured, and the repository a repository-scoped
// record names prints "not recorded" under its scope. Instructions, skills,
// memory and ontology notes join the list when the steering registry reads
// every source into one item type; each not-recorded value names the issue
// that tracks it in its tooltip, and the footer holds nothing the design does
// not.
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
import { ListTable, type ListRow } from "@/ui/faceted-list-table";
import { cell, numericCell } from "@/ui/table";
import { STEERING_GAPS } from "./gaps";
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
function assemblerOrder(rows: readonly Row[]): Row[] {
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
  title,
}: {
  term: string;
  value: ReactNode;
  note: string;
  testId: string;
  /** What the value leaves out, and the issue that tracks it. */
  title?: string;
}) {
  return (
    <div className={statTile} data-testid={testId} title={title}>
      <span className={statTerm}>{term}</span>
      <span className={statValue}>{value}</span>
      <span className={statNote}>{basis}</span>
    </div>
  );
}

export function LibraryAll({
  at,
  page,
}: {
  at: SteeringAt;
  /** Every record in force the shelf read, and how many are in force. */
  page: RecordPage;
}) {
  const t = useTranslations("steering.library");
  const issue = String(STEERING_GAPS.registry);
  const record = useTranslations("ui.record");
  const notRecorded = (
    <span className="text-[15px] font-medium text-muted-foreground">
      {t("notRecorded")}
    </span>
  );
  const kindOf = (row: Row) =>
    row.kind === null
      ? t("kindRecord")
      : `${t("kindRecord")} · ${record(`kinds.${row.kind}`).toLowerCase()}`;
  const sourceOf = (row: Row) =>
    row.path === null
      ? null
      : `${row.path}${row.commit === null ? "" : ` @ ${row.commit.slice(0, 7)}`}`;
  const rows: ListRow[] = assemblerOrder(page.records).map((row) => {
    const source = sourceOf(row);
    return {
      key: row.id,
      values: {
        item: `${row.label ?? row.title} ${row.statement ?? ""} ${row.lineage}`,
        kind: kindOf(row),
        force: row.force ?? t("notRecorded"),
        scope: row.sharingScope,
        compiles: t("compilesNotRecorded"),
        tokens: null,
        source,
      },
      node: (
        <tr key={row.id} data-lineage={row.lineage}>
          <td className={`${cell} max-w-[54ch]`}>
            <b data-term="label" className="block font-medium text-foreground">
              {row.label ?? row.title}
            </b>
            {row.statement === null ? null : (
              <span
                data-term="statement"
                className="block text-[12.5px] text-muted-foreground"
              >
                {row.statement}
              </span>
            )}
            <SafeLink
              to={routes.steeringRecord(at.org, at.ws, row.lineage)}
              className={`${linkText} font-mono text-[12px]`}
            >
              {row.lineage}
            </SafeLink>
          </td>
          <td className={cell}>
            <Badge tone="quiet" dot={false}>
              {kindOf(row)}
            </Badge>
          </td>
          <td className={cell}>
            {row.force === null ? (
              <span className="text-muted-foreground">{t("notRecorded")}</span>
            ) : (
              <Badge tone="quiet" dot={false} data-force={row.force}>
                {row.force}
              </Badge>
            )}
          </td>
          <td className={cell}>
            {row.sharingScope}
            {row.sharingScope === "repository" ? (
              <span
                className="block text-[12px] text-muted-foreground"
                title={t("scopeTargetTitle", { issue })}
                data-scope-target="not-recorded"
              >
                {t("notRecorded")}
              </span>
            ) : null}
          </td>
          <td className={cell}>
            <span
              title={t("compilesTitle", { issue })}
              data-compiles="not-recorded"
              className="text-muted-foreground"
            >
              {t("compilesNotRecorded")}
            </span>
          </td>
          <td className={numericCell}>
            <span
              title={t("tokensTitle", { issue })}
              className="font-sans text-muted-foreground"
            >
              {t("notRecorded")}
            </span>
          </td>
          <td
            className={`${cell} max-w-[34ch] break-all font-mono text-[11px]`}
          >
            {source ?? (
              <span className="font-sans text-muted-foreground">
                {t("sourceNone")}
              </span>
            )}
          </td>
        </tr>
      ),
    };
  });
  return (
    <div className="flex flex-col gap-3.5" data-testid="library-all">
      <div className={statStrip}>
        <Tile
          testId="tile-items"
          term={t("items")}
          value={page.total}
          note={t("itemsNote")}
          title={t("gap", { issue })}
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
          title={t("gap", { issue })}
        />
        <Tile
          testId="tile-compiled-size"
          term={t("compiledSize")}
          value={notRecorded}
          note={t("compiledSizeNote")}
          title={t("tokensTitle", { issue })}
        />
        <Tile
          testId="tile-grants"
          term={t("grants")}
          value={notRecorded}
          note={t("grantsNote")}
          title={t("compilesTitle", { issue })}
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
        <ListTable
          testId="library-list"
          label={t("title")}
          columns={[
            { key: "item", label: t("columns.item") },
            { key: "kind", label: t("columns.kind") },
            { key: "force", label: t("columns.force") },
            { key: "scope", label: t("columns.scope") },
            { key: "compiles", label: t("columns.compiles") },
            { key: "tokens", label: t("columns.tokens"), numeric: true },
            { key: "source", label: t("columns.source") },
          ]}
          filters={["scope", "compiles", "force"]}
          rows={rows}
        />
        <div className={`${panelFooter} flex-col items-start`}>
          {page.records.length < page.total ? (
            <p className={note} data-testid="library-truncated">
              {t("truncated", {
                read: String(page.records.length),
                total: String(page.total),
              })}
            </p>
          ) : null}
          <p className={note}>{t("planes")}</p>
        </div>
      </section>
    </div>
  );
}
