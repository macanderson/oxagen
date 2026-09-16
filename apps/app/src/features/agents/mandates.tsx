// Agents › Mandates (#2957; mockup `aMandates`): the mandates this agent
// holds, and — when it holds none — what that means for a call that carries a
// consequence. Nothing in a role, a grant or a toolbelt substitutes for a
// mandate: a call carrying a consequence tag with no mandate is denied before
// dispatch, before any credential is minted.
//
// The section reads `list_mandates` narrowed to the agent. A member without an
// accountable org role is not denied on that read: the handler narrows it to
// the agents that reader created and answers a successful, shorter list. So an
// empty answer means one of two things — the agent holds no mandate, or it
// holds mandates this reader may not see — and only an accountable reader can
// tell them apart. The "No mandate" state says a call carrying a consequence
// is denied before dispatch, which is a statement about the agent's authority
// and not about this list, so it is shown only to a reader whose answer covers
// every mandate. Everyone else is told what the view cannot show.
//
// The warning is driven by authority and not by row count. A draft, a revoked
// row and an expired one all authorize nothing, and `request_mandate` writes a
// draft — so a page that asked "are there rows?" would stop warning the moment
// an operator requested a mandate, which is the moment the agent still has
// none. The rows stay in the table, because the request and the history are
// what the office reads; only the claim about authority is theirs to make.
import { useFormatter, useTranslations } from "next-intl";
import type { OrgRole } from "@/data/contracts/common";
import {
  isEffective,
  type MandateList,
  readsEveryMandate,
} from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import { mono, panel } from "@/ui/control-styles";
import { Measure } from "@/ui/measure";
import { ReadFailure } from "@/ui/read-failure";
import { RequestMandate } from "./mandate-request";

type Place = { org: string; ws: string; agentId: string; agentSlug: string };

const COLUMNS = [
  "mandate",
  "effect",
  "perCall",
  "perPeriod",
  "remaining",
  "validTo",
  "status",
] as const;

export function MandatesSection({
  read,
  orgRole,
  ...place
}: { read: Read<MandateList>; orgRole: OrgRole } & Place) {
  const t = useTranslations("agents.mandates");
  const format = useFormatter();
  const title = t("title");
  const held = read.ok ? read.value.mandates : [];
  /** Of those rows, the ones that authorize a call right now — none of the rest do. */
  const asOf = read.ok ? new Date(read.value.asOf) : null;
  const effective =
    asOf === null ? [] : held.filter((mandate) => isEffective(mandate, asOf));
  /** An empty answer is proof of no authority only for a reader who sees them all. */
  const complete = readsEveryMandate(orgRole);
  return (
    <section aria-labelledby="agent-mandates" className={`${panel} p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="agent-mandates" className="text-base font-semibold">
            {read.ok && effective.length === 0
              ? complete
                ? t("noneTitle")
                : t("noneVisibleTitle")
              : title}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            {t("lead")}
          </p>
        </div>
        <RequestMandate
          org={place.org}
          ws={place.ws}
          agentId={place.agentId}
          agentSlug={place.agentSlug}
        />
      </div>
      <div className="mt-3">
        {!read.ok ? (
          <ReadFailure read={read} section={title} />
        ) : (
          <div className="flex flex-col gap-3">
            {effective.length > 0 ? null : (
              <div className="flex flex-col gap-2 text-sm">
                <p data-state="empty">
                  {complete
                    ? held.length === 0
                      ? t("none")
                      : t("noneEffective")
                    : t("noneVisible")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {complete ? t("noneDetail") : t("noneVisibleDetail")}
                </p>
              </div>
            )}
            {held.length === 0 ? null : (
              <>
                {read.value.truncatedAt === null ? null : (
                  <p
                    data-state="truncated"
                    className="max-w-prose text-sm text-foreground"
                  >
                    {t("truncated", { shown: String(read.value.truncatedAt) })}
                  </p>
                )}
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        {COLUMNS.map((column) => (
                          <th
                            key={column}
                            scope="col"
                            className="px-3 pb-2 font-medium"
                          >
                            {t(`columns.${column}`)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {held.map((mandate) => (
                        <tr
                          key={mandate.id}
                          data-testid="agent-mandate"
                          data-status={mandate.status}
                          className="border-t border-border align-top"
                        >
                          <td className="px-3 py-2">
                            <span className={`${mono} break-all`}>
                              {mandate.id}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            {mandate.consequenceTags.join(", ")}
                          </td>
                          {(["perCall", "perPeriod", "remaining"] as const).map(
                            (field) => (
                              <td key={field} className="px-3 py-2">
                                <ul className="flex flex-col gap-0.5">
                                  {mandate.authority.map((measure) => {
                                    const value = measure[field];
                                    // Two measures in one currency are two dollar
                                    // figures, and which budget each governs is the
                                    // whole question; the Tools ledger names them
                                    // the same way.
                                    return value === null ? null : (
                                      <li key={measure.measure}>
                                        <Measure value={value} />
                                        {mandate.authority.length > 1 ? (
                                          <span className="ml-1 text-xs text-muted-foreground">
                                            {measure.measure}
                                          </span>
                                        ) : null}
                                      </li>
                                    );
                                  })}
                                </ul>
                              </td>
                            ),
                          )}
                          <td className="whitespace-nowrap px-3 py-2">
                            {format.dateTime(new Date(mandate.validTo), {
                              dateStyle: "medium",
                            })}
                          </td>
                          <td className="px-3 py-2">
                            {t(`status.${mandate.status}`)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <p className="mt-3 max-w-prose text-xs text-muted-foreground">
        {t("authority")}
      </p>
    </section>
  );
}
