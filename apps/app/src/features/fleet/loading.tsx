// The Fleet page while its reads are in flight: the shell stays, and the page
// body is replaced by a skeleton in the shape of what is coming, the stat
// strip's tiles and then a panel of rows. A spinner would move every element
// once the reads land; a skeleton the shape of the answer keeps a person's
// place. The same reasoning as the Run page's `RunLoading`.
//
// Next replaces page.tsx's whole return value with this default export while
// the route segment suspends, the page header included, so this reproduces
// it. The landmark carries no `id`: while the page streams in, React holds
// the resolved page hidden beside this fallback, and two `main#main` in one
// document is what the page-load check refused.
import { useTranslations } from "next-intl";
import { panel, statStrip, statTile } from "@/ui/control-styles";
import { PageHeader } from "@/ui/page-header";

/** The stat strip: live runs, waiting, and the two spend tiles. */
const TILES = [0, 1, 2, 3];
/** The runs table's first page, as rows. */
const ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

const bone = "animate-pulse rounded bg-muted motion-reduce:animate-none";

export function FleetLoading() {
  const t = useTranslations();
  return (
    <main
      aria-busy="true"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("pages.fleet")} />
      <div
        role="status"
        aria-busy="true"
        data-testid="fleet-loading"
        className="flex flex-col gap-3.5"
      >
        <span className="sr-only">{t("fleet.loading")}</span>
        <div className={statStrip}>
          {TILES.map((tile) => (
            <span key={tile} aria-hidden="true" className={statTile}>
              <span className={`mb-2 block h-2.5 w-20 ${bone}`} />
              <span className={`block h-6 w-16 ${bone}`} />
              <span className={`mt-2 block h-2.5 w-28 ${bone}`} />
            </span>
          ))}
        </div>
        <div className={`${panel} flex flex-col gap-3 p-4`}>
          {ROWS.map((row) => (
            <span
              key={row}
              aria-hidden="true"
              className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-4"
            >
              <span className={`h-4 ${bone}`} />
              <span className={`h-4 ${bone}`} />
              <span className={`h-4 w-3/4 ${bone}`} />
              <span className={`h-4 w-1/2 ${bone}`} />
            </span>
          ))}
        </div>
      </div>
    </main>
  );
}
