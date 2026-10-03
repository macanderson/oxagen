// Changes (ADR-292): what the work item's pull requests changed, from
// Oxagen's own pull request store. The item's change set is read with the
// page. A work order has no page, so each send opens its own change set
// below it, read the first time a person opens it.
import { useTranslations } from "next-intl";
import type { ChangeSet } from "@/data/contracts/changes";
import type { WorkItemDetail } from "@/data/contracts/work";
import type { Read } from "@/data/read";
import {
  eyebrowQuiet,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { ItemChangeSet, SendChangeSet } from "./change-sets";

type At = { org: string; ws: string };

export function ChangesPanel({
  detail,
  read,
  at,
}: {
  detail: WorkItemDetail;
  /** `get_change_set` for the work item. */
  read: Read<ChangeSet>;
  at: At;
}) {
  const t = useTranslations("workItem.changes");
  return (
    <section
      aria-labelledby="work-changes-heading"
      data-testid="work-panel-changes"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-changes-heading" className={panelTitle}>
          {t("heading")}
        </h2>
      </div>
      <div className={panelBody}>
        {read.ok ? (
          <ItemChangeSet changeSet={read.value} at={at} />
        ) : (
          <ReadFailure read={read} section={t("heading")} />
        )}
        {detail.sends.length === 0 ? null : (
          <section
            aria-labelledby="work-changes-sends-heading"
            data-testid="work-changes-sends"
            className="mt-4 border-t border-border pt-3"
          >
            <h3
              id="work-changes-sends-heading"
              className={`${eyebrowQuiet} mb-1.5`}
            >
              {t("sendsHeading")}
            </h3>
            <ul className="flex flex-col">
              {detail.sends.map((send) => (
                <li
                  key={send.id}
                  className="border-t border-border first:border-t-0"
                >
                  <SendChangeSet
                    orderId={send.id}
                    label={t("send", { number: String(send.send) })}
                    at={at}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </section>
  );
}
