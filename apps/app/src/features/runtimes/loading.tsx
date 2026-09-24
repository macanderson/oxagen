// The Runtimes pages while the read is in flight (runtimes.md, States:
// "the shell stays; the page body, header included, is replaced by the
// skeleton"): four tile blocks and a panel of seven rows, the mockup's
// `skeleton()`. The landmark carries no `id`: while the page streams in,
// React holds the resolved page hidden beside this fallback, and two
// `main#main` in one document is what the page-load check refused.
import { useTranslations } from "next-intl";
import {
  panel,
  panelBody,
  panelHeader,
  statStrip,
  statTile,
} from "@/ui/control-styles";

const TILES = [0, 1, 2, 3];
const ROWS = [0, 1, 2, 3, 4, 5, 6];

const bone = "animate-pulse rounded bg-muted motion-reduce:animate-none";

export function RuntimesLoading() {
  const t = useTranslations("runtimes.page");
  return (
    <main
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
              className={`${statTile} h-[66px] ${bone}`}
            />
          ))}
        </div>
        <div aria-hidden="true" className={panel}>
          <div className={panelHeader}>
            <span className={`h-4 w-44 ${bone}`} />
          </div>
          <div className={`${panelBody} flex flex-col gap-2`}>
            {ROWS.map((row) => (
              <span key={row} className={`block h-9 ${bone}`} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
