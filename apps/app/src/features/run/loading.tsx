// The Run page while its reads are in flight (the page spec's loading state):
// the shell stays, and the page body is replaced by a skeleton shaped like
// what is coming: the header's figure tiles, then a panel of rows.
//
// A skeleton in the shape of the answer is the point: a spinner in the middle
// of the page would move every element once the reads land, and a person who
// has already started reading the header would lose their place.
//
// Next replaces page.tsx's whole return value with this default export while
// the route segment suspends, `<main id="main">` and the page header
// included, so this reproduces both: the skip-to-content link keeps a
// target, and the frame does not jump once the read finishes and the real
// page takes over the same container.
import { useTranslations } from "next-intl";
import { panel } from "@/ui/control-styles";
import { PageHeader } from "@/ui/page-header";

/** The header's figure strip: cost, turns, steps, frames, started, sealed. */
const TILES = [0, 1, 2, 3, 4, 5];
/** The panel of rows the spec asks for. */
const ROWS = [0, 1, 2, 3, 4, 5, 6];

export function RunLoading() {
  const t = useTranslations();
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-10"
    >
      <PageHeader title={t("pages.run")} />
      <div
        role="status"
        aria-busy="true"
        data-testid="run-loading"
        className="flex flex-col gap-6"
      >
        <span className="sr-only">{t("run.loading")}</span>
        <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg border border-border px-4 py-3">
          {TILES.map((tile) => (
            <span
              key={tile}
              aria-hidden="true"
              className="flex flex-col gap-1.5"
            >
              <span className="block h-3 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <span className="block h-4 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </span>
          ))}
        </div>
        <div className={`${panel} flex flex-col gap-2 p-4`}>
          {ROWS.map((row) => (
            <span
              key={row}
              aria-hidden="true"
              className="h-4 w-full animate-pulse rounded bg-muted motion-reduce:animate-none"
            />
          ))}
        </div>
      </div>
    </main>
  );
}
