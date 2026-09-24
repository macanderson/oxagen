// The calls parked on this run, on the Governed actions tab (mockup
// `fdApproval`): the one the open frame records is drawn inside that frame's
// detail as the approval card Fleet's drawer draws, with Decide and its
// Approve and Deny behind it; every other parked call is reachable from the
// top of the frame area, so no parked call drops out of the Run page.
//
// A card is `ApprovalsPanel` (features/fleet): one component, so an approval
// and its mandate bar read and decide the same wherever it is shown. The tab
// draws at most one, because the panel names its heading by page and a second
// copy would repeat that id.
import { useTranslations } from "next-intl";
import type { ApprovalItem, ApprovalQueue } from "@/data/contracts/approvals";
import type { MandateRow } from "@/data/contracts/mandates";
import { type Read, readOk } from "@/data/read";
import { ApprovalsPanel } from "@/features/fleet";
import type { SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { linkText, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { OpenApprovalsButton } from "./frame-player";

/**
 * `.warn { border:1px solid <st-critical 45%>; background:<st-critical 9%>;
 * border-radius:10px; padding:11px 14px; font-size:12.5px; color:var(--body) }`
 * and `.warn b { color:var(--st-critical) }`: the box the mockup draws over a
 * parked call.
 */
const warn =
  "m-0 rounded-[10px] border border-critical/45 bg-critical/[0.09] px-3.5 py-[11px] text-[12.5px] text-foreground [&_b]:font-semibold [&_b]:text-critical";

type Cards = {
  mandates: ReadonlyMap<string, MandateRow>;
  now: number;
  org: string;
  ws: string;
};

/** The parked call the open frame records, as its card. */
export function ParkedHere({
  item,
  mandates,
  now,
  org,
  ws,
}: { item: ApprovalItem } & Cards) {
  const t = useTranslations("run.player.approvals");
  return (
    // One card inside a frame's detail takes the detail's width, where the
    // panel's own grid would give it half.
    <div
      data-testid="frame-parked"
      className="flex flex-col gap-3 md:[&_ul]:grid-cols-1"
    >
      <p className={warn}>
        {t.rich("parked", { b: (chunks) => <b>{chunks}</b> })}
      </p>
      <ApprovalsPanel
        approvals={readOk({ items: [item], more: false })}
        mandates={mandates}
        now={now}
        on="run"
        org={org}
        ws={ws}
      />
    </div>
  );
}

/**
 * The parked calls the open frame does not record. Those no frame on the page
 * records are drawn as cards, unless the open frame's own card is on screen,
 * in which case the drawer holds them. Those another frame on the page
 * records point to it.
 */
export function ParkedElsewhere({
  pending,
  unmatched,
  elsewhere,
  cardShown,
  hrefOf,
  mandates,
  now,
  org,
  ws,
}: {
  /** The run's pending read, for its failure. */
  pending: Read<ApprovalQueue>;
  unmatched: readonly ApprovalItem[];
  elsewhere: readonly { item: ApprovalItem; seq: string }[];
  /** The open frame draws a card of its own. */
  cardShown: boolean;
  hrefOf: (seq: string) => SafePath;
} & Cards) {
  const t = useTranslations("run.player.approvals");
  const failed = !pending.ok && !cardShown;
  const cards = unmatched.length > 0 && !cardShown;
  const more = unmatched.length > 0 && cardShown;
  if (!failed && !cards && !more && elsewhere.length === 0) return null;
  return (
    <div data-testid="parked-elsewhere" className="flex flex-col gap-2.5">
      {failed || cards ? (
        <ApprovalsPanel
          approvals={
            pending.ok
              ? readOk({ items: [...unmatched], more: pending.value.more })
              : pending
          }
          mandates={mandates}
          now={now}
          on="run"
          org={org}
          ws={ws}
        />
      ) : null}
      {more ? (
        <p className="m-0 flex flex-wrap items-center gap-2.5 text-[12.5px]">
          <Badge tone="approval">{t("parkedBadge")}</Badge>
          <span>{t("more", { count: unmatched.length })}</span>
          <OpenApprovalsButton>{t("openDrawer")}</OpenApprovalsButton>
        </p>
      ) : null}
      {elsewhere.map(({ item, seq }) => (
        <p
          key={item.id}
          data-testid="parked-pointer"
          // The Run header's pause banner: `border:1px solid <st-approval 40%>;
          // background:<st-approval 10%>; border-radius:10px; padding:11px 14px`.
          className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[10px] border border-info/40 bg-info/10 px-3.5 py-[11px] text-[12.5px] text-foreground"
        >
          <Badge tone="approval">{t("parkedBadge")}</Badge>
          <span>
            {t.rich("elsewhere", {
              seq,
              tool: item.tool,
              code: (chunks) => <span className={mono}>{chunks}</span>,
            })}
          </span>
          <SafeLink to={hrefOf(seq)} className={linkText}>
            {t("openFrame", { seq })}
          </SafeLink>
        </p>
      ))}
    </div>
  );
}
