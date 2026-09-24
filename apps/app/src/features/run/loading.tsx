// The Run page while its reads are in flight (the page spec's loading state):
// the shell stays, and the page body is replaced by a skeleton shaped like
// what is coming: the header's strips, then the two columns, with the
// summary, the six stat tiles, the tab strip and a panel of rows on the left
// and the three side panels on the right.
//
// A skeleton in the shape of the answer is the point: a spinner in the middle
// of the page would move every element once the reads land, and a person who
// has already started reading the header would lose their place.
//
// Next replaces page.tsx's whole return value with this default export while
// the route segment suspends, the page header included, so this draws the
// header too and the frame does not jump once the read finishes. The
// landmark carries `aria-busy` and no `id`: while the page streams in, React
// holds the resolved page hidden beside this fallback, and two `main#main` in
// one document is what the page-load check refused. `aria-busy` also puts it
// in the page's frame (globals.css). The run's id is not known here, so the
// h1 says "Run" until the page lands.
import { useTranslations } from "next-intl";
import { panel } from "@/ui/control-styles";
import { PageHeader } from "@/ui/page-header";

/** The stat row: tokens, prompts, cost, wasted, wall clock, cache hit. */
const TILES = [0, 1, 2, 3, 4, 5];
/** The seven tabs. */
const TABS = [0, 1, 2, 3, 4, 5, 6];
/** The open section's rows. */
const ROWS = [0, 1, 2, 3, 4, 5, 6];
/** Changes, Outputs and Spend by area. */
const SIDE = [0, 1, 2];

const bar = "block animate-pulse rounded bg-muted motion-reduce:animate-none";

export function RunLoading() {
  const t = useTranslations();
  return (
    <main
      aria-busy="true"
      className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader eyebrow={t("pages.run")} title={t("pages.run")} />
      <div
        role="status"
        aria-busy="true"
        data-testid="run-loading"
        className="flex flex-col gap-6"
      >
        <span className="sr-only">{t("run.loading")}</span>
        <div aria-hidden="true" className="flex flex-col gap-2">
          <span className={`${bar} h-6 w-72`} />
          <span className={`${bar} h-4 w-96 max-w-full`} />
          <span className={`${bar} h-4 w-80 max-w-full`} />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
            <div className={`${panel} flex flex-col gap-2 p-4`}>
              <span aria-hidden="true" className={`${bar} h-4 w-24`} />
              <span aria-hidden="true" className={`${bar} h-4 w-full`} />
              <span aria-hidden="true" className={`${bar} h-4 w-2/3`} />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {TILES.map((tile) => (
                <span
                  key={tile}
                  aria-hidden="true"
                  className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5"
                >
                  <span className={`${bar} h-3 w-14`} />
                  <span className={`${bar} h-5 w-20`} />
                </span>
              ))}
            </div>
            <div className="flex gap-4 overflow-hidden border-b border-border pb-3">
              {TABS.map((tab) => (
                <span
                  key={tab}
                  aria-hidden="true"
                  className={`${bar} h-4 w-20 shrink-0`}
                />
              ))}
            </div>
            <div className={`${panel} flex flex-col gap-2 p-4`}>
              {ROWS.map((row) => (
                <span
                  key={row}
                  aria-hidden="true"
                  className={`${bar} h-4 w-full`}
                />
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            {SIDE.map((side) => (
              <div key={side} className={`${panel} flex flex-col gap-2 p-4`}>
                <span aria-hidden="true" className={`${bar} h-4 w-24`} />
                <span aria-hidden="true" className={`${bar} h-4 w-full`} />
                <span aria-hidden="true" className={`${bar} h-4 w-3/4`} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
