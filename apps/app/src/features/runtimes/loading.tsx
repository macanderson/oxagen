// The Runtimes tab while its reads are in flight: a panel of seven rows, the
// mockup's `skeleton()`. The Agents page's header and tab strip stay above
// it. The frame is a busy region inside the shell's `main#main`, the page's
// one landmark (ADR-227). A `main` here, with or without an `id`,
// would give the document two while the page streams in beside it (#4053,
// arch/loading-landmarks.test.ts).
import { useTranslations } from "next-intl";
import { panel, panelBody, panelHeader } from "@/ui/control-styles";

const ROWS = [0, 1, 2, 3, 4, 5, 6];

/** The design's `.sk` shimmer (globals.css), the one every skeleton draws. */
const bone = "skeleton";

export function RuntimesLoading() {
  const t = useTranslations("runtimes.page");
  return (
    <div aria-busy="true" className="flex w-full flex-col gap-4">
      <div
        role="status"
        aria-busy="true"
        data-testid="runtimes-loading"
        className="flex flex-col gap-3.5"
      >
        <span className="sr-only">{t("loading")}</span>
        <div aria-hidden="true" className={panel}>
          <div className={panelHeader}>
            <span
              className={`${bone} h-5.5 w-45 max-w-full rounded-[7px]`}
            />
          </div>
          <div className={`${panelBody} flex flex-col gap-2`}>
            {ROWS.map((row) => (
              <span
                key={row}
                data-skeleton-row=""
                className={`${bone} h-9.5 rounded-[9px]`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
