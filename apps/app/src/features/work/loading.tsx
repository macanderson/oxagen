// The Work pages while their reads are in flight: the shape of the answer in
// the design's `.sk` shimmer (globals.css `skeleton`), so nothing moves when
// the reads land and no zero flashes where a figure is coming. The Work page,
// Work setup and Outcomes draw a header, three tiles, a tab row and a panel
// of rows. One work item draws its header and two panels.
//
// Each skeleton is a busy region inside the shell's `main#main`, the page's
// one landmark (ADR-227). A `main` here would give the document two while the
// page streams in beside it (arch/loading-landmarks.test.ts).
import { useTranslations } from "next-intl";
import {
  panel,
  panelBody,
  panelHeader,
  statStrip,
} from "@/ui/control-styles";

const bone = "skeleton";

function HeaderBones() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2 pb-[18px]">
      <span className={`${bone} h-3 w-24 rounded-[5px]`} />
      <span className={`${bone} h-7 w-48 max-w-full rounded-[7px]`} />
      <span className={`${bone} h-4 w-96 max-w-full rounded-[5px]`} />
    </div>
  );
}

function RowsPanel({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true" className={panel}>
      <div className={panelHeader}>
        <span className={`${bone} h-[22px] w-[180px] max-w-full rounded-[7px]`} />
      </div>
      <div className={`${panelBody} flex flex-col gap-2`}>
        {Array.from({ length: rows }, (_, row) => (
          <span
            key={row}
            data-skeleton-row=""
            className={`${bone} h-[38px] rounded-[9px]`}
          />
        ))}
      </div>
    </div>
  );
}

/** The Work page, Work setup and Outcomes while their reads run. */
export function WorkLoading() {
  const t = useTranslations("work.loading");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="work-loading"
      className="flex w-full flex-col gap-4"
    >
      <span className="sr-only">{t("page")}</span>
      <HeaderBones />
      <div aria-hidden="true" className={statStrip}>
        {[0, 1, 2].map((tile) => (
          <span
            key={tile}
            data-skeleton-tile=""
            className={`${bone} h-16 rounded-[11px]`}
          />
        ))}
      </div>
      <div aria-hidden="true" className="flex gap-2 border-b border-border pb-2">
        {[0, 1, 2, 3].map((tab) => (
          <span key={tab} className={`${bone} h-6 w-20 rounded-[7px]`} />
        ))}
      </div>
      <RowsPanel rows={7} />
    </div>
  );
}

/** One work item while its read runs. */
export function WorkItemLoading() {
  const t = useTranslations("work.loading");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="work-item-loading"
      className="flex w-full flex-col gap-4"
    >
      <span className="sr-only">{t("item")}</span>
      <HeaderBones />
      <RowsPanel rows={4} />
      <RowsPanel rows={3} />
    </div>
  );
}
