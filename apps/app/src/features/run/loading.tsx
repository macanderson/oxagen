// The Run page while its reads are in flight (the page spec's loading state):
// the shell stays, and the page body is replaced by the skeleton the spec
// draws, four tile blocks and a panel of seven rows, so a person keeps their
// bearings and nothing on screen is a figure. No zero, no stale row and no
// run id reaches the page before the read does.
//
// Next renders this default export as the route segment's Suspense fallback,
// so it reproduces the page's container: the frame does not jump once the read
// finishes and the real page takes over. The container is not the page's main
// landmark: while the page streams in, this fallback and the page are in the
// document together, and two main#main elements gave the skip link two targets
// and failed page-load's strict locator (Billing's fallback, 2026-09-24;
// arch/loading-landmarks.test.ts). It carries no h1 either: the page titles
// itself from the run's own title, which no read has answered yet.
import { useTranslations } from "next-intl";
import { panel } from "@/ui/control-styles";

/** The four tile blocks the spec's skeleton opens with. */
const TILES = [0, 1, 2, 3];
/** The panel's seven rows. */
const ROWS = [0, 1, 2, 3, 4, 5, 6];

const bar =
  "block animate-pulse rounded-lg bg-muted motion-reduce:animate-none";

export function RunLoading() {
  const t = useTranslations("run");
  return (
    <div
      data-testid="run-loading-frame"
      className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-10"
    >
      <div
        role="status"
        aria-busy="true"
        data-testid="run-loading"
        className="flex flex-col gap-4"
      >
        <span className="sr-only">{t("loading")}</span>
        <div
          aria-hidden="true"
          className="grid grid-cols-2 gap-3.5 lg:grid-cols-4"
        >
          {TILES.map((tile) => (
            <span
              key={tile}
              data-testid="run-loading-tile"
              className={`${bar} h-16 border border-border`}
            />
          ))}
        </div>
        <div aria-hidden="true" className={`${panel} flex flex-col`}>
          <span className="block border-b border-border bg-muted/40 px-4 py-3.5">
            <span className={`${bar} h-4 w-44`} />
          </span>
          <span className="flex flex-col gap-2.5 p-4">
            {ROWS.map((row) => (
              <span
                key={row}
                data-testid="run-loading-row"
                className={`${bar} h-9 w-full`}
              />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
