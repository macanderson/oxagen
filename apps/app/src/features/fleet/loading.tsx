// The Fleet page while its reads are in flight (fleet.md, States: loading):
// the shell stays, and the page body is replaced by the skeleton, four tile
// blocks and a panel of seven rows, so a person keeps their bearings. A
// spinner would move every element once the reads land; a skeleton the shape
// of the answer does not. It draws no figure, no zero and no stale row.
//
// Next replaces page.tsx's whole return value with this default export while
// the route segment suspends. The route lives in the `(fleet)` group so this
// skeleton never stands in for a nested workspace page. The landmark carries
// no `id`: while the page streams in, React holds the resolved page hidden
// beside this fallback, and two `main#main` in one document is what the
// page-load check refused.
import { useTranslations } from "next-intl";
import { panel, panelHeader, statStrip } from "@/ui/control-styles";

/** The four summary tiles. */
const TILES = [0, 1, 2, 3];
/** The Runs panel's rows. */
const ROWS = [0, 1, 2, 3, 4, 5, 6];

/** The design's `.sk` shimmer (globals.css), the one every skeleton draws. */
const bone = "skeleton";

export function FleetLoading() {
  const t = useTranslations("fleet");
  return (
    <main
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <div
        role="status"
        aria-busy="true"
        data-testid="fleet-loading"
        className="flex flex-col gap-4"
      >
        <span className="sr-only">{t("loading")}</span>
        <div className={statStrip}>
          {TILES.map((tile) => (
            <span
              key={tile}
              aria-hidden="true"
              data-testid="skeleton-tile"
              className={`block h-16 rounded-[11px] ${bone}`}
            />
          ))}
        </div>
        <div aria-hidden="true" className={panel}>
          <div className={panelHeader}>
            <span
              className={`block h-[22px] w-[180px] rounded-[7px] ${bone}`}
            />
          </div>
          <div className="flex flex-col gap-2 px-4 py-3.5">
            {ROWS.map((row) => (
              <span
                key={row}
                data-testid="skeleton-row"
                className={`block h-[38px] rounded-[9px] ${bone}`}
              />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
