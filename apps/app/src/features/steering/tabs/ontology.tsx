// The Library's Ontology shelf (roadmap pages/steering-ontology.md, held to
// steering-ontology.audit-prompt.md): the lead note, the Definitions table,
// and the Index, which says where the notes live today, what Phase 3 adds,
// and what this shelf does not bring back.
//
// No store holds ontology notes yet. The Data sources row is ❌: the note
// source adapter arrives in Phase 1 (#3830), so the Definitions table draws
// its columns and names what is missing in place of rows, and prints no
// count. Nothing on this shelf is a control; nothing is edited here.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";
import { cell, Table } from "@/ui/table";
import { STEERING_GAPS } from "../gaps";

const note =
  "border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground";

const INDEX = ["today", "later", "notHere"] as const;

export function OntologyShelf({ repository }: { repository: string | null }) {
  const t = useTranslations("steering.bodies.ontology");
  const code = (chunks: ReactNode) => (
    <code className="font-mono text-[12px]">{chunks}</code>
  );
  const columns = [
    "term",
    "kind",
    "definition",
    "force",
    "about",
    "tokens",
    "file",
  ] as const;
  return (
    <div className="flex flex-col gap-3.5" data-testid="shelf-ontology">
      <p className={note} data-testid="ontology-lead">
        {t.rich("lead", {
          code,
          repository: repository ?? t("repository"),
        })}
      </p>
      <section
        aria-labelledby="steering-ontology-title"
        data-testid="ontology-definitions"
        className={panel}
      >
        <div className={panelHeader}>
          <h3 id="steering-ontology-title" className={panelTitle}>
            {t("title")}
          </h3>
        </div>
        <Table
          label={t("title")}
          columns={columns.map((column) => ({
            label: t(`columns.${column}`),
            numeric: column === "tokens",
          }))}
        >
          <tr>
            <td
              colSpan={columns.length}
              className={`${cell} text-[13px] text-muted-foreground`}
              data-testid="ontology-not-backed"
              data-not-backed=""
              data-issue={String(STEERING_GAPS.registry)}
            >
              {t.rich("notBacked", {
                code,
                issue: String(STEERING_GAPS.registry),
              })}
            </td>
          </tr>
        </Table>
      </section>
      <section
        aria-labelledby="steering-ontology-index"
        data-testid="ontology-index"
        className={panel}
      >
        <div className={panelHeader}>
          <h3 id="steering-ontology-index" className={panelTitle}>
            {t("index.title")}
          </h3>
        </div>
        <dl
          className={`${panelBody} grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 text-[13px]`}
        >
          {INDEX.map((row) => (
            <div key={row} data-index={row} className="contents">
              <dt className="font-semibold text-foreground">
                {t(`index.${row}.term`)}
              </dt>
              <dd className="text-muted-foreground">
                {t.rich(`index.${row}.body`, { code })}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
