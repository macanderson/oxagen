// The skeleton a page shows while its reads are in flight: four tile blocks,
// then a panel with a title bar and seven rows, each bone sweeping with the
// design's shimmer (`.sk` in globals.css). The shell stays around it, so a
// person keeps their bearings, and nothing moves when the page lands because
// the skeleton sits in the page's own frame. It draws no figure, no zero and
// no stale row.
//
// The landmark carries `aria-busy` and no `id`: while the page streams in,
// React holds the resolved page hidden beside this fallback, and two
// `main#main` in one document is what the page-load check refused.
import { useTranslations } from "next-intl";
import { panel, panelHeader, statStrip } from "@/ui/control-styles";

/** The four summary tiles. */
const TILES = [0, 1, 2, 3];
/** The panel's rows. */
const ROWS = [0, 1, 2, 3, 4, 5, 6];

/** A bone: the shimmer, stopped under reduced motion. */
const bone = "sk block motion-reduce:animate-none";

/** The skeleton alone, for a boundary that already draws its own landmark. */
export function PageSkeleton() {
  const t = useTranslations("ui.pageState");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="page-skeleton"
      className="flex flex-col gap-4"
    >
      <span className="sr-only">{t("loading")}</span>
      <div aria-hidden="true" className={statStrip}>
        {TILES.map((tile) => (
          <span
            key={tile}
            data-testid="skeleton-tile"
            className={`${bone} h-16 rounded-[11px]`}
          />
        ))}
      </div>
      <div aria-hidden="true" className={panel}>
        <div className={panelHeader}>
          <span
            data-testid="skeleton-title"
            className={`${bone} h-[22px] w-[180px] rounded-[7px]`}
          />
        </div>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          {ROWS.map((row) => (
            <span
              key={row}
              data-testid="skeleton-row"
              className={`${bone} h-[38px] rounded-[9px]`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** A route's `loading.tsx`: the skeleton in the page's landmark. */
export function PageLoading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageSkeleton />
    </main>
  );
}
