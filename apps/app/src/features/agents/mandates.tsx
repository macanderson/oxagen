// Agents › Mandates (#2957; mockup `aMandates`): the mandates this agent
// holds, and — when it holds none — what that means for a call that carries a
// consequence. Nothing in a role, a grant or a toolbelt substitutes for a
// mandate: a call carrying a consequence tag with no mandate is denied before
// dispatch, before any credential is minted.
//
// The section reads `list_mandates` narrowed to the agent. A member without an
// accountable org role is denied on that read, which the section says rather
// than the page.
import { useFormatter, useTranslations } from "next-intl";
import type { MandateList } from "@/data/contracts/mandates";
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
  ...place
}: { read: Read<MandateList> } & Place) {
  const t = useTranslations("agents.mandates");
  const format = useFormatter();
  const title = t("title");
  const held = read.ok ? read.value.mandates : [];
  return (
    <section aria-labelledby="agent-mandates" className={`${panel} p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="agent-mandates" className="text-base font-semibold">
            {read.ok && held.length === 0 ? t("noneTitle") : title}
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
        ) : held.length === 0 ? (
          <div className="flex flex-col gap-2 text-sm">
            <p data-state="empty">{t("none")}</p>
            <p className="text-xs text-muted-foreground">{t("noneDetail")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
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
                      <span className={`${mono} break-all`}>{mandate.id}</span>
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
                              return value === null ? null : (
                                <li key={measure.measure}>
                                  <Measure value={value} />
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
          </div>
        )}
      </div>
      <p className="mt-3 max-w-prose text-xs text-muted-foreground">
        {t("authority")}
      </p>
    </section>
  );
}
