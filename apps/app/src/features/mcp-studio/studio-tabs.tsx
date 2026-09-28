"use client";
// A Studio server's four tabs (#4678): Tools, Connection, Try it and Changes,
// each a path segment under the server. The strip is the Tools page's own
// (tabs.tsx): a tablist of links marked with `aria-selected` and
// `aria-current`, scrolling in its own row on a phone.
//
// Tools counts the tools the page lists, with a plus when the registry has a
// later page. Changes counts the draft's edits, which live in this browser tab,
// so the count appears once the draft holds one.
import { useLocale, useTranslations } from "next-intl";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { tabCount, tabLink } from "@/ui/route-tabs";
import { draftCount } from "./draft";
import type { StudioTool } from "./model";
import { STUDIO_TABS, type StudioAt, type StudioTab, studioHref } from "./route";
import { useStudioDraft } from "./use-draft";

export function StudioTabs({
  at,
  serverName,
  serverId,
  current,
  tools,
  complete,
}: {
  at: StudioAt;
  /** The folder name the draft is keyed by; null until the record names it. */
  serverName: string | null;
  serverId: string;
  current: StudioTab;
  tools: readonly Pick<StudioTool, "name" | "imported" | "tokens">[];
  /** False when the registry read had a later page, so the count is a floor. */
  complete: boolean;
}) {
  const t = useTranslations("mcpStudio.tabs");
  const locale = useLocale();
  const draft = useStudioDraft({ serverName, serverId });
  const edits = draftCount({ tools }, draft.ops);
  const count = (tab: StudioTab): string | null => {
    switch (tab) {
      case "tools":
        return complete
          ? formatCount(tools.length, locale)
          : t("atLeast", { count: tools.length });
      case "changes":
        return edits > 0 ? formatCount(edits, locale) : null;
      case "connection":
      case "try":
        return null;
    }
  };
  return (
    <div className="min-w-0 overflow-x-auto border-b border-border">
      <div
        role="tablist"
        aria-label={t("label")}
        className="flex w-max min-w-full gap-0.5"
      >
        {STUDIO_TABS.map((tab) => {
          const n = count(tab);
          return (
            <SafeLink
              key={tab}
              id={`studio-tab-${tab}`}
              role="tab"
              to={studioHref(at, serverId, tab)}
              data-tab={tab}
              aria-selected={tab === current}
              aria-controls={tab === current ? `studio-panel-${tab}` : undefined}
              aria-current={tab === current ? "page" : undefined}
              className={tabLink}
            >
              {t(tab)}
              {n === null ? null : (
                <span data-count={tab} className={tabCount}>
                  {n}
                </span>
              )}
            </SafeLink>
          );
        })}
      </div>
    </div>
  );
}
