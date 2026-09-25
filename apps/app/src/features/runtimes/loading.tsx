// The Runtimes pages while the read is in flight (runtimes.md, States:
// "the shell stays; the page body, header included, is replaced by the
// skeleton"): four tile blocks and a panel of seven rows, the mockup's
// `skeleton()`. The frame is a busy region, not a `main`: while the page
// streams in, React holds the resolved page hidden beside this fallback, and
// only the page may own the landmark. A second `main`, with or without an
// `id`, gives the document two main landmarks during the swap (#4053,
// arch/loading-landmarks.test.ts).
import { useTranslations } from "next-intl";
import { panel, panelBody, panelHeader, statStrip } from "@/ui/control-styles";

const TILES = [0, 1, 2, 3];
const ROWS = [0, 1, 2, 3, 4, 5, 6];

/** The design's `.sk` shimmer (globals.css), the one every skeleton draws. */
const bone = "skeleton";

export function RuntimesLoading() {
  const t = useTranslations("runtimes.page");
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <div
        role="status"
        aria-busy="true"
        data-testid="runtimes-loading"
        className="flex flex-col gap-3.5"
      >
        <span className="sr-only">{t("loading")}</span>
        <div className={statStrip}>
          {TILES.map((tile) => (
            <span
              key={tile}
              aria-hidden="true"
              data-skeleton-tile=""
              className={`${bone} h-16 rounded-[11px]`}
            />
          ))}
        </div>
        <div aria-hidden="true" className={panel}>
          <div className={panelHeader}>
            <span
              className={`${bone} h-[22px] w-[180px] max-w-full rounded-[7px]`}
            />
          </div>
          <div className={`${panelBody} flex flex-col gap-2`}>
            {ROWS.map((row) => (
              <span
                key={row}
                data-skeleton-row=""
                className={`${bone} h-[38px] rounded-[9px]`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
