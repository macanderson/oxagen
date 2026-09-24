// The Run page while its reads are in flight (pages/run.md, States: "the
// shell stays; the page body is replaced by the skeleton (four tile blocks
// and a panel of seven rows), so you keep your bearings"). It is the
// mockup's `skeleton()`: a `.grid.g4` of four `.sk.b` blocks, then a panel
// whose header holds one `.sk.t` bar and whose body holds seven `.sk.r` rows.
//
// No figure, no zero and no stale row is drawn: the skeleton is shapes only.
//
// Next replaces page.tsx's whole return value with this default export while
// the route segment suspends, `<main id="main">` included, so this reproduces
// it: the skip-to-content link keeps a target, and the frame does not jump
// once the read finishes and the real page takes over the same container.
import { useTranslations } from "next-intl";
import { panel, panelBody, panelHeader } from "@/ui/control-styles";

/** `.grid.g4`'s four blocks. */
const BLOCKS = [0, 1, 2, 3];
/** The panel's seven rows. */
const ROWS = [0, 1, 2, 3, 4, 5, 6];

/**
 * `.sk { background: linear-gradient(90deg, var(--hl) 25%, var(--panel) 50%,
 * var(--hl) 75%); animation: shim 1.5s linear infinite; border-radius: 6px }`,
 * as the kit's pulse, which stops under reduced motion.
 */
const sk = "block animate-pulse bg-hl motion-reduce:animate-none";

export function RunLoading() {
  const t = useTranslations("run");
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-10"
    >
      <div
        role="status"
        aria-busy="true"
        data-testid="run-loading"
        className="flex flex-col"
      >
        <span className="sr-only">{t("loading")}</span>
        <div
          aria-hidden="true"
          className="mb-4 grid grid-cols-2 gap-3.5 md:grid-cols-4"
        >
          {BLOCKS.map((block) => (
            <span
              key={block}
              className={`${sk} h-16 rounded-[11px] border border-border`}
            />
          ))}
        </div>
        <div aria-hidden="true" className={panel}>
          <div className={panelHeader}>
            <span className={`${sk} h-[22px] w-[180px] rounded-[7px]`} />
          </div>
          <div className={`${panelBody} flex flex-col gap-2`}>
            {ROWS.map((row) => (
              <span key={row} className={`${sk} h-[38px] rounded-[9px]`} />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
